// The slot's private NSS database, read and written only with certutil (Debian libnss3-tools) and
// only ever with `-d sql:<the slot's nssdb>`: never the user's ~/.pki/nssdb or
// ~/.local/share/pki/nssdb, the system trust store or any other database.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { singleCertificate } from './cert.ts';
import { CliError } from './errors.ts';
import type { Env } from './slot.ts';
import type { Runner } from './runner.ts';

/** The nickname the dev CA has in the slot's database. */
export const NICKNAME = 'autologger-dev-ca';
/** Trusted as a CA for TLS server certificates only: not for e-mail (S/MIME) or code signing. */
export const TRUST = 'C,,';

export const CERTUTIL_FIX = 'install certutil: sudo apt-get install libnss3-tools (or agent-browser install --with-deps)';

export interface Nss {
  runner: Runner;
  env: Env;
  /** The database directory (sql: format). */
  dir: string;
}

export type TrustState =
  | { state: 'no database' }
  | { state: 'absent' }
  /** Present: the trust flags and each certificate stored under the nickname (fingerprints). */
  | { state: 'present'; trust: string; fingerprints: string[] };

async function certutil(nss: Nss, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const result = await nss.runner('certutil', ['-d', `sql:${nss.dir}`, ...args], { env: nss.env, timeoutMs: 30_000 });
  if (result.error === 'ENOENT') throw new CliError(`certutil is not on PATH; ${CERTUTIL_FIX}`);
  if (result.error !== undefined) throw new CliError(`certutil could not be started: ${result.error}`);
  return result;
}

export function hasDatabase(dir: string): boolean {
  return existsSync(join(dir, 'cert9.db'));
}

/**
 * Parses `certutil -L` output: a header, then one `<nickname>   <trust>` line per certificate,
 * the trust being the last whitespace-separated word.
 */
export function parseList(stdout: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const match = /^(.*\S)\s+(\S*,\S*,\S*)\s*$/.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) continue;
    if (/^Certificate Nickname\b/.test(match[1])) continue;
    entries.set(match[1].trim(), match[2]);
  }
  return entries;
}

/** What the database holds for NICKNAME. Read-only. */
export async function readTrust(nss: Nss): Promise<TrustState> {
  if (!hasDatabase(nss.dir)) return { state: 'no database' };
  const list = await certutil(nss, ['-L']);
  if (list.code !== 0) throw new CliError(`certutil -L failed (exit ${list.code ?? 'killed'}) on ${nss.dir}`);
  const trust = parseList(list.stdout).get(NICKNAME);
  if (trust === undefined) return { state: 'absent' };
  const exported = await certutil(nss, ['-L', '-n', NICKNAME, '-a']);
  if (exported.code !== 0) throw new CliError(`certutil -L -n ${NICKNAME} failed (exit ${exported.code ?? 'killed'})`);
  const fingerprints = [...exported.stdout.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)].flatMap((m) => {
    const found = singleCertificate(m[0]);
    return found.ok ? [found.cert.fingerprint256] : [];
  });
  return { state: 'present', trust, fingerprints };
}

/** True when the database trusts exactly the certificate with `fingerprint256`, as TRUST, under NICKNAME. */
export function trustsExactly(state: TrustState, fingerprint256: string): boolean {
  return state.state === 'present' && state.trust === TRUST && state.fingerprints.length === 1 && state.fingerprints[0] === fingerprint256;
}

/** Creates an empty database (no password) in nss.dir, which must exist. */
export async function createDatabase(nss: Nss): Promise<void> {
  const result = await certutil(nss, ['-N', '--empty-password']);
  if (result.code !== 0) throw new CliError(`certutil -N failed (exit ${result.code ?? 'killed'}) creating ${nss.dir}`);
}

/** Removes every certificate stored under NICKNAME (certutil -D removes one per call). */
export async function removeCa(nss: Nss): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const state = await readTrust(nss);
    if (state.state !== 'present') return;
    const result = await certutil(nss, ['-D', '-n', NICKNAME]);
    if (result.code !== 0) throw new CliError(`certutil -D -n ${NICKNAME} failed (exit ${result.code ?? 'killed'})`);
  }
  throw new CliError(`certutil -D did not remove ${NICKNAME} from ${nss.dir}`);
}

/** Adds the CA file under NICKNAME, trusted as TRUST. */
export async function addCa(nss: Nss, caPath: string): Promise<void> {
  const result = await certutil(nss, ['-A', '-n', NICKNAME, '-t', TRUST, '-i', caPath]);
  if (result.code !== 0) throw new CliError(`certutil -A failed (exit ${result.code ?? 'killed'}) adding ${caPath}`);
}
