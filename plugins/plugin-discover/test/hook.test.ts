// The UserPromptSubmit hook, fed recorded hook inputs (test/fixtures/hooks/*.json, in Claude Code's
// UserPromptSubmit input format) with the cwd rewritten per case.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { HINT, hookOutput, originUrl, promptMatches } from '../src/hook.ts';
import { FIXTURES, PLUGIN_ROOT, sandbox } from './helpers.ts';

const s = sandbox();
after(s.cleanup);

function fixture(name: string, changes: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...JSON.parse(readFileSync(join(FIXTURES, 'hooks', `${name}.json`), 'utf8')), ...changes });
}

const HINT_LINE = `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: HINT } })}\n`;
let n = 0;
/** A fresh session id per call, so the once-per-session rule does not hide a hint. */
const fresh = (): string => `session-${++n}`;

test('the hint is one short line telling Claude to run match first', () => {
  assert.ok(!HINT.includes('\n'));
  assert.ok(HINT.length < 300);
  assert.match(HINT, /plugin-discover/);
  assert.match(HINT, /`match`/);
});

test('recorded autologger prompts get the additionalContext hint', () => {
  for (const name of ['prompt-autologger', 'prompt-mcp-tool', 'prompt-dev-stack']) {
    assert.equal(hookOutput(fixture(name, { session_id: fresh() }), s.env), HINT_LINE, name);
  }
});

test('an unrelated prompt in an unrelated cwd, and other events, add nothing', () => {
  assert.equal(hookOutput(fixture('prompt-unrelated', { cwd: s.cwd, session_id: fresh() }), s.env), '');
  assert.equal(hookOutput(fixture('other-event'), s.env), '');
  assert.equal(hookOutput(fixture('prompt-autologger', { hook_event_name: 'PostToolUse' }), s.env), '');
  for (const raw of ['', 'not json', '{"hook_event_name":"UserPromptSubmit"', '[]', '"UserPromptSubmit"']) assert.equal(hookOutput(raw, s.env), '', raw);
});

test('at most once per session, remembered in the plugin config dir (owner-only)', () => {
  const t = sandbox();
  try {
    const first = fixture('prompt-autologger', { session_id: 'abc' });
    assert.equal(hookOutput(first, t.env), HINT_LINE);
    assert.equal(hookOutput(first, t.env), '');
    assert.equal(hookOutput(fixture('prompt-mcp-tool', { session_id: 'abc' }), t.env), '');
    assert.equal(hookOutput(fixture('prompt-mcp-tool', { session_id: 'def' }), t.env), HINT_LINE);
    const file = join(t.configDir, 'hinted-sessions.json');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { sessions: ['abc', 'def'] });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(t.configDir).mode & 0o777, 0o700);
    // An unrelated prompt does not use up the session's hint.
    assert.equal(hookOutput(fixture('prompt-unrelated', { cwd: t.cwd, session_id: 'ghi' }), t.env), '');
    assert.equal(hookOutput(fixture('prompt-autologger', { session_id: 'ghi' }), t.env), HINT_LINE);
  } finally {
    t.cleanup();
  }
});

test('when the session cannot be remembered, no hint (rather than one on every prompt)', () => {
  const blocker = join(s.dir, 'a-file');
  writeFileSync(blocker, '');
  assert.equal(hookOutput(fixture('prompt-autologger', { session_id: fresh() }), { ...s.env, PLUGIN_DISCOVER_CONFIG_DIR: join(blocker, 'cfg') }), '');
});

function repo(name: string, config: string): string {
  const root = join(s.dir, name);
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  writeFileSync(join(root, '.git', 'config'), config);
  return root;
}

const origin = (url: string): string => `[core]\n\trepositoryformatversion = 0\n[remote "upstream"]\n\turl = https://example.com/x/y.git\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;

test('a cwd inside an autologger-2 or autologger-marketplace checkout gets the hint, even for an unrelated prompt', () => {
  const al = repo('al2', origin('git@github.com:kwcantrell/autologger-2.git'));
  const mk = repo('mk', origin('https://github.com/kwcantrell/autologger-marketplace'));
  for (const cwd of [al, join(al, 'src', 'deep'), mk]) {
    assert.equal(hookOutput(fixture('prompt-unrelated', { cwd, session_id: fresh() }), s.env), HINT_LINE, cwd);
  }
});

test('a linked worktree (.git file) of an autologger checkout counts', () => {
  const main = repo('main-checkout', origin('https://github.com/kwcantrell/autologger-2.git'));
  const gitdir = join(main, '.git', 'worktrees', 'wt');
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, 'commondir'), '../..\n');
  const wt = join(s.dir, 'wt');
  mkdirSync(wt);
  writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`);
  assert.equal(hookOutput(fixture('prompt-unrelated', { cwd: wt, session_id: fresh() }), s.env), HINT_LINE);
});

test('a marketplace checkout without that origin is recognised by its manifest; other repos are not', () => {
  const fork = repo('fork', origin('https://github.com/someone/fork.git'));
  assert.equal(hookOutput(fixture('prompt-unrelated', { cwd: fork, session_id: fresh() }), s.env), '');
  mkdirSync(join(fork, '.claude-plugin'));
  writeFileSync(join(fork, '.claude-plugin', 'marketplace.json'), '{"name": "autologger-marketplace", "plugins": []}');
  assert.equal(hookOutput(fixture('prompt-unrelated', { cwd: fork, session_id: fresh() }), s.env), HINT_LINE);
  const lookalike = repo('lookalike', origin('https://github.com/kwcantrell/autologger-2-docs.git'));
  assert.equal(hookOutput(fixture('prompt-unrelated', { cwd: lookalike, session_id: fresh() }), s.env), '');
});

test('originUrl reads only the origin remote', () => {
  assert.equal(originUrl(origin('git@github.com:kwcantrell/autologger-2.git')), 'git@github.com:kwcantrell/autologger-2.git');
  assert.equal(originUrl('[remote "upstream"]\n\turl = x\n'), undefined);
});

test('the keyword list: autologger words fire, generic ones do not', () => {
  for (const p of [
    'Summarise my Autologger session',
    'call get_session_aggregates for show 3',
    'use list_transcript_words',
    'delete_wiki_page for the old page',
    'which logged events have no topic',
    'read the session transcript',
    'enable custom dashboards',
    'CUSTOM_DASHBOARDS_ENABLED=1 is not taking effect',
    'start the dev stack',
    'make dev-up fails',
    'run dev-mcp-token',
    'OpenBao is sealed',
    'https://localhost:8787/mcp is unreachable',
    'curl https://localhost:21787/mcp',
    'the specs-with-code gate failed',
    'plugin-builder verify fails',
  ]) {
    assert.equal(promptMatches(p), true, p);
  }
  for (const p of [
    'refactor the session middleware',
    'add a dashboard to grafana',
    'log an event to the console',
    'update the wiki',
    'start the dev server on localhost:3000',
    'list all events in the calendar',
    'my mcp server config',
  ]) {
    assert.equal(promptMatches(p), false, p);
  }
});

test('hooks.json runs `node <root>/src/cli.ts hook` on UserPromptSubmit, synchronously, with a short timeout', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks), ['UserPromptSubmit']);
  const handler = hooks.hooks.UserPromptSubmit[0].hooks[0];
  assert.deepEqual(handler, { type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/src/cli.ts', 'hook'], timeout: 5 });
});

test('the hook process exits 0 and prints the hint or nothing, never blocking', () => {
  const env = { ...process.env, ...s.env } as NodeJS.ProcessEnv;
  const runHook = (input: string): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'src', 'cli.ts'), 'hook'], { cwd: s.cwd, env, input, encoding: 'utf8', timeout: 10_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  assert.deepEqual(runHook(fixture('prompt-autologger', { session_id: fresh() })), { status: 0, stdout: HINT_LINE, stderr: '' });
  assert.deepEqual(runHook(fixture('prompt-unrelated', { cwd: s.cwd, session_id: fresh() })), { status: 0, stdout: '', stderr: '' });
  assert.deepEqual(runHook('garbage'), { status: 0, stdout: '', stderr: '' });
  const out = JSON.parse(runHook(fixture('prompt-dev-stack', { session_id: fresh() })).stdout);
  assert.equal(out.decision, undefined);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});
