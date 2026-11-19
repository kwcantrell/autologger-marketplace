// Usage: node scripts/harden-repo.ts [--dry-run | --apply] [--json] [--repo <owner/name>] [--skip-required-checks]
// Brings a GitHub repo's security settings and its `main protection` ruleset to the desired state
// below, through `gh api`. The default is a dry run: it reads the current state and prints, per
// setting, current → desired. `--apply` makes only the changes needed, so a second run changes nothing.
// A setting GitHub refuses to read or change for this account or plan (HTTP 403 or 404) is reported
// as unavailable and does not fail the run.
// Exit codes: 0 done (also when some settings are unavailable), 1 failed (including the refusal to
// require the CI check while the CI workflow is not on the default branch), 2 usage error.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const NAME = 'harden-repo';
export const DEFAULT_REPO = 'kwcantrell/autologger-marketplace';
export const RULESET_NAME = 'main protection';
/** The job name in .github/workflows/ci.yml, which is the check run name the ruleset requires. */
export const CI_CHECK = 'ci';
/** GitHub Actions' app id (slug github-actions): pins the required check so no other app can report a `ci` status. */
export const GITHUB_ACTIONS_INTEGRATION_ID = 15368;
export const CI_WORKFLOW = '.github/workflows/ci.yml';
/** GitHub's role id for the repository admin role, as a ruleset bypass actor of type RepositoryRole. */
export const ADMIN_ROLE_ID = 5;
const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

const USAGE = `Usage: node scripts/harden-repo.ts [--dry-run | --apply] [--json] [--repo <owner/name>] [--skip-required-checks]

Brings the repo's GitHub settings to the desired state through \`gh api\`:
  vulnerability alerts, Dependabot security updates, private vulnerability reporting,
  secret scanning and push protection, delete_branch_on_merge, actions sha_pinning_required
  (with read-only default workflow permissions), and the '${RULESET_NAME}' ruleset on the default
  branch (no deletion or force-push, pull request with 0 approvals, required check '${CI_CHECK}',
  repository admins may bypass).

Options:
  --dry-run               Read the current state and print current → desired (default). Changes nothing.
  --apply                 Make only the changes needed.
  --json                  Print the plan (or the result) as one JSON value.
  --repo <owner/name>     Target repo (default ${DEFAULT_REPO}).
  --skip-required-checks  Leave the required status check out of the ruleset (keep an existing one).
                          Without it, --apply refuses while ${CI_WORKFLOW} is not on the default branch.
  -h, --help              Show this help.

Exit codes: 0 done (unavailable settings are reported, not failures), 1 failed, 2 usage error.`;

export class HardenError extends Error {
  readonly exitCode: 1 | 2;
  constructor(message: string, exitCode: 1 | 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------------------------
// gh api

export type GhResult = { ok: true; body: unknown } | { ok: false; status: number | undefined; message: string };

export function ghApi(method: string, path: string, body?: unknown): GhResult {
  const args = ['api', '-X', method, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', path];
  if (body !== undefined) args.push('--input', '-');
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    input: body === undefined ? '' : JSON.stringify(body),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new HardenError(code === 'ENOENT' ? 'gh not found on PATH (install GitHub CLI and run gh auth login)' : `gh failed to start: ${result.error.message}`, 1);
  }
  if (result.status === 0) {
    const text = result.stdout.trim();
    if (text === '') return { ok: true, body: undefined };
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      return { ok: true, body: text };
    }
  }
  const stderr = result.stderr.trim();
  const match = /\(HTTP (\d{3})\)/.exec(stderr);
  const message = stderr.replace(/^gh: /, '').replace(/\s*\(HTTP \d{3}\)/, '');
  return { ok: false, status: match ? Number(match[1]) : undefined, message: message || `gh exited ${result.status}` };
}

function describe(r: GhResult): string {
  if (r.ok) return 'unexpected response';
  return r.status !== undefined ? `HTTP ${r.status}: ${r.message}` : r.message;
}

/** 403 and 404: the account or plan can't read or change this setting. */
function isUnavailable(r: GhResult): r is { ok: false; status: number; message: string } {
  return !r.ok && (r.status === 403 || r.status === 404);
}

function fail(what: string, r: GhResult): never {
  throw new HardenError(`${what}: ${describe(r)}`, 1);
}

// ---------------------------------------------------------------------------------------------
// Desired ruleset and its comparison

export interface Rule {
  type: string;
  parameters?: Record<string, unknown>;
}
export interface Ruleset {
  id?: number;
  name: string;
  target: string;
  enforcement: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  bypass_actors?: { actor_id: number | null; actor_type: string; bypass_mode: string }[];
  rules?: Rule[];
}

export function requiredChecksRule(): Rule {
  return {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: false,
      required_status_checks: [{ context: CI_CHECK, integration_id: GITHUB_ACTIONS_INTEGRATION_ID }],
    },
  };
}

/** The ruleset to have. `keepChecks` is the existing required_status_checks rule, kept when skipping. */
export function desiredRuleset(skipRequiredChecks: boolean, keepChecks?: Rule): Ruleset {
  const rules: Rule[] = [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
    },
  ];
  if (!skipRequiredChecks) rules.push(requiredChecksRule());
  else if (keepChecks) rules.push(keepChecks);
  return {
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [{ actor_id: ADMIN_ROLE_ID, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
    rules,
  };
}

const COMPARED_PARAMETERS: Record<string, string[]> = {
  pull_request: [
    'required_approving_review_count',
    'dismiss_stale_reviews_on_push',
    'require_code_owner_review',
    'require_last_push_approval',
    'required_review_thread_resolution',
  ],
  required_status_checks: ['strict_required_status_checks_policy'],
};

/** A one-line, order-independent description of a ruleset, used both to compare and to print. */
export function describeRuleset(r: Ruleset): string {
  const include = [...(r.conditions?.ref_name?.include ?? [])].sort().join(',');
  const exclude = [...(r.conditions?.ref_name?.exclude ?? [])].sort().join(',');
  const bypass = (r.bypass_actors ?? [])
    .map((a) => (a.actor_type === 'RepositoryRole' && a.actor_id === ADMIN_ROLE_ID ? `admin:${a.bypass_mode}` : `${a.actor_type}#${a.actor_id}:${a.bypass_mode}`))
    .sort()
    .join(',');
  const rules = (r.rules ?? [])
    .map((rule) => {
      const keys = COMPARED_PARAMETERS[rule.type];
      const params = rule.parameters ?? {};
      if (keys === undefined) return Object.keys(params).length === 0 ? rule.type : `${rule.type}${JSON.stringify(params)}`;
      const parts = keys.map((k) => `${k}=${JSON.stringify(params[k])}`);
      if (rule.type === 'required_status_checks') {
        const checks = Array.isArray(params.required_status_checks) ? (params.required_status_checks as { context?: unknown; integration_id?: unknown }[]) : [];
        parts.unshift(`checks=${checks.map((c) => (c.integration_id == null ? String(c.context) : `${String(c.context)}@${String(c.integration_id)}`)).sort().join('|')}`);
      }
      return `${rule.type}(${parts.join(' ')})`;
    })
    .sort()
    .join(', ');
  return `${r.target} ${r.enforcement}; refs ${include || '-'}${exclude ? ` minus ${exclude}` : ''}; bypass ${bypass || 'none'}; rules ${rules || 'none'}`;
}

// ---------------------------------------------------------------------------------------------
// The plan

export type Status = 'ok' | 'change' | 'changed' | 'unavailable';

export interface Setting {
  id: string;
  current: string;
  desired: string;
  status: Status;
  note?: string;
}

interface Item extends Setting {
  apply?: () => GhResult;
}

export interface Plan {
  repo: string;
  mode: 'dry-run' | 'apply';
  defaultBranch: string;
  ciWorkflowOnDefaultBranch: boolean;
  skipRequiredChecks: boolean;
  settings: Setting[];
  summary: { ok: number; change: number; changed: number; unavailable: number };
}

function onOff(v: boolean): string {
  return v ? 'enabled' : 'disabled';
}

function boolItem(id: string, current: boolean, desired: boolean, apply: () => GhResult): Item {
  return { id, current: onOff(current), desired: onOff(desired), status: current === desired ? 'ok' : 'change', apply };
}

function unavailable(id: string, desired: string, r: { status: number; message: string }): Item {
  return { id, current: 'unknown', desired, status: 'unavailable', note: `GitHub answered HTTP ${r.status}: ${r.message}` };
}

interface Built {
  plan: Plan;
  items: Item[];
  /** The ruleset change would add the required check while the CI workflow is missing. */
  blocked: boolean;
}

export function buildPlan(repo: string, skipRequiredChecks: boolean, gh = ghApi): Built {
  const base = `repos/${repo}`;
  const items: Item[] = [];

  const repoRead = gh('GET', base);
  if (!repoRead.ok) fail(`cannot read ${repo}`, repoRead);
  const info = repoRead.body as {
    default_branch?: string;
    delete_branch_on_merge?: boolean;
    security_and_analysis?: Record<string, { status?: string } | undefined> | null;
  };
  const defaultBranch = info.default_branch ?? 'main';

  // Vulnerability (Dependabot) alerts: 204 when on, 404 when off.
  const alerts = gh('GET', `${base}/vulnerability-alerts`);
  if (alerts.ok || (!alerts.ok && alerts.status === 404)) {
    items.push(boolItem('vulnerability_alerts', alerts.ok, true, () => gh('PUT', `${base}/vulnerability-alerts`)));
  } else if (isUnavailable(alerts)) items.push(unavailable('vulnerability_alerts', 'enabled', alerts));
  else fail('reading vulnerability alerts', alerts);

  for (const [id, path] of [
    ['dependabot_security_updates', 'automated-security-fixes'],
    ['private_vulnerability_reporting', 'private-vulnerability-reporting'],
  ] as const) {
    const r = gh('GET', `${base}/${path}`);
    if (r.ok) items.push(boolItem(id, (r.body as { enabled?: boolean }).enabled === true, true, () => gh('PUT', `${base}/${path}`)));
    else if (isUnavailable(r)) items.push(unavailable(id, 'enabled', r));
    else fail(`reading ${id}`, r);
  }

  const sa = info.security_and_analysis ?? {};
  for (const key of ['secret_scanning', 'secret_scanning_push_protection']) {
    const status = sa[key]?.status;
    if (status === undefined) {
      items.push({ id: key, current: 'unknown', desired: 'enabled', status: 'unavailable', note: 'not in security_and_analysis (no admin access, or not offered for this repo)' });
    } else {
      items.push(boolItem(key, status === 'enabled', true, () => gh('PATCH', base, { security_and_analysis: { [key]: { status: 'enabled' } } })));
    }
  }

  items.push(boolItem('delete_branch_on_merge', info.delete_branch_on_merge === true, true, () => gh('PATCH', base, { delete_branch_on_merge: true })));

  const actions = gh('GET', `${base}/actions/permissions`);
  if (actions.ok) {
    const a = actions.body as { enabled?: boolean; allowed_actions?: string; sha_pinning_required?: boolean };
    items.push(
      boolItem('actions_sha_pinning_required', a.sha_pinning_required === true, true, () =>
        gh('PUT', `${base}/actions/permissions`, {
          enabled: a.enabled ?? true,
          ...(a.allowed_actions !== undefined ? { allowed_actions: a.allowed_actions } : {}),
          sha_pinning_required: true,
        }),
      ),
    );
  } else if (isUnavailable(actions)) items.push(unavailable('actions_sha_pinning_required', 'enabled', actions));
  else fail('reading actions permissions', actions);

  const workflow = gh('GET', `${base}/actions/permissions/workflow`);
  const wantWorkflow = 'default_workflow_permissions=read, can_approve_pull_request_reviews=false';
  if (workflow.ok) {
    const w = workflow.body as { default_workflow_permissions?: string; can_approve_pull_request_reviews?: boolean };
    const current = `default_workflow_permissions=${w.default_workflow_permissions}, can_approve_pull_request_reviews=${w.can_approve_pull_request_reviews}`;
    items.push({
      id: 'workflow_permissions',
      current,
      desired: wantWorkflow,
      status: current === wantWorkflow ? 'ok' : 'change',
      apply: () => gh('PUT', `${base}/actions/permissions/workflow`, { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false }),
    });
  } else if (isUnavailable(workflow)) items.push(unavailable('workflow_permissions', wantWorkflow, workflow));
  else fail('reading workflow permissions', workflow);

  // Is the CI workflow on the default branch on GitHub? A required check that never runs blocks every PR.
  const ci = gh('GET', `${base}/contents/${CI_WORKFLOW}?ref=${encodeURIComponent(defaultBranch)}`);
  if (!ci.ok && ci.status !== 404) fail(`checking ${CI_WORKFLOW} on ${defaultBranch}`, ci);
  const ciPresent = ci.ok;

  let blocked = false;
  const list = gh('GET', `${base}/rulesets?includes_parents=false`);
  if (list.ok) {
    const summaries = (Array.isArray(list.body) ? list.body : []) as { id: number; name: string; source_type?: string }[];
    const existing = summaries.find((r) => r.name === RULESET_NAME && (r.source_type === undefined || r.source_type === 'Repository'));
    let current: Ruleset | undefined;
    if (existing) {
      const read = gh('GET', `${base}/rulesets/${existing.id}`);
      if (!read.ok) fail(`reading ruleset ${existing.id}`, read);
      current = read.body as Ruleset;
    }
    const keep = current?.rules?.find((r) => r.type === 'required_status_checks');
    const desired = desiredRuleset(skipRequiredChecks, keep);
    const desiredText = describeRuleset(desired);
    const currentText = current ? describeRuleset(current) : 'absent';
    const item: Item = {
      id: `ruleset '${RULESET_NAME}'`,
      current: currentText,
      desired: desiredText,
      status: currentText === desiredText ? 'ok' : 'change',
      apply: current?.id !== undefined ? () => gh('PUT', `${base}/rulesets/${current.id}`, desired) : () => gh('POST', `${base}/rulesets`, desired),
    };
    if (item.status === 'change') item.note = current ? `update ruleset ${current.id}` : 'create';
    if (item.status === 'change' && !skipRequiredChecks && !ciPresent) {
      blocked = true;
      item.note = `${item.note}; --apply refuses: ${CI_WORKFLOW} is not on ${defaultBranch} (merge CI first, or use --skip-required-checks)`;
    }
    items.push(item);
  } else if (isUnavailable(list)) items.push(unavailable(`ruleset '${RULESET_NAME}'`, describeRuleset(desiredRuleset(skipRequiredChecks)), list));
  else fail('listing rulesets', list);

  const plan: Plan = {
    repo,
    mode: 'dry-run',
    defaultBranch,
    ciWorkflowOnDefaultBranch: ciPresent,
    skipRequiredChecks,
    settings: [],
    summary: { ok: 0, change: 0, changed: 0, unavailable: 0 },
  };
  return { plan, items, blocked };
}

function finish(plan: Plan, items: Item[]): Plan {
  plan.settings = items.map(({ apply: _apply, ...setting }) => setting);
  for (const s of plan.settings) plan.summary[s.status]++;
  return plan;
}

export function run(repo: string, opts: { apply: boolean; skipRequiredChecks: boolean }, gh = ghApi): Plan {
  const { plan, items, blocked } = buildPlan(repo, opts.skipRequiredChecks, gh);
  if (!opts.apply) return finish(plan, items);
  plan.mode = 'apply';
  if (blocked) {
    throw new HardenError(
      `refusing to apply: the '${RULESET_NAME}' ruleset would require the '${CI_CHECK}' check, but ${CI_WORKFLOW} is not on ${plan.defaultBranch} on GitHub, so every pull request would be blocked. Merge the CI workflow first, or rerun with --skip-required-checks. Nothing was changed.`,
      1,
    );
  }
  const done: string[] = [];
  for (const item of items) {
    if (item.status !== 'change' || item.apply === undefined) continue;
    const r = item.apply();
    if (r.ok) {
      item.status = 'changed';
      done.push(item.id);
    } else if (isUnavailable(r)) {
      item.status = 'unavailable';
      item.note = `GitHub answered HTTP ${r.status}: ${r.message}`;
    } else {
      throw new HardenError(`changing ${item.id}: ${describe(r)}${done.length ? ` (already changed: ${done.join(', ')})` : ' (nothing was changed)'}`, 1);
    }
  }
  return finish(plan, items);
}

export function formatPlan(plan: Plan): string {
  const lines = [
    `${plan.repo} (${plan.mode === 'apply' ? 'apply' : 'dry run, nothing changed'})`,
    `CI workflow ${CI_WORKFLOW} on ${plan.defaultBranch}: ${plan.ciWorkflowOnDefaultBranch ? 'present' : 'missing'}${plan.skipRequiredChecks ? ' (required check skipped)' : ''}`,
  ];
  for (const s of plan.settings) {
    lines.push(`  [${s.status}] ${s.id}: ${s.current} → ${s.desired}${s.note ? ` (${s.note})` : ''}`);
  }
  const { ok, change, changed, unavailable: na } = plan.summary;
  const parts = plan.mode === 'apply' ? [`${changed} changed`, `${ok} already set`] : [`${change} to change`, `${ok} already set`];
  parts.push(`${na} unavailable (403/404: the account or plan can't change it)`);
  lines.push(`Summary: ${parts.join(', ')}.${plan.mode === 'dry-run' && change > 0 ? ' Run with --apply to make the changes.' : ''}`);
  return lines.join('\n');
}

export function main(argv: string[], gh = ghApi): { code: number; stdout: string; stderr: string } {
  try {
    let values;
    try {
      ({ values } = parseArgs({
        args: argv,
        options: {
          'dry-run': { type: 'boolean' },
          apply: { type: 'boolean' },
          json: { type: 'boolean' },
          repo: { type: 'string' },
          'skip-required-checks': { type: 'boolean' },
          help: { type: 'boolean', short: 'h' },
        },
        strict: true,
        allowPositionals: false,
      }));
    } catch (error) {
      throw new HardenError((error as Error).message, 2);
    }
    if (values.help) return { code: 0, stdout: `${USAGE}\n`, stderr: '' };
    if (values.apply && values['dry-run']) throw new HardenError('--dry-run and --apply are mutually exclusive', 2);
    const repo = values.repo ?? DEFAULT_REPO;
    if (!REPO_PATTERN.test(repo)) throw new HardenError(`invalid --repo '${repo}': use owner/name`, 2);
    const plan = run(repo, { apply: values.apply === true, skipRequiredChecks: values['skip-required-checks'] === true }, gh);
    return { code: 0, stdout: `${values.json ? JSON.stringify(plan) : formatPlan(plan)}\n`, stderr: '' };
  } catch (error) {
    const code = error instanceof HardenError ? error.exitCode : 1;
    return { code, stdout: '', stderr: `${NAME}: ${(error as Error).message}\n${code === 2 ? 'Run with --help for usage.\n' : ''}` };
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const result = main(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
