import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Io, run } from '../src/run.ts';
import { CredentialStore, type Credentials } from '../src/store.ts';
import { browse } from './fakeServer.ts';

export interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything any test's CLI run printed, for the token non-disclosure check. */
export const transcript: string[] = [];

const tempDirs: string[] = [];
process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

export function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autologger-mcp-test-'));
  tempDirs.push(dir);
  return dir;
}

export interface CallOptions {
  configDir: string;
  server?: string;
  now?: () => number;
  openUrl?: Io['openUrl'];
  fetch?: Io['fetch'];
  stdin?: string;
  env?: Record<string, string>;
  sleep?: Io['sleep'];
}

export async function cli(opts: CallOptions, ...argv: string[]): Promise<Outcome> {
  let stdout = '';
  let stderr = '';
  const env: Record<string, string> = {
    AUTOLOGGER_MCP_CONFIG_DIR: opts.configDir,
    HOME: opts.configDir,
    ...(opts.server !== undefined ? { AUTOLOGGER_URL: opts.server } : {}),
    ...opts.env,
  };
  const code = await run(argv, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    env,
    openUrl: opts.openUrl ?? ((url) => void browse(url)),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.stdin !== undefined ? { readStdin: async () => opts.stdin ?? '' } : {}),
  });
  transcript.push(stdout, stderr);
  return { code, stdout, stderr };
}

export function storedCredentials(configDir: string, server: string): Credentials {
  const store = new CredentialStore({ AUTOLOGGER_MCP_CONFIG_DIR: configDir }, server);
  return JSON.parse(readFileSync(store.path, 'utf8')) as Credentials;
}

export function credentialsPath(configDir: string, server: string): string {
  return new CredentialStore({ AUTOLOGGER_MCP_CONFIG_DIR: configDir }, server).path;
}

export const HOUR = 60 * 60 * 1000;
