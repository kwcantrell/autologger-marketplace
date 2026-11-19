// HTTP helpers: the server URL policy (the same as autologger-mcp's: https, or http to a loopback
// host only) and probes that classify network and TLS failures instead of throwing. TLS
// verification is never turned off: the dev stack's private CA is trusted through
// NODE_EXTRA_CA_CERTS, which `ca` writes and `connect` explains.
import { UsageError } from './errors.ts';

export const DEFAULT_SERVER = 'https://localhost:8787';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export type Env = Readonly<Record<string, string | undefined>>;
export type Fetch = typeof fetch;

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

/** Whether a server origin is on this machine (localhost, 127.0.0.1 or [::1]). */
export function isLoopback(server: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(server).hostname);
  } catch {
    return false;
  }
}

/** `--server`, else `AUTOLOGGER_URL`, else the dev stack (`fallback`); returned as an origin. */
export function resolveServer(option: string | undefined, env: Env, fallback = DEFAULT_SERVER): string {
  const fromEnv = env.AUTOLOGGER_URL !== undefined && env.AUTOLOGGER_URL !== '' ? env.AUTOLOGGER_URL : undefined;
  const raw = option ?? fromEnv ?? fallback;
  const url = allowedUrl(raw);
  if (url === null) {
    const source = option !== undefined ? '--server' : fromEnv !== undefined ? 'AUTOLOGGER_URL' : 'default server';
    throw new UsageError(`${source} '${raw}' must be an https:// URL (or http:// to localhost/127.0.0.1/[::1])`);
  }
  return url.origin;
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

export type Probe =
  | { ok: true; response: Response }
  | { ok: false; kind: 'tls' | 'unreachable' | 'timeout'; message: string };

/** fetch() that never throws: a response, or why there was none (TLS trust, unreachable, timeout). */
export async function probe(fetchFn: Fetch, url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Probe> {
  const origin = new URL(url).origin;
  try {
    const response = await fetchFn(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return { ok: true, response };
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const code = cause?.code;
    if (code !== undefined && TLS_CODES.has(code)) {
      return { ok: false, kind: 'tls', message: `the TLS certificate of ${origin} is not trusted (${code})` };
    }
    if ((error as Error).name === 'TimeoutError') return { ok: false, kind: 'timeout', message: `${origin} did not answer within ${timeoutMs / 1000} s` };
    // An empty message is common (undici's AggregateError for localhost on both ::1 and 127.0.0.1).
    const why = [cause?.message, code, (error as Error).message].find((m) => m !== undefined && m !== '') ?? 'unknown error';
    return { ok: false, kind: 'unreachable', message: `cannot reach ${origin}: ${clip(why)}` };
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

/** Truncated, single-line text, safe to put in a message. */
export function clip(value: unknown, max = 200): string {
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Quotes a word for a POSIX shell when it needs it. */
export function shellQuote(text: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}
