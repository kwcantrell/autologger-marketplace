// End to end: runs the exact npx command lines from the skill, the way Claude Code would after
// installing the plugin (a fresh copy, unrelated cwd, no npm install or build step).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI_NAME = 'plugin-template';
const SKILL = 'skills/plugin-template/SKILL.md';
const INVOCATION = `npx --yes --loglevel=error --package="\${CLAUDE_PLUGIN_ROOT}" -- ${CLI_NAME}`;

const source = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), `${CLI_NAME}-e2e-`));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Simulate the plugin cache: Claude Code installs a plugin by copying its folder.
const pluginRoot = join(scratch, 'plugin-cache', CLI_NAME);
cpSync(source, pluginRoot, { recursive: true, filter: (path) => !path.includes('node_modules') });
const cwd = join(scratch, 'unrelated-cwd');
mkdirSync(cwd);
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_')),
);
env.CLAUDE_PLUGIN_ROOT = pluginRoot;
// Empty npx cache, and offline: proves nothing is fetched from the registry.
env.npm_config_cache = join(scratch, 'npm-cache');
env.npm_config_offline = 'true';

function skillCommands(): string[] {
  const text = readFileSync(join(pluginRoot, SKILL), 'utf8');
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  return blocks.flatMap((b) => b.split('\n')).filter((line) => line.startsWith('npx '));
}

function sh(command: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('sh', ['-c', command], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('the skill calls the CLI only through the shared npx invocation', () => {
  const commands = skillCommands();
  assert.ok(commands.length >= 2, `expected npx command lines in ${SKILL}`);
  for (const command of commands) assert.ok(command.startsWith(`${INVOCATION} `), command);
  assert.equal(existsSync(join(pluginRoot, 'node_modules')), false);
});

test('every skill command line runs from a fresh copy and exits 0', () => {
  for (const command of skillCommands()) {
    const { status, stdout, stderr } = sh(command);
    assert.equal(status, 0, `${command}\nstderr: ${stderr}`);
    assert.notEqual(stdout, '', command);
    if (command.endsWith(' --help')) assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
    if (command.includes(' --json')) JSON.parse(stdout);
  }
});

test('hello --json through npx prints the greeting as JSON', () => {
  const { status, stdout } = sh(`${INVOCATION} hello --json "Ada Lovelace"`);
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stdout), { greeting: 'Hello, Ada Lovelace!' });
});

test('an unknown command through npx exits 2 with the message on stderr', () => {
  const { status, stdout, stderr } = sh(`${INVOCATION} no-such-command`);
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /unknown command 'no-such-command'/);
});
