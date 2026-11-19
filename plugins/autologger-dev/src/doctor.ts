// doctor: what the local dev stack and its MCP connection still need, as named checks. Read-only:
// it runs `docker info`, `docker container inspect`, `make --version` and `node --version`, reads
// the override file to say whether keys are set (never their values), and makes one request to the
// dev server.
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Env, type Fetch, probe } from './http.ts';
import type { Runner } from './runner.ts';
import {
  type Checkout,
  CREDENTIALS_FILE,
  containerName,
  dashboardsEnabled,
  DASHBOARDS_KEY,
  defaultCaFile,
  GOOGLE_REDIRECT,
  googleClient,
  isFile,
  openbaoContainer,
  OVERRIDES_FILE,
  readOverrides,
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
}

export interface DoctorContext {
  env: Env;
  runner: Runner;
  fetch: Fetch;
  checkout: Checkout;
  server: string;
}

export interface DoctorReport {
  repo: string;
  server: string;
  ok: boolean;
  checks: Check[];
}

/** Node version the autologger Makefile needs on PATH. */
export const MIN_NODE = [22, 12] as const;

const ok = (name: string, detail: string): Check => ({ name, status: 'ok', detail, fix: null });
const missing = (name: string, detail: string, fix: string): Check => ({ name, status: 'missing', detail, fix });
const fail = (name: string, detail: string, fix: string): Check => ({ name, status: 'fail', detail, fix });

const UP = 'autologger-dev up';
const CA = 'autologger-dev ca';

export async function doctor(ctx: DoctorContext): Promise<DoctorReport> {
  const { checkout, env, runner } = ctx;
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
        ? missing('openbao', `container ${container} exists but is not running (dev-mode OpenBao loses its state when it stops)`, `run make dev-bao in the checkout (or ${UP})`)
        : state.state === 'absent'
          ? missing('openbao', `no container ${container}`, `run make dev-bao in the checkout (or ${UP})`)
          : fail('openbao', `cannot tell whether ${container} is running: ${state.reason}`, 'make docker reachable (see the docker check), then run doctor again'),
  );

  checks.push(
    !isCheckout
      ? missing('openbao_credentials', `no checkout, so no ${CREDENTIALS_FILE} to look for`, 'fix the checkout check first')
      : isFile(join(checkout.path, CREDENTIALS_FILE))
        ? ok('openbao_credentials', `${CREDENTIALS_FILE} is present in the checkout`)
        : missing('openbao_credentials', `no ${CREDENTIALS_FILE} in the checkout`, `run make dev-bao in the checkout (or ${UP})`),
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
    checks.push(
      google.ok
        ? ok('google_client', `GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set (${where})`)
        : missing(
            'google_client',
            `GOOGLE_CLIENT_ID is ${google.keys.GOOGLE_CLIENT_ID}, GOOGLE_CLIENT_SECRET is ${google.keys.GOOGLE_CLIENT_SECRET} (${where}): the stack boots but Google sign-in will not work`,
            `the user adds their own Google OAuth client (redirect ${GOOGLE_REDIRECT}) to ${overridesPath}, then runs make dev-bao and ${UP}`,
          ),
    );
    checks.push(
      dashboardsEnabled(values)
        ? ok('custom_dashboards', `${DASHBOARDS_KEY}=1 (${where})`)
        : missing('custom_dashboards', `${DASHBOARDS_KEY} is not 1 (${where}), so /mcp is off`, `${UP} (runs make dev-bao-set ${DASHBOARDS_KEY}=1)`),
    );
  }

  checks.push(caCheck(env));
  checks.push(await serverCheck(ctx));

  return { repo: checkout.path, server: ctx.server, ok: checks.every((c) => c.status === 'ok'), checks };
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

function caCheck(env: Env): Check {
  const path = env.NODE_EXTRA_CA_CERTS;
  const caFile = defaultCaFile(env);
  const howTo = `run ${CA} (writes ${caFile}), then export NODE_EXTRA_CA_CERTS=${caFile} where Claude Code starts and restart it`;
  if (path === undefined || path === '') return missing('node_extra_ca_certs', 'NODE_EXTRA_CA_CERTS is not set, so Node does not trust the dev CA', howTo);
  try {
    if (!statSync(path).isFile()) return fail('node_extra_ca_certs', `NODE_EXTRA_CA_CERTS=${path} is not a file`, howTo);
    accessSync(path, constants.R_OK);
  } catch {
    return fail('node_extra_ca_certs', `NODE_EXTRA_CA_CERTS=${path} cannot be read`, howTo);
  }
  return ok('node_extra_ca_certs', `NODE_EXTRA_CA_CERTS=${path} is a readable file`);
}

async function serverCheck(ctx: DoctorContext): Promise<Check> {
  const result = await probe(ctx.fetch, `${ctx.server}/`, {}, 5_000);
  if (result.ok) {
    await result.response.body?.cancel();
    return ok('dev_server', `${ctx.server} answers (HTTP ${result.response.status})`);
  }
  if (result.kind === 'tls') {
    return fail('dev_server', result.message, `run ${CA}, then set NODE_EXTRA_CA_CERTS to the file it writes before Claude Code starts`);
  }
  return missing('dev_server', result.message, `${UP} (DEV_HTTPS=1 make dev-up in the checkout)`);
}

export function formatDoctor(report: DoctorReport): string {
  const lines = [`autologger dev stack: ${report.repo} -> ${report.server}`];
  for (const c of report.checks) {
    lines.push(`[${c.status}] ${c.name}: ${c.detail}`);
    if (c.fix !== null) lines.push(`    fix: ${c.fix}`);
  }
  const notOk = report.checks.filter((c) => c.status !== 'ok').length;
  lines.push(notOk === 0 ? 'Everything is in place.' : `${notOk} of ${report.checks.length} checks need attention.`);
  return `${lines.join('\n')}\n`;
}
