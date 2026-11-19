// DEV_PORT (slot 0's app port from overrides.env), the doctor's test-only probe origin, and the
// fixes that name autologger-dev ca with --repo.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { probeOrigins, TEST_PROBE_ORIGIN_ENV } from '../src/doctor.ts';
import { run } from '../src/run.ts';
import { appOrigin, parseDevPort, readDevPortValue, slotAppOrigin } from '../src/slot.ts';
import type { Probe } from '../src/tls.ts';
import { capture, fakeRunner, tempHome } from './helpers.ts';

function writeOverrides(home: string, text: string): void {
  const dir = join(home, '.autologger-local-openbao');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'overrides.env'), text);
}

async function cli(env: Record<string, string>, args: string[], probe?: Probe): Promise<{ code: number; json: Record<string, unknown>; err: string; probed: string[] }> {
  const probed: string[] = [];
  const c = capture({ env, runner: fakeRunner().runner, probe: async (origin) => (probed.push(origin), probe === undefined ? { ok: true, status: 200 } : probe(origin, '')), readStdin: async () => 'autologger_sid=tok\n', stdinIsTty: false });
  const code = await run([...args, '--json'], c.io);
  return { code, json: code === 0 ? (JSON.parse(c.out()) as Record<string, unknown>) : {}, err: c.err(), probed };
}

test('parseDevPort: digits only, 1-65535, no leading zero; anything else is 8787', () => {
  for (const [value, port] of [
    ['9000', 9000],
    ['1', 1],
    ['65535', 65535],
    [undefined, 8787],
    ['', 8787],
    ['0', 8787],
    ['08787', 8787],
    ['65536', 8787],
    ['123456', 8787],
    [' 9000', 8787],
    ['9000 ', 8787],
    ['"9000"', 8787],
    ['9000x', 8787],
    ['-1', 8787],
  ] as const) {
    assert.equal(parseDevPort(value), port, String(value));
  }
});

test('readDevPortValue reads overrides.env verbatim (last line wins, comments skipped), and LOCAL_BAO_DIR moves it', () => {
  const t = tempHome();
  try {
    assert.equal(readDevPortValue(t.env), undefined, 'no file');
    writeOverrides(t.home, '# DEV_PORT=1111\nOTHER=1\nDEV_PORT=9000\r\nDEV_PORT=9001\n');
    assert.equal(readDevPortValue(t.env), '9001');
    writeOverrides(t.home, 'DEV_PORT= 9000\n');
    assert.equal(readDevPortValue(t.env), ' 9000');
    writeOverrides(t.home, 'OTHER=1\n');
    assert.equal(readDevPortValue(t.env), undefined);
    const elsewhere = join(t.home, 'bao');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'overrides.env'), 'DEV_PORT=7000\n');
    assert.equal(readDevPortValue({ ...t.env, LOCAL_BAO_DIR: elsewhere }), '7000');
  } finally {
    t.cleanup();
  }
});

test('slotAppOrigin: slot 0 follows a valid DEV_PORT, an invalid or unset one is 8787, slots 1-9 ignore it', () => {
  const t = tempHome();
  try {
    assert.equal(slotAppOrigin(t.env, 0), 'https://localhost:8787', 'unset');
    writeOverrides(t.home, 'DEV_PORT=9443\n');
    assert.equal(slotAppOrigin(t.env, 0), 'https://localhost:9443', 'set');
    for (let slot = 1; slot <= 9; slot++) assert.equal(slotAppOrigin(t.env, slot), appOrigin(slot));
    assert.equal(slotAppOrigin(t.env, 3), 'https://localhost:23787');
    for (const bad of ['08787', '70000', 'abc', '"9443"', '']) {
      writeOverrides(t.home, `DEV_PORT=${bad}\n`);
      assert.equal(slotAppOrigin(t.env, 0), 'https://localhost:8787', `invalid ${bad}`);
    }
  } finally {
    t.cleanup();
  }
});

test('DEV_PORT moves doctor app_tls and setup app_url for slot 0 only; signin keeps its cookie origin', async () => {
  const t = tempHome();
  try {
    writeOverrides(t.home, 'DEV_PORT=9443\n');
    const setup0 = await cli(t.env, ['setup']);
    assert.equal(setup0.code, 0, setup0.err);
    assert.equal(setup0.json.app_url, 'https://localhost:9443');
    assert.equal(setup0.json.runtime_url, 'https://dashboards.localhost');
    const doctor0 = await cli(t.env, ['doctor']);
    assert.deepEqual(doctor0.probed, ['https://localhost:9443', 'https://dashboards.localhost']);
    const checks = doctor0.json.checks as Array<{ name: string; detail: string }>;
    assert.match(checks.find((c) => c.name === 'app_tls')?.detail ?? '', /^https:\/\/localhost:9443 answers/);
    const signin0 = await cli(t.env, ['signin']);
    assert.equal(signin0.code, 0, signin0.err);
    assert.equal(signin0.json.origin, 'https://localhost:8787');

    const setup4 = await cli(t.env, ['setup', '--slot', '4']);
    assert.equal(setup4.json.app_url, 'https://localhost:24787');
    const doctor4 = await cli(t.env, ['doctor', '--slot', '4']);
    assert.deepEqual(doctor4.probed, ['https://localhost:24787', 'https://dashboards-4.localhost']);

    writeOverrides(t.home, 'DEV_PORT=08787\n');
    assert.equal((await cli(t.env, ['setup'])).json.app_url, 'https://localhost:8787');
    assert.deepEqual((await cli(t.env, ['doctor'])).probed, ['https://localhost:8787', 'https://dashboards.localhost']);
  } finally {
    t.cleanup();
  }
});

test(`${TEST_PROBE_ORIGIN_ENV} replaces both probe origins; it must be https`, async () => {
  assert.deepEqual(probeOrigins({ HOME: '/h' }, 0), [['app_tls', 'https://localhost:8787'], ['runtime_tls', 'https://dashboards.localhost']]);
  assert.deepEqual(probeOrigins({ HOME: '/h', [TEST_PROBE_ORIGIN_ENV]: 'https://127.0.0.1:9/x' }, 2), [['app_tls', 'https://127.0.0.1:9'], ['runtime_tls', 'https://127.0.0.1:9']]);
  assert.deepEqual(probeOrigins({ HOME: '/h', [TEST_PROBE_ORIGIN_ENV]: '' }, 0)[0], ['app_tls', 'https://localhost:8787']);
  for (const bad of ['http://127.0.0.1:9', 'not a url']) assert.throws(() => probeOrigins({ HOME: '/h', [TEST_PROBE_ORIGIN_ENV]: bad }, 0), /must be an https origin/);
  const t = tempHome();
  try {
    const { code, probed } = await cli({ ...t.env, [TEST_PROBE_ORIGIN_ENV]: 'https://127.0.0.1:9' }, ['doctor']);
    assert.equal(code, 0);
    assert.deepEqual(probed, ['https://127.0.0.1:9', 'https://127.0.0.1:9']);
  } finally {
    t.cleanup();
  }
});

test('doctor and setup name autologger-dev ca with --repo in every CA fix', async () => {
  const repo = /autologger-dev ca --repo <path to autologger-2>/;
  const bare = tempHome(false);
  try {
    for (const slot of ['0', '5']) {
      const { json } = await cli(bare.env, ['doctor', '--slot', slot]);
      const checks = json.checks as Array<{ name: string; fix: string | null }>;
      for (const name of ['dev_ca', 'app_tls', 'runtime_tls']) {
        const fix = checks.find((c) => c.name === name)?.fix ?? '';
        assert.match(fix, repo, `${name} slot ${slot}`);
        if (slot === '5') assert.match(fix, /--repo <path to autologger-2> --slot 5/);
      }
    }
    const setup = await cli(bare.env, ['setup']);
    assert.equal(setup.code, 1);
    assert.match(setup.err, repo);
  } finally {
    bare.cleanup();
  }
  const t = tempHome();
  try {
    writeFileSync(join(t.home, '.autologger-dev', 'autologger-dev-ca.crt'), 'not a certificate\n');
    const broken = await cli(t.env, ['doctor']);
    assert.match((broken.json.checks as Array<{ name: string; fix: string | null }>).find((c) => c.name === 'dev_ca')?.fix ?? '', repo);
  } finally {
    t.cleanup();
  }
  const s = tempHome();
  try {
    const stale = await cli(s.env, ['doctor'], async () => ({ ok: false, code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'x' }));
    assert.match((stale.json.checks as Array<{ name: string; fix: string | null }>).find((c) => c.name === 'app_tls')?.fix ?? '', repo);
  } finally {
    s.cleanup();
  }
});
