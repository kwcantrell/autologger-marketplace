// which / stale / lint / new: the logic of autologger's `specs` and `specs-with-code` gates
// (scripts/lib/check_change.py), as plain functions over a checkout.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { byCodePoint, globRe, matches } from './glob.ts';
import { CommandError, SPECS_DIR, git, gitZ, loadLifecycle, loadLifecycleAt, specPathMap, stringList, tracked } from './repo.ts';
import type { Repo } from './repo.ts';
import { isYamlMap, parseYaml } from './yaml.ts';

/** Exit 2 from a command: bad arguments. */
export class ArgumentError extends Error {}

export const SPEC_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const SPEC_NAME_MAX = 64;

export function specFile(name: string): string {
  return `${SPECS_DIR}/${name}.md`;
}

// ---------------------------------------------------------------- which

/**
 * A path argument as a repo-relative POSIX path. Absolute paths are taken as they are; relative ones
 * are resolved against the current directory when it is inside the checkout, else against the root.
 */
export function repoPath(repo: Repo, path: string): string {
  const cwdInside = !relative(repo.root, repo.cwd).startsWith('..') && !isAbsolute(relative(repo.root, repo.cwd));
  const abs = isAbsolute(path) ? path : resolve(cwdInside ? repo.cwd : repo.root, path);
  const rel = relative(repo.root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ArgumentError(`${path} is not inside the checkout ${repo.root}`);
  }
  return rel.split(sep).join('/');
}

/** Spec names whose working-tree `spec_paths` globs match each path. */
export function which(repo: Repo, paths: readonly string[]): Record<string, string[]> {
  const map = specPathMap(loadLifecycle(repo.root));
  const out: Record<string, string[]> = {};
  for (const arg of paths) {
    const path = repoPath(repo, arg);
    out[path] = [...map].filter(([, globs]) => matches(path, globs)).map(([name]) => name).sort(byCodePoint);
  }
  return out;
}

// ---------------------------------------------------------------- stale

export interface StaleSpec {
  spec: string;
  file: string;
  covered: string[];
}

export interface StaleResult {
  base: string | null; // merge-base commit
  baseRef: string | null; // the ref it was resolved from
  mapFrom: 'base' | 'working-tree';
  active: boolean; // false when spec_paths is empty: the gate is not active
  changed: number;
  checked: number; // changed files that are not tests or managed paths
  stale: StaleSpec[];
}

function verifies(root: string, ref: string): boolean {
  return git(root, ['rev-parse', '--verify', '-q', ref], true).ok;
}

function mergeBase(root: string, ref: string): string {
  return git(root, ['merge-base', ref, 'HEAD'], true).stdout.trim();
}

/**
 * `resolve_base`: the merge-base of HEAD with origin/$GITHUB_BASE_REF, origin/main or main. An
 * explicit --base must resolve (check_change.py would silently fall back to the defaults instead).
 */
export function resolveBase(root: string, explicit?: string): { base: string; ref: string } | null {
  if (explicit !== undefined) {
    if (!verifies(root, explicit)) throw new CommandError(`--base ${explicit}: not a known ref`);
    const base = mergeBase(root, explicit);
    if (!base) throw new CommandError(`--base ${explicit}: no merge-base with HEAD`);
    return { base, ref: explicit };
  }
  const candidates: string[] = [];
  if (process.env.GITHUB_BASE_REF) candidates.push(`origin/${process.env.GITHUB_BASE_REF}`);
  candidates.push('origin/main', 'main');
  for (const ref of candidates) {
    if (verifies(root, ref)) {
      const base = mergeBase(root, ref);
      if (base) return { base, ref };
    }
  }
  return null;
}

/** `changed_files`: diff against the base (or everything tracked), plus staged and untracked files. */
export function changedFiles(root: string, base: string | null): string[] {
  const files = new Set<string>(
    base ? gitZ(root, ['diff', '--name-only', '--no-renames', '-z', base]) : gitZ(root, ['ls-files', '-z']),
  );
  for (const f of gitZ(root, ['diff', '--name-only', '--no-renames', '-z', '--cached'])) files.add(f);
  for (const f of gitZ(root, ['ls-files', '--others', '--exclude-standard', '-z'])) files.add(f);
  return [...files].sort(byCodePoint);
}

/** `check_specs_with_code` without PR overrides: specs whose covered files changed while they did not. */
export function stale(repo: Repo, explicitBase?: string): StaleResult {
  const resolved = resolveBase(repo.root, explicitBase);
  const baseCfg = resolved ? loadLifecycleAt(repo.root, resolved.base) : null;
  const cfg = baseCfg ?? loadLifecycle(repo.root);
  const map = specPathMap(cfg);
  const changed = changedFiles(repo.root, resolved?.base ?? null);
  const testGlobs = stringList(cfg, 'test_globs');
  const managed = stringList(cfg, 'managed_paths');
  const changedSet = new Set(changed);
  const source = changed.filter((f) => !matches(f, testGlobs) && !matches(f, managed));
  const result: StaleResult = {
    base: resolved?.base ?? null,
    baseRef: resolved?.ref ?? null,
    mapFrom: baseCfg ? 'base' : 'working-tree',
    active: map.size > 0,
    changed: changed.length,
    checked: source.length,
    stale: [],
  };
  for (const name of [...map.keys()].sort(byCodePoint)) {
    const file = specFile(name);
    const globs = map.get(name) ?? [];
    const covered = source.filter((f) => f !== file && matches(f, globs));
    if (covered.length > 0 && !changedSet.has(file)) result.stale.push({ spec: name, file, covered });
  }
  return result;
}

// ---------------------------------------------------------------- lint

export interface LintResult {
  specs: string[];
  problems: string[];
}

function readSpecText(path: string): string {
  // Python's read_text() uses universal newlines.
  return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
}

/** The `specs` gate's shape problems for one spec's text, plus any Requirement without a Scenario. */
export function shapeProblems(rel: string, text: string): string[] {
  const missing: string[] = [];
  if (!text.startsWith('# ')) missing.push('a `# ` title on the first line');
  const purpose = /^## Purpose[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text);
  if (!purpose) missing.push('a `## Purpose` section');
  else if ((purpose[1] ?? '').trim() === '') missing.push('text under `## Purpose`');
  if (!/^### Requirement:/m.test(text)) missing.push('a `### Requirement:` heading');
  const problems = missing.length ? [`${rel}: missing ${missing.join(', ')}`] : [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.startsWith('### Requirement:')) continue;
    let hasScenario = false;
    for (let j = i + 1; j < lines.length && !/^#{1,3} /.test(lines[j] ?? ''); j++) {
      if ((lines[j] ?? '').startsWith('#### Scenario:')) hasScenario = true;
    }
    if (!hasScenario) problems.push(`${rel}:${i + 1}: \`${line.trim()}\` has no \`#### Scenario:\``);
  }
  return problems;
}

function specNames(root: string): string[] {
  const dir = join(root, SPECS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md' && statSync(join(dir, f)).isFile())
    .map((f) => f.slice(0, -'.md'.length))
    .sort(byCodePoint);
}

/** A spec argument (`name`, `name.md` or `docs/specs/name.md`) as its name. */
export function specArg(arg: string): string {
  const base = arg.replace(/\\/g, '/').split('/').pop() ?? arg;
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

/**
 * `check_specs` + `spec_map_problems` from the working tree, plus a `#### Scenario:` check. With names,
 * only those specs and their map entries are checked.
 */
export function lint(repo: Repo, names: readonly string[] = []): LintResult {
  const all = specNames(repo.root);
  const only = names.length ? [...new Set(names.map(specArg))] : null;
  const problems: string[] = [];
  if (!only && all.length === 0) return { specs: [], problems: [`no specs in ${SPECS_DIR}/`] };
  const specs = only ?? all;
  const existing = new Set(all);
  for (const name of specs) {
    const rel = specFile(name);
    if (!existing.has(name)) {
      problems.push(`${rel} does not exist`);
      continue;
    }
    problems.push(...shapeProblems(rel, readSpecText(join(repo.root, rel))));
  }
  problems.push(...mapProblems(repo, existing, only));
  return { specs, problems };
}

function mapProblems(repo: Repo, specNamesOnDisk: Set<string>, only: string[] | null): string[] {
  const raw = loadLifecycle(repo.root).spec_paths;
  if (raw !== null && raw !== undefined && !isYamlMap(raw)) {
    return ['lifecycle.spec_paths must be a mapping of spec name to a list of globs'];
  }
  const map = isYamlMap(raw) ? raw : {};
  const inScope = (name: string) => only === null || only.includes(name);
  const problems: string[] = [];
  for (const n of [...specNamesOnDisk].sort(byCodePoint)) {
    if (inScope(n) && !(n in map)) problems.push(`${specFile(n)} has no lifecycle.spec_paths entry`);
  }
  for (const n of Object.keys(map).sort(byCodePoint)) {
    if (inScope(n) && !specNamesOnDisk.has(n)) {
      problems.push(`lifecycle.spec_paths.${n} names a spec that doesn't exist (no ${specFile(n)})`);
    }
  }
  const files = tracked(repo.root);
  for (const name of Object.keys(map).sort(byCodePoint)) {
    if (!inScope(name)) continue;
    const globs = map[name];
    if (!Array.isArray(globs) || globs.length === 0 || !globs.every((g) => typeof g === 'string')) {
      problems.push(`lifecycle.spec_paths.${name} must be a non-empty list of globs`);
      continue;
    }
    for (const g of globs as string[]) {
      const re = globRe(g);
      if (!files.some((f) => re.test(f))) problems.push(`lifecycle.spec_paths.${name}: \`${g}\` matches no tracked file`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- new

export interface NewSpecResult {
  file: string;
  entry: string; // the YAML to add under lifecycle.spec_paths in scripts/lifecycle.yaml
  covers: string[];
  unmatched: string[]; // --covers globs that match no tracked file (the specs gate would fail)
  mapped: boolean; // spec_paths already has an entry for this name
}

export const PLACEHOLDER_GLOB = 'path/to/covered/source/**';

export function specTemplate(name: string): string {
  return `# ${name} Specification

## Purpose
TODO: say what the ${name} capability does and why it exists, in a sentence or two.

## Requirements

### Requirement: TODO name the first requirement

TODO: state the behavior the system SHALL have.

#### Scenario: TODO name a scenario

- **WHEN** TODO the action or state that triggers the behavior
- **THEN** TODO the observable outcome
`;
}

/** A glob as a YAML list item that reads back as exactly that string. */
export function yamlScalar(text: string): string {
  let plainOk = false;
  try {
    const parsed = parseYaml(`- ${text}\n`);
    plainOk = Array.isArray(parsed) && parsed.length === 1 && parsed[0] === text && !/^\s|\s$|["'\\]/.test(text);
  } catch {
    plainOk = false;
  }
  return plainOk ? text : `'${text.replaceAll("'", "''")}'`;
}

export function specPathsEntry(name: string, covers: readonly string[]): string {
  const globs = covers.length ? covers : [PLACEHOLDER_GLOB];
  return `    ${name}:\n${globs.map((g) => `    - ${yamlScalar(g)}\n`).join('')}`;
}

export function newSpec(repo: Repo, name: string, covers: readonly string[]): NewSpecResult {
  if (!SPEC_NAME_RE.test(name) || name.length > SPEC_NAME_MAX) {
    throw new ArgumentError(`spec name '${name}' must be kebab-case (${SPEC_NAME_RE.source}), at most ${SPEC_NAME_MAX} characters`);
  }
  if (name === 'README') throw new ArgumentError('README is not a spec name');
  for (const g of covers) {
    if (g.trim() === '' || /[\n\r]/.test(g)) throw new ArgumentError(`--covers '${g}' is not a usable glob`);
  }
  const file = specFile(name);
  const abs = join(repo.root, file);
  if (existsSync(abs)) throw new CommandError(`${file} already exists`);
  const files = tracked(repo.root);
  const unmatched = covers.filter((g) => !files.some((f) => globRe(g).test(f)));
  const mapped = specPathMap(loadLifecycle(repo.root)).has(name);
  mkdirSync(join(repo.root, SPECS_DIR), { recursive: true });
  writeFileSync(abs, specTemplate(name), { flag: 'wx' });
  return { file, entry: specPathsEntry(name, covers), covers: [...covers], unmatched, mapped };
}
