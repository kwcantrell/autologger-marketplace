// up: brings the dev stack up in HTTPS mode with /mcp on, running only these make targets, in this
// order and only as needed. The step list is fixed here: no other target (no *-reset, *-down,
// stage or prod target, no dev-bao-set with any other key) can be run through this command, and
// the Google client is never written; that is the user's.
import { join } from 'node:path';
import { CliError } from './errors.ts';
import type { Env } from './http.ts';
import type { Runner } from './runner.ts';
import {
  type Checkout,
  childEnv,
  containerName,
  CREDENTIALS_FILE,
  DASHBOARDS_KEY,
  dashboardsState,
  GOOGLE_REDIRECT,
  googleClient,
  googleKeysIn,
  isFile,
  openbaoContainer,
  OVERRIDES_FILE,
  QUOTES_WHY,
  readOverrides,
  stateDir,
  verifyCheckout,
} from './stack.ts';

export type StepId = 'dev-bao' | 'dev-bao-set' | 'dev-up';

interface StepSpec {
  /** Arguments to make. */
  args: readonly string[];
  /** Extra environment for make. */
  env: Readonly<Record<string, string>>;
  /** The command line as a user would type it in the checkout. */
  command: string;
}

/** The only commands `up` ever runs. */
export const STEPS: Readonly<Record<StepId, StepSpec>> = {
  'dev-bao': { args: ['dev-bao'], env: {}, command: 'make dev-bao' },
  'dev-bao-set': { args: ['dev-bao-set', `${DASHBOARDS_KEY}=1`], env: {}, command: `make dev-bao-set ${DASHBOARDS_KEY}=1` },
  'dev-up': { args: ['dev-up'], env: { DEV_HTTPS: '1' }, command: 'DEV_HTTPS=1 make dev-up' },
};

export interface PlannedStep {
  id: StepId;
  command: string;
  run: boolean;
  /** Why it runs or is skipped. */
  reason: string;
  status: 'planned' | 'skipped' | 'ok' | 'failed' | 'not run';
}

export interface UpReport {
  repo: string;
  dry_run: boolean;
  steps: PlannedStep[];
  /** 'placeholder' also covers not set and quoted values (the warnings say which). */
  google_client: 'set' | 'placeholder';
  warnings: string[];
}

export interface UpContext {
  env: Env;
  runner: Runner;
  checkout: Checkout;
  /** Receives the make output (and the step headers) as it arrives. */
  progress: (text: string) => void;
}

export async function planUp(ctx: UpContext): Promise<UpReport> {
  const { checkout, env } = ctx;
  await verifyCheckout(checkout, ctx.runner, ctx.env);
  const container = containerName(env);
  const state = await openbaoContainer(ctx.runner, container, env);
  const hasCreds = isFile(join(checkout.path, CREDENTIALS_FILE));
  const overrides = readOverrides(env);
  const values = overrides.state === 'read' ? overrides.values : new Map<string, string>();
  const overridesPath = join(stateDir(env), OVERRIDES_FILE);

  const steps: PlannedStep[] = [];
  const baoReasons: string[] = [];
  if (state.state !== 'running') baoReasons.push(state.state === 'unknown' ? `cannot tell whether ${container} is running (${state.reason})` : `${container} is not running`);
  if (!hasCreds) baoReasons.push(`${CREDENTIALS_FILE} is missing`);
  steps.push({
    id: 'dev-bao',
    command: STEPS['dev-bao'].command,
    run: baoReasons.length > 0,
    reason: baoReasons.length > 0 ? baoReasons.join('; ') : `${container} is running and ${CREDENTIALS_FILE} is present`,
    status: 'planned',
  });
  const dashboards = dashboardsState(values);
  steps.push({
    id: 'dev-bao-set',
    command: STEPS['dev-bao-set'].command,
    run: dashboards !== 'enabled',
    reason:
      dashboards === 'enabled'
        ? `${DASHBOARDS_KEY}=1 is already in ${overridesPath}`
        : dashboards === 'quoted'
          ? `${DASHBOARDS_KEY} is quoted in ${overridesPath} (${QUOTES_WHY}, so it is not 1); this rewrites it unquoted, and /mcp needs it`
          : `${DASHBOARDS_KEY} is not 1 in ${overridesPath}; /mcp needs it`,
    status: 'planned',
  });
  steps.push({ id: 'dev-up', command: STEPS['dev-up'].command, run: true, reason: 'migrate, build and start the stack in HTTPS mode', status: 'planned' });
  for (const step of steps) if (!step.run) step.status = 'skipped';

  const google = overrides.state === 'unreadable' ? null : googleClient(values);
  const warnings: string[] = [];
  const quoted = google === null ? [] : googleKeysIn(google, 'quoted');
  if (quoted.length > 0) {
    warnings.push(
      `${quoted.join(' and ')} in ${overridesPath} ${quoted.length > 1 ? 'are' : 'is'} wrapped in quotes, and ${QUOTES_WHY}, so Google will reject the client: the stack will come up, but Google sign-in (and so the MCP sign-in) will not work. Remove the quotes, then run make dev-bao and up again.`,
    );
  }
  const unset = google === null ? [] : [...googleKeysIn(google, 'placeholder'), ...googleKeysIn(google, 'not set')];
  if (google === null || unset.length > 0) {
    warnings.push(
      `the Google OAuth client in ${overridesPath} is ${google === null ? 'unreadable' : 'a placeholder or not set'}: the stack will come up, but Google sign-in (and so the MCP sign-in) will not work. The user must add their own GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (authorized redirect ${GOOGLE_REDIRECT}) to that file, then run make dev-bao and up again.`,
    );
  }
  return { repo: checkout.path, dry_run: true, steps, google_client: google?.ok === true ? 'set' : 'placeholder', warnings };
}

/** Runs the planned steps in order; the first failure stops the rest and throws (exit 1). */
export async function runUp(ctx: UpContext, report: UpReport): Promise<UpReport> {
  report.dry_run = false;
  for (const step of report.steps) {
    if (!step.run) continue;
    const spec = STEPS[step.id];
    ctx.progress(`==> ${step.command}  (${step.reason})\n`);
    const result = await ctx.runner('make', spec.args, {
      cwd: report.repo,
      env: childEnv(ctx.env, { ...spec.env }),
      onOutput: ctx.progress,
    });
    if (result.code !== 0) {
      step.status = 'failed';
      for (const later of report.steps) if (later.status === 'planned') later.status = 'not run';
      const why =
        result.error === 'ENOENT' ? 'make is not on PATH' : result.code === null ? `it did not finish${result.error ? ` (${result.error})` : ''}` : `exit ${result.code}`;
      const notRun = report.steps.filter((s) => s.status === 'not run').map((s) => s.command);
      throw new CliError(`step '${step.command}' failed (${why}); its output is above.${notRun.length > 0 ? ` Not run: ${notRun.join(', ')}.` : ''}`);
    }
    step.status = 'ok';
  }
  return report;
}

export function formatUp(report: UpReport): string {
  const lines = [report.dry_run ? `Would run in ${report.repo}:` : `Ran in ${report.repo}:`];
  for (const s of report.steps) {
    const mark = s.status === 'skipped' ? 'skip' : report.dry_run ? 'run ' : s.status;
    lines.push(`  [${mark}] ${s.command}  (${s.reason})`);
  }
  for (const w of report.warnings) lines.push(`Warning: ${w}`);
  if (!report.dry_run) lines.push('Next: autologger-dev ca, then autologger-dev connect.');
  return `${lines.join('\n')}\n`;
}
