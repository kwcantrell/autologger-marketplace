// End to end: runs the exact npx command lines from every skill, the way Claude Code would after
// installing the plugin (a fresh copy, no npm install or build step), from inside a fixture
// autologger checkout that is unrelated to the plugin's folder.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixture.ts';
import type { Fixture } from './fixture.ts';

const CLI_NAME = 'autologger-specs';
const INVOCATION = `npx --yes --offline --loglevel=error --package="\${CLAUDE_PLUGIN_ROOT}" -- ${CLI_NAME}`;
const ALLOWED_TOOLS = `allowed-tools: Bash(${INVOCATION}:*)`;

// Skill command lines name their arguments as placeholders; the test fills them with fixture values.
const PLACEHOLDERS: Record<string, string> = {
  '<path>': 'src/shared.ts',
  '<name>': 'gamma-ray',
  '<glob>': 'src/other.ts',
};

const source = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), `${CLI_NAME}-e2e-`));
const fixtures: Fixture[] = [];
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const f of fixtures) f.cleanup();
});

// Simulate the plugin cache: Claude Code installs a plugin by copying its folder.
const pluginRoot = join(scratch, 'plugin cache', CLI_NAME);
cpSync(source, pluginRoot, { recursive: true, filter: (path) => !path.includes('node_modules') });
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_') && key !== 'FAKE_GATE_EXIT'),
);
env.CLAUDE_PLUGIN_ROOT = pluginRoot;
// Empty npx cache, and offline: proves nothing is fetched from the registry.
env.npm_config_cache = join(scratch, 'npm-cache');
env.npm_config_offline = 'true';

const skills = readdirSync(join(pluginRoot, 'skills'));

function skillText(skill: string): string {
  return readFileSync(join(pluginRoot, 'skills', skill, 'SKILL.md'), 'utf8');
}

// Commands in the ```sh blocks of a skill: each starts at a line beginning with "npx " and, like the
// shell, continues over lines ending in an odd number of backslashes (only the "\" and the newline
// are removed). Mirrors npxLines in plugin-builder's check.ts; copied so this test stays standalone.
function shCommands(text: string): string[] {
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  const continues = (s: string): boolean => (/\\+$/.exec(s)?.[0].length ?? 0) % 2 === 1;
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    lines.forEach((line, index) => {
      let command = line.trim();
      if (!command.startsWith('npx ')) return;
      for (let next = index + 1; continues(command) && next < lines.length; next++) {
        command = `${command.slice(0, -1)}${(lines[next] ?? '').trimEnd()}`;
      }
      out.push(command.trim());
    });
  }
  return out;
}

function skillCommands(skill: string): string[] {
  return shCommands(skillText(skill));
}

function fill(command: string): string {
  let out = command;
  for (const [placeholder, value] of Object.entries(PLACEHOLDERS)) out = out.replaceAll(placeholder, value);
  assert.doesNotMatch(out, /<[a-z-]+>/, `unknown placeholder in: ${command}`);
  return out;
}

function sh(command: string, cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('sh', ['-c', command], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function checkout(): Fixture {
  const f = fixture();
  fixtures.push(f);
  return f;
}

test('there are the two skills, and each calls the CLI only through the shared npx invocation', () => {
  assert.deepEqual(skills.sort(), ['autologger-new-spec', 'autologger-specs']);
  for (const skill of skills) {
    const text = skillText(skill);
    assert.match(text, new RegExp(`^---\\nname: ${skill}\\n`), `${skill}: frontmatter name`);
    assert.ok(text.includes(`\n${ALLOWED_TOOLS}\n`), `${skill}: allowed-tools`);
    const commands = skillCommands(skill);
    assert.ok(commands.length >= 2, `expected npx command lines in ${skill}`);
    for (const command of commands) assert.ok(command.startsWith(`${INVOCATION} `), command);
    // Every npx line in the skill is inside a sh block, so the tests below run all of them.
    const allNpxLines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('npx '));
    assert.deepEqual(allNpxLines, commands);
  }
  assert.equal(existsSync(join(pluginRoot, 'node_modules')), false);
});

test('autologger-specs skill: every command line runs from a fresh copy inside a checkout and exits 0', () => {
  const f = checkout();
  const commands = skillCommands('autologger-specs');
  assert.deepEqual(commands.map((c) => c.slice(INVOCATION.length + 1).split(' ')[0]), ['stale', 'gate', 'which', 'lint', '--help']);
  for (const command of commands.map(fill)) {
    const { status, stdout, stderr } = sh(command, f.root);
    assert.equal(status, 0, `${command}\nstderr: ${stderr}`);
    if (command.endsWith(' --help')) assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
    if (command.includes(' --json')) {
      const value = JSON.parse(stdout);
      if (command.includes(' which ')) assert.deepEqual(value, { 'src/shared.ts': ['alpha', 'beta'] });
      if (command.includes(' stale ')) assert.deepEqual(value.stale, []);
    }
  }
});

test('autologger-new-spec skill: which, new, (add the entry), lint, gate all exit 0 in order', () => {
  const f = checkout();
  const commands = skillCommands('autologger-new-spec');
  assert.deepEqual(commands.map((c) => c.slice(INVOCATION.length + 1).split(' ')[0]), ['which', 'new', 'lint', 'gate']);
  for (const command of commands.map(fill)) {
    const { status, stdout, stderr } = sh(command, f.root);
    assert.equal(status, 0, `${command}\nstderr: ${stderr}`);
    const value = JSON.parse(stdout);
    if (command.includes(' new ')) {
      assert.equal(value.file, 'docs/specs/gamma-ray.md');
      assert.deepEqual(value.unmatched, []);
      // The step the skill gives Claude: add the printed entry under lifecycle.spec_paths.
      appendFileSync(join(f.root, 'scripts/lifecycle.yaml'), value.entry);
    }
    if (command.includes(' lint ')) assert.deepEqual(value, { specs: ['gamma-ray'], problems: [] });
  }
});

test('npx keeps the current directory: paths are relative to a subdirectory of the checkout', () => {
  const f = checkout();
  const { status, stdout, stderr } = sh(`${INVOCATION} which --json shared.ts alpha/a.ts`, join(f.root, 'src'));
  assert.equal(status, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { 'src/shared.ts': ['alpha', 'beta'], 'src/alpha/a.ts': ['alpha'] });
});

test('stale through npx: exit 1, stdout empty, the stale specs on stderr', () => {
  const f = checkout();
  writeFileSync(join(f.root, 'src/alpha/a.ts'), 'changed\n');
  const { status, stdout, stderr } = sh(`${INVOCATION} stale --json`, f.root);
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /^autologger-specs: 1 spec\(s\) not updated/);
  assert.match(stderr, /^docs\/specs\/alpha\.md not changed, but its spec_paths cover: src\/alpha\/a\.ts$/m);
});

test('outside an autologger checkout through npx: exit 2 with the message on stderr', () => {
  const cwd = join(scratch, 'unrelated-cwd');
  mkdirSync(cwd, { recursive: true });
  const { status, stdout, stderr } = sh(`${INVOCATION} stale --json`, cwd);
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /^autologger-specs: not inside a git checkout/);
});

test('an unknown command through npx exits 2 with the message on stderr', () => {
  const { status, stdout, stderr } = sh(`${INVOCATION} no-such-command`, scratch);
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
    const child = spawn('sh', ['-c', `${INVOCATION} --help`], { cwd: scratch, env: onlineEnv });
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
