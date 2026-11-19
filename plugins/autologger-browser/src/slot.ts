// Dev slots and this plugin's own files. autologger runs up to ten dev stacks side by side
// (DEV_SLOT=0-9, autologger ADR 0038), each with its own app origin, dashboard runtime origin and
// session cookie name (autologger-2 docs/specs/local-container-environments.md, "Dev slots run side
// by side"; the same rules as autologger-dev's src/slot.ts):
//   slot 0  app https://localhost:8787   runtime https://dashboards.localhost     cookie autologger_sid
//           (the app port is DEV_PORT from ~/.autologger-local-openbao/overrides.env when valid)
//   slot N  app https://localhost:2N787  runtime https://dashboards-N.localhost   cookie autologger_sid_N
// Every file this plugin writes lives under ~/.autologger-dev/browser/slot-<N>/ (see slotPaths).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from './errors.ts';

export const CLI = 'autologger-browser';

export type Env = Readonly<Record<string, string | undefined>>;

/** `--slot`: exactly one digit 0-9, else a usage error. */
export function parseSlot(option: string | undefined): number {
  if (option === undefined) return 0;
  if (!/^[0-9]$/.test(option)) throw new UsageError(`--slot must be one digit 0-9 (0 is the default dev stack), not '${option}'`);
  return Number(option);
}

/** The port slot 0's app listens on when overrides.env does not set a valid DEV_PORT. */
export const DEFAULT_DEV_PORT = 8787;

/** The slot's app origin; slot 0's port is `devPort` (default 8787), slot N's is always 2N787. */
export function appOrigin(slot: number, devPort = DEFAULT_DEV_PORT): string {
  return slot === 0 ? `https://localhost:${devPort}` : `https://localhost:2${slot}787`;
}

/** The local OpenBao state folder ($LOCAL_BAO_DIR, else ~/.autologger-local-openbao), as autologger-dev reads it. */
export function localBaoDir(env: Env): string {
  return env.LOCAL_BAO_DIR !== undefined && env.LOCAL_BAO_DIR !== '' ? env.LOCAL_BAO_DIR : join(homeDir(env), '.autologger-local-openbao');
}

/**
 * The DEV_PORT value in overrides.env, verbatim (the last KEY=value line, no unquoting or trimming:
 * local-bao.mjs stores values as written), or undefined when the file or key is absent or unreadable.
 * The same parse as autologger-dev's parseEnvText.
 */
export function readDevPortValue(env: Env): string | undefined {
  const path = join(localBaoDir(env), 'overrides.env');
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let value: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m !== null && m[1] === 'DEV_PORT') value = m[2] ?? '';
  }
  return value;
}

/**
 * A DEV_PORT value as a port: digits only, 1-65535, no leading zero (compose-run.mjs's own check,
 * and autologger-dev's devPort); anything else, or no value, is the default 8787.
 */
export function parseDevPort(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]{0,4}$/.test(value)) return DEFAULT_DEV_PORT;
  const port = Number(value);
  return port <= 65535 ? port : DEFAULT_DEV_PORT;
}

/** The slot's app origin on this machine: slot 0 follows DEV_PORT in overrides.env; slots 1-9 ignore it. */
export function slotAppOrigin(env: Env, slot: number): string {
  return slot === 0 ? appOrigin(0, parseDevPort(readDevPortValue(env))) : appOrigin(slot);
}

/** The slot's dashboard runtime origin, served on 443 by the shared dev HTTPS front. */
export function runtimeOrigin(slot: number): string {
  return slot === 0 ? 'https://dashboards.localhost' : `https://dashboards-${slot}.localhost`;
}

/** The slot's session cookie name (the app's SESSION_COOKIE), as `make dev-login` prints it. */
export function cookieName(slot: number): string {
  return slot === 0 ? 'autologger_sid' : `autologger_sid_${slot}`;
}

/** The agent-browser session name for the slot: a session of its own, so it never reuses another launch. */
export function sessionName(slot: number): string {
  return `autologger-dev-${slot}`;
}

/** An autologger-browser command line for the slot (no flag for slot 0). */
export function cliCommand(command: string, slot: number): string {
  return slot === 0 ? `${CLI} ${command}` : `${CLI} ${command} --slot ${slot}`;
}

/** autologger-dev's command that writes the slot's dev CA file; it runs the checkout's Makefile, so it needs --repo. */
export function caCommand(slot: number): string {
  return `autologger-dev ca --repo <path to autologger-2>${slot === 0 ? '' : ` --slot ${slot}`}`;
}

export function homeDir(env: Env): string {
  return env.HOME !== undefined && env.HOME !== '' ? env.HOME : homedir();
}

/** The dev CA autologger-dev ca writes. */
export function defaultCaFile(env: Env): string {
  return join(homeDir(env), '.autologger-dev', 'autologger-dev-ca.crt');
}

/** The one directory this plugin owns; nothing outside it is ever written or removed. */
export function baseDir(env: Env): string {
  return join(homeDir(env), '.autologger-dev', 'browser');
}

export interface SlotPaths {
  slot: number;
  /** ~/.autologger-dev/browser */
  base: string;
  /** ~/.autologger-dev/browser/slot-<N> (mode 700): everything below is this slot's. */
  dir: string;
  /** Chromium's user data dir, passed to agent-browser as --profile. */
  profile: string;
  /** The HOME the launcher gives Chromium, so Chromium opens the NSS database below. */
  home: string;
  /** The private NSS database: $XDG_DATA_HOME/pki/nssdb, where current Chromium looks. */
  nssdb: string;
  /** $HOME/.pki/nssdb, where older Chromium looks: a symlink to nssdb, so both find the same one. */
  legacyNssdb: string;
  /** The launcher passed to agent-browser as --executable-path. */
  launcher: string;
}

export function slotPaths(env: Env, slot: number): SlotPaths {
  const base = baseDir(env);
  const dir = join(base, `slot-${slot}`);
  const home = join(dir, 'home');
  return {
    slot,
    base,
    dir,
    profile: join(dir, 'profile'),
    home,
    nssdb: join(home, '.local', 'share', 'pki', 'nssdb'),
    legacyNssdb: join(home, '.pki', 'nssdb'),
    launcher: join(dir, 'chromium-launcher.sh'),
  };
}

/** Quotes a value for a POSIX shell: as is when it is plain, else in single quotes. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The agent-browser global flags for the slot's profile. */
export function browserFlags(paths: SlotPaths): string[] {
  return ['--session', sessionName(paths.slot), '--profile', paths.profile, '--executable-path', paths.launcher];
}

/** `agent-browser <flags>` as one shell-quoted line, to put a command after. */
export function browserCommand(paths: SlotPaths): string {
  return ['agent-browser', ...browserFlags(paths)].map(shellQuote).join(' ');
}
