// ca: fetches the HTTPS-mode dev stack's root CA certificate (`DEV_HTTPS=1 make dev-ca`), checks it
// is exactly one public PEM certificate, and writes it where NODE_EXTRA_CA_CERTS can point.
import { randomBytes, X509Certificate } from 'node:crypto';
import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { CliError } from './errors.ts';
import { type Env, shellQuote } from './http.ts';
import type { Runner } from './runner.ts';
import { cliCommand, slotEnv, slotPrefix } from './slot.ts';
import { type Checkout, childEnv, verifyCheckout } from './stack.ts';

export const CA_COMMAND = 'DEV_HTTPS=1 make dev-ca';

/**
 * The command line `ca` runs for the slot: DEV_HTTPS=1 DEV_SLOT=N make dev-ca for slot N. Every slot
 * prints the same root (ADR 0038: one dev CA, slot 0's volume, shared by every slot), but the make
 * target reads it from that slot's own gate, so the slot must be up.
 */
export function caCommand(slot: number): string {
  return `DEV_HTTPS=1 ${slotPrefix(slot)}make dev-ca`;
}

export interface CaReport {
  path: string;
  /** The dev slot whose gate printed the (shared) root CA. */
  slot: number;
  subject: string;
  fingerprint256: string;
  valid_to: string;
  is_ca: boolean;
  export: string;
}

/**
 * The single certificate in `text`, or why it is refused. The output must be one
 * `-----BEGIN CERTIFICATE-----` block and nothing else (whitespace aside), with nothing that looks
 * like a private key. The text itself is never put in a message.
 */
export function singleCertificate(text: string): { ok: true; pem: string; cert: X509Certificate } | { ok: false; reason: string } {
  if (/PRIVATE KEY/i.test(text)) return { ok: false, reason: 'it contains something that looks like a private key' };
  const blocks = [...text.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g)];
  if (blocks.length === 0) return { ok: false, reason: 'it holds no PEM certificate' };
  if (blocks.length > 1) return { ok: false, reason: `it holds ${blocks.length} PEM blocks, not one certificate` };
  const block = blocks[0];
  if (block === undefined || block[1] !== 'CERTIFICATE') return { ok: false, reason: 'its PEM block is not a CERTIFICATE' };
  if (text.replace(block[0], '').trim() !== '') return { ok: false, reason: 'it holds other text besides the PEM certificate' };
  try {
    return { ok: true, pem: `${block[0]}\n`, cert: new X509Certificate(block[0]) };
  } catch {
    return { ok: false, reason: 'its PEM block is not a valid X.509 certificate' };
  }
}

export interface CaContext {
  env: Env;
  runner: Runner;
  checkout: Checkout;
  /** The dev slot (0, the default stack, when left out). */
  slot?: number;
  /** Absolute path to write the certificate to. */
  out: string;
  /** Receives make's own stderr (diagnostics), scrubbed by the caller. */
  diagnostics: (text: string) => void;
}

/** An existing file larger than this is not a CA certificate `ca` wrote. */
const MAX_EXISTING_BYTES = 64 * 1024;

/**
 * Why `ca` may not write `path`, or null when it may: it does not exist, or it is a regular file
 * holding exactly one PEM certificate (an earlier `ca` run's file, which is replaced). A directory,
 * symlink, other special file or any other content is refused, so an unrelated file is never
 * clobbered. The file's text is never put in a message.
 */
export function outRefusal(path: string): string | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : `it cannot be inspected (${(error as NodeJS.ErrnoException).code ?? 'error'})`;
  }
  if (stat.isSymbolicLink()) return 'it is a symlink';
  if (stat.isDirectory()) return 'it is a directory';
  if (!stat.isFile()) return 'it is not a regular file';
  if (stat.size > MAX_EXISTING_BYTES) return 'it exists and is not a single PEM certificate';
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return `it exists and cannot be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`;
  }
  return singleCertificate(text).ok ? null : 'it exists and is not a single PEM certificate';
}

function refuseOut(path: string, why: string): CliError {
  return new CliError(`refusing to write ${path}: ${why}; only a missing file or an existing single-certificate file is replaced. Nothing was written; pass another --out`);
}

/** The file operations writeCertificate uses; tests swap one for a failing fake. */
export interface WriteOps {
  write: (fd: number, text: string) => void;
  rename: (from: string, to: string) => void;
}

const FS_OPS: WriteOps = {
  write: (fd, text) => {
    writeSync(fd, text);
  },
  rename: renameSync,
};

/**
 * Replaces `path` with `pem` (mode 644) atomically: the certificate goes to a new temp file in the
 * same directory (created exclusively, never through a symlink), `path` is checked again with
 * outRefusal, and the temp file is renamed over it. Nothing at `path` is ever written in place, so a
 * file swapped in there is replaced as a whole or refused, never overwritten; on any failure the
 * temp file is removed, `path` is left as it was, and the parent folders this call created are
 * removed again (see removeCreatedDirs), so nothing is left behind.
 */
export function writeCertificate(path: string, pem: string, ops: WriteOps = FS_OPS): void {
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  let created = false;
  let firstCreated: string | undefined;
  let done = false;
  try {
    firstCreated = mkdirSync(dir, { recursive: true });
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    created = true;
    try {
      fchmodSync(fd, 0o644);
      ops.write(fd, pem);
    } finally {
      closeSync(fd);
    }
    const refusal = outRefusal(path);
    if (refusal !== null) throw refuseOut(path, refusal);
    ops.rename(temp, path);
    created = false;
    done = true;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`cannot write ${path}: ${(error as Error).message}; nothing was written`);
  } finally {
    if (created) {
      try {
        unlinkSync(temp);
      } catch {
        // Already gone: nothing to clean up.
      }
    }
    if (!done && firstCreated !== undefined) removeCreatedDirs(dir, firstCreated);
  }
}

/**
 * Removes `dir` and its parents up to and including `firstCreated` (the first folder
 * `mkdirSync(dir, { recursive: true })` created), deepest first, each only if it is empty; it stops
 * at the first that cannot be removed. Folders above `firstCreated` existed before and are never
 * touched.
 */
export function removeCreatedDirs(dir: string, firstCreated: string): void {
  if (dir !== firstCreated && !dir.startsWith(`${firstCreated}${sep}`)) return;
  for (let current = dir; ; current = dirname(current)) {
    try {
      rmdirSync(current);
    } catch {
      return; // Not empty, or already gone: leave it and everything above it.
    }
    if (current === firstCreated || dirname(current) === current) return;
  }
}

export async function fetchCa(ctx: CaContext): Promise<CaReport> {
  const { checkout } = ctx;
  const slot = ctx.slot ?? 0;
  const command = caCommand(slot);
  await verifyCheckout(checkout, ctx.runner, ctx.env);
  const before = outRefusal(ctx.out);
  if (before !== null) throw refuseOut(ctx.out, before);
  const result = await ctx.runner('make', ['dev-ca'], { cwd: checkout.path, env: childEnv(ctx.env, { DEV_HTTPS: '1', ...slotEnv(slot) }), timeoutMs: 120_000 });
  if (result.error === 'ENOENT') throw new CliError('make is not on PATH');
  if (result.stderr !== '') ctx.diagnostics(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  if (result.code !== 0) {
    throw new CliError(
      `${command} failed (${result.code === null ? 'it did not finish' : `exit ${result.code}`}); is the stack up in HTTPS mode? Run ${cliCommand('up', slot)} first`,
    );
  }
  const found = singleCertificate(result.stdout);
  if (!found.ok) throw new CliError(`refusing the output of ${command}: ${found.reason}; nothing was written`);

  writeCertificate(ctx.out, found.pem);
  return {
    path: ctx.out,
    slot,
    subject: found.cert.subject.replaceAll('\n', ', '),
    fingerprint256: found.cert.fingerprint256,
    valid_to: new Date(found.cert.validTo).toISOString(),
    is_ca: found.cert.ca,
    export: exportLine(ctx.out),
  };
}

export function exportLine(path: string): string {
  return `export NODE_EXTRA_CA_CERTS=${shellQuote(path)}`;
}

export function formatCa(report: CaReport): string {
  return [
    `Wrote the dev stack's root CA (${report.subject}, valid to ${report.valid_to}) to ${report.path}.`,
    'Trust it in Node: set this in the environment Claude Code starts in, then restart Claude Code',
    '(Node reads NODE_EXTRA_CA_CERTS only at startup):',
    `  ${report.export}`,
    '',
  ].join('\n');
}
