// Running other programs (agent-browser, certutil, chromium). Commands take a Runner so tests can
// inject a fake one: no unit test runs a real browser or certutil.
import { spawn } from 'node:child_process';

export interface RunOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** Written to the child's stdin, which is then closed. Without it stdin is /dev/null. */
  input?: string;
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
      env: (options.env ?? process.env) as NodeJS.ProcessEnv,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (options.timeoutMs !== undefined) timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.on('data', (chunk: string) => (stderr += chunk));
    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        // The child exited before reading its input; its exit code says why.
      });
      child.stdin.end(options.input);
    }
    child.on('error', (error: NodeJS.ErrnoException) => done({ code: null, stdout, stderr, error: error.code === 'ENOENT' ? 'ENOENT' : error.message }));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
