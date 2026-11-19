// ca: fetches the HTTPS-mode dev stack's root CA certificate (`DEV_HTTPS=1 make dev-ca`), checks it
// is exactly one public PEM certificate, and writes it where NODE_EXTRA_CA_CERTS can point.
import { X509Certificate } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CliError } from './errors.ts';
import { type Env, shellQuote } from './http.ts';
import type { Runner } from './runner.ts';
import { type Checkout, childEnv } from './stack.ts';

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

export async function fetchCa(ctx: CaContext): Promise<CaReport> {
  const { checkout } = ctx;
  if (checkout.missing.length > 0) {
    throw new CliError(
      `${checkout.path} (from ${checkout.source}) is not an autologger-2 checkout (no ${checkout.missing.join(', ')}); pass --repo <path> or set AUTOLOGGER_REPO`,
    );
  }
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

  try {
    mkdirSync(dirname(ctx.out), { recursive: true });
    writeFileSync(ctx.out, found.pem, { mode: 0o644 });
    chmodSync(ctx.out, 0o644);
  } catch (error) {
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
