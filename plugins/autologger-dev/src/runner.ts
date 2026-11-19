// Running other programs (docker, make, node). Commands take a Runner so tests can inject a fake
// one: no test runs real docker or make.
import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** When given, the child's stdout and stderr go here as they arrive instead of being captured. */
  onOutput?: (text: string) => void;
  /** Kill the child after this many ms. */
  timeoutMs?: number;
}

export interface RunResult {
  /** Exit code, or null when the program did not start or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 'ENOENT' when the program is not on PATH; another message when it could not be started. */
  error?: string;
}

export type Runner = (command: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;

/** The real runner: spawn without a shell (arguments are never parsed by one). */
export const spawnRunner: Runner = (command, args, options = {}) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: (options.env ?? process.env) as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (options.timeoutMs !== undefined) timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (options.onOutput ? options.onOutput(chunk) : (stdout += chunk)));
    child.stderr.on('data', (chunk: string) => (options.onOutput ? options.onOutput(chunk) : (stderr += chunk)));
    child.on('error', (error: NodeJS.ErrnoException) => done({ code: null, stdout, stderr, error: error.code === 'ENOENT' ? 'ENOENT' : error.message }));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
