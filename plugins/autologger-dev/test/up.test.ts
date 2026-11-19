// up: which make steps run, in what order, with what environment; failures; --dry-run; and that
// nothing outside the fixed step list can ever be run. Injected runner only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../src/run.ts';
import { cli, fakeRunner, fixture, GOOD_OVERRIDES, INHERITED, NOT_FOUND } from './helpers.ts';

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
