// HTTP helpers: URL policy (https, or http on a loopback host only), fetch with readable network
// and TLS errors, and JSON bodies. TLS verification is never turned off: a private CA (the dev
// stack's) is trusted through NODE_EXTRA_CA_CERTS.
import { CliError, UsageError } from './errors.ts';

export const DEFAULT_SERVER = 'https://localhost:8787';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether a URL may be used: `https:`, or `http:` to a loopback host, with no user info. */
export function allowedUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url;
  return null;
}

/** Whether a server origin is on this machine (localhost, 127.0.0.1 or [::1]): a local dev stack. */
export function isLoopback(server: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(server).hostname);
  } catch {
    return false;
  }
}

/** `--server`, else `AUTOLOGGER_URL`, else the dev stack; returned as an origin. */
export function resolveServer(option: string | undefined, env: Readonly<Record<string, string | undefined>>): string {
  const fromEnv = env.AUTOLOGGER_URL !== undefined && env.AUTOLOGGER_URL !== '' ? env.AUTOLOGGER_URL : undefined;
  const raw = option ?? fromEnv ?? DEFAULT_SERVER;
  const url = allowedUrl(raw);
  if (url === null) {
    const source = option !== undefined ? '--server' : fromEnv !== undefined ? 'AUTOLOGGER_URL' : 'default server';
    throw new UsageError(`${source} '${raw}' must be an https:// URL (or http:// to localhost/127.0.0.1/[::1])`);
  }
  return url.origin;
}

/** Checks a URL a server handed us before we send anything to it. */
export function requireAllowedUrl(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || allowedUrl(raw) === null) {
    throw new CliError(`${what} '${String(raw)}' is not an https:// URL (or http:// to a loopback host)`);
  }
  return raw;
}

const TLS_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
]);

export type Fetch = typeof fetch;

/** fetch(), with network and TLS failures turned into messages a user can act on. */
export async function request(fetchFn: Fetch, url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetchFn(url, { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(60_000) });
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const code = cause?.code;
    const origin = new URL(url).origin;
    if (code !== undefined && TLS_CODES.has(code)) {
      throw new CliError(
        `the TLS certificate of ${origin} is not trusted (${code}). If it is signed by a private CA (such as the autologger dev stack's), run with NODE_EXTRA_CA_CERTS=/path/to/ca.crt`,
      );
    }
    if ((error as Error).name === 'TimeoutError') throw new CliError(`${origin} did not answer in time`);
    throw new CliError(`cannot reach ${origin}: ${cause?.message ?? code ?? (error as Error).message}`);
  }
}

/** The body as JSON, or undefined when it is not JSON. */
export async function jsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Truncated, single-line text from a server, safe to put in a message. */
export function clip(value: unknown, max = 300): string {
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
