// signin: puts the session cookie `make dev-login EMAIL=<address>` prints (one line,
// `<cookie name>=<token>`) into the slot's profile, for the slot's app origin. The token is read from
// stdin only and handed to agent-browser on its stdin (`batch`, JSON), so it is never on a command
// line, in the process list, in a file, or in anything this CLI prints.
import { lstatSync } from 'node:fs';
import { CliError, UsageError } from './errors.ts';
import type { Runner } from './runner.ts';
import { appOrigin, browserFlags, cliCommand, cookieName, type Env, sessionName, slotAppOrigin, slotPaths } from './slot.ts';

/** autologger's session lifetime (SESSION_DAYS, default 14): the cookie expires with the session. */
export const SESSION_DAYS = 14;

/** RFC 6265 cookie-octets: no controls, whitespace, DQUOTE, comma, semicolon or backslash. */
const TOKEN = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{1,4096}$/;

/**
 * The token from the input, which must be exactly one line `<slot's cookie name>=<token>` (one
 * trailing newline allowed). Messages never contain the input.
 */
export function parseCookieLine(input: string, slot: number): string {
  const expected = cookieName(slot);
  const body = input.endsWith('\r\n') ? input.slice(0, -2) : input.endsWith('\n') ? input.slice(0, -1) : input;
  if (body === '') throw new UsageError(`signin reads one line, ${expected}=<token>, from stdin (pipe make dev-login into it); it got nothing. Nothing was written`);
  if (/[\r\n]/.test(body)) throw new UsageError(`signin reads exactly one line, ${expected}=<token>; the input has more than one. Nothing was written`);
  const eq = body.indexOf('=');
  if (eq <= 0) throw new UsageError(`signin reads one line, ${expected}=<token>; the input is not <cookie name>=<token>. Nothing was written`);
  const name = body.slice(0, eq);
  const token = body.slice(eq + 1);
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new UsageError(`signin reads one line, ${expected}=<token>; the input's cookie name is not one. Nothing was written`);
  if (name !== expected) {
    throw new UsageError(`the cookie is ${name}, but dev slot ${slot}'s is ${expected}; run make dev-login for the same slot${slot === 0 ? '' : ` (DEV_SLOT=${slot})`}. Nothing was written`);
  }
  if (!TOKEN.test(token)) throw new UsageError(`the ${expected} value is empty, too long, or has characters a cookie cannot hold. Nothing was written`);
  return token;
}

export interface SigninContext {
  env: Env;
  runner: Runner;
  slot: number;
  input: string;
  /** Now, in ms (tests pin it). */
  now?: number;
}

export interface SigninReport {
  slot: number;
  cookie: string;
  origin: string;
  session: string;
  secure: true;
  http_only: true;
  path: '/';
  same_site: 'Lax';
  expires: string;
  flags: string[];
}

function isDir(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function signin(ctx: SigninContext): Promise<SigninReport> {
  const { slot } = ctx;
  const token = parseCookieLine(ctx.input, slot);
  const paths = slotPaths(ctx.env, slot);
  if (!isDir(paths.profile)) throw new CliError(`no profile for dev slot ${slot} at ${paths.profile}; run ${cliCommand('setup', slot)} first. Nothing was written`);
  const name = cookieName(slot);
  // Cookies are scoped to a host, not a port (RFC 6265): the cookie set from this URL has domain
  // `localhost` and is sent to https://localhost on every port. So the default-port URL below works
  // for a slot 0 stack on any DEV_PORT, and the cookie written never changes with it. `origin` is
  // only what the report names: the slot's real app origin (DEV_PORT for slot 0).
  const cookieUrl = appOrigin(slot);
  const origin = slotAppOrigin(ctx.env, slot);
  const expiresAt = Math.floor((ctx.now ?? Date.now()) / 1000) + SESSION_DAYS * 86_400;
  const batch = JSON.stringify([
    ['cookies', 'set', name, token, '--url', `${cookieUrl}/`, '--path', '/', '--secure', '--http-only', '--same-site', 'Lax', '--expires', String(expiresAt)],
  ]);
  const flags = browserFlags(paths);
  const result = await ctx.runner('agent-browser', [...flags, 'batch', '--bail', '--json', '--omit-command'], { env: ctx.env, input: batch, timeoutMs: 120_000 });
  const scrub = (text: string): string => text.split(token).join('[redacted]').trim().split('\n')[0]?.slice(0, 300) ?? '';
  if (result.error === 'ENOENT') throw new CliError('agent-browser is not on PATH; install it: npm install -g agent-browser');
  if (result.error !== undefined) throw new CliError(`agent-browser could not be started: ${scrub(result.error)}`);
  let reason: string | null = null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const first = Array.isArray(parsed) ? (parsed[0] as { success?: unknown; error?: unknown } | undefined) : undefined;
    if (first?.success !== true) reason = typeof first?.error === 'string' ? scrub(first.error) : 'it reported a failure';
  } catch {
    reason = result.code === 0 ? 'its output was not the expected JSON' : `exit ${result.code ?? 'killed'}${result.stderr === '' ? '' : `: ${scrub(result.stderr)}`}`;
  }
  if (reason === null && result.code !== 0) reason = `exit ${result.code ?? 'killed'}`;
  if (reason !== null) throw new CliError(`agent-browser did not set the ${name} cookie (${reason})`);
  return {
    slot,
    cookie: name,
    origin,
    session: sessionName(slot),
    secure: true,
    http_only: true,
    path: '/',
    same_site: 'Lax',
    expires: new Date(expiresAt * 1000).toISOString(),
    flags,
  };
}

export function formatSignin(report: SigninReport): string {
  return `Dev slot ${report.slot}: the profile now holds the ${report.cookie} session cookie for ${report.origin} (Secure, HttpOnly, path /, expires ${report.expires}). The ${report.session} agent-browser session is open with it.\n`;
}
