// Running other programs (git, pnpm, yt-dlp, claude). Commands take a Runner so tests can inject a
// fake one; the end-to-end test puts fake programs on PATH instead.
import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** When given, the child's stderr goes here as it arrives instead of being captured. */
  onStderr?: (text: string) => void;
  /** When given, the child's stdout goes here as it arrives (and is captured as well). */
  onStdout?: (text: string) => void;
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
    let timer: NodeJS.Timeout | undefined;
    const done = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: (options.env ?? process.env) as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (options.timeoutMs !== undefined) timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr.on('data', (chunk: string) => (options.onStderr ? options.onStderr(chunk) : (stderr += chunk)));
    child.on('error', (error: NodeJS.ErrnoException) => done({ code: null, stdout, stderr, error: error.code === 'ENOENT' ? 'ENOENT' : error.message }));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
