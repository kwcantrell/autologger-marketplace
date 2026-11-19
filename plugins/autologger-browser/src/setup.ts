// setup: the slot's profile folder, its private NSS database trusting the dev CA (C,,: TLS only),
// and the launcher that points Chromium at that database. Everything lives under
// ~/.autologger-dev/browser/slot-<N>/; nothing else on the machine is written.
import { dirname, join } from 'node:path';
import { readCaFile } from './cert.ts';
import { CliError } from './errors.ts';
import { ensureDirs, ensurePrivateDir, ensureSymlink, fileHolds, writeFileAtomic } from './files.ts';
import { findChromium, launcherScript } from './launcher.ts';
import { addCa, createDatabase, hasDatabase, NICKNAME, readTrust, removeCa, TRUST, trustsExactly } from './nss.ts';
import type { Runner } from './runner.ts';
import { browserCommand, browserFlags, caCommand, type Env, runtimeOrigin, sessionName, slotAppOrigin, slotPaths } from './slot.ts';

export interface SetupContext {
  env: Env;
  runner: Runner;
  slot: number;
  /** The dev CA file (default ~/.autologger-dev/autologger-dev-ca.crt). */
  ca: string;
}

export interface SetupReport {
  slot: number;
  dir: string;
  profile: string;
  launcher: string;
  nssdb: string;
  chromium: string;
  session: string;
  ca: { path: string; subject: string; fingerprint256: string };
  /** added (none before), replaced (another certificate or trust before), unchanged (a no-op). */
  trust: 'added' | 'replaced' | 'unchanged';
  launcher_written: boolean;
  /** The agent-browser global flags, in order. */
  flags: string[];
  /** `agent-browser <flags>`, shell-quoted: put a command (open <url>, snapshot, ...) after it. */
  command: string;
  app_url: string;
  runtime_url: string;
  /** True when a running session must be closed for Chromium to see the new trust. */
  restart_needed: boolean;
}

export async function setup(ctx: SetupContext): Promise<SetupReport> {
  const paths = slotPaths(ctx.env, ctx.slot);
  const ca = readCaFile(ctx.ca);
  if (!ca.ok) {
    const fix = `${ca.state === 'missing' ? 'write it first' : 'write it again'} with ${caCommand(ctx.slot)} (or pass --ca <file>)`;
    throw new CliError(`the dev CA file ${ca.path} cannot be used: ${ca.reason}; ${fix}. Nothing was written`);
  }
  const chromium = findChromium(ctx.env, [paths.launcher]);
  if (chromium === null) throw new CliError('no Chromium found (AGENT_BROWSER_EXECUTABLE_PATH, or chromium on PATH); install chromium. Nothing was written');
  // Fail before writing anything when certutil is missing.
  const probe = await ctx.runner('certutil', ['-H'], { env: ctx.env, timeoutMs: 10_000 });
  if (probe.error === 'ENOENT') throw new CliError('certutil is not on PATH; install it: sudo apt-get install libnss3-tools (or agent-browser install --with-deps). Nothing was written');

  ensureDirs(dirname(paths.base));
  for (const dir of [paths.base, paths.dir, paths.profile, paths.home, join(paths.home, '.local'), join(paths.home, '.local', 'share'), join(paths.home, '.local', 'share', 'pki'), paths.nssdb, join(paths.home, '.pki')]) {
    ensurePrivateDir(dir);
  }
  ensureSymlink(paths.legacyNssdb, join('..', '.local', 'share', 'pki', 'nssdb'));

  const nss = { runner: ctx.runner, env: ctx.env, dir: paths.nssdb };
  if (!hasDatabase(paths.nssdb)) await createDatabase(nss);
  const before = await readTrust(nss);
  let trust: SetupReport['trust'] = 'unchanged';
  if (!trustsExactly(before, ca.fingerprint256)) {
    trust = before.state === 'present' ? 'replaced' : 'added';
    await removeCa(nss);
    await addCa(nss, ca.path);
    const after = await readTrust(nss);
    if (!trustsExactly(after, ca.fingerprint256)) throw new CliError(`certutil did not store ${NICKNAME} with trust ${TRUST} in ${paths.nssdb}`);
  }

  const script = launcherScript(paths, chromium, ctx.env);
  const launcherWritten = !fileHolds(paths.launcher, script);
  if (launcherWritten) writeFileAtomic(paths.launcher, script, 0o700);

  return {
    slot: ctx.slot,
    dir: paths.dir,
    profile: paths.profile,
    launcher: paths.launcher,
    nssdb: paths.nssdb,
    chromium,
    session: sessionName(ctx.slot),
    ca: { path: ca.path, subject: ca.subject, fingerprint256: ca.fingerprint256 },
    trust,
    launcher_written: launcherWritten,
    flags: browserFlags(paths),
    command: browserCommand(paths),
    app_url: slotAppOrigin(ctx.env, ctx.slot),
    runtime_url: runtimeOrigin(ctx.slot),
    restart_needed: trust !== 'unchanged' || launcherWritten,
  };
}

export function formatSetup(report: SetupReport): string {
  const trust = { added: 'now trusts', replaced: 'now trusts (replacing the certificate it had)', unchanged: 'already trusted' }[report.trust];
  const lines = [
    `Dev slot ${report.slot}: the profile at ${report.profile} ${trust} the dev CA (${report.ca.subject}) for HTTPS, in its own NSS database only.`,
    'Run agent-browser with these flags, always:',
    `  ${report.command} open ${report.app_url}`,
    `  ${report.command} open ${report.runtime_url}`,
  ];
  if (report.restart_needed) {
    lines.push(`If the ${report.session} session was already open, close it first so Chromium starts with the change: agent-browser --session ${report.session} close`);
  }
  return `${lines.join('\n')}\n`;
}
