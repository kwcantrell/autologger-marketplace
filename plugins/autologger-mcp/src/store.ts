// Per-server credential files: `<config dir>/credentials/<server key>.json`, mode 0600 in 0700
// directories, written atomically (temp file + rename), with a lock file that serialises token
// refreshes between concurrent CLI processes (the server revokes a grant whose refresh token is
// presented twice outside its grace window).
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError } from './errors.ts';

export type Env = Readonly<Record<string, string | undefined>>;

/** The endpoints discovered at login, kept so `logout` and refreshes need no new discovery. */
export interface ServerEndpoints {
  issuer: string;
  resource: string;
  token_endpoint: string;
  authorization_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
}

export interface ClientRegistration {
  client_id: string;
  /** The registration endpoint it was registered at; a different one means a new registration. */
  registration_endpoint: string;
  registered_at: number;
  /** Last successful code exchange (the server sweeps clients unused for 30 days). */
  last_authorized_at?: number;
}

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  /** Epoch milliseconds. */
  expires_at?: number;
  /** The scope the server granted (from the token answer). */
  scope: string;
  obtained_at: number;
}

export interface Credentials {
  version: 1;
  server: string;
  endpoints?: ServerEndpoints;
  client?: ClientRegistration;
  tokens?: Tokens;
}

/** `$AUTOLOGGER_MCP_CONFIG_DIR`, else `$XDG_CONFIG_HOME/autologger-mcp`, else `~/.config/autologger-mcp`. */
export function configDir(env: Env): string {
  const override = env.AUTOLOGGER_MCP_CONFIG_DIR;
  if (override !== undefined && override !== '') return override;
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== '' ? xdg : join(env.HOME ?? homedir(), '.config');
  return join(base, 'autologger-mcp');
}

/** A file name for a server origin: readable, and collision-free thanks to the hash suffix. */
export function serverKey(server: string): string {
  const readable = server.replace(/^[a-z]+:\/\//, '').replace(/[^A-Za-z0-9.-]+/g, '_');
  const hash = createHash('sha256').update(server).digest('hex').slice(0, 12);
  return `${readable}-${hash}`;
}

/** Secrets seen by this process, so every line of output can be scrubbed of them. */
export const knownSecrets = new Set<string>();

export function rememberSecrets(tokens: Tokens | undefined): void {
  if (tokens === undefined) return;
  knownSecrets.add(tokens.access_token);
  if (tokens.refresh_token !== undefined) knownSecrets.add(tokens.refresh_token);
}

/** Replaces any known token in `text` with `[redacted]`. */
export function redact(text: string): string {
  let out = text;
  for (const secret of knownSecrets) if (secret.length >= 8) out = out.replaceAll(secret, '[redacted]');
  return out;
}

export class CredentialStore {
  readonly dir: string;
  readonly path: string;
  readonly server: string;

  constructor(env: Env, server: string) {
    this.server = server;
    this.dir = join(configDir(env), 'credentials');
    this.path = join(this.dir, `${serverKey(server)}.json`);
  }

  /** The stored credentials, or an empty record for this server. */
  load(): Credentials {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, server: this.server };
      throw new CliError(`cannot read ${this.path}: ${(error as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CliError(`${this.path} is not valid JSON; delete it and run login again`);
    }
    if (typeof parsed !== 'object' || parsed === null || (parsed as Credentials).version !== 1) {
      throw new CliError(`${this.path} has an unknown format; delete it and run login again`);
    }
    const creds = parsed as Credentials;
    rememberSecrets(creds.tokens);
    return { ...creds, server: this.server };
  }

  /** Writes the credentials atomically, mode 0600, in a 0700 directory. */
  save(creds: Credentials): void {
    rememberSecrets(creds.tokens);
    this.ensureDir();
    const tmp = join(this.dir, `.${serverKey(this.server)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(creds, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, this.path);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
      throw error;
    }
  }

  /** Removes the tokens, keeping the client registration and endpoints. */
  clearTokens(): void {
    const creds = this.load();
    if (creds.tokens === undefined) return;
    delete creds.tokens;
    this.save(creds);
  }

  private ensureDir(): void {
    const root = join(this.dir, '..');
    for (const dir of [root, this.dir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      // mkdir's mode is filtered by the umask, and an existing directory may be wider: set it.
      if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    }
  }

  /**
   * Runs `fn` holding an exclusive lock on this server's credentials (an O_EXCL lock file). A lock
   * older than `staleMs` is treated as left behind by a crashed process and taken over.
   */
  async withLock<T>(fn: () => Promise<T>, opts: { timeoutMs?: number; staleMs?: number } = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const staleMs = opts.staleMs ?? 60_000;
    this.ensureDir();
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + timeoutMs;
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(lock, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - statSync(lock).mtimeMs > staleMs) unlinkSync(lock);
        } catch {
          // released meanwhile
        }
        if (Date.now() > deadline) {
          throw new CliError(`timed out waiting for another autologger-mcp process (lock ${lock})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    try {
      writeSync(fd, `${process.pid}\n`);
      return await fn();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lock);
      } catch {
        // already removed
      }
    }
  }
}
