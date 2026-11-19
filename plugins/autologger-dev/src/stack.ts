// What the CLI knows about a local autologger dev stack: the checkout, the local OpenBao (its
// container, state directory and override file) and the dev CA file. Values from the state
// directory and the credentials file are read only to say whether a key is set or a placeholder,
// and to scrub them from anything printed; no value is ever returned to a caller for output.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CliError } from './errors.ts';
import type { Env } from './http.ts';
import type { Runner } from './runner.ts';

/** Files at the root of an autologger-2 checkout that the setup flow runs. */
export const CHECKOUT_FILES = ['Makefile', 'docker/scripts/compose-run.mjs', 'docker/scripts/local-bao.mjs'] as const;

/** `make dev-bao`'s credentials file, at the checkout root. */
export const CREDENTIALS_FILE = '.env.openbao.dev';

export const DEFAULT_CONTAINER = 'autologger-local-openbao';
export const STATE_DIR_NAME = '.autologger-local-openbao';
export const OVERRIDES_FILE = 'overrides.env';
export const SECRETS_FILE = 'secrets.json';

/** Where `ca` writes the dev CA unless told otherwise. */
export const CA_DIR_NAME = '.autologger-dev';
export const CA_FILE_NAME = 'autologger-dev-ca.crt';

export const GOOGLE_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const;
export const DASHBOARDS_KEY = 'CUSTOM_DASHBOARDS_ENABLED';
export const GOOGLE_REDIRECT = 'https://localhost:8787/auth/google/callback';

export function homeDir(env: Env): string {
  return env.HOME !== undefined && env.HOME !== '' ? env.HOME : homedir();
}

/** The local OpenBao state directory: $LOCAL_BAO_DIR (as make dev-bao reads it), else ~/.autologger-local-openbao. */
export function stateDir(env: Env): string {
  return env.LOCAL_BAO_DIR !== undefined && env.LOCAL_BAO_DIR !== '' ? env.LOCAL_BAO_DIR : join(homeDir(env), STATE_DIR_NAME);
}

/** The local OpenBao container: $LOCAL_BAO_NAME (as make dev-bao reads it), else autologger-local-openbao. */
export function containerName(env: Env): string {
  return env.LOCAL_BAO_NAME !== undefined && env.LOCAL_BAO_NAME !== '' ? env.LOCAL_BAO_NAME : DEFAULT_CONTAINER;
}

export function defaultCaFile(env: Env): string {
  return join(homeDir(env), CA_DIR_NAME, CA_FILE_NAME);
}

export interface Checkout {
  path: string;
  /** Where the path came from: --repo, $AUTOLOGGER_REPO or the current directory. */
  source: '--repo' | 'AUTOLOGGER_REPO' | 'current directory';
  /** The CHECKOUT_FILES that are not there; empty for a checkout. */
  missing: string[];
}

/** `--repo`, else $AUTOLOGGER_REPO, else the current directory. */
export function resolveCheckout(option: string | undefined, env: Env, cwd: string): Checkout {
  const fromEnv = env.AUTOLOGGER_REPO !== undefined && env.AUTOLOGGER_REPO !== '' ? env.AUTOLOGGER_REPO : undefined;
  const source = option !== undefined ? '--repo' : fromEnv !== undefined ? 'AUTOLOGGER_REPO' : 'current directory';
  const path = resolve(cwd, option ?? fromEnv ?? '.');
  const missing = CHECKOUT_FILES.filter((f) => !isFile(join(path, f)));
  return { path, source, missing };
}

/** The GitHub repository whose checkout `up` and `ca` agree to run the Makefile of. */
export const ORIGIN_REPO = 'kwcantrell/autologger-2';

/**
 * Whether a git remote URL is github.com/kwcantrell/autologger-2: https (credentials in the URL
 * allowed), scp-style ssh (git@github.com:...) or ssh:// form, `.git` and a trailing slash optional.
 * GitHub names are case-insensitive, so the comparison is too.
 */
export function isAutologgerOrigin(url: string): boolean {
  const m = /^(?:https:\/\/(?:[^@/\s]+@)?github\.com(?::443)?\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m !== null && `${m[1] ?? ''}/${m[2] ?? ''}`.toLowerCase() === ORIGIN_REPO;
}

/** A remote URL fit for a message: credentials in an http(s) URL replaced, control characters escaped. */
export function displayRemote(url: string): string {
  return JSON.stringify(url.trim().replace(/^(https?:\/\/)[^@/]*@/i, '$1[credentials]@'));
}

/**
 * The checks `up` and `ca` make before running the checkout's Makefile: the checkout files are
 * there, and its `origin` remote is github.com/kwcantrell/autologger-2. Exit 1 otherwise, nothing run.
 * (The remote is read with `git remote get-url origin`, which runs no hook or Makefile recipe.)
 */
export async function verifyCheckout(checkout: Checkout, runner: Runner, env: Env): Promise<void> {
  if (checkout.missing.length > 0) {
    throw new CliError(
      `${checkout.path} (from ${checkout.source}) is not an autologger-2 checkout (no ${checkout.missing.join(', ')}); pass --repo <path> or set AUTOLOGGER_REPO`,
    );
  }
  const gitEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('GIT_')) gitEnv[k] = v;
  const r = await runner('git', ['remote', 'get-url', 'origin'], { cwd: checkout.path, env: gitEnv, timeoutMs: 15_000 });
  if (r.error === 'ENOENT') throw new CliError(`git is not on PATH, so the origin remote of ${checkout.path} cannot be checked`);
  if (r.code !== 0) {
    throw new CliError(`${checkout.path} has no git origin remote (or is not a git repository); refusing to run its Makefile, which only a checkout of github.com/${ORIGIN_REPO} may do`);
  }
  const url = r.stdout.trim();
  if (!isAutologgerOrigin(url)) {
    throw new CliError(`the origin remote of ${checkout.path} is ${displayRemote(url)}, not github.com/${ORIGIN_REPO}; refusing to run its Makefile`);
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * KEY=VALUE lines, the way docker/scripts/local-bao.mjs reads them (blank and # lines skipped, the
 * last line of a key wins, the value is the rest of the line verbatim: no quote is removed and
 * nothing is trimmed). Malformed lines are skipped here: their text is never shown.
 */
export function parseEnvText(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m !== null) out.set(m[1] ?? '', m[2] ?? '');
  }
  return out;
}

export type OverridesRead = { state: 'absent' } | { state: 'unreadable' } | { state: 'read'; values: Map<string, string> };

export function readOverrides(env: Env): OverridesRead {
  const path = join(stateDir(env), OVERRIDES_FILE);
  if (!existsSync(path)) return { state: 'absent' };
  try {
    return { state: 'read', values: parseEnvText(readFileSync(path, 'utf8')) };
  } catch {
    return { state: 'unreadable' };
  }
}

/**
 * A value with surrounding whitespace and one matching pair of surrounding quotes ("..." or '...')
 * removed. local-bao.mjs keeps quotes as part of the value, so `KEY=""` reaches the OpenBao secret
 * as the two characters `""`: not empty to autologger's own blank check, but no setting either.
 */
export function unquote(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

/** A value that is not a real setting: empty (quoted or not), or one of the defaults' REPLACE_ME placeholders. */
export function isPlaceholder(value: string | undefined): boolean {
  return value === undefined || unquote(value) === '' || value.includes('REPLACE_ME');
}

export interface GoogleClient {
  /** true when both keys hold a non-placeholder value in overrides.env. */
  ok: boolean;
  /**
   * For each key: 'set', 'placeholder' (a REPLACE_ME value) or 'not set' (no line for it, so the
   * defaults' placeholder applies, or an empty value: `KEY=`, `KEY=""` or `KEY=''`).
   */
  keys: Record<(typeof GOOGLE_KEYS)[number], 'set' | 'placeholder' | 'not set'>;
}

export function googleClient(values: Map<string, string>): GoogleClient {
  const state = (key: string): 'set' | 'placeholder' | 'not set' => {
    const value = values.get(key);
    if (value === undefined || unquote(value) === '') return 'not set';
    return isPlaceholder(value) ? 'placeholder' : 'set';
  };
  const keys = { GOOGLE_CLIENT_ID: state('GOOGLE_CLIENT_ID'), GOOGLE_CLIENT_SECRET: state('GOOGLE_CLIENT_SECRET') };
  return { ok: keys.GOOGLE_CLIENT_ID === 'set' && keys.GOOGLE_CLIENT_SECRET === 'set', keys };
}

export function dashboardsEnabled(values: Map<string, string>): boolean {
  return values.get(DASHBOARDS_KEY)?.trim() === '1';
}

export type ContainerState =
  | { state: 'running' }
  | { state: 'stopped' }
  | { state: 'absent' }
  | { state: 'unknown'; reason: string };

/** Whether the local OpenBao container is running, from `docker container inspect` (read-only). */
export async function openbaoContainer(runner: Runner, name: string, env: Env): Promise<ContainerState> {
  const r = await runner('docker', ['container', 'inspect', '--format', '{{.State.Running}}', name], { env, timeoutMs: 15_000 });
  if (r.error === 'ENOENT') return { state: 'unknown', reason: 'docker is not on PATH' };
  if (r.error !== undefined) return { state: 'unknown', reason: `docker could not be run: ${r.error}` };
  if (r.code === 0) return r.stdout.trim() === 'true' ? { state: 'running' } : { state: 'stopped' };
  if (/no such (container|object)/i.test(r.stderr)) return { state: 'absent' };
  return { state: 'unknown', reason: `docker container inspect exited ${String(r.code)}` };
}

/** Keys whose values are not secret (and would make output unreadable if scrubbed). */
const NON_SECRET_KEYS = new Set(['BAO_ADDR', 'BAO_CACERT', 'BAO_KV_PATH']);
const MIN_SECRET_LENGTH = 8;

/**
 * Every value in overrides.env, secrets.json and the checkout's .env.openbao.dev that could be a
 * secret. Used only to scrub output (anything a child process prints included); never printed.
 */
export function secretValues(env: Env, checkoutPath: string | undefined): string[] {
  const values: string[] = [];
  const add = (key: string, value: unknown): void => {
    if (typeof value !== 'string' || NON_SECRET_KEYS.has(key) || value.includes('REPLACE_ME')) return;
    for (const v of [value.trim(), unquote(value)]) {
      if (v.length >= MIN_SECRET_LENGTH) values.push(v);
    }
  };
  const readText = (path: string): string | undefined => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  };
  const envFiles = [join(stateDir(env), OVERRIDES_FILE), ...(checkoutPath !== undefined ? [join(checkoutPath, CREDENTIALS_FILE)] : [])];
  for (const file of envFiles) {
    const text = readText(file);
    if (text !== undefined) for (const [k, v] of parseEnvText(text)) add(k, v);
  }
  const secrets = readText(join(stateDir(env), SECRETS_FILE));
  if (secrets !== undefined) {
    try {
      const parsed: unknown = JSON.parse(secrets);
      if (typeof parsed === 'object' && parsed !== null) for (const [k, v] of Object.entries(parsed)) add(k, v);
    } catch {
      // Not JSON: nothing to collect.
    }
  }
  const secretId = readText(join(stateDir(env), 'secret_id'));
  if (secretId !== undefined) add('secret_id', secretId);
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

/** Replaces every known secret value in a text with [redacted]. */
export function redactor(secrets: readonly string[]): (text: string) => string {
  return (text) => {
    let out = text;
    for (const secret of secrets) out = out.replaceAll(secret, '[redacted]');
    return out;
  };
}

/**
 * Variables the caller's environment may not pass to make: those that would point it at another dev
 * slot, a stage or prod stack, or allow a reset, and make's own (flags and variable assignments in
 * MAKEFLAGS/GNUMAKEFLAGS/MFLAGS, MAKELEVEL, which makes it print "Entering directory" lines into
 * output that is parsed, and MAKEFILES, extra makefiles it would read first).
 */
export const STRIPPED_ENV = ['DEV_SLOT', 'DEV_HTTPS', 'CONFIRM', 'EMAIL', 'MAKEFLAGS', 'GNUMAKEFLAGS', 'MFLAGS', 'MAKELEVEL', 'MAKEFILES'] as const;

/**
 * The environment for make and docker: the caller's, without STRIPPED_ENV and STAGE_* variables.
 * Extra values (DEV_HTTPS=1) are added.
 */
export function childEnv(env: Env, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if ((STRIPPED_ENV as readonly string[]).includes(k) || k.startsWith('STAGE_')) continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}
