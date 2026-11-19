// A fake `gh` for scripts/test/harden-repo.test.ts. It answers `gh api -X <METHOD> ... <path>
// [--input -]` from a JSON state file (FAKE_GH_STATE), applies writes to that state the way GitHub
// would, and appends every call to FAKE_GH_LOG as one JSON line. It never touches the network.
// Errors look like real gh: a JSON body on stdout, `gh: <message> (HTTP <status>)` on stderr, exit 1.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

export interface FakeRuleset {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  source_type: string;
  source: string;
  conditions?: unknown;
  bypass_actors?: unknown[];
  rules?: { type: string; parameters?: Record<string, unknown> }[];
}

export interface FakeState {
  repo: string;
  info: {
    default_branch: string;
    delete_branch_on_merge: boolean;
    security_and_analysis: Record<string, { status: string }>;
  };
  vulnerabilityAlerts: boolean;
  automatedSecurityFixes: boolean;
  privateVulnerabilityReporting: boolean;
  actions: { enabled: boolean; allowed_actions: string; sha_pinning_required: boolean };
  workflow: { default_workflow_permissions: string; can_approve_pull_request_reviews: boolean };
  rulesets: FakeRuleset[];
  /** Paths (as `<path>@<ref>`) present in the repo contents. */
  files: string[];
  /** Forced answers: "<METHOD> <path without query>" -> HTTP status. */
  forced: Record<string, number>;
}

export interface FakeCall {
  method: string;
  path: string;
  body?: unknown;
}

const MESSAGES: Record<number, string> = { 403: 'Forbidden', 404: 'Not Found', 422: 'Validation Failed', 500: 'Server Error' };

function main(argv: string[]): number {
  const statePath = process.env.FAKE_GH_STATE;
  const logPath = process.env.FAKE_GH_LOG;
  if (!statePath || !logPath) {
    process.stderr.write('fake gh: FAKE_GH_STATE and FAKE_GH_LOG must be set\n');
    return 4;
  }
  if (argv[0] !== 'api') {
    process.stderr.write(`fake gh: only 'api' is supported, got ${argv[0]}\n`);
    return 4;
  }
  let method = 'GET';
  let path = '';
  let readInput = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-X' || a === '--method') method = argv[++i] ?? '';
    else if (a === '-H' || a === '--header') i++;
    else if (a === '--input') readInput = argv[++i] === '-';
    else path = a ?? '';
  }
  const body = readInput ? JSON.parse(readFileSync(0, 'utf8')) : undefined;
  appendFileSync(logPath, `${JSON.stringify({ method, path, ...(body !== undefined ? { body } : {}) })}\n`);

  const state = JSON.parse(readFileSync(statePath, 'utf8')) as FakeState;
  const [bare = '', query = ''] = path.split('?');
  const error = (status: number): number => {
    const message = MESSAGES[status] ?? 'Error';
    process.stdout.write(JSON.stringify({ message, status: String(status) }));
    process.stderr.write(`gh: ${message} (HTTP ${status})\n`);
    return 1;
  };
  const ok = (value?: unknown): number => {
    if (value !== undefined) process.stdout.write(JSON.stringify(value));
    return 0;
  };
  const save = (): void => writeFileSync(statePath, JSON.stringify(state));

  const forced = state.forced[`${method} ${bare}`];
  if (forced !== undefined) return error(forced);

  const prefix = `repos/${state.repo}`;
  if (bare !== prefix && !bare.startsWith(`${prefix}/`)) return error(404);
  const rest = bare.slice(prefix.length);
  const route = `${method} ${rest}`;

  if (route === 'GET ') return ok({ full_name: state.repo, ...state.info });
  if (route === 'PATCH ') {
    const patch = body as { delete_branch_on_merge?: boolean; security_and_analysis?: Record<string, { status: string }> };
    if (patch.delete_branch_on_merge !== undefined) state.info.delete_branch_on_merge = patch.delete_branch_on_merge;
    for (const [k, v] of Object.entries(patch.security_and_analysis ?? {})) state.info.security_and_analysis[k] = v;
    save();
    return ok({ full_name: state.repo, ...state.info });
  }
  if (route === 'GET /vulnerability-alerts') return state.vulnerabilityAlerts ? ok() : error(404);
  if (route === 'PUT /vulnerability-alerts') {
    state.vulnerabilityAlerts = true;
    save();
    return ok();
  }
  if (route === 'GET /automated-security-fixes') return ok({ enabled: state.automatedSecurityFixes, paused: false });
  if (route === 'PUT /automated-security-fixes') {
    if (!state.vulnerabilityAlerts) return error(422);
    state.automatedSecurityFixes = true;
    save();
    return ok();
  }
  if (route === 'GET /private-vulnerability-reporting') return ok({ enabled: state.privateVulnerabilityReporting });
  if (route === 'PUT /private-vulnerability-reporting') {
    state.privateVulnerabilityReporting = true;
    save();
    return ok();
  }
  if (route === 'GET /actions/permissions') return ok(state.actions);
  if (route === 'PUT /actions/permissions') {
    state.actions = { ...state.actions, ...(body as object) };
    save();
    return ok();
  }
  if (route === 'GET /actions/permissions/workflow') return ok(state.workflow);
  if (route === 'PUT /actions/permissions/workflow') {
    state.workflow = { ...state.workflow, ...(body as object) };
    save();
    return ok();
  }
  if (method === 'GET' && rest.startsWith('/contents/')) {
    const ref = new URLSearchParams(query).get('ref') ?? state.info.default_branch;
    const file = rest.slice('/contents/'.length);
    return state.files.includes(`${file}@${ref}`) ? ok({ path: file, type: 'file' }) : error(404);
  }
  if (route === 'GET /rulesets') {
    return ok(state.rulesets.map(({ id, name, target, enforcement, source_type, source }) => ({ id, name, target, enforcement, source_type, source })));
  }
  const one = /^\/rulesets\/(\d+)$/.exec(rest);
  if (route === 'POST /rulesets' || (one && method === 'PUT')) {
    const id = one ? Number(one[1]) : Math.max(100, ...state.rulesets.map((r) => r.id)) + 1;
    const index = state.rulesets.findIndex((r) => r.id === id);
    if (one && index < 0) return error(404);
    // GitHub fills in defaults it was not sent; the script must not see those as a difference.
    const sent = body as Omit<FakeRuleset, 'id' | 'source_type' | 'source'>;
    const rules = (sent.rules ?? []).map((r) =>
      r.type === 'pull_request' ? { ...r, parameters: { allowed_merge_methods: ['merge', 'squash', 'rebase'], ...r.parameters } } : r,
    );
    const stored: FakeRuleset = { ...sent, rules, id, source_type: 'Repository', source: state.repo };
    if (index >= 0) state.rulesets[index] = stored;
    else state.rulesets.push(stored);
    save();
    return ok(stored);
  }
  if (one && method === 'GET') {
    const found = state.rulesets.find((r) => r.id === Number(one[1]));
    return found ? ok(found) : error(404);
  }
  return error(404);
}

process.exitCode = main(process.argv.slice(2));
