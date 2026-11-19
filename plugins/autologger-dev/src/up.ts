// up: brings the dev stack up in HTTPS mode with /mcp on, running only these make targets, in this
// order and only as needed. The step list is fixed here: no other target (no *-reset, *-down,
// stage or prod target, no dev-bao-set with any other key) can be run through this command, and
// the Google client is never written; that is the user's.
import { join } from 'node:path';
import { CliError } from './errors.ts';
import type { Env } from './http.ts';
import type { Runner } from './runner.ts';
import { cliCommand, type DevPort, googleRedirect, slotEnv, slotPrefix } from './slot.ts';
import {
  type Checkout,
  childEnv,
  containerName,
  CREDENTIALS_FILE,
  DASHBOARDS_KEY,
  DASHBOARDS_ON,
  dashboardsState,
  googleClient,
  googleKeysIn,
  isFile,
  openbaoContainer,
  OVERRIDES_FILE,
  QUOTES_AND_SPACES_WHY,
  QUOTES_WHY,
  readOverrides,
  SPACES_WHY,
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

/** The only commands `up` ever runs (slot 0's; see stepFor for a slot's command line). */
export const STEPS: Readonly<Record<StepId, StepSpec>> = {
  'dev-bao': { args: ['dev-bao'], env: {}, command: 'make dev-bao' },
  'dev-bao-set': { args: ['dev-bao-set', `${DASHBOARDS_KEY}=1`], env: {}, command: `make dev-bao-set ${DASHBOARDS_KEY}=1` },
  'dev-up': { args: ['dev-up'], env: { DEV_HTTPS: '1' }, command: 'DEV_HTTPS=1 make dev-up' },
};

/**
 * Steps that act on the dev slot and so get DEV_SLOT=N for slot N. dev-bao and dev-bao-set act on the
 * local OpenBao, which every slot shares (autologger's Makefile runs them with `env -i`, dropping
 * DEV_SLOT anyway), so they never get it.
 */
const SLOT_STEPS: ReadonlySet<StepId> = new Set(['dev-up']);

/** The step's environment for make, and its command line as a user would type it, for the slot. */
export function stepFor(id: StepId, slot: number): { env: Record<string, string>; command: string } {
  const spec = STEPS[id];
  if (!SLOT_STEPS.has(id) || slot === 0) return { env: { ...spec.env }, command: spec.command };
  // DEV_HTTPS=1 DEV_SLOT=N make dev-up
  const command = spec.command.replace(/(^|\s)make /, `$1${slotPrefix(slot)}make `);
  return { env: { ...spec.env, ...slotEnv(slot) }, command };
}

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
  /** The dev slot (0 is the default stack). */
  slot: number;
  dry_run: boolean;
  steps: PlannedStep[];
  /** 'placeholder' also covers not set, quoted and padded values (the warnings say which). */
  google_client: 'set' | 'placeholder';
  warnings: string[];
}

export interface UpContext {
  env: Env;
  runner: Runner;
  checkout: Checkout;
  /** The dev slot (0, the default stack, when left out). */
  slot?: number;
  /** Slot 0's DEV_PORT from overrides.env, for the Google redirect in warnings (8787 when left out). */
  devPort?: DevPort;
  /** Receives the make output (and the step headers) as it arrives. */
  progress: (text: string) => void;
  /**
   * Called after each step: ends a last line of its output that had no newline, so the next step's
   * header starts on a line of its own.
   */
  endOutput: () => void;
}

export async function planUp(ctx: UpContext): Promise<UpReport> {
  const { checkout, env } = ctx;
  const slot = ctx.slot ?? 0;
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
  const on = DASHBOARDS_ON.join(', ').replace(/, ([^,]*)$/, ' or $1');
  steps.push({
    id: 'dev-bao-set',
    command: STEPS['dev-bao-set'].command,
    run: dashboards !== 'enabled',
    reason:
      dashboards === 'enabled'
        ? `${DASHBOARDS_KEY} is already on in ${overridesPath}`
        : dashboards === 'quoted'
          ? `${DASHBOARDS_KEY} is quoted in ${overridesPath} (${QUOTES_WHY}, so it is not on); this rewrites it unquoted, as 1, and /mcp needs it`
          : `${DASHBOARDS_KEY} is not ${on} in ${overridesPath}; /mcp needs it`,
    status: 'planned',
  });
  steps.push({
    id: 'dev-up',
    command: stepFor('dev-up', slot).command,
    run: true,
    reason: slot === 0 ? 'migrate, build and start the stack in HTTPS mode' : `migrate, build and start dev slot ${slot} in HTTPS mode`,
    status: 'planned',
  });
  for (const step of steps) if (!step.run) step.status = 'skipped';

  const google = overrides.state === 'unreadable' ? null : googleClient(values);
  const warnings: string[] = [];
  const quotedAndPadded = google === null ? [] : google.quotedAndPadded;
  for (const [keys, what, why, fix] of [
    [google === null ? [] : googleKeysIn(google, 'quoted').filter((k) => !quotedAndPadded.includes(k)), 'wrapped in quotes', QUOTES_WHY, 'Remove the quotes'],
    [quotedAndPadded, 'wrapped in quotes with spaces around them', QUOTES_AND_SPACES_WHY, 'Remove both the quotes and the spaces'],
    [google === null ? [] : googleKeysIn(google, 'padded'), 'surrounded by spaces', SPACES_WHY, 'Remove the spaces'],
  ] as const) {
    if (keys.length === 0) continue;
    warnings.push(
      `${keys.join(' and ')} in ${overridesPath} ${keys.length > 1 ? 'are' : 'is'} ${what}, and ${why}, so Google will reject the client: the stack will come up, but Google sign-in (and so the MCP sign-in) will not work. ${fix}, then run make dev-bao and up again.`,
    );
  }
  const unset = google === null ? [] : [...googleKeysIn(google, 'placeholder'), ...googleKeysIn(google, 'not set')];
  if (google === null || unset.length > 0) {
    warnings.push(
      `the Google OAuth client in ${overridesPath} is ${google === null ? 'unreadable' : 'a placeholder or not set'}: the stack will come up, but Google sign-in (and so the MCP sign-in) will not work. The user must add their own GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (authorized redirect ${googleRedirect(slot, ctx.devPort)}) to that file, then run make dev-bao and up again.`,
    );
  }
  return { repo: checkout.path, slot, dry_run: true, steps, google_client: google?.ok === true ? 'set' : 'placeholder', warnings };
}

/** Runs the planned steps in order; the first failure stops the rest and throws (exit 1). */
export async function runUp(ctx: UpContext, report: UpReport): Promise<UpReport> {
  report.dry_run = false;
  for (const step of report.steps) {
    if (!step.run) continue;
    const spec = stepFor(step.id, report.slot);
    ctx.progress(`==> ${step.command}  (${step.reason})\n`);
    const result = await ctx.runner('make', STEPS[step.id].args, {
      cwd: report.repo,
      env: childEnv(ctx.env, spec.env),
      onOutput: ctx.progress,
    });
    ctx.endOutput();
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
  const where = report.slot === 0 ? report.repo : `${report.repo} (dev slot ${report.slot})`;
  const lines = [report.dry_run ? `Would run in ${where}:` : `Ran in ${where}:`];
  for (const s of report.steps) {
    const mark = s.status === 'skipped' ? 'skip' : report.dry_run ? 'run ' : s.status;
    lines.push(`  [${mark}] ${s.command}  (${s.reason})`);
  }
  for (const w of report.warnings) lines.push(`Warning: ${w}`);
  if (!report.dry_run) lines.push(`Next: ${cliCommand('ca', report.slot)}, then ${cliCommand('connect', report.slot)}.`);
  return `${lines.join('\n')}\n`;
}
