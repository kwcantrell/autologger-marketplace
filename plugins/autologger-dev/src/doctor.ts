// doctor: what the local dev stack and its MCP connection still need, as named checks. Read-only:
// it runs `docker info`, `docker container inspect`, `make --version` and `node --version`, reads
// the override file to say whether keys are set (never their values), and makes one request to the
// dev server.
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { devMcpTokenCommand } from './connect.ts';
import { DEFAULT_SERVER, type Env, type Fetch, isLoopback, probe } from './http.ts';
import type { Runner } from './runner.ts';
import { appContainer, cliCommand, DEV_PORT_KEY, type DevPort, expectedPort, googleRedirect, slotServer } from './slot.ts';
import { stepFor } from './up.ts';
import {
  type Checkout,
  CREDENTIALS_FILE,
  containerName,
  DASHBOARDS_KEY,
  DASHBOARDS_ON,
  dashboardsState,
  defaultCaFile,
  googleClient,
  googleKeysIn,
  isFile,
  isQuotedAndPadded,
  openbaoContainer,
  OVERRIDES_FILE,
  QUOTES_AND_SPACES_WHY,
  QUOTES_WHY,
  readOverrides,
  SPACES_WHY,
  stateDir,
} from './stack.ts';

export type CheckStatus = 'ok' | 'missing' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  /** One line: what was found. */
  detail: string;
  /** One line: what to do about it; null when the check is ok. */
  fix: string | null;
  /**
   * google_client and custom_dashboards only, when overrides.env could be read: each key's state
   * (`set`, `placeholder`, `quoted`, `padded`, `not set`; `enabled`, `quoted`, `not enabled`), never its value.
   * A `quoted` value that also has spaces around it keeps the state `quoted`; its fix names both.
   */
  keys?: Record<string, string>;
}

export interface DoctorContext {
  env: Env;
  runner: Runner;
  fetch: Fetch;
  checkout: Checkout;
  server: string;
  /** The dev slot (0, the default stack, when left out). */
  slot?: number;
  /** Slot 0's DEV_PORT from overrides.env (not set when left out). */
  devPort?: DevPort;
  /**
   * Where `server` came from when it was not the slot's own server: `--server` or `AUTOLOGGER_URL`.
   * dev_port then compares against that server's port (localhost) or is skipped (any other host).
   */
  serverOverride?: '--server' | 'AUTOLOGGER_URL';
}

export interface DoctorReport {
  repo: string;
  server: string;
  /** The dev slot the fixes name (0 is the default stack). */
  slot: number;
  ok: boolean;
  /** One-line notes beside the checks (an invalid DEV_PORT for slot 0); never a value from overrides.env. */
  notes: string[];
  checks: Check[];
}

/** Node version the autologger Makefile needs on PATH. */
export const MIN_NODE = [22, 12] as const;

const ok = (name: string, detail: string): Check => ({ name, status: 'ok', detail, fix: null });
const missing = (name: string, detail: string, fix: string): Check => ({ name, status: 'missing', detail, fix });
const fail = (name: string, detail: string, fix: string): Check => ({ name, status: 'fail', detail, fix });

export async function doctor(ctx: DoctorContext): Promise<DoctorReport> {
  const { checkout, env, runner } = ctx;
  const slot = ctx.slot ?? 0;
  const up = cliCommand('up', slot);
  const isCheckout = checkout.missing.length === 0;
  const checks: Check[] = [];

  checks.push(
    isCheckout
      ? ok('checkout', `autologger-2 checkout at ${checkout.path} (from ${checkout.source})`)
      : missing(
          'checkout',
          `${checkout.path} (from ${checkout.source}) is not an autologger-2 checkout: no ${checkout.missing.join(', ')}`,
          'pass --repo <path to autologger-2> or set AUTOLOGGER_REPO (git clone https://github.com/kwcantrell/autologger-2 if there is none)',
        ),
  );

  checks.push(await dockerCheck(runner, env));
  checks.push(await makeCheck(runner, env));
  checks.push(await nodeCheck(runner, env));

  const container = containerName(env);
  const state = await openbaoContainer(runner, container, env);
  checks.push(
    state.state === 'running'
      ? ok('openbao', `container ${container} is running`)
      : state.state === 'stopped'
        ? missing('openbao', `container ${container} exists but is not running (dev-mode OpenBao loses its state when it stops)`, `run make dev-bao in the checkout (or ${up})`)
        : state.state === 'absent'
          ? missing('openbao', `no container ${container}`, `run make dev-bao in the checkout (or ${up})`)
          : fail('openbao', `cannot tell whether ${container} is running: ${state.reason}`, 'make docker reachable (see the docker check), then run doctor again'),
  );

  checks.push(
    !isCheckout
      ? missing('openbao_credentials', `no checkout, so no ${CREDENTIALS_FILE} to look for`, 'fix the checkout check first')
      : isFile(join(checkout.path, CREDENTIALS_FILE))
        ? ok('openbao_credentials', `${CREDENTIALS_FILE} is present in the checkout`)
        : missing('openbao_credentials', `no ${CREDENTIALS_FILE} in the checkout`, `run make dev-bao in the checkout (or ${up})`),
  );

  const overridesPath = join(stateDir(env), OVERRIDES_FILE);
  const overrides = readOverrides(env);
  const values = overrides.state === 'read' ? overrides.values : new Map<string, string>();
  if (overrides.state === 'unreadable') {
    const fix = `make ${overridesPath} readable by you (make dev-bao creates it mode 600)`;
    checks.push(fail('google_client', `${overridesPath} exists but cannot be read`, fix));
    checks.push(fail('custom_dashboards', `${overridesPath} exists but cannot be read`, fix));
  } else {
    const google = googleClient(values);
    const where = overrides.state === 'absent' ? `${overridesPath} does not exist` : `in ${overridesPath}`;
    const detail = `GOOGLE_CLIENT_ID is ${google.keys.GOOGLE_CLIENT_ID}, GOOGLE_CLIENT_SECRET is ${google.keys.GOOGLE_CLIENT_SECRET} (${where})`;
    const quotedAndPadded = google.quotedAndPadded;
    const quoted = googleKeysIn(google, 'quoted').filter((k) => !quotedAndPadded.includes(k));
    const padded = googleKeysIn(google, 'padded');
    const unset = [...googleKeysIn(google, 'placeholder'), ...googleKeysIn(google, 'not set')];
    const fixes: string[] = [];
    const verbatim = [
      ...(quoted.length > 0 ? [QUOTES_WHY] : []),
      ...(quotedAndPadded.length > 0 ? [QUOTES_AND_SPACES_WHY] : []),
      ...(padded.length > 0 ? [SPACES_WHY] : []),
    ];
    if (quoted.length > 0) {
      fixes.push(`remove the quotes around the value of ${quoted.join(' and ')} in ${overridesPath} (${QUOTES_WHY}, so Google rejects the client), then run make dev-bao and ${up} again`);
    }
    if (quotedAndPadded.length > 0) {
      fixes.push(
        `remove both the quotes and the spaces around the value of ${quotedAndPadded.join(' and ')} in ${overridesPath} (${QUOTES_AND_SPACES_WHY}, so Google rejects the client), then run make dev-bao and ${up} again`,
      );
    }
    if (padded.length > 0) {
      fixes.push(`remove the spaces around the value of ${padded.join(' and ')} in ${overridesPath} (${SPACES_WHY}, so Google rejects the client), then run make dev-bao and ${up} again`);
    }
    if (unset.length > 0) {
      fixes.push(`the user adds their own Google OAuth client (redirect ${googleRedirect(slot, ctx.devPort)}) to ${overridesPath}, then runs make dev-bao and ${up}`);
    }
    // Google sign-in is only one way in: MCP can still be connected with a dev token.
    if (!google.ok) {
      fixes.push(
        `MCP can still be connected without a Google client: ${devMcpTokenCommand(ctx.server, slot)} (autologger's dev-only dev-mcp-token; see autologger-dev connect)`,
      );
    }
    checks.push({
      ...(google.ok
        ? ok('google_client', `GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set (${where})`)
        : verbatim.length > 0
          ? fail('google_client', `${detail}: ${verbatim.join(' and ')}, so Google sign-in will not work`, fixes.join('; '))
          : missing('google_client', `${detail}: the stack boots but Google sign-in will not work`, fixes.join('; '))),
      keys: { ...google.keys },
    });
    const dashboards = dashboardsState(values);
    const on = DASHBOARDS_ON.join(', ').replace(/, ([^,]*)$/, ' or $1');
    // up runs make dev-bao-set CUSTOM_DASHBOARDS_ENABLED=1 for anything the server does not read as on, which rewrites the line.
    const rewrite = `or just run ${up}, which rewrites it as ${DASHBOARDS_KEY}=1 (make dev-bao-set), so editing it by hand is optional`;
    const unquote = isQuotedAndPadded(values.get(DASHBOARDS_KEY)) ? 'remove both the quotes and the spaces around' : 'remove the quotes around';
    checks.push({
      ...(dashboards === 'enabled'
        ? ok('custom_dashboards', `${DASHBOARDS_KEY} is on (${where})`)
        : dashboards === 'quoted'
          ? fail(
              'custom_dashboards',
              `${DASHBOARDS_KEY} is quoted (${where}): ${QUOTES_WHY}, so autologger does not read it as on and /mcp is off`,
              `${unquote} the value of ${DASHBOARDS_KEY} in ${overridesPath} (${QUOTES_WHY}), then run make dev-bao and ${up} again; ${rewrite}`,
            )
          : missing('custom_dashboards', `${DASHBOARDS_KEY} is not ${on} (${where}), so /mcp is off`, `${up} (runs make dev-bao-set ${DASHBOARDS_KEY}=1)`)),
      keys: { [DASHBOARDS_KEY]: dashboards },
    });
  }

  checks.push(caCheck(env, slot));
  checks.push(await portCheck(ctx, slot, overridesPath));
  checks.push(await serverCheck(ctx, slot));

  const notes: string[] = [];
  if (slot === 0 && ctx.devPort?.state === 'invalid') {
    notes.push(`${DEV_PORT_KEY} in ${overridesPath} is not a port number (digits only, 1-65535, no quotes or spaces), so slot 0's server falls back to ${DEFAULT_SERVER}`);
  }
  return { repo: checkout.path, server: ctx.server, slot, ok: checks.every((c) => c.status === 'ok'), notes, checks };
}

async function dockerCheck(runner: Runner, env: Env): Promise<Check> {
  const r = await runner('docker', ['info', '--format', '{{.ServerVersion}}'], { env, timeoutMs: 20_000 });
  if (r.error === 'ENOENT') return missing('docker', 'docker is not on PATH', 'install Docker Engine with the compose plugin and buildx');
  if (r.code === 0) return ok('docker', `docker daemon reachable (server ${r.stdout.trim() || 'unknown version'})`);
  return fail('docker', `docker info failed${r.code === null ? '' : ` (exit ${r.code})`}: the daemon is not reachable`, 'start the Docker daemon and make sure this user may use it (docker info)');
}

async function makeCheck(runner: Runner, env: Env): Promise<Check> {
  const r = await runner('make', ['--version'], { env, timeoutMs: 10_000 });
  if (r.error === 'ENOENT') return missing('make', 'make is not on PATH', 'install make (e.g. apt install make)');
  if (r.code === 0) return ok('make', (r.stdout.split('\n')[0] ?? 'make').trim());
  return fail('make', `make --version exited ${String(r.code)}`, 'reinstall make');
}

export function parseNodeVersion(text: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

async function nodeCheck(runner: Runner, env: Env): Promise<Check> {
  const need = `${MIN_NODE[0]}.${MIN_NODE[1]}`;
  const r = await runner('node', ['--version'], { env, timeoutMs: 10_000 });
  if (r.error === 'ENOENT') return missing('node', 'node is not on PATH (the Makefile runs it)', `install Node ${need} or newer`);
  const v = r.code === 0 ? parseNodeVersion(r.stdout) : null;
  if (v === null) return fail('node', 'node --version did not print a version', `install Node ${need} or newer`);
  const [major, minor] = v;
  if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) return ok('node', `node ${v.join('.')} on PATH`);
  return fail('node', `node ${v.join('.')} on PATH is older than ${need}`, `install Node ${need} or newer and put it first on PATH`);
}

function caCheck(env: Env, slot: number): Check {
  const ca = cliCommand('ca', slot);
  const path = env.NODE_EXTRA_CA_CERTS;
  const caFile = defaultCaFile(env);
  const howTo = `run ${ca} (writes ${caFile}), then export NODE_EXTRA_CA_CERTS=${caFile} where Claude Code starts and restart it`;
  if (path === undefined || path === '') return missing('node_extra_ca_certs', 'NODE_EXTRA_CA_CERTS is not set, so Node does not trust the dev CA', howTo);
  try {
    if (!statSync(path).isFile()) return fail('node_extra_ca_certs', `NODE_EXTRA_CA_CERTS=${path} is not a file`, howTo);
    accessSync(path, constants.R_OK);
  } catch {
    return fail('node_extra_ca_certs', `NODE_EXTRA_CA_CERTS=${path} cannot be read`, howTo);
  }
  return ok('node_extra_ca_certs', `NODE_EXTRA_CA_CERTS=${path} is a readable file`);
}

/**
 * dev_port: the host port the running stack publishes for its app (`docker port` on the slot's app
 * container, read-only) against the port this CLI uses. autologger takes slot 0's DEV_PORT from the
 * OpenBao dev secret, which overrides.env seeds through make dev-bao; the CLI never reads that
 * secret, so the published port is the only source for what the stack really uses. Not running or
 * docker unreachable is skipped (ok, saying so): the docker, openbao and dev_server checks report those.
 * A server from --server or AUTOLOGGER_URL is what this command really uses: on localhost its port is
 * the one to compare; on any other host the stack's published port says nothing about it (skipped).
 */
async function portCheck(ctx: DoctorContext, slot: number, overridesPath: string): Promise<Check> {
  const override = ctx.serverOverride;
  const overridden = override !== undefined && ctx.server !== slotServer(slot, ctx.devPort);
  if (overridden && !isLoopback(ctx.server)) {
    return ok('dev_port', `skipped: server overridden (${override} names ${ctx.server}, not a localhost server, so the stack's published port does not apply)`);
  }
  const container = appContainer(slot);
  const r = await ctx.runner('docker', ['port', container, '8443/tcp'], { env: ctx.env, timeoutMs: 15_000 });
  if (r.error !== undefined) return ok('dev_port', `skipped: docker could not be run (${r.error === 'ENOENT' ? 'not on PATH' : r.error})`);
  if (r.code !== 0) {
    return /no such (container|object)|no public port|not running/i.test(r.stderr)
      ? ok('dev_port', `skipped: ${container} is not running, so there is no published port to compare`)
      : ok('dev_port', 'skipped: docker did not answer for the published port');
  }
  const published = /:(\d{1,5})\s*$/m.exec(r.stdout)?.[1];
  if (published === undefined) return ok('dev_port', `skipped: ${container} publishes no port for its app`);
  const want = overridden ? portOf(ctx.server) : expectedPort(slot, ctx.devPort);
  if (Number(published) === want) return ok('dev_port', `${container} publishes its app on port ${want}, the port this command uses`);
  if (overridden) {
    return fail(
      'dev_port',
      `${container} publishes its app on port ${published}, but this command uses port ${want} (${ctx.server}, from ${override})`,
      `point ${override} at the stack's port (${new URL(ctx.server).protocol}//${new URL(ctx.server).hostname}:${published}), or leave it out to use slot ${slot}'s server`,
    );
  }
  return fail(
    'dev_port',
    `${container} publishes its app on port ${published}, but this command uses port ${want}`,
    slot === 0
      ? `re-run make dev-bao and ${cliCommand('up', slot)} so the stack takes ${DEV_PORT_KEY} from ${overridesPath}, or correct ${DEV_PORT_KEY} in ${overridesPath} to ${published}`
      : `re-run ${cliCommand('up', slot)} (a slot's port is fixed by its number, ${want})`,
  );
}

/** The port of an origin, with the scheme's default when the URL leaves it out. */
function portOf(server: string): number {
  const url = new URL(server);
  return url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
}

async function serverCheck(ctx: DoctorContext, slot: number): Promise<Check> {
  const result = await probe(ctx.fetch, `${ctx.server}/`, {}, 5_000);
  if (result.ok) {
    await result.response.body?.cancel();
    return ok('dev_server', `${ctx.server} answers (HTTP ${result.response.status})`);
  }
  if (result.kind === 'tls') {
    return fail('dev_server', result.message, `run ${cliCommand('ca', slot)}, then set NODE_EXTRA_CA_CERTS to the file it writes before Claude Code starts`);
  }
  return missing('dev_server', result.message, `${cliCommand('up', slot)} (${stepFor('dev-up', slot).command} in the checkout)`);
}

export function formatDoctor(report: DoctorReport): string {
  const lines = [`autologger dev stack: ${report.repo} -> ${report.server}${report.slot === 0 ? '' : ` (dev slot ${report.slot})`}`];
  for (const note of report.notes) lines.push(`note: ${note}`);
  for (const c of report.checks) {
    lines.push(`[${c.status}] ${c.name}: ${c.detail}`);
    if (c.fix !== null) lines.push(`    fix: ${c.fix}`);
  }
  const notOk = report.checks.filter((c) => c.status !== 'ok').length;
  lines.push(notOk === 0 ? 'Everything is in place.' : `${notOk} of ${report.checks.length} checks need attention.`);
  return `${lines.join('\n')}\n`;
}
