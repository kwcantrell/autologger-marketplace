// Fakes for the unit tests: a temp autologger-2 checkout and home directory, a scripted command
// runner (no real docker, make or node is ever run) and canned fetch functions (no network).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RunOptions, RunResult, Runner } from '../src/runner.ts';
import { type Io, run } from '../src/run.ts';
import { CHECKOUT_FILES } from '../src/stack.ts';

export interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything any unit test's CLI run printed, for the secret non-disclosure check. */
export const transcript: string[] = [];

const tempDirs: string[] = [];
process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix = 'autologger-dev-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A value that must never appear in any output. */
export const SECRET = 'S3cr3t-value-0f-the-dev-stack-9f8e7d6c';
export const GOOGLE_SECRET = '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234';
export const GOOGLE_ID = '123456789-abcdefg.apps.googleusercontent.com';

/** connect's dev_mcp_token (and doctor's google_client fix) for slot 0's default server, word for word. */
export const DEV_TOKEN_8787 =
  "get import_tokens_command from autologger-mcp's `status --server https://localhost:8787 --json` (the autologger-mcp sign-in skill runs it; it is the whole make dev-mcp-token line, piped into autologger-mcp's import-tokens in its full npx form) and run that line in the autologger-2 checkout with the user's email for <address>";

/** connect's autologger_mcp_login for a server, word for word. */
export function loginHint(server: string): string {
  return `get login_command from autologger-mcp's \`status --server ${server} --json\` (the autologger-mcp sign-in skill runs it; it is the full npx form of login) and run that line yourself in a terminal`;
}

export const TEST_CA = readFileSync(new URL('./fixtures/test-ca.crt', import.meta.url), 'utf8');

export interface FixtureOptions {
  /** Create the checkout files (default true). */
  checkout?: boolean;
  /** Write .env.openbao.dev in the checkout (default true). */
  credentials?: boolean;
  /** overrides.env text; undefined leaves the file out. */
  overrides?: string;
  /** Write secrets.json and secret_id (default true). */
  secrets?: boolean;
}

export interface Fixture {
  repo: string;
  home: string;
  stateDir: string;
  env: Record<string, string>;
}

export const GOOD_OVERRIDES = `# overrides\nGOOGLE_CLIENT_ID=${GOOGLE_ID}\nGOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}\nCUSTOM_DASHBOARDS_ENABLED=1\nDEEPGRAM_API_KEY=${SECRET}\n`;

export function fixture(opts: FixtureOptions = {}): Fixture {
  const root = tempDir();
  const repo = join(root, 'autologger-2');
  const home = join(root, 'home');
  const stateDir = join(home, '.autologger-local-openbao');
  mkdirSync(repo, { recursive: true });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (opts.checkout ?? true) {
    for (const f of CHECKOUT_FILES) {
      mkdirSync(dirname(join(repo, f)), { recursive: true });
      writeFileSync(join(repo, f), '# fake\n');
    }
  }
  if (opts.credentials ?? true) {
    writeFileSync(
      join(repo, '.env.openbao.dev'),
      `BAO_ADDR=https://127.0.0.1:8200\nBAO_CACERT=${stateDir}/ca.pem\nBAO_ROLE_ID=role-${SECRET}\nBAO_SECRET_ID=${SECRET}\nBAO_KV_PATH=kv/autologger/dev\n`,
      { mode: 0o600 },
    );
  }
  if (opts.overrides !== undefined) writeFileSync(join(stateDir, 'overrides.env'), opts.overrides, { mode: 0o600 });
  if (opts.secrets ?? true) {
    writeFileSync(join(stateDir, 'secrets.json'), JSON.stringify({ JWT_SECRET: SECRET, MCP_SIGNING_SECRET: `mcp-${SECRET}` }), { mode: 0o600 });
    writeFileSync(join(stateDir, 'secret_id'), `${SECRET}\n`, { mode: 0o600 });
  }
  return { repo, home, stateDir, env: { HOME: home, PATH: '/usr/bin:/bin' } };
}

export interface Call {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: Readonly<Record<string, string | undefined>> | undefined;
}

export type Handler = (call: Call, options: RunOptions) => Partial<RunResult> | undefined;

/**
 * A scripted runner. `handlers` is keyed by "command arg1" (the first argument), e.g. "docker info",
 * "make dev-up"; a missing key falls back to `defaults`. Every call is recorded in `calls`.
 */
export function fakeRunner(handlers: Record<string, Handler | Partial<RunResult>> = {}): Runner & { calls: Call[] } {
  const calls: Call[] = [];
  const runner = async (command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> => {
    const call: Call = { command, args: [...args], cwd: options.cwd, env: options.env };
    calls.push(call);
    const key = `${command} ${args[0] ?? ''}`;
    const handler = handlers[key] ?? DEFAULTS[key] ?? { code: 0 };
    const partial = typeof handler === 'function' ? (handler(call, options) ?? { code: 0 }) : handler;
    const result: RunResult = { code: 0, stdout: '', stderr: '', ...partial };
    if (options.onOutput !== undefined) {
      if (result.stdout !== '') options.onOutput(result.stdout);
      if (result.stderr !== '') options.onOutput(result.stderr);
      return { ...result, stdout: '', stderr: '' };
    }
    return result;
  };
  return Object.assign(runner, { calls });
}

const DEFAULTS: Record<string, Partial<RunResult>> = {
  'docker info': { code: 0, stdout: '28.5.2\n' },
  'docker container': { code: 0, stdout: 'true\n' },
  'make --version': { code: 0, stdout: 'GNU Make 4.4.1\nCopyright\n' },
  'node --version': { code: 0, stdout: 'v22.18.0\n' },
  'make dev-ca': { code: 0, stdout: TEST_CA },
  'git remote': { code: 0, stdout: 'https://github.com/kwcantrell/autologger-2.git\n' },
};

/**
 * Variables a caller (an outer make, a stage shell) may have set that must not reach make: they
 * would point it at another slot, a stage stack or a reset, or add flags and variables to it.
 */
export const INHERITED: Record<string, string> = {
  CONFIRM: 'yes',
  DEV_SLOT: '3',
  DEV_HTTPS: '0',
  EMAIL: 'someone@example.com',
  STAGE_IMAGE_TAG: 'abc',
  MAKEFLAGS: 'w -- CONFIRM=yes',
  GNUMAKEFLAGS: '--print-directory',
  MFLAGS: '-w',
  MAKELEVEL: '1',
  MAKEFILES: '/tmp/evil.mk',
};

export const NOT_FOUND: Partial<RunResult> = { code: null, error: 'ENOENT' };

/** fetch that answers every request with this status. */
export function answering(status = 200, body = ''): typeof fetch {
  return async () => new Response(status === 204 ? null : body, { status });
}

/** fetch that fails the way undici does for a refused connection. */
export const refused: typeof fetch = async () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8787' } });
};

/** fetch that fails the way undici does for an untrusted certificate. */
export const untrusted: typeof fetch = async () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'self-signed certificate in certificate chain' } });
};

export interface CliOptions {
  env?: Record<string, string>;
  cwd?: string;
  runner?: Runner;
  fetch?: typeof fetch;
}

export async function cli(opts: CliOptions, ...argv: string[]): Promise<Outcome> {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    env: opts.env ?? {},
    cwd: opts.cwd ?? tmpdir(),
    runner: opts.runner ?? fakeRunner(),
    fetch: opts.fetch ?? refused,
  };
  const code = await run(argv, io);
  transcript.push(stdout, stderr);
  return { code, stdout, stderr };
}
