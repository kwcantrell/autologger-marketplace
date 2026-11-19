// Shared test helpers: a fake Io, and fake runners for certutil, agent-browser and chromium. The fake
// certutil keeps its state in the database folder it is given (`-d sql:<dir>`), so setup and doctor
// see the same database across calls, as with the real one.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Io } from '../src/run.ts';
import type { RunOptions, RunResult, Runner } from '../src/runner.ts';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const CA1 = join(FIXTURES, 'test-ca-1.crt');
export const CA2 = join(FIXTURES, 'test-ca-2.crt');

export interface Call {
  command: string;
  args: string[];
  options: RunOptions | undefined;
}

export interface Fake {
  runner: Runner;
  calls: Call[];
}

const HEADER = 'Certificate Nickname                                         Trust Attributes\n                                                             SSL,S/MIME,JAR/XPI\n\n';

/** One certutil call against the fake database in `-d sql:<dir>`. */
export function fakeCertutil(args: readonly string[]): RunResult {
  const d = args.indexOf('-d');
  const spec = args[d + 1] ?? '';
  if (d < 0 || !spec.startsWith('sql:')) return { code: 1, stdout: '', stderr: 'no -d sql:' };
  const dir = spec.slice(4);
  const pem = join(dir, 'fake-ca.pem');
  const trustFile = join(dir, 'fake-trust');
  const op = args[d + 2];
  if (op === '-N') {
    writeFileSync(join(dir, 'cert9.db'), 'fake');
    return { code: 0, stdout: '', stderr: '' };
  }
  if (!existsSync(join(dir, 'cert9.db'))) return { code: 255, stdout: '', stderr: 'no database' };
  if (op === '-L' && !args.includes('-n')) {
    return { code: 0, stdout: existsSync(pem) ? `${HEADER}autologger-dev-ca                                            ${readFileSync(trustFile, 'utf8')}  \n` : HEADER, stderr: '' };
  }
  if (op === '-L') return existsSync(pem) ? { code: 0, stdout: readFileSync(pem, 'utf8'), stderr: '' } : { code: 255, stdout: '', stderr: 'not found' };
  if (op === '-D') {
    rmSync(pem, { force: true });
    rmSync(trustFile, { force: true });
    return { code: 0, stdout: '', stderr: '' };
  }
  if (op === '-A') {
    const input = args[args.indexOf('-i') + 1] ?? '';
    copyFileSync(input, pem);
    writeFileSync(trustFile, args[args.indexOf('-t') + 1] ?? '');
    return { code: 0, stdout: '', stderr: '' };
  }
  return { code: 1, stdout: '', stderr: `fake certutil: unexpected ${args.join(' ')}` };
}

export interface FakeOptions {
  certutil?: boolean;
  agentBrowser?: boolean;
  /** What agent-browser batch prints (default: one successful result). */
  batchStdout?: string;
  batchCode?: number;
}

/** A runner faking certutil, agent-browser and any chromium, recording every call. */
export function fakeRunner(options: FakeOptions = {}): Fake {
  const calls: Call[] = [];
  const runner: Runner = async (command, args, opts) => {
    calls.push({ command, args: [...args], options: opts });
    if (command === 'certutil') {
      if (options.certutil === false) return { code: null, stdout: '', stderr: '', error: 'ENOENT' };
      if (args[0] === '-H') return { code: 1, stdout: '', stderr: 'usage' };
      return fakeCertutil(args);
    }
    if (command === 'agent-browser') {
      if (options.agentBrowser === false) return { code: null, stdout: '', stderr: '', error: 'ENOENT' };
      if (args[0] === '--version') return { code: 0, stdout: 'agent-browser 0.43.0\n', stderr: '' };
      if (args.includes('batch')) {
        return { code: options.batchCode ?? 0, stdout: options.batchStdout ?? '[{"error":null,"index":0,"result":{"set":true},"success":true}]\n', stderr: '' };
      }
      return { code: 0, stdout: '✓ Browser closed\n', stderr: '' };
    }
    if (args[0] === '--version') return { code: 0, stdout: 'Chromium 156.0.0.0\n', stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected ${command}` };
  };
  return { runner, calls };
}

export interface Captured {
  io: Io;
  out: () => string;
  err: () => string;
}

export function capture(extra: Partial<Io> = {}): Captured {
  let out = '';
  let err = '';
  return {
    io: { stdout: (t) => (out += t), stderr: (t) => (err += t), ...extra },
    out: () => out,
    err: () => err,
  };
}

/** A temp HOME with a fake `chromium` on a private PATH, and the dev CA file in place (unless `ca` is false). */
export function tempHome(ca: string | false = CA1): { home: string; env: Record<string, string>; chromium: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'autologger-browser-test-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  for (const dir of [home, bin, join(home, '.autologger-dev')]) mkdirSync(dir, { recursive: true });
  const chromium = join(bin, 'chromium');
  writeFileSync(chromium, '#!/bin/sh\necho "Chromium 156.0.0.0"\n', { mode: 0o755 });
  if (ca !== false) copyFileSync(ca, join(home, '.autologger-dev', 'autologger-dev-ca.crt'));
  return { home, env: { HOME: home, PATH: bin }, chromium, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
