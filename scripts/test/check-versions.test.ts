// check-versions against throwaway git repos in a temp dir: a plugin change without a bump fails,
// with one passes, and the push/PR base forms CI passes (a merge base, an all-zero `before`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkVersions, compareVersions, main } from '../check-versions.ts';

const SCRIPT = fileURLToPath(new URL('../check-versions.ts', import.meta.url));
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// Git without the user's or the system's config, so a global hook or signing setting cannot interfere.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function git(repo: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(repo: string, path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

function setVersion(repo: string, name: string, version: string, pkgVersion: string | null = version): void {
  write(repo, `plugins/${name}/.claude-plugin/plugin.json`, `${JSON.stringify({ name, version, description: 'x' }, null, 2)}\n`);
  write(repo, `plugins/${name}/package.json`, `${JSON.stringify({ name, ...(pkgVersion === null ? {} : { version: pkgVersion }), private: true }, null, 2)}\n`);
}

function commit(repo: string, message: string): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** A repo whose main has two plugins at 0.1.0 (alpha, beta) and a README; returns the repo and the commit. */
function repo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'check-versions-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'README.md', 'repo\n');
  for (const name of ['alpha', 'beta']) {
    setVersion(dir, name, '0.1.0');
    write(dir, `plugins/${name}/src/cli.ts`, '// v1\n');
  }
  return { dir, base: commit(dir, 'initial') };
}

const statuses = (dir: string, base: string) => Object.fromEntries(checkVersions(dir, base).plugins.map((p) => [p.name, p.status]));

test('a plugin file changed without a version bump fails, with the plugin named and the fix', () => {
  const { dir, base } = repo();
  write(dir, 'plugins/alpha/src/cli.ts', '// v2\n');
  commit(dir, 'change alpha');
  const r = main(['--base', base], dir);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^check-versions: alpha: files under plugins\/alpha\/ changed but its version went from 0\.1\.0 to 0\.1\.0; raise "version"/);
  assert.doesNotMatch(r.stderr, /beta/);
});

test('the same change with plugin.json and package.json raised passes; an untouched plugin is not listed', () => {
  const { dir, base } = repo();
  write(dir, 'plugins/alpha/src/cli.ts', '// v2\n');
  setVersion(dir, 'alpha', '0.2.0');
  commit(dir, 'change alpha, bump');
  const r = main(['--base', base, '--json'], dir);
  assert.equal(r.code, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.ok, true);
  assert.deepEqual(result.plugins, [{ name: 'alpha', status: 'bumped', from: '0.1.0', to: '0.2.0' }]);
});

test('a docs-only change inside a plugin also needs a bump (no escape hatch)', () => {
  const { dir, base } = repo();
  write(dir, 'plugins/beta/README.md', 'docs\n');
  commit(dir, 'docs');
  assert.deepEqual(statuses(dir, base), { beta: 'not-bumped' });
});

test('changes outside plugins/ need no bump', () => {
  const { dir, base } = repo();
  write(dir, 'README.md', 'changed\n');
  write(dir, 'scripts/x.ts', '// x\n');
  commit(dir, 'root only');
  const r = main(['--base', base], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'No plugin files changed.\n');
});

test('a lower or non-X.Y.Z version fails; a patch or major raise passes', () => {
  const { dir, base } = repo();
  write(dir, 'plugins/alpha/src/cli.ts', '// v2\n');
  setVersion(dir, 'alpha', '0.0.9');
  write(dir, 'plugins/beta/src/cli.ts', '// v2\n');
  setVersion(dir, 'beta', 'v0.2');
  commit(dir, 'bad versions');
  assert.deepEqual(statuses(dir, base), { alpha: 'not-bumped', beta: 'invalid' });
  setVersion(dir, 'alpha', '0.1.1');
  setVersion(dir, 'beta', '1.0.0');
  commit(dir, 'good versions');
  assert.deepEqual(statuses(dir, base), { alpha: 'bumped', beta: 'bumped' });
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0', '1.0.0'), null);
});

test('package.json out of step with plugin.json fails; a package.json without a version is fine', () => {
  const { dir, base } = repo();
  write(dir, 'plugins/alpha/src/cli.ts', '// v2\n');
  setVersion(dir, 'alpha', '0.2.0', '0.1.0');
  write(dir, 'plugins/beta/src/cli.ts', '// v2\n');
  setVersion(dir, 'beta', '0.2.0', null);
  commit(dir, 'bump');
  const r = main(['--base', base], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /alpha: plugins\/alpha\/package\.json "version" is 0\.1\.0 but plugin\.json's is 0\.2\.0/);
  assert.doesNotMatch(r.stderr, /beta/);
});

test('a new plugin and a removed plugin pass', () => {
  const { dir, base } = repo();
  setVersion(dir, 'gamma', '0.1.0');
  rmSync(join(dir, 'plugins', 'beta'), { recursive: true });
  commit(dir, 'add gamma, remove beta');
  assert.deepEqual(statuses(dir, base), { beta: 'removed', gamma: 'new' });
});

test('a PR compares from the merge base: a bump on main after the branch point is not the branch\'s bump', () => {
  const { dir, base } = repo();
  git(dir, 'checkout', '-q', '-b', 'feature');
  write(dir, 'plugins/alpha/src/cli.ts', '// feature\n');
  const feature = commit(dir, 'feature changes alpha');
  git(dir, 'checkout', '-q', 'main');
  setVersion(dir, 'beta', '0.2.0');
  write(dir, 'plugins/beta/src/cli.ts', '// main\n');
  const mainTip = commit(dir, 'main bumps beta');
  // As in CI for a pull request: --base is the PR base SHA, HEAD is the PR head.
  const result = checkVersions(dir, mainTip, feature);
  assert.equal(result.mergeBase, base);
  assert.deepEqual(result.plugins.map((p) => [p.name, p.status]), [['alpha', 'not-bumped']]);
});

test('a push compares against its before SHA, over every commit in the push', () => {
  const { dir, base } = repo();
  setVersion(dir, 'alpha', '0.2.0');
  commit(dir, 'bump alpha first');
  write(dir, 'plugins/alpha/src/cli.ts', '// v2\n');
  write(dir, 'plugins/beta/src/cli.ts', '// v2\n');
  commit(dir, 'then change both');
  assert.deepEqual(statuses(dir, base), { alpha: 'bumped', beta: 'not-bumped' });
});

test('an empty or all-zero base (a new branch) means the first parent of head; a root commit passes', () => {
  const { dir, base } = repo();
  assert.deepEqual(checkVersions(dir, '0000000000000000000000000000000000000000').plugins, []);
  write(dir, 'plugins/alpha/src/cli.ts', '// v2\n');
  commit(dir, 'change alpha');
  for (const zero of ['', '0000000000000000000000000000000000000000']) {
    const result = checkVersions(dir, zero);
    assert.equal(result.base, base);
    assert.deepEqual(result.plugins.map((p) => p.status), ['not-bumped']);
  }
});

test('usage and git errors: no --base is exit 2, an unknown base is exit 1', () => {
  const { dir } = repo();
  const missing = main([], dir);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--base <rev> is required/);
  assert.equal(main(['--bogus'], dir).code, 2);
  const unknown = main(['--base', 'deadbeef'.repeat(5)], dir);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /--base '[0-9a-f]+' is not a commit in this repository \(with actions\/checkout, set fetch-depth: 0\)/);
  assert.equal(unknown.stdout, '');
  const help = main(['--help'], dir);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: node scripts\/check-versions\.ts/);
});

test('run as a script from inside the repo: exit status and streams', () => {
  const { dir, base } = repo();
  write(dir, 'plugins/alpha/src/cli.ts', '// v2\n');
  commit(dir, 'change alpha');
  const failed = spawnSync(process.execPath, [SCRIPT, '--base', base], { cwd: join(dir, 'plugins'), encoding: 'utf8', env: GIT_ENV });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /^check-versions: alpha: /);
  setVersion(dir, 'alpha', '0.2.0');
  commit(dir, 'bump');
  const passed = spawnSync(process.execPath, [SCRIPT, '--base', base], { cwd: dir, encoding: 'utf8', env: GIT_ENV });
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stdout, 'alpha: bumped (0.1.0 -> 0.2.0)\n');
});
