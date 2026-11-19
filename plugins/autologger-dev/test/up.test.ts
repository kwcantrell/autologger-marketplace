// up: which make steps run, in what order, with what environment; failures; --dry-run; and that
// nothing outside the fixed step list can ever be run. Injected runner only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../src/run.ts';
import { cli, fakeRunner, fixture, GOOD_OVERRIDES, GOOGLE_ID, GOOGLE_SECRET, INHERITED, NOT_FOUND } from './helpers.ts';

const makeCalls = (runner: ReturnType<typeof fakeRunner>): string[] =>
  runner.calls.filter((c) => c.command === 'make').map((c) => `${c.env?.DEV_HTTPS === '1' ? 'DEV_HTTPS=1 ' : ''}make ${c.args.join(' ')}`);

const ALLOWED = new Set(['make dev-bao', 'make dev-bao-set CUSTOM_DASHBOARDS_ENABLED=1', 'DEV_HTTPS=1 make dev-up']);

test('up on a fresh machine runs dev-bao, dev-bao-set CUSTOM_DASHBOARDS_ENABLED=1, then DEV_HTTPS=1 dev-up, in the checkout', async () => {
  const f = fixture({ credentials: false });
  const runner = fakeRunner({
    'docker container': { code: 1, stderr: 'Error: No such container: autologger-local-openbao' },
    'make dev-up': { stdout: 'dev app: https://localhost:8787\n' },
  });
  const { code, stdout, stderr } = await cli({ env: f.env, runner }, 'up', '--repo', f.repo, '--json');
  assert.equal(code, EXIT.ok, stderr);
  assert.deepEqual(makeCalls(runner), ['make dev-bao', 'make dev-bao-set CUSTOM_DASHBOARDS_ENABLED=1', 'DEV_HTTPS=1 make dev-up']);
  for (const c of runner.calls.filter((c) => c.command === 'make')) assert.equal(c.cwd, f.repo);
  // make's output is streamed to stderr, after a header per step.
  assert.match(stderr, /==> make dev-bao {2}\(autologger-local-openbao is not running; \.env\.openbao\.dev is missing\)\n/);
  assert.match(stderr, /==> DEV_HTTPS=1 make dev-up .*\ndev app: https:\/\/localhost:8787\n/);
  const report = JSON.parse(stdout) as { dry_run: boolean; steps: { id: string; status: string }[]; google_client: string; warnings: string[] };
  assert.equal(report.dry_run, false);
  assert.deepEqual(
    report.steps.map((s) => [s.id, s.status]),
    [
      ['dev-bao', 'ok'],
      ['dev-bao-set', 'ok'],
      ['dev-up', 'ok'],
    ],
  );
  // No overrides.env: the Google client is the defaults' placeholder.
  assert.equal(report.google_client, 'placeholder');
  assert.match(report.warnings[0] ?? '', /sign-in .*will not work.*GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET .*https:\/\/localhost:8787\/auth\/google\/callback/);
  assert.match(stderr, /autologger-dev: warning: the Google OAuth client/);
});

test('up with the OpenBao running, credentials present and dashboards on runs only DEV_HTTPS=1 make dev-up', async () => {
  const f = fixture({ overrides: GOOD_OVERRIDES });
  const runner = fakeRunner();
  const { code, stdout, stderr } = await cli({ env: f.env, runner }, 'up', '--repo', f.repo);
  assert.equal(code, EXIT.ok, stderr);
  assert.deepEqual(makeCalls(runner), ['DEV_HTTPS=1 make dev-up']);
  assert.match(stdout, /\[skip\] make dev-bao /);
  assert.match(stdout, /\[skip\] make dev-bao-set CUSTOM_DASHBOARDS_ENABLED=1 {2}\(CUSTOM_DASHBOARDS_ENABLED=1 is already in /);
  assert.match(stdout, /\[ok\] DEV_HTTPS=1 make dev-up/);
  assert.doesNotMatch(stdout + stderr, /warning/i);
});

test('up runs dev-bao when the container is stopped (dev mode lost its state) even with credentials present', async () => {
  const f = fixture({ overrides: GOOD_OVERRIDES });
  const runner = fakeRunner({ 'docker container': { stdout: 'false\n' } });
  assert.equal((await cli({ env: f.env, runner }, 'up', '--repo', f.repo)).code, EXIT.ok);
  assert.deepEqual(makeCalls(runner), ['make dev-bao', 'DEV_HTTPS=1 make dev-up']);
});

test('up runs dev-bao when .env.openbao.dev is missing even with the container running', async () => {
  const f = fixture({ credentials: false, overrides: GOOD_OVERRIDES });
  const runner = fakeRunner();
  assert.equal((await cli({ env: f.env, runner }, 'up', '--repo', f.repo)).code, EXIT.ok);
  assert.deepEqual(makeCalls(runner), ['make dev-bao', 'DEV_HTTPS=1 make dev-up']);
});

test('up stops at the first failing step with exit 1 naming it, and runs nothing after it', async () => {
  const f = fixture({ credentials: false });
  const runner = fakeRunner({ 'make dev-bao': { code: 2, stderr: 'local-bao: docker could not start\n' } });
  const { code, stdout, stderr } = await cli({ env: f.env, runner }, 'up', '--repo', f.repo, '--json');
  assert.equal(code, EXIT.failure);
  assert.equal(stdout, '');
  assert.deepEqual(makeCalls(runner), ['make dev-bao']);
  assert.match(stderr, /local-bao: docker could not start\n/);
  assert.match(
    stderr,
    /autologger-dev: step 'make dev-bao' failed \(exit 2\); its output is above\. Not run: make dev-bao-set CUSTOM_DASHBOARDS_ENABLED=1, DEV_HTTPS=1 make dev-up\.\n$/,
  );

  const late = fakeRunner({ 'make dev-up': { code: 1 } });
  const r2 = await cli({ env: f.env, runner: late }, 'up', '--repo', f.repo);
  assert.equal(r2.code, EXIT.failure);
  assert.match(r2.stderr, /step 'DEV_HTTPS=1 make dev-up' failed \(exit 1\)/);

  const noMake = fakeRunner({ 'make dev-bao': NOT_FOUND });
  const r3 = await cli({ env: f.env, runner: noMake }, 'up', '--repo', f.repo);
  assert.equal(r3.code, EXIT.failure);
  assert.match(r3.stderr, /step 'make dev-bao' failed \(make is not on PATH\)/);
});

test('up --dry-run prints the plan and runs no make target', async () => {
  const f = fixture({ credentials: false });
  const runner = fakeRunner();
  const { code, stdout } = await cli({ env: f.env, runner }, 'up', '--repo', f.repo, '--dry-run');
  assert.equal(code, EXIT.ok);
  assert.deepEqual(makeCalls(runner), []);
  assert.match(stdout, /^Would run in .*:\n {2}\[run \] make dev-bao .*\n {2}\[run \] make dev-bao-set CUSTOM_DASHBOARDS_ENABLED=1 .*\n {2}\[run \] DEV_HTTPS=1 make dev-up /);
  const json = await cli({ env: f.env, runner }, 'up', '--repo', f.repo, '--dry-run', '--json');
  const report = JSON.parse(json.stdout) as { dry_run: boolean; steps: { command: string; run: boolean; status: string }[] };
  assert.equal(report.dry_run, true);
  assert.deepEqual(
    report.steps.map((s) => [s.command, s.run, s.status]),
    [
      ['make dev-bao', true, 'planned'],
      ['make dev-bao-set CUSTOM_DASHBOARDS_ENABLED=1', true, 'planned'],
      ['DEV_HTTPS=1 make dev-up', true, 'planned'],
    ],
  );
  assert.deepEqual(makeCalls(runner), []);
});

test('up never runs a target outside its fixed list and never writes overrides.env', async () => {
  for (const overrides of [undefined, GOOD_OVERRIDES, 'GOOGLE_CLIENT_ID=REPLACE_ME\nCUSTOM_DASHBOARDS_ENABLED=0\n']) {
    for (const container of ['true\n', 'false\n']) {
      const f = fixture({ credentials: container === 'true\n', ...(overrides !== undefined ? { overrides } : {}) });
      const runner = fakeRunner({ 'docker container': { stdout: container } });
      // Variables that would point make at a reset, another slot or stage are not passed on.
      const env = { ...f.env, ...INHERITED };
      assert.equal((await cli({ env, runner }, 'up', '--repo', f.repo)).code, EXIT.ok);
      for (const call of makeCalls(runner)) assert.ok(ALLOWED.has(call), call);
      for (const call of runner.calls) {
        assert.doesNotMatch(call.args.join(' '), /reset|down|stage|prod|GOOGLE/);
        if (call.command !== 'make') continue;
        for (const k of Object.keys(INHERITED)) assert.equal(call.env?.[k], k === 'DEV_HTTPS' && call.args[0] === 'dev-up' ? '1' : undefined, k);
        assert.equal(call.env?.HOME, f.env.HOME, 'the rest of the environment is passed on');
      }
      const after = overrides === undefined ? undefined : readFileSync(join(f.stateDir, 'overrides.env'), 'utf8');
      assert.equal(after, overrides);
    }
  }
});

test('up refuses a directory that is not an autologger-2 checkout (exit 1, nothing run)', async () => {
  const f = fixture({ checkout: false });
  const runner = fakeRunner();
  const { code, stdout, stderr } = await cli({ env: f.env, runner }, 'up', '--repo', f.repo);
  assert.equal(code, EXIT.failure);
  assert.equal(stdout, '');
  assert.match(stderr, /is not an autologger-2 checkout/);
  assert.deepEqual(runner.calls, []);
});

interface DryRun {
  google_client: string;
  warnings: string[];
  steps: { id: string; run: boolean; reason: string }[];
}

test('up and up --dry-run warn about a quoted Google value, naming the quotes, like a placeholder', async () => {
  for (const [id, secret] of [
    [`"${GOOGLE_ID}"`, GOOGLE_SECRET],
    [GOOGLE_ID, `'${GOOGLE_SECRET}'`],
  ] as const) {
    const f = fixture({ overrides: `GOOGLE_CLIENT_ID=${id}\nGOOGLE_CLIENT_SECRET=${secret}\nCUSTOM_DASHBOARDS_ENABLED=1\n` });
    const key = id.startsWith('"') ? 'GOOGLE_CLIENT_ID' : 'GOOGLE_CLIENT_SECRET';
    const dry = await cli({ env: f.env, runner: fakeRunner() }, 'up', '--repo', f.repo, '--dry-run', '--json');
    assert.equal(dry.code, EXIT.ok, dry.stderr);
    const report = JSON.parse(dry.stdout) as DryRun;
    assert.equal(report.google_client, 'placeholder');
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0] ?? '', new RegExp(`^${key} in .* is wrapped in quotes, and autologger stores the value verbatim, quotes included, so Google will reject the client.*Remove the quotes, then run make dev-bao and up again\\.$`));
    const run = await cli({ env: f.env, runner: fakeRunner() }, 'up', '--repo', f.repo);
    assert.equal(run.code, EXIT.ok, run.stderr);
    assert.match(run.stdout, new RegExp(`Warning: ${key} in .* is wrapped in quotes`));
  }
  const both = fixture({ overrides: `GOOGLE_CLIENT_ID="${GOOGLE_ID}"\nGOOGLE_CLIENT_SECRET=REPLACE_ME\n` });
  const report = JSON.parse((await cli({ env: both.env, runner: fakeRunner() }, 'up', '--repo', both.repo, '--dry-run', '--json')).stdout) as DryRun;
  assert.match(report.warnings[0] ?? '', /^GOOGLE_CLIENT_ID in .* is wrapped in quotes/);
  assert.match(report.warnings[1] ?? '', /is a placeholder or not set/);
});

test('up plans make dev-bao-set CUSTOM_DASHBOARDS_ENABLED=1 for a quoted value, and says why', async () => {
  for (const q of ['"', "'"]) {
    const f = fixture({ overrides: `GOOGLE_CLIENT_ID=${GOOGLE_ID}\nGOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}\nCUSTOM_DASHBOARDS_ENABLED=${q}1${q}\n` });
    const dry = await cli({ env: f.env, runner: fakeRunner({ 'docker container': { stdout: 'true\n' } }) }, 'up', '--repo', f.repo, '--dry-run', '--json');
    assert.equal(dry.code, EXIT.ok, dry.stderr);
    const report = JSON.parse(dry.stdout) as DryRun;
    const step = report.steps.find((s) => s.id === 'dev-bao-set');
    assert.equal(step?.run, true);
    assert.match(step?.reason ?? '', /CUSTOM_DASHBOARDS_ENABLED is quoted in .*autologger stores the value verbatim.*rewrites it unquoted/);
    assert.deepEqual(report.warnings, [], 'the Google client is fine');
    const runner = fakeRunner({ 'docker container': { stdout: 'true\n' } });
    const run = await cli({ env: f.env, runner }, 'up', '--repo', f.repo);
    assert.equal(run.code, EXIT.ok, run.stderr);
    assert.deepEqual(makeCalls(runner), ['make dev-bao-set CUSTOM_DASHBOARDS_ENABLED=1', 'DEV_HTTPS=1 make dev-up']);
  }
});

test("a step's output that ends without a newline is ended before the next step's header, still scrubbed", async () => {
  const f = fixture({ credentials: false, overrides: GOOD_OVERRIDES.replace('CUSTOM_DASHBOARDS_ENABLED=1', 'CUSTOM_DASHBOARDS_ENABLED=0') });
  const runner = fakeRunner({
    'docker container': { code: 1, stderr: 'No such container' },
    'make dev-bao': (_call, options) => {
      options.onOutput?.('started\ntail');
      return { code: 0 };
    },
    'make dev-bao-set': (_call, options) => {
      options.onOutput?.(`secret ${GOOGLE_SECRET}`);
      return { code: 0 };
    },
  });
  const { code, stderr } = await cli({ env: f.env, runner }, 'up', '--repo', f.repo);
  assert.equal(code, EXIT.ok, stderr);
  assert.match(stderr, /started\ntail\n==> make dev-bao-set /);
  assert.match(stderr, /\nsecret \[redacted\]\n==> DEV_HTTPS=1 make dev-up /);
  assert.ok(!stderr.includes(GOOGLE_SECRET));
});

test('up and up --dry-run warn about a Google value with spaces around it, naming the spaces, never the value', async () => {
  for (const [id, secret, key] of [
    [` ${GOOGLE_ID}`, GOOGLE_SECRET, 'GOOGLE_CLIENT_ID'],
    [GOOGLE_ID, `${GOOGLE_SECRET} `, 'GOOGLE_CLIENT_SECRET'],
  ] as const) {
    const f = fixture({ overrides: `GOOGLE_CLIENT_ID=${id}\nGOOGLE_CLIENT_SECRET=${secret}\nCUSTOM_DASHBOARDS_ENABLED=1\n` });
    const dry = await cli({ env: f.env, runner: fakeRunner() }, 'up', '--repo', f.repo, '--dry-run', '--json');
    assert.equal(dry.code, EXIT.ok, dry.stderr);
    const report = JSON.parse(dry.stdout) as DryRun;
    assert.equal(report.google_client, 'placeholder');
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0] ?? '', new RegExp(`^${key} in .* is surrounded by spaces, and autologger stores the value verbatim, surrounding spaces included, so Google will reject the client.*Remove the spaces, then run make dev-bao and up again\\.$`));
    const run = await cli({ env: f.env, runner: fakeRunner() }, 'up', '--repo', f.repo);
    assert.equal(run.code, EXIT.ok, run.stderr);
    assert.match(run.stdout, new RegExp(`Warning: ${key} in .* is surrounded by spaces`));
    assert.match(run.stderr, new RegExp(`autologger-dev: warning: ${key} in .* is surrounded by spaces`));
    for (const out of [dry, run]) {
      for (const v of [GOOGLE_ID, GOOGLE_SECRET]) assert.ok(!(out.stdout + out.stderr).includes(v), 'no value printed');
    }
  }
});

test('up plans make dev-bao-set CUSTOM_DASHBOARDS_ENABLED=1 for a value with spaces around it, and says why', async () => {
  for (const value of [' 1', '1 ', '\t1']) {
    const f = fixture({ overrides: `GOOGLE_CLIENT_ID=${GOOGLE_ID}\nGOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}\nCUSTOM_DASHBOARDS_ENABLED=${value}\n` });
    const dry = await cli({ env: f.env, runner: fakeRunner() }, 'up', '--repo', f.repo, '--dry-run', '--json');
    assert.equal(dry.code, EXIT.ok, dry.stderr);
    const report = JSON.parse(dry.stdout) as DryRun;
    const step = report.steps.find((s) => s.id === 'dev-bao-set');
    assert.equal(step?.run, true, JSON.stringify(value));
    assert.match(step?.reason ?? '', /CUSTOM_DASHBOARDS_ENABLED has spaces around its value in .*surrounding spaces included.*rewrites it without them/);
    assert.deepEqual(report.warnings, []);
  }
});
