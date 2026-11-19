// ca: fetches the HTTPS-mode dev stack's root CA certificate (`DEV_HTTPS=1 make dev-ca`), checks it
// is exactly one public PEM certificate, and writes it where NODE_EXTRA_CA_CERTS can point.
import { X509Certificate } from 'node:crypto';
import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { CliError } from './errors.ts';
import { type Env, shellQuote } from './http.ts';
import type { Runner } from './runner.ts';
import { type Checkout, childEnv, verifyCheckout } from './stack.ts';

export const CA_COMMAND = 'DEV_HTTPS=1 make dev-ca';

export interface CaReport {
  path: string;
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

/** Writes `pem` to `path` (mode 644) without following a symlink planted there since the check. */
function writeCertificate(path: string, pem: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    fchmodSync(fd, 0o644);
    writeSync(fd, pem);
  } finally {
    closeSync(fd);
  }
}

export async function fetchCa(ctx: CaContext): Promise<CaReport> {
  const { checkout } = ctx;
  await verifyCheckout(checkout, ctx.runner, ctx.env);
  const before = outRefusal(ctx.out);
  if (before !== null) throw refuseOut(ctx.out, before);
  const result = await ctx.runner('make', ['dev-ca'], { cwd: checkout.path, env: childEnv(ctx.env, { DEV_HTTPS: '1' }), timeoutMs: 120_000 });
  if (result.error === 'ENOENT') throw new CliError('make is not on PATH');
  if (result.stderr !== '') ctx.diagnostics(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  if (result.code !== 0) {
    throw new CliError(
      `${CA_COMMAND} failed (${result.code === null ? 'it did not finish' : `exit ${result.code}`}); is the stack up in HTTPS mode? Run autologger-dev up first`,
    );
  }
  const found = singleCertificate(result.stdout);
  if (!found.ok) throw new CliError(`refusing the output of ${CA_COMMAND}: ${found.reason}; nothing was written`);

  const after = outRefusal(ctx.out);
  if (after !== null) throw refuseOut(ctx.out, after);
  try {
    mkdirSync(dirname(ctx.out), { recursive: true });
    writeCertificate(ctx.out, found.pem);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw refuseOut(ctx.out, 'it is a symlink');
    throw new CliError(`cannot write ${ctx.out}: ${(error as Error).message}`);
  }
  return {
    path: ctx.out,
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
