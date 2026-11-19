// End to end: runs the exact npx command lines from the skill, the way Claude Code would after
// installing the plugin (a fresh copy, unrelated cwd, no npm install or build step), with the log in a
// scratch config dir and a fake gh on PATH (the real one is never run). Also runs the hook command
// exactly as hooks/hooks.json declares it, from the fresh copy.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeGh } from './helpers.ts';

const CLI_NAME = 'plugin-advisor';
const SKILL = 'skills/plugin-advisor/SKILL.md';
const INVOCATION = `npx --yes --offline --loglevel=error --package="\${CLAUDE_PLUGIN_ROOT}" -- ${CLI_NAME}`;
const ISSUE_URL = 'https://github.com/kwcantrell/autologger-marketplace/issues/1';

const source = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), `${CLI_NAME}-e2e-`));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Simulate the plugin cache: Claude Code installs a plugin by copying its folder.
const pluginRoot = join(scratch, 'plugin-cache', CLI_NAME);
cpSync(source, pluginRoot, { recursive: true, filter: (path) => !path.includes('node_modules') });
const cwd = join(scratch, 'unrelated-cwd');
mkdirSync(cwd);
const config = join(scratch, 'config', 'plugin-advisor');
const ghBin = fakeGh(scratch, `console.log(${JSON.stringify(ISSUE_URL)});`);
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_')),
);
env.CLAUDE_PLUGIN_ROOT = pluginRoot;
// Empty npx cache, and offline: proves nothing is fetched from the registry.
env.npm_config_cache = join(scratch, 'npm-cache');
env.npm_config_offline = 'true';
env.PLUGIN_ADVISOR_CONFIG_DIR = config;
env.HOME = join(scratch, 'home');
env.PATH = `${ghBin}:${process.env.PATH ?? ''}`;

function skillText(): string {
  return readFileSync(join(pluginRoot, SKILL), 'utf8');
}

// Commands in the ```sh blocks of a skill: each starts at a line beginning with "npx " and, like the
// shell, continues over lines ending in an odd number of backslashes (only the "\" and the newline
// are removed), stopping at the closing fence (the last element of the split), so a dangling "\" there
// is kept. Mirrors npxLines in plugin-builder's check.ts; copied so this test stays standalone. Unlike
// npxLines, a block opens only at "```sh" + newline and ends at the next "```" anywhere in a line.
function shCommands(text: string): string[] {
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  const continues = (s: string): boolean => (/\\+$/.exec(s)?.[0].length ?? 0) % 2 === 1;
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    lines.forEach((line, index) => {
      let command = line.trim();
      if (!command.startsWith('npx ')) return;
      for (let next = index + 1; continues(command) && next < lines.length - 1; next++) {
        command = `${command.slice(0, -1)}${(lines[next] ?? '').trimEnd()}`;
      }
      out.push(command.trim());
    });
  }
  return out;
}

function skillCommands(): string[] {
  return shCommands(skillText());
}

function sh(command: string, input?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('sh', ['-c', command], { cwd, env, encoding: 'utf8', timeout: 60_000, ...(input === undefined ? {} : { input }) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const VALUES: Record<string, string> = {
  plugin: 'autologger-mcp',
  kind: 'workaround',
  summary: 'call list_events needed a retry after a 502',
  detail: 'retried once; worked',
};

/** Fills a skill line's `<placeholder>` values. */
function fill(command: string, signature: string): string {
  return command.replace(/<([a-z]+)>/g, (m, name: string) => (name === 'signature' ? signature : (VALUES[name] ?? m)));
}

test('the skill calls the CLI only through the shared npx invocation', () => {
  const commands = skillCommands();
  assert.ok(commands.length >= 8, `expected npx command lines in ${SKILL}`);
  for (const command of commands) assert.ok(command.startsWith(`${INVOCATION} `), command);
  for (const command of ['record', 'list', 'show', 'suggest', 'file', 'dismiss', '--help']) {
    assert.ok(commands.some((c) => c.startsWith(`${INVOCATION} ${command}`)), `the skill runs ${command}`);
  }
  assert.equal(existsSync(join(pluginRoot, 'node_modules')), false);
});

test('allowed-tools pre-approves record, list, show, suggest and --help, and never file or dismiss', () => {
  const line = /^allowed-tools: (.*)$/m.exec(skillText())?.[1] ?? '';
  const rules = [...line.matchAll(/Bash\((.*?):\*\)/g)].map((m) => m[1] ?? '');
  assert.deepEqual(
    rules,
    ['record', 'list', 'show', 'suggest', '--help'].map((c) => `${INVOCATION} ${c}`),
  );
});

test('every skill command line runs from a fresh copy, in order, and exits 0', () => {
  // One earlier occurrence, so the skill's two record lines bring the issue to the threshold (3).
  const seed = sh(`${INVOCATION} record --plugin autologger-mcp --kind workaround --summary "call list_events needed a retry after a 503" --json`);
  assert.equal(seed.status, 0, seed.stderr);
  const signature: string = JSON.parse(seed.stdout).signature;
  for (const line of skillCommands()) {
    const command = fill(line, signature);
    const { status, stdout, stderr } = sh(command);
    assert.equal(status, 0, `${command}\nstderr: ${stderr}`);
    assert.notEqual(stdout, '', command);
    if (command.endsWith(' --help')) assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
    if (command.includes(' --json')) {
      const value = JSON.parse(stdout);
      if (command.includes(' suggest ')) assert.equal(value.suggestions[0]?.signature, signature);
      if (command.includes(' file ') && !command.includes('--confirm')) assert.equal(value.dryRun, true);
      if (command.includes('--confirm')) assert.equal(value.url, ISSUE_URL);
      if (command.includes(' dismiss ')) assert.equal(value.dismissed, true);
    }
  }
  // The fake gh was called exactly once, by the --confirm line, with the body on stdin.
  const calls = readFileSync(join(scratch, 'gh-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].argv[3], 'kwcantrell/autologger-marketplace');
  assert.match(calls[0].stdin, /## Proposed change/);
});

test('the hook command from hooks/hooks.json records a failed marketplace CLI call from the fresh copy', () => {
  const hooks = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  const handler = hooks.hooks.PostToolUseFailure[0].hooks[0];
  const args: string[] = handler.args.map((a: string) => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot));
  const fixture = readFileSync(join(pluginRoot, 'test', 'fixtures', 'hook-npx-failure.json'), 'utf8');
  const r = spawnSync(handler.command, args, { cwd, env, input: fixture, encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  const list = sh(`${INVOCATION} list --plugin autologger-mcp --json`);
  const issues: Array<{ kind: string; summary: string }> = JSON.parse(list.stdout).issues;
  assert.ok(issues.some((i) => i.kind === 'cli-failure' && i.summary.startsWith('autologger-mcp call exited 1:')), list.stdout);
});

test('an unknown command through npx exits 2 with the message on stderr', () => {
  const { status, stdout, stderr } = sh(`${INVOCATION} no-such-command`);
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /unknown command 'no-such-command'/);
});

// Guard against `--package=""`: npm reads an empty spec as the registry package `undefined` (owned by a
// third party), and `--yes` would install and run it unprompted. `--offline` in the invocation must
// stop that before any request, even when npm itself is allowed online.
test('with CLAUDE_PLUGIN_ROOT empty, the invocation fails without contacting a registry', async () => {
  const requests: string[] = [];
  const registry = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = registry.address() as AddressInfo;
    const onlineEnv: NodeJS.ProcessEnv = {
      ...env,
      CLAUDE_PLUGIN_ROOT: '',
      npm_config_cache: join(scratch, 'npm-cache-empty-root'),
      npm_config_registry: `http://127.0.0.1:${port}/`,
      // npm's own version check also uses the registry; it is not what this test is about.
      npm_config_update_notifier: 'false',
    };
    delete onlineEnv.npm_config_offline;
    const child = spawn('sh', ['-c', `${INVOCATION} --help`], { cwd, env: onlineEnv });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.resume();
    const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.notEqual(status, 0);
    assert.equal(stdout, '');
    assert.deepEqual(requests, [], 'npx contacted the registry');
  } finally {
    registry.close();
  }
});
