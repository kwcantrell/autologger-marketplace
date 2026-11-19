// Dev slots and this plugin's own files. autologger runs up to ten dev stacks side by side
// (DEV_SLOT=0-9, autologger ADR 0038), each with its own app origin, dashboard runtime origin and
// session cookie name (autologger-2 docs/specs/local-container-environments.md, "Dev slots run side
// by side"; the same rules as autologger-dev's src/slot.ts):
//   slot 0  app https://localhost:8787   runtime https://dashboards.localhost     cookie autologger_sid
//   slot N  app https://localhost:2N787  runtime https://dashboards-N.localhost   cookie autologger_sid_N
// Every file this plugin writes lives under ~/.autologger-dev/browser/slot-<N>/ (see slotPaths).
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

/** The slot's app origin (slot 0 assumes the default port 8787; DEV_PORT is not read). */
export function appOrigin(slot: number): string {
  return slot === 0 ? 'https://localhost:8787' : `https://localhost:2${slot}787`;
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
