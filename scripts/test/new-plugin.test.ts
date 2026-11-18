import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ScaffoldError, scaffold, TEMPLATE_TOKEN, validateName } from '../new-plugin.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const script = join(repo, 'scripts', 'new-plugin.ts');
const scratch = mkdtempSync(join(tmpdir(), 'new-plugin-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let fixtures = 0;
/** A throwaway copy of the parts of the repo the scaffold reads and writes. */
function fixtureRoot(): string {
  const root = join(scratch, `repo-${fixtures++}`);
  cpSync(join(repo, 'templates', 'plugin'), join(root, 'templates', 'plugin'), {
    recursive: true,
    filter: (path) => !path.includes('node_modules'),
  });
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  // Start from the real manifest with no plugins, whatever plugins the repo has.
  const manifest = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'marketplace.json'), 'utf8'));
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({ ...manifest, plugins: [] }));
  return root;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((p) => join(dir, p));
}

function marketplace(root: string): { plugins: { name: string; source: string; description?: string }[] } {
  return JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
}

function runScript(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

test('scaffold copies the template and renames plugin, skill and bin', () => {
  const root = fixtureRoot();
  const target = scaffold(root, 'log-tools', 'Tools for logs.');
  assert.equal(target, join(root, 'plugins', 'log-tools'));

  for (const path of walk(target)) {
    assert.ok(!path.includes(TEMPLATE_TOKEN), `path still has the template token: ${path}`);
    if (statSync(path).isFile()) {
      assert.ok(!readFileSync(path, 'utf8').includes(TEMPLATE_TOKEN), `file still has the template token: ${path}`);
    }
  }
  const manifest = JSON.parse(readFileSync(join(target, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'log-tools');
  assert.equal(manifest.description, 'Tools for logs.');
  const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'log-tools');
  assert.deepEqual(pkg.bin, { 'log-tools': 'src/cli.ts' });
  const skill = readFileSync(join(target, 'skills', 'log-tools', 'SKILL.md'), 'utf8');
  assert.match(skill, /^name: log-tools$/m);
  assert.match(skill, /--package="\$\{CLAUDE_PLUGIN_ROOT\}" -- log-tools hello --json/);
  assert.match(readFileSync(join(target, 'src', 'run.ts'), 'utf8'), /CLI_NAME = 'log-tools'/);

  assert.deepEqual(marketplace(root).plugins, [
    { name: 'log-tools', source: './plugins/log-tools', description: 'Tools for logs.' },
  ]);
  // The template itself is untouched.
  assert.ok(existsSync(join(root, 'templates', 'plugin', 'skills', TEMPLATE_TOKEN, 'SKILL.md')));
});

test('the scaffolded CLI runs and keeps its new name', () => {
  const root = fixtureRoot();
  const target = scaffold(root, 'demo-cli');
  const result = spawnSync(process.execPath, [join(target, 'src', 'cli.ts'), 'nope'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^demo-cli: unknown command 'nope'/);
  assert.equal(marketplace(root).plugins[0]?.description, 'demo-cli: TODO describe what this plugin does.');
});

test('scaffold refuses a name that already exists', () => {
  const root = fixtureRoot();
  scaffold(root, 'taken');
  assert.throws(() => scaffold(root, 'taken'), (e: unknown) => e instanceof ScaffoldError && e.exitCode === 1);
  assert.equal(marketplace(root).plugins.length, 1);
});

test('scaffold refuses a name already listed in marketplace.json', () => {
  const root = fixtureRoot();
  scaffold(root, 'listed');
  rmSync(join(root, 'plugins', 'listed'), { recursive: true });
  assert.throws(() => scaffold(root, 'listed'), /already lists/);
  assert.equal(existsSync(join(root, 'plugins', 'listed')), false);
});

for (const bad of ['', 'Foo', 'foo_bar', 'foo--bar', '-foo', 'foo-', '1foo', 'foo bar', '../x', 'a'.repeat(65), TEMPLATE_TOKEN]) {
  test(`validateName rejects ${JSON.stringify(bad)}`, () => {
    assert.throws(() => validateName(bad), (e: unknown) => e instanceof ScaffoldError && e.exitCode === 2);
  });
}

for (const good of ['a', 'log-tools', 'v2-api', 'autologger-dev']) {
  test(`validateName accepts ${good}`, () => validateName(good));
}

test('CLI: creates a plugin and exits 0', () => {
  const root = fixtureRoot();
  const result = runScript('cli-made', '--root', root, '--description', 'Made by the CLI.');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Created .*plugins\/cli-made/);
  assert.equal(marketplace(root).plugins[0]?.name, 'cli-made');
});

test('CLI: refuses an existing name with exit 1 and leaves the repo unchanged', () => {
  const root = fixtureRoot();
  assert.equal(runScript('dup', '--root', root).status, 0);
  const before = readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8');
  const result = runScript('dup', '--root', root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists/);
  assert.equal(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'), before);
});

test('CLI: refuses a non-kebab-case name with exit 2 and writes nothing', () => {
  const root = fixtureRoot();
  const result = runScript('Not_Kebab', '--root', root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /kebab-case/);
  assert.equal(existsSync(join(root, 'plugins')), false);
});

test('CLI: missing name is a usage error', () => {
  const result = runScript();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: npm run new-plugin/);
});
