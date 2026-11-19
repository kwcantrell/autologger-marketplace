// doctor: what the slot's browser profile still needs, as named checks. Read-only: it runs
// `agent-browser --version`, `<chromium> --version`, `certutil -H` and `certutil -L` on the slot's
// own database, reads the CA file, and makes two HTTPS requests verified with the dev CA.
import { lstatSync } from 'node:fs';
import { readCaFile } from './cert.ts';
import { messageOf } from './errors.ts';
import { fileHolds } from './files.ts';
import { findChromium, launcherScript } from './launcher.ts';
import { CERTUTIL_FIX, NICKNAME, readTrust, TRUST, trustsExactly } from './nss.ts';
import type { Runner } from './runner.ts';
import { appOrigin, cliCommand, type Env, runtimeOrigin, slotPaths } from './slot.ts';
import { isTlsError, type Probe } from './tls.ts';

export type CheckStatus = 'ok' | 'missing' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  /** One line: what was found. */
  detail: string;
  /** One line: what to do about it; null when the check is ok. */
  fix: string | null;
}

export interface DoctorContext {
  env: Env;
  runner: Runner;
  probe: Probe;
  slot: number;
  ca: string;
}

export interface DoctorReport {
  slot: number;
  ok: boolean;
  checks: Check[];
}

const ok = (name: string, detail: string): Check => ({ name, status: 'ok', detail, fix: null });
const missing = (name: string, detail: string, fix: string): Check => ({ name, status: 'missing', detail, fix });
const fail = (name: string, detail: string, fix: string): Check => ({ name, status: 'fail', detail, fix });

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim();
}

function isDir(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function doctor(ctx: DoctorContext): Promise<DoctorReport> {
  const { env, runner, slot } = ctx;
  const paths = slotPaths(env, slot);
  const setupCmd = cliCommand('setup', slot);
  const checks: Check[] = [];

  const ab = await runner('agent-browser', ['--version'], { env, timeoutMs: 15_000 });
  checks.push(
    ab.code === 0
      ? ok('agent_browser', firstLine(ab.stdout) || 'agent-browser')
      : missing('agent_browser', ab.error === 'ENOENT' ? 'agent-browser is not on PATH' : `agent-browser --version failed (${ab.error ?? `exit ${ab.code}`})`, 'install it: npm install -g agent-browser'),
  );

  const chromium = findChromium(env, [paths.launcher]);
  if (chromium === null) {
    checks.push(missing('chromium', 'no Chromium found (AGENT_BROWSER_EXECUTABLE_PATH, or chromium, chromium-browser, google-chrome on PATH)', 'install it: sudo apt-get install chromium'));
  } else {
    const version = await runner(chromium, ['--version'], { env, timeoutMs: 15_000 });
    checks.push(
      version.code === 0
        ? ok('chromium', `${firstLine(version.stdout)} (${chromium})`)
        : fail('chromium', `${chromium} --version failed (${version.error ?? `exit ${version.code}`})`, 'reinstall it: sudo apt-get install --reinstall chromium'),
    );
  }

  const cu = await runner('certutil', ['-H'], { env, timeoutMs: 10_000 });
  const haveCertutil = cu.error === undefined;
  checks.push(haveCertutil ? ok('certutil', 'certutil is on PATH') : missing('certutil', cu.error === 'ENOENT' ? 'certutil is not on PATH' : `certutil could not be started (${cu.error})`, CERTUTIL_FIX));

  const ca = readCaFile(ctx.ca);
  checks.push(
    ca.ok
      ? ok('dev_ca', `${ca.path}: one certificate, ${ca.subject}`)
      : ca.state === 'missing'
        ? missing('dev_ca', `${ca.path} does not exist`, `write it: autologger-dev ca${slot === 0 ? '' : ` --slot ${slot}`} (or pass --ca <file>)`)
        : fail('dev_ca', `${ca.path} cannot be used: ${ca.reason}`, `write it again: autologger-dev ca${slot === 0 ? '' : ` --slot ${slot}`}`),
  );

  checks.push(await profileCheck());

  for (const [name, origin] of [['app_tls', appOrigin(slot)], ['runtime_tls', runtimeOrigin(slot)]] as const) {
    if (!ca.ok) {
      checks.push(missing(name, `${origin} not checked: no usable dev CA`, `write the dev CA first: autologger-dev ca${slot === 0 ? '' : ` --slot ${slot}`}`));
      continue;
    }
    const result = await ctx.probe(origin, ca.pem);
    if (result.ok) checks.push(ok(name, `${origin} answers over TLS verified with the dev CA (HTTP ${result.status})`));
    else if (isTlsError(result.code)) {
      checks.push(fail(name, `${origin} does not verify with the dev CA (${result.code})`, `the CA file is stale: autologger-dev ca${slot === 0 ? '' : ` --slot ${slot}`}, then ${setupCmd}`));
    } else {
      checks.push(fail(name, `${origin} cannot be reached (${result.code})`, `start the dev stack in HTTPS mode: autologger-dev up${slot === 0 ? '' : ` --slot ${slot}`}`));
    }
  }

  return { slot, ok: checks.every((c) => c.status === 'ok'), checks };

  async function profileCheck(): Promise<Check> {
    const name = 'profile';
    if (!isDir(paths.dir) || !isDir(paths.profile)) return missing(name, `no profile at ${paths.profile}`, `create it: ${setupCmd}`);
    if (chromium !== null && !fileHolds(paths.launcher, launcherScript(paths, chromium, env))) {
      return fail(name, `the launcher ${paths.launcher} is missing or out of date`, `write it again: ${setupCmd}`);
    }
    if (!haveCertutil) return fail(name, `the profile exists; its trust cannot be read without certutil`, CERTUTIL_FIX);
    let state;
    try {
      state = await readTrust({ runner, env, dir: paths.nssdb });
    } catch (error) {
      return fail(name, `the profile's NSS database cannot be read: ${messageOf(error)}`, `reset and set it up again: ${cliCommand('reset', slot)}, then ${setupCmd}`);
    }
    if (state.state === 'no database') return missing(name, `the profile has no NSS database at ${paths.nssdb}`, `create it: ${setupCmd}`);
    if (state.state === 'absent') return missing(name, `the profile's NSS database does not hold ${NICKNAME}`, `add it: ${setupCmd}`);
    if (ca.ok && !trustsExactly(state, ca.fingerprint256)) {
      const why = state.trust !== TRUST ? `trust ${state.trust}, not ${TRUST}` : 'a different certificate from the CA file';
      return fail(name, `the profile's ${NICKNAME} is ${why}`, `replace it: ${setupCmd}`);
    }
    return ok(name, `${paths.profile} trusts ${NICKNAME} (${state.trust}) through ${paths.launcher}`);
  }
}

export function formatDoctor(report: DoctorReport): string {
  const lines = report.checks.map((c) => `${c.status === 'ok' ? 'ok     ' : c.status === 'missing' ? 'missing' : 'fail   '} ${c.name}: ${c.detail}${c.fix === null ? '' : `\n        fix: ${c.fix}`}`);
  lines.push(report.ok ? `Dev slot ${report.slot}: ready.` : `Dev slot ${report.slot}: not ready; see the fixes above.`);
  return `${lines.join('\n')}\n`;
}
