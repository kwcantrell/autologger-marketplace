// The local autologger app's own HTTP API (not MCP), used by `import --create` to make the teams,
// shows and sessions the MCP write tools cannot, and to add transcript words. It authenticates with
// the session cookie a dev stack's `make dev-login EMAIL=<address>` prints (`<cookie name>=<token>`),
// which `app-signin` reads from standard input only and keeps in a mode-0600 file under the config
// directory, per server. The cookie is never taken from an argument, never printed (every output
// line is scrubbed of it) and never written into a snapshot or state file. Only a loopback server
// (a local dev stack) is ever sent it.
import { chmodSync, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { RateLimitStop, writeJsonFile } from './copy.ts';
import { CliError, messageOf, UsageError } from './errors.ts';
import { clip, type Fetch, isLoopback, isObject, request } from './http.ts';
import { configDir, type Env, knownSecrets, makeDirs, serverKey } from './store.ts';

/** RFC 6265 cookie-octets: no controls, whitespace, DQUOTE, comma, semicolon or backslash. */
const TOKEN_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{8,4096}$/;
const NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

export interface AppCookie {
  version: 1;
  server: string;
  name: string;
  token: string;
  stored_at: string;
}

/** The cookie from `make dev-login`'s output: exactly one line `<cookie name>=<token>`. */
export function parseCookieLine(input: string): { name: string; token: string } {
  const lines = input.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length !== 1) throw new UsageError('app-signin reads one line, <cookie name>=<token>, as make dev-login prints it; nothing was stored');
  const line = (lines[0] ?? '').trim();
  const eq = line.indexOf('=');
  if (eq <= 0) throw new UsageError('app-signin reads one line, <cookie name>=<token>; the input is not that. Nothing was stored');
  const name = line.slice(0, eq);
  const token = line.slice(eq + 1);
  if (!NAME_RE.test(name)) throw new UsageError("app-signin: the input's cookie name is not one; nothing was stored");
  if (!TOKEN_RE.test(token)) throw new UsageError('app-signin: the cookie value is empty, too short or too long, or has characters a cookie cannot hold; nothing was stored');
  return { name, token };
}

/** `<config dir>/app-cookies/<server key>.json`, mode 0600 in 0700 directories. */
export class AppCookieStore {
  readonly dir: string;
  readonly path: string;
  readonly server: string;

  constructor(env: Env, server: string) {
    this.server = server;
    this.dir = join(configDir(env), 'app-cookies');
    this.path = join(this.dir, `${serverKey(server)}.json`);
  }

  load(): AppCookie | undefined {
    if (!existsSync(this.path)) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (error) {
      throw new CliError(`cannot read ${this.path}: ${messageOf(error)}; delete it and run app-signin again`);
    }
    if (!isObject(value) || value.version !== 1 || typeof value.name !== 'string' || typeof value.token !== 'string' || !NAME_RE.test(value.name) || !TOKEN_RE.test(value.token)) {
      throw new CliError(`${this.path} has an unknown format; delete it and run app-signin again`);
    }
    knownSecrets.add(value.token);
    return { version: 1, server: this.server, name: value.name, token: value.token, stored_at: String(value.stored_at ?? '') };
  }

  save(cookie: AppCookie): void {
    knownSecrets.add(cookie.token);
    for (const dir of [join(this.dir, '..'), this.dir]) {
      try {
        makeDirs(dir, 0o700);
      } catch (error) {
        throw new CliError(`cannot create ${dir}: ${messageOf(error)}`);
      }
      if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    }
    writeJsonFile(this.path, cookie, true);
  }

  /** Deletes the stored cookie; whether there was one. */
  delete(): boolean {
    try {
      unlinkSync(this.path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new CliError(`cannot delete ${this.path}: ${messageOf(error)}`);
    }
  }
}

export interface AppAnswer {
  status: number;
  body: unknown;
}

/** Waits on one HTTP request before giving up, and the longest wait (s). */
const MAX_WAITS = 5;
const MAX_WAIT_S = 3600;

/** A JSON client for the app's `/api/...` routes, signed in with the dev-login cookie. */
export class AppClient {
  readonly server: string;
  private readonly cookie: AppCookie;
  private readonly fetchFn: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly noWait: boolean;
  private readonly notice: (text: string) => void;

  constructor(opts: { server: string; cookie: AppCookie; fetch: Fetch; sleep: (ms: number) => Promise<void>; noWait: boolean; notice: (text: string) => void }) {
    if (!isLoopback(opts.server)) throw new CliError(`${opts.server} is not a local dev stack; the app cookie is only ever sent to localhost, 127.0.0.1 or [::1]`);
    this.server = opts.server;
    this.cookie = opts.cookie;
    this.fetchFn = opts.fetch;
    this.sleep = opts.sleep;
    this.noWait = opts.noWait;
    this.notice = opts.notice;
  }

  /**
   * One request; answers its status and JSON body. A 429 is waited out (its Retry-After, else 5 s)
   * unless `noWait`; a 401 means the cookie is not (or no longer) a session and is an error.
   */
  async call(method: string, path: string, body?: unknown): Promise<AppAnswer> {
    for (let waits = 0; ; waits++) {
      const headers: Record<string, string> = { accept: 'application/json', cookie: `${this.cookie.name}=${this.cookie.token}` };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await request(this.fetchFn, `${this.server}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text === '' ? undefined : JSON.parse(text);
      } catch {
        parsed = text;
      }
      if (response.status === 401) {
        throw new CliError(`${method} ${path} on ${this.server} answered 401: the dev-login cookie is not a session there (expired, or from another stack). Run make dev-login again and pipe it into app-signin`);
      }
      if (response.status !== 429) return { status: response.status, body: parsed };
      const header = Number(response.headers.get('retry-after'));
      const seconds = Number.isFinite(header) && header > 0 ? Math.ceil(header) : 5;
      if (this.noWait) throw new RateLimitStop(`${method} ${path}: rate limited (retry in ${seconds} s)`, seconds);
      if (seconds > MAX_WAIT_S || waits >= MAX_WAITS) throw new RateLimitStop(`${method} ${path}: still rate limited after ${waits} waits (retry in ${seconds} s)`, seconds);
      this.notice(`${method} ${path}: rate limited; waiting ${seconds} s before retrying\n`);
      await this.sleep((seconds + 1) * 1000);
    }
  }
}

/** The `detail` of an error answer, else its body, short and on one line. */
export function detailOf(answer: AppAnswer): string {
  const b = answer.body;
  if (isObject(b) && typeof b.detail === 'string') return clip(b.detail, 300);
  if (isObject(b) && typeof b.error === 'string') return clip(b.error, 300);
  return clip(typeof b === 'string' ? b : JSON.stringify(b ?? ''), 300);
}
