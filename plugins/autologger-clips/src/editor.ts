// editor start|status|stop: the OpenReel web editor, cloned once at a pinned commit into
// ~/.autologger-clips/openreel/<sha>/, installed with pnpm, and run with `pnpm dev` in the
// background on 127.0.0.1. Only the process this CLI started (recorded in editor.json) is stopped.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { CliError, UsageError } from './errors.ts';
import { homeOf, type Env } from './media.ts';
import type { Runner } from './runner.ts';

export const OPENREEL_REPO = 'https://github.com/Augani/openreel-video.git';
/** OpenReel main on 2026-11-18 ("Sync OpenReel Desktop 1.0.0"), after tag v1.0.0-alpha.17. */
export const OPENREEL_COMMIT = '38c7e26c4d33a101f7fc5d5414a5ee0010623d74';
export const DEFAULT_PORT = 5173;
export const PORT_TRIES = 20;
export const INSTALLED_MARKER = '.autologger-clips-installed';
export const MIN_NODE_MAJOR = 18;

const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const SHA = /^[0-9a-f]{40}$/;

export const baseDir = (env: Env): string => join(homeOf(env), '.autologger-clips');
export const checkoutsDir = (env: Env): string => join(baseDir(env), 'openreel');
export const stateFile = (env: Env): string => join(baseDir(env), 'editor.json');
export const logFile = (env: Env): string => join(baseDir(env), 'editor.log');

export interface EditorState {
  pid: number;
  port: number;
  url: string;
  sha: string;
  dir: string;
  log: string;
  started_at: string;
}

export interface EditorContext {
  env: Env;
  runner: Runner;
  /** pnpm install / git output as it arrives. */
  log: (text: string) => void;
  /** How long start waits for the dev server to answer. */
  readyTimeoutMs?: number;
  now?: () => Date;
}

export function readState(env: Env): EditorState | null {
  const file = stateFile(env);
  if (!existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as EditorState;
    return Number.isInteger(s.pid) && s.pid > 0 && Number.isInteger(s.port) ? s : null;
  } catch {
    return null;
  }
}

function writeState(env: Env, state: EditorState): void {
  mkdirSync(baseDir(env), { recursive: true, mode: 0o700 });
  writeFileSync(stateFile(env), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

const clearState = (env: Env): void => rmSync(stateFile(env), { force: true });

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** On Linux, whether the pid still runs pnpm (so a recycled pid is never signalled); elsewhere, whether it is alive. */
export function ownedBy(pid: number): boolean {
  if (!alive(pid)) return false;
  const cmdline = `/proc/${pid}/cmdline`;
  if (!existsSync('/proc/self/cmdline')) return true;
  try {
    return readFileSync(cmdline, 'utf8').includes('pnpm');
  } catch {
    return false;
  }
}

export async function answers(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

const portFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });

export async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + PORT_TRIES; port++) if (await portFree(port)) return port;
  throw new CliError(`no free port in ${from}-${from + PORT_TRIES - 1} on 127.0.0.1; stop what uses them or pass --port`);
}

/** Checks git, node (>= 18) and pnpm, with the fix for each one that is missing. */
export async function checkTools(ctx: EditorContext): Promise<{ git: string; node: string; pnpm: string }> {
  const version = async (tool: string, fix: string): Promise<string> => {
    const r = await ctx.runner(tool, ['--version'], { env: ctx.env, timeoutMs: 30_000 });
    if (r.error === 'ENOENT') throw new CliError(`${tool} is not on PATH; ${fix}`);
    if (r.code !== 0) throw new CliError(`${tool} --version failed (${r.error ?? `exit ${r.code}`}); ${fix}`);
    return r.stdout.trim().split('\n')[0] ?? '';
  };
  const git = await version('git', 'install git (https://git-scm.com/downloads) and run editor start again');
  const node = await version('node', `install Node.js ${MIN_NODE_MAJOR} or newer (https://nodejs.org) and run editor start again`);
  const major = Number(/^v?(\d+)/.exec(node)?.[1] ?? 0);
  if (major < MIN_NODE_MAJOR) throw new CliError(`OpenReel needs Node.js ${MIN_NODE_MAJOR} or newer, and node on PATH is ${node}; install a newer Node.js and run editor start again`);
  const pnpm = await version('pnpm', 'install pnpm (https://pnpm.io/installation, for example `npm install -g pnpm` or `corepack enable pnpm`) and run editor start again');
  return { git, node, pnpm };
}

export function checkRef(ref: string): string {
  if (!REF.test(ref) || ref.includes('..')) throw new UsageError(`--ref '${ref}' is not a commit, tag or branch name`);
  return ref;
}

/** The checkout for `ref`: an existing one, or a fresh clone moved into place under its full sha. */
export async function ensureCheckout(ref: string, ctx: EditorContext): Promise<{ sha: string; dir: string; cloned: boolean }> {
  const root = checkoutsDir(ctx.env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const existing = existsSync(root) ? readdirSync(root).filter((d) => SHA.test(d) && statSync(join(root, d)).isDirectory()) : [];
  if (/^[0-9a-f]{7,40}$/.test(ref)) {
    const hits = existing.filter((d) => d.startsWith(ref));
    if (hits.length === 1) return { sha: hits[0] as string, dir: join(root, hits[0] as string), cloned: false };
  }
  const tmp = join(root, `.clone-${process.pid}-${Date.now()}`);
  const git = async (args: string[], what: string): Promise<string> => {
    const r = await ctx.runner('git', args, { env: ctx.env, onStderr: ctx.log });
    if (r.code !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      throw new CliError(`${what} failed (${r.error ?? `exit ${r.code}`}); git's messages are above`);
    }
    return r.stdout.trim();
  };
  await git(['clone', '--filter=blob:none', '--no-checkout', OPENREEL_REPO, tmp], `git clone ${OPENREEL_REPO}`);
  await git(['-C', tmp, '-c', 'advice.detachedHead=false', 'checkout', '--detach', ref], `git checkout ${ref}`);
  const sha = await git(['-C', tmp, 'rev-parse', 'HEAD'], 'git rev-parse HEAD');
  if (!SHA.test(sha)) {
    rmSync(tmp, { recursive: true, force: true });
    throw new CliError(`git rev-parse printed '${sha}', not a commit sha`);
  }
  const dir = join(root, sha);
  if (existsSync(dir)) {
    rmSync(tmp, { recursive: true, force: true });
    return { sha, dir, cloned: false };
  }
  renameSync(tmp, dir);
  return { sha, dir, cloned: true };
}

export interface StartOptions {
  ref?: string;
  port?: number;
}

export interface StartResult extends EditorState {
  already_running: boolean;
  cloned: boolean;
  installed: boolean;
}

export async function startEditor(options: StartOptions, ctx: EditorContext): Promise<StartResult> {
  const ref = checkRef(options.ref ?? OPENREEL_COMMIT);
  const current = readState(ctx.env);
  if (current && ownedBy(current.pid)) {
    if (await answers(current.url)) return { ...current, already_running: true, cloned: false, installed: false };
    throw new CliError(`the editor started earlier (pid ${current.pid}) is running but ${current.url} does not answer; run editor stop, then editor start`);
  }
  if (current) clearState(ctx.env);

  await checkTools(ctx);
  const { sha, dir, cloned } = await ensureCheckout(ref, ctx);
  let installed = false;
  if (!existsSync(join(dir, INSTALLED_MARKER))) {
    ctx.log(`autologger-clips: pnpm install in ${dir} (first start; this takes a few minutes)\n`);
    const r = await ctx.runner('pnpm', ['install', '--frozen-lockfile'], { cwd: dir, env: ctx.env, onStderr: ctx.log, onStdout: ctx.log });
    if (r.code !== 0) throw new CliError(`pnpm install failed in ${dir} (${r.error ?? `exit ${r.code}`}); its messages are above`);
    writeFileSync(join(dir, INSTALLED_MARKER), `${(ctx.now?.() ?? new Date()).toISOString()}\n`);
    installed = true;
  }

  const port = options.port ?? (await freePort(DEFAULT_PORT));
  if (options.port !== undefined && !(await portFree(port))) throw new CliError(`port ${port} on 127.0.0.1 is in use; pass another --port or leave it out`);
  const url = `http://127.0.0.1:${port}/`;
  const log = logFile(ctx.env);
  mkdirSync(baseDir(ctx.env), { recursive: true, mode: 0o700 });
  const fd = openSync(log, 'a', 0o600);
  let child;
  try {
    child = spawn('pnpm', ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: dir,
      env: ctx.env as NodeJS.ProcessEnv,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  const spawnError = new Promise<string>((resolve) => child.once('error', (e) => resolve(e.message)));
  let exited: number | null | undefined;
  child.once('exit', (code) => (exited = code));
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new CliError(`could not start pnpm dev: ${await spawnError}`);
  const state: EditorState = { pid, port, url, sha, dir, log, started_at: (ctx.now?.() ?? new Date()).toISOString() };
  writeState(ctx.env, state);

  const deadline = Date.now() + (ctx.readyTimeoutMs ?? 180_000);
  while (Date.now() < deadline) {
    if (await answers(url)) return { ...state, already_running: false, cloned, installed };
    if (exited !== undefined || !alive(pid)) {
      clearState(ctx.env);
      throw new CliError(`pnpm dev exited (code ${exited ?? 'unknown'}) before ${url} answered; the end of ${log}:\n${tail(log)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new CliError(`${url} did not answer within ${Math.round((ctx.readyTimeoutMs ?? 180_000) / 1000)} s; pnpm dev (pid ${pid}) is still running; check ${log}, then editor status, or editor stop`);
}

function tail(file: string, lines = 15): string {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

export interface StatusResult {
  running: boolean;
  answers: boolean;
  url: string | null;
  pid: number | null;
  port: number | null;
  sha: string | null;
  dir: string | null;
  log: string | null;
  started_at: string | null;
}

export async function editorStatus(env: Env): Promise<StatusResult> {
  const s = readState(env);
  if (!s) return { running: false, answers: false, url: null, pid: null, port: null, sha: null, dir: null, log: null, started_at: null };
  const running = ownedBy(s.pid);
  return { running, answers: running && (await answers(s.url)), url: s.url, pid: s.pid, port: s.port, sha: s.sha, dir: s.dir, log: s.log, started_at: s.started_at };
}

export interface StopResult {
  stopped: boolean;
  pid: number | null;
  reason?: string;
}

export async function stopEditor(env: Env, graceMs = 10_000): Promise<StopResult> {
  const s = readState(env);
  if (!s) return { stopped: false, pid: null, reason: 'no editor was started by autologger-clips' };
  if (!alive(s.pid)) {
    clearState(env);
    return { stopped: false, pid: s.pid, reason: 'it was no longer running' };
  }
  if (!ownedBy(s.pid)) {
    clearState(env);
    return { stopped: false, pid: s.pid, reason: `pid ${s.pid} is no longer pnpm dev; it was left alone` };
  }
  // pnpm dev runs in its own process group (started detached), so the group holds vite too.
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-s.pid, sig);
    } catch {
      try {
        process.kill(s.pid, sig);
      } catch {
        // already gone
      }
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (alive(s.pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (alive(s.pid)) signal('SIGKILL');
  clearState(env);
  return { stopped: true, pid: s.pid };
}
