// The dev CA file: exactly one public PEM certificate (what `autologger-dev ca` writes).
import { X509Certificate } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export type CaFile =
  | { ok: true; path: string; pem: string; cert: X509Certificate; fingerprint256: string; subject: string }
  | { ok: false; path: string; state: 'missing' | 'invalid'; reason: string };

const MAX_BYTES = 64 * 1024;

/**
 * The single certificate in `text`, or why it is refused: one `-----BEGIN CERTIFICATE-----` block
 * and nothing else (whitespace aside), and nothing that looks like a private key.
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

/** Reads and checks the CA file; the file's text is never put in a message. */
export function readCaFile(path: string): CaFile {
  let text;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { ok: false, path, state: 'invalid', reason: 'it is not a regular file' };
    if (stat.size > MAX_BYTES) return { ok: false, path, state: 'invalid', reason: 'it is too large to be one certificate' };
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, path, state: 'missing', reason: 'it does not exist' };
    return { ok: false, path, state: 'invalid', reason: `it cannot be read (${code ?? 'error'})` };
  }
  const found = singleCertificate(text);
  if (!found.ok) return { ok: false, path, state: 'invalid', reason: found.reason };
  return { ok: true, path, pem: found.pem, cert: found.cert, fingerprint256: found.cert.fingerprint256, subject: found.cert.subject.replaceAll('\n', ', ') };
}
