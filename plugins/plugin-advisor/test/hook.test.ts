// The PostToolUseFailure hook: recorded hook-input JSON (the documented Claude Code format) on stdin,
// matching and non-matching, through run() and through the exact command hooks/hooks.json runs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { cliCalls, failureOf, quickReject } from '../src/hook.ts';
import { marketplacePlugins } from '../src/plugins.ts';
import { EXIT } from '../src/run.ts';
import { FIXTURES, PLUGIN_ROOT, sandbox, type Sandbox } from './helpers.ts';

let box: Sandbox;
afterEach(() => box?.cleanup());

const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const { bins, plugins } = marketplacePlugins(PLUGIN_ROOT, {});

function log(b: Sandbox): any[] {
  const path = join(b.config, 'occurrences.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

test('an npx run of a marketplace CLI that exits non-zero is recorded as a cli-failure', () => {
  box = sandbox();
  const r = box.call(['hook'], { stdin: fixture('hook-npx-failure.json') });
  assert.deepEqual(r, { code: EXIT.ok, stdout: '', stderr: '' });
  const [o, ...more] = log(box);
  assert.equal(more.length, 0);
  assert.equal(o.plugin, 'autologger-mcp');
  assert.equal(o.kind, 'cli-failure');
  assert.equal(o.subcommand, 'call');
  assert.equal(o.exitCode, 1);
  assert.equal(o.source, 'hook');
  assert.equal(o.summary, 'autologger-mcp call exited 1: autologger-mcp: not signed in to https://autologger.example (token [redacted] expired); run login');
  assert.equal(o.detail, undefined);
  // Only the plugin, subcommand, exit code and the redacted error line are kept.
  const stored = readFileSync(join(box.config, 'occurrences.jsonl'), 'utf8');
  for (const leak of ['STDOUT-SHOULD-NOT-BE-STORED', 'list_events', 'ses_8f3k2a', '--package', 'alm_Zx81', 'toolu_', 'transcript', 'npx']) {
    assert.ok(!stored.includes(leak), `stored ${leak}`);
  }
});

test('a node run of plugins/<plugin>/src/cli.ts that exits non-zero is recorded', () => {
  box = sandbox();
  assert.deepEqual(box.call(['hook'], { stdin: fixture('hook-node-failure.json') }), { code: EXIT.ok, stdout: '', stderr: '' });
  const [o] = log(box);
  assert.equal(o.plugin, 'plugin-builder');
  assert.equal(o.subcommand, 'verify');
  assert.equal(o.summary, 'plugin-builder verify exited 1: plugin-builder: verify failed: <n> gates failed (typecheck, tests)'.replace('<n>', '2'));
  assert.ok(!readFileSync(join(box.config, 'occurrences.jsonl'), 'utf8').includes('my-plugin'));
});

for (const name of ['hook-other-failure.json', 'hook-other-npx-failure.json', 'hook-success.json', 'hook-interrupt.json']) {
  test(`${name}: nothing recorded, no output, exit 0`, () => {
    box = sandbox();
    assert.deepEqual(box.call(['hook'], { stdin: fixture(name) }), { code: EXIT.ok, stdout: '', stderr: '' });
    assert.equal(existsSync(box.config), false, 'not even the config dir is created');
  });
}

test('malformed or empty input never fails the hook', () => {
  box = sandbox();
  for (const stdin of ['', 'not json', '{"hook_event_name":"PostToolUseFailure","tool_input":"npx"}', '[]', 'PostToolUseFailure npx {']) {
    assert.deepEqual(box.call(['hook'], { stdin }), { code: EXIT.ok, stdout: '', stderr: '' });
  }
  assert.equal(log(box).length, 0);
});

test('a failure to write the log is swallowed', () => {
  box = sandbox({ PLUGIN_ADVISOR_CONFIG_DIR: '/proc/plugin-advisor-cannot-write-here' });
  assert.deepEqual(box.call(['hook'], { stdin: fixture('hook-npx-failure.json') }), { code: EXIT.ok, stdout: '', stderr: '' });
});

test('quickReject rejects anything that is not a failure mentioning npx or cli.ts, before parsing', () => {
  assert.equal(quickReject(fixture('hook-other-failure.json')), true);
  assert.equal(quickReject(fixture('hook-success.json')), true);
  assert.equal(quickReject(fixture('hook-npx-failure.json')), false);
  assert.equal(quickReject(fixture('hook-node-failure.json')), false);
});

test('cliCalls finds marketplace CLI calls in compound commands', () => {
  const prefix = 'npx --yes --offline --loglevel=error --package="/p/x y/autologger-dev/0.2.0" --';
  assert.deepEqual(cliCalls(`cd /x && ${prefix} autologger-dev doctor --json | jq .`, bins, plugins), [{ bin: 'autologger-dev', plugin: 'autologger-dev', subcommand: 'doctor' }]);
  assert.deepEqual(cliCalls(`${prefix} autologger-dev --help`, bins, plugins), [{ bin: 'autologger-dev', plugin: 'autologger-dev' }]);
  assert.deepEqual(cliCalls('node /home/u/.claude/plugins/cache/autologger-marketplace/autologger-specs/0.1.0/src/cli.ts stale', bins, plugins), [
    { bin: 'autologger-specs', plugin: 'autologger-specs', subcommand: 'stale' },
  ]);
  assert.deepEqual(cliCalls('npx -- eslint . ; node scripts/src/cli.ts x ; npx tsc', bins, plugins), []);
  assert.equal(cliCalls(`${prefix} autologger-mcp status; ${prefix} autologger-mcp call x`, bins, plugins).length, 2);
});

test('failureOf reads the exit code from the error string and ignores exit 0 and other tools', () => {
  const base = JSON.parse(fixture('hook-npx-failure.json'));
  assert.equal(failureOf({ ...base, error: 'Exit code 0\n' }, bins, plugins), null);
  assert.equal(failureOf({ ...base, error: 'spawn /bin/bash ENOENT' }, bins, plugins), null);
  assert.equal(failureOf({ ...base, tool_name: 'Read' }, bins, plugins), null);
  assert.deepEqual(failureOf({ ...base, error: 'Exit code 2\nsome stdout line\n' }, bins, plugins), { bin: 'autologger-mcp', plugin: 'autologger-mcp', subcommand: 'call', exitCode: 2 });
  assert.equal(failureOf({ ...base, error: 'Exit code 1\nnpm error code ENOTCACHED' }, bins, plugins)?.message, 'npm error code ENOTCACHED');
});

test('the hook command from hooks/hooks.json runs and records, with no output', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const groups = hooks.hooks.PostToolUseFailure;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].matcher, 'Bash');
  const [handler] = groups[0].hooks;
  assert.equal(handler.type, 'command');
  assert.equal(handler.command, 'node');
  assert.equal(handler.async, true, 'runs in the background, so Claude never waits for it');
  box = sandbox();
  const args = handler.args.map((a: string) => a.replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT.replace(/\/$/, '')));
  for (const [name, expected] of [['hook-other-failure.json', 0], ['hook-npx-failure.json', 1]] as const) {
    const r = spawnSync(handler.command, args, { input: fixture(name), encoding: 'utf8', env: { ...process.env, ...box.env } as NodeJS.ProcessEnv });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.equal(log(box).length, expected, name);
  }
});
