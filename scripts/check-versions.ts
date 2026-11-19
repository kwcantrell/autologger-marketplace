// Usage: node scripts/check-versions.ts --base <rev> [--head <rev>] [--json]
// Fails when a plugin's files changed between <base> and <head> but its version did not go up.
// Claude Code's plugin cache is keyed by a plugin's version, so a change shipped without a bump is
// never picked up by `/plugin marketplace update`: users keep the stale cached copy.
//
// For every plugins/<name>/ with a file changed between the merge base of <base> and <head>, and
// <head>, the `version` in plugins/<name>/.claude-plugin/plugin.json at <head> must be a plain
// X.Y.Z greater than the one at the merge base, and a `version` in the plugin's package.json (if it
// has one) must equal it. A plugin that is new at <head> or removed by it passes. CI runs this on
// pull requests (base: the PR base) and pushes to main (base: the push's `before` SHA); a missing or
// all-zero <base> (a new branch) means <head>'s first parent. It is not part of `npm test`, so a
// working tree in the middle of a change is never failed by it.
// Exit codes: 0 every changed plugin is bumped (or none changed), 1 a plugin is not bumped or git
// failed, 2 usage error.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const NAME = 'check-versions';

const USAGE = `Usage: node scripts/check-versions.ts --base <rev> [--head <rev>] [--json]

Fails when a plugin's files (anything under plugins/<name>/) differ between the merge base of
<base> and <head>, and <head>, but plugins/<name>/.claude-plugin/plugin.json "version" was not
raised. A package.json "version" in the plugin must equal plugin.json's.

Options:
  --base <rev>  What to compare against: the PR base SHA, or a push's \`before\` SHA. Empty or
                all zeros (a new branch) means the first parent of <head>.
  --head <rev>  The revision to check (default HEAD).
  --json        Print the result as one JSON value.
  -h, --help    Show this help.

Exit codes: 0 every changed plugin is bumped, 1 a plugin is not bumped (or git failed), 2 usage error.`;

export class VersionError extends Error {
  readonly exitCode: 1 | 2;
  constructor(message: string, exitCode: 1 | 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

export type Status = 'bumped' | 'new' | 'removed' | 'not-bumped' | 'invalid';

export interface PluginResult {
  name: string;
  status: Status;
  /** The version at the merge base (null for a new plugin). */
  from: string | null;
  /** The version at head (null for a removed plugin). */
  to: string | null;
  /** Why the plugin fails, and what to do. */
  problem?: string;
}

export interface Result {
  ok: boolean;
  base: string;
  head: string;
  mergeBase: string;
  plugins: PluginResult[];
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new VersionError(`cannot run git: ${r.error.message}`, 1);
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr.trim() };
}

function resolve(cwd: string, rev: string, what: string): string {
  const r = git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
  if (!r.ok) throw new VersionError(`${what} '${rev}' is not a commit in this repository (with actions/checkout, set fetch-depth: 0)`, 1);
  return r.stdout.trim();
}

/** A file's text at a commit, or null when the commit has no such file. */
function show(cwd: string, commit: string, path: string): string | null {
  const r = git(cwd, ['cat-file', '-p', `${commit}:${path}`]);
  return r.ok ? r.stdout : null;
}

/** The `version` field of a JSON file at a commit: null when the file is missing, undefined when it has none. */
function versionAt(cwd: string, commit: string, path: string): string | null | undefined {
  const text = show(cwd, commit, path);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && 'version' in value) {
      const version = (value as { version: unknown }).version;
      return typeof version === 'string' ? version : JSON.stringify(version);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Compares two plain X.Y.Z versions; null when either is not one. */
export function compareVersions(a: string, b: string): number | null {
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** The plugin names with a file under plugins/<name>/ changed between two commits. */
export function changedPlugins(cwd: string, from: string, to: string): string[] {
  const r = git(cwd, ['diff', '--name-only', '-z', '--no-renames', from, to, '--', 'plugins/']);
  if (!r.ok) throw new VersionError(`git diff failed: ${r.stderr}`, 1);
  const names = new Set<string>();
  for (const path of r.stdout.split('\0')) {
    const parts = path.split('/');
    if (parts.length >= 3 && parts[0] === 'plugins' && parts[1]) names.add(parts[1]);
  }
  return [...names].sort();
}

export function checkVersions(cwd: string, baseRev: string, headRev = 'HEAD'): Result {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new VersionError(`not inside a git repository: ${cwd}`, 1);
  const root = top.stdout.trim();
  const head = resolve(root, headRev, '--head');
  let base: string;
  if (baseRev === '' || /^0+$/.test(baseRev)) {
    const parent = git(root, ['rev-parse', '--verify', '--quiet', `${head}^1`]);
    if (!parent.ok) return { ok: true, base: '', head, mergeBase: '', plugins: [] }; // a root commit: nothing to compare
    base = parent.stdout.trim();
  } else {
    base = resolve(root, baseRev, '--base');
  }
  const mb = git(root, ['merge-base', base, head]);
  if (!mb.ok) throw new VersionError(`${base} and ${head} have no common ancestor`, 1);
  const mergeBase = mb.stdout.trim();

  const plugins = changedPlugins(root, mergeBase, head).map((name): PluginResult => {
    const manifest = `plugins/${name}/.claude-plugin/plugin.json`;
    const from = versionAt(root, mergeBase, manifest);
    const to = versionAt(root, head, manifest);
    const stillThere = git(root, ['ls-tree', '-r', '--name-only', head, '--', `plugins/${name}/`]).stdout.trim() !== '';
    if (!stillThere) return { name, status: 'removed', from: from ?? null, to: null };
    if (to === null || to === undefined || SEMVER.exec(to) === null) {
      return {
        name,
        status: 'invalid',
        from: from ?? null,
        to: to ?? null,
        problem: `${manifest} has ${to === null ? 'no file' : to === undefined ? 'no "version"' : `version ${JSON.stringify(to)}`}; give it a plain X.Y.Z "version"`,
      };
    }
    const pkgVersion = versionAt(root, head, `plugins/${name}/package.json`);
    if (typeof pkgVersion === 'string' && pkgVersion !== to) {
      return { name, status: 'invalid', from: from ?? null, to, problem: `plugins/${name}/package.json "version" is ${pkgVersion} but plugin.json's is ${to}; set both to the same version` };
    }
    if (from === null) return { name, status: 'new', from: null, to };
    const cmp = from === undefined ? null : compareVersions(to, from);
    // A base with no readable X.Y.Z version (an old manifest) passes once head has a different, valid one.
    if ((cmp !== null && cmp > 0) || (cmp === null && from !== to)) return { name, status: 'bumped', from: from ?? null, to };
    return {
      name,
      status: 'not-bumped',
      from: from ?? null,
      to,
      problem: `files under plugins/${name}/ changed but its version went from ${from ?? 'none'} to ${to}; raise "version" in ${manifest} (and package.json), e.g. a minor bump`,
    };
  });
  return { ok: plugins.every((p) => p.problem === undefined), base, head, mergeBase, plugins };
}

export function formatResult(result: Result): string {
  if (result.plugins.length === 0) return 'No plugin files changed.';
  return result.plugins.map((p) => `${p.name}: ${p.status}${p.from || p.to ? ` (${p.from ?? '-'} -> ${p.to ?? '-'})` : ''}`).join('\n');
}

export function main(argv: string[], cwd = process.cwd()): { code: number; stdout: string; stderr: string } {
  try {
    let values;
    try {
      ({ values } = parseArgs({
        args: argv,
        options: { base: { type: 'string' }, head: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
        strict: true,
        allowPositionals: false,
      }));
    } catch (error) {
      throw new VersionError((error as Error).message, 2);
    }
    if (values.help) return { code: 0, stdout: `${USAGE}\n`, stderr: '' };
    if (values.base === undefined) throw new VersionError('--base <rev> is required (it may be empty for a new branch)', 2);
    if (values.head === '') throw new VersionError('--head must not be empty', 2);
    const result = checkVersions(cwd, values.base, values.head ?? 'HEAD');
    if (!result.ok) {
      const lines = result.plugins.filter((p) => p.problem !== undefined).map((p) => `${NAME}: ${p.name}: ${p.problem}`);
      return { code: 1, stdout: '', stderr: `${lines.join('\n')}\n` };
    }
    return { code: 0, stdout: `${values.json ? JSON.stringify(result) : formatResult(result)}\n`, stderr: '' };
  } catch (error) {
    const code = error instanceof VersionError ? error.exitCode : 1;
    return { code, stdout: '', stderr: `${NAME}: ${(error as Error).message}\n${code === 2 ? 'Run with --help for usage.\n' : ''}` };
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const result = main(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
