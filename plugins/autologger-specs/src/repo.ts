// The autologger checkout the CLI works on, git access, and scripts/lifecycle.yaml.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { YamlError, isYamlMap, parseYaml, pyStr } from './yaml.ts';
import type { YamlMap } from './yaml.ts';

export const CONFIG_PATH = 'scripts/lifecycle.yaml';
export const SPECS_DIR = 'docs/specs';

/** Exit 2: the CLI was not pointed at an autologger checkout. */
export class NotACheckoutError extends Error {}
/** Exit 1: the command could not do its job (git failed, the config could not be read, ...). */
export class CommandError extends Error {}

export interface Repo {
  root: string;
  cwd: string;
}

export function git(root: string, args: readonly string[], allowFailure = false): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('git', [...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new CommandError(`could not run git: ${r.error.message}`);
  const ok = r.status === 0;
  if (!ok && !allowFailure) throw new CommandError(`git ${args.join(' ')} failed: ${r.stderr.trim() || `exit ${r.status}`}`);
  return { ok, stdout: r.stdout, stderr: r.stderr };
}

export function gitZ(root: string, args: readonly string[]): string[] {
  return git(root, args).stdout.split('\0').filter((f) => f !== '');
}

/** The git toplevel containing `repoOption` (relative to cwd) or cwd, which must have scripts/lifecycle.yaml. */
export function findRepo(cwd: string, repoOption?: string): Repo {
  const start = repoOption === undefined ? cwd : resolve(cwd, repoOption);
  if (!existsSync(start) || !statSync(start).isDirectory()) {
    throw new NotACheckoutError(`--repo ${repoOption}: no such directory`);
  }
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: start, encoding: 'utf8' });
  if (r.error) throw new CommandError(`could not run git: ${r.error.message}`);
  const hint = repoOption === undefined ? '; run it inside an autologger checkout or pass --repo <path>' : '';
  if (r.status !== 0) throw new NotACheckoutError(`not inside a git checkout: ${start}${hint}`);
  const root = r.stdout.trim();
  if (!existsSync(join(root, CONFIG_PATH))) {
    throw new NotACheckoutError(`not an autologger checkout: ${root} has no ${CONFIG_PATH}${hint}`);
  }
  return { root, cwd: realpathSync(cwd) };
}

export function tracked(root: string): string[] {
  return gitZ(root, ['ls-files', '-z']);
}

/** `lifecycle:` from YAML text, like check_change.py's `(data or {}).get("lifecycle") or {}`. */
export function lifecycleFrom(text: string, where: string): YamlMap {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (error) {
    if (error instanceof YamlError) throw new CommandError(`cannot read ${where}: ${error.message}`);
    throw error;
  }
  if (data === null) return {};
  if (!isYamlMap(data)) throw new CommandError(`cannot read ${where}: the top level is not a mapping`);
  const lifecycle = data.lifecycle;
  if (lifecycle === null || lifecycle === undefined) return {};
  if (!isYamlMap(lifecycle)) throw new CommandError(`cannot read ${where}: \`lifecycle\` is not a mapping`);
  return lifecycle;
}

/** The working tree's lifecycle config. */
export function loadLifecycle(root: string): YamlMap {
  return lifecycleFrom(readFileSync(join(root, CONFIG_PATH), 'utf8'), CONFIG_PATH);
}

/** The lifecycle config at a commit, or null when it has none (no file, or no `lifecycle` mapping). */
export function loadLifecycleAt(root: string, ref: string): YamlMap | null {
  const r = git(root, ['show', `${ref}:${CONFIG_PATH}`], true);
  if (!r.ok) return null;
  const where = `${CONFIG_PATH} at ${ref.slice(0, 12)}`;
  let data: unknown;
  try {
    data = parseYaml(r.stdout);
  } catch (error) {
    if (error instanceof YamlError) throw new CommandError(`cannot read ${where}: ${error.message}`);
    throw error;
  }
  const lifecycle = isYamlMap(data) ? data.lifecycle : null;
  return isYamlMap(lifecycle) ? lifecycle : null;
}

/** `spec_path_map`: spec name -> its string globs (non-strings dropped, a non-list value is []). */
export function specPathMap(cfg: YamlMap): Map<string, string[]> {
  const raw = cfg.spec_paths;
  const map = new Map<string, string[]>();
  if (!isYamlMap(raw)) return map;
  for (const [name, value] of Object.entries(raw)) {
    map.set(pyStr(name), Array.isArray(value) ? value.filter((g): g is string => typeof g === 'string') : []);
  }
  return map;
}

/** A list of strings from the config (`cfg.get(key) or []`), ignoring anything that is not a string. */
export function stringList(cfg: YamlMap, key: string): string[] {
  const value = cfg[key];
  return Array.isArray(value) ? value.filter((g): g is string => typeof g === 'string') : [];
}
