import assert from 'node:assert/strict';
import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/run.ts';
import { slotPaths } from '../src/slot.ts';
import type { Probe } from '../src/tls.ts';
import { CA2, capture, type Fake, fakeRunner, tempHome } from './helpers.ts';

interface Check {
  name: string;
  status: string;
  detail: string;
  fix: string | null;
}

const okProbe: Probe = async () => ({ ok: true, status: 200 });

async function doctor(env: Record<string, string>, fake: Fake = fakeRunner(), probe: Probe = okProbe, extra: string[] = []): Promise<{ code: number; checks: Map<string, Check>; ok: boolean; probed: string[] }> {
  const probed: string[] = [];
  const c = capture({ env, runner: fake.runner, probe: async (origin, ca) => (probed.push(origin), probe(origin, ca)) });
  const code = await run(['doctor', '--json', ...extra], c.io);
  const report = JSON.parse(c.out()) as { ok: boolean; checks: Check[] };
  return { code, checks: new Map(report.checks.map((x) => [x.name, x])), ok: report.ok, probed };
}

async function setupFirst(env: Record<string, string>): Promise<void> {
  const c = capture({ env, runner: fakeRunner().runner });
  assert.equal(await run(['setup'], c.io), 0, c.err());
}

test('doctor reports every named check ok after setup, and is read-only', async () => {
  const t = tempHome();
  try {
    await setupFirst(t.env);
    const fake = fakeRunner();
    const { code, checks, ok, probed } = await doctor(t.env, fake);
    assert.equal(code, 0);
    assert.equal(ok, true);
    assert.deepEqual([...checks.keys()], ['agent_browser', 'chromium', 'certutil', 'dev_ca', 'profile', 'app_tls', 'runtime_tls']);
    for (const c of checks.values()) assert.equal(c.status, 'ok', `${c.name}: ${c.detail}`);
    assert.match(checks.get('agent_browser')?.detail ?? '', /agent-browser 0\.43\.0/);
    assert.deepEqual(probed, ['https://localhost:8787', 'https://dashboards.localhost']);
    // Read-only: certutil only lists, nothing is added, removed or created.
    for (const call of fake.calls) assert.ok(!['-A', '-D', '-N'].some((op) => call.args.includes(op)), call.args.join(' '));
  } finally {
    t.cleanup();
  }
});

test('doctor on a bare machine: each missing piece has its fix, and it still exits 0', async () => {
  const t = tempHome(false);
  try {
    const { code, checks, ok, probed } = await doctor({ ...t.env, PATH: '/nonexistent' }, fakeRunner({ certutil: false, agentBrowser: false }));
    assert.equal(code, 0);
    assert.equal(ok, false);
    assert.equal(checks.get('agent_browser')?.status, 'missing');
    assert.match(checks.get('agent_browser')?.fix ?? '', /npm install -g agent-browser/);
    assert.equal(checks.get('chromium')?.status, 'missing');
    assert.equal(checks.get('certutil')?.status, 'missing');
    assert.match(checks.get('certutil')?.fix ?? '', /libnss3-tools/);
    assert.match(checks.get('certutil')?.fix ?? '', /agent-browser install --with-deps/);
    assert.equal(checks.get('dev_ca')?.status, 'missing');
    assert.match(checks.get('dev_ca')?.fix ?? '', /autologger-dev ca/);
    assert.equal(checks.get('profile')?.status, 'missing');
    assert.match(checks.get('profile')?.fix ?? '', /autologger-browser setup/);
    assert.equal(checks.get('app_tls')?.status, 'missing');
    assert.deepEqual(probed, [], 'probed without a CA');
  } finally {
    t.cleanup();
  }
});

test('doctor: a CA file that is not one certificate fails with the autologger-dev ca fix', async () => {
  const t = tempHome();
  try {
    writeFileSync(join(t.home, '.autologger-dev', 'autologger-dev-ca.crt'), 'not a certificate\n');
    const { checks } = await doctor(t.env);
    assert.equal(checks.get('dev_ca')?.status, 'fail');
    assert.match(checks.get('dev_ca')?.fix ?? '', /autologger-dev ca/);
  } finally {
    t.cleanup();
  }
});

test('doctor: a changed CA file makes the profile check fail until setup runs again', async () => {
  const t = tempHome();
  try {
    await setupFirst(t.env);
    copyFileSync(CA2, join(t.home, '.autologger-dev', 'autologger-dev-ca.crt'));
    const { checks } = await doctor(t.env);
    assert.equal(checks.get('profile')?.status, 'fail');
    assert.match(checks.get('profile')?.detail ?? '', /different certificate/);
    assert.equal(checks.get('profile')?.fix, 'replace it: autologger-browser setup');
  } finally {
    t.cleanup();
  }
});

test('doctor: a missing launcher, and certutil missing after setup, are failures with fixes', async () => {
  const t = tempHome();
  try {
    await setupFirst(t.env);
    const first = await doctor(t.env, fakeRunner({ certutil: false }));
    assert.equal(first.checks.get('profile')?.status, 'fail');
    assert.match(first.checks.get('profile')?.fix ?? '', /libnss3-tools/);
    rmSync(slotPaths(t.env, 0).launcher);
    const second = await doctor(t.env);
    assert.equal(second.checks.get('profile')?.status, 'fail');
    assert.match(second.checks.get('profile')?.detail ?? '', /launcher/);
  } finally {
    t.cleanup();
  }
});

test('doctor: TLS failures say whether the CA is stale or the stack is down; slot N probes its own origins', async () => {
  const t = tempHome();
  try {
    const stale = await doctor(t.env, fakeRunner(), async () => ({ ok: false, code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'x' }));
    assert.equal(stale.checks.get('app_tls')?.status, 'fail');
    assert.match(stale.checks.get('app_tls')?.fix ?? '', /autologger-dev ca/);
    const down = await doctor(t.env, fakeRunner(), async () => ({ ok: false, code: 'ECONNREFUSED', message: 'x' }), ['--slot', '2']);
    assert.match(down.checks.get('runtime_tls')?.fix ?? '', /autologger-dev up --slot 2/);
    assert.deepEqual(down.probed, ['https://localhost:22787', 'https://dashboards-2.localhost']);
  } finally {
    t.cleanup();
  }
});
