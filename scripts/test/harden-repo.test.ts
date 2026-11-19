import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FakeCall, FakeState } from './fake-gh.ts';

// Every test runs the real script with a fake `gh` first on PATH. No test talks to GitHub.
const repo = fileURLToPath(new URL('../..', import.meta.url));
const script = join(repo, 'scripts', 'harden-repo.ts');
const fakeGh = join(repo, 'scripts', 'test', 'fake-gh.ts');
const scratch = mkdtempSync(join(tmpdir(), 'harden-repo-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// A made-up repo: every --apply runs against it, as a second guard beside the fake gh.
const REPO = 'example-owner/example-repo';
// The default repo (used in dry-run only).
const DEFAULT_REPO = 'kwcantrell/autologger-marketplace';

const CI = '.github/workflows/ci.yml@main';

/** The state read from the real repo on 2026-11-19, with the CI workflow merged. */
function initialState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    repo: REPO,
    info: {
      default_branch: 'main',
      delete_branch_on_merge: false,
      security_and_analysis: {
        dependabot_security_updates: { status: 'disabled' },
        secret_scanning: { status: 'enabled' },
        secret_scanning_push_protection: { status: 'enabled' },
      },
    },
    vulnerabilityAlerts: false,
    automatedSecurityFixes: false,
    privateVulnerabilityReporting: false,
    actions: { enabled: true, allowed_actions: 'all', sha_pinning_required: false },
    workflow: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
    rulesets: [],
    files: [CI],
    forced: {},
    ...overrides,
  };
}

let fixtures = 0;
/**
 * The repos a run of the script could target: every explicit `--repo <x>` or `--repo=<x>`, else
 * the fixture's own repo. All of them are checked, so the guard does not depend on which value
 * parseArgs keeps.
 */
function targetRepos(args: string[], fixtureRepo: string): string[] {
  const repos: string[] = [];
  args.forEach((arg, i) => {
    if (arg === '--repo') repos.push(args[i + 1] ?? '');
    else if (arg.startsWith('--repo=')) repos.push(arg.slice('--repo='.length));
  });
  return repos.length > 0 ? repos : [fixtureRepo];
}

/** Guard: an --apply run must never target the real repo (the script's default or the named one). */
function assertApplySafe(args: string[], fixtureRepo: string): void {
  if (!args.includes('--apply')) return;
  for (const target of targetRepos(args, fixtureRepo)) {
    if (target === DEFAULT_REPO || target !== fixtureRepo) {
      throw new Error(`test guard: refusing an --apply run against '${target}'; it may only target the fake repo '${fixtureRepo}'`);
    }
  }
}

interface Fixture {
  run: (...args: string[]) => { status: number | null; stdout: string; stderr: string };
  state: () => FakeState;
  calls: () => FakeCall[];
  writes: () => FakeCall[];
  clearLog: () => void;
}

function fixture(state: FakeState): Fixture {
  const dir = join(scratch, `f${fixtures++}`);
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const statePath = join(dir, 'state.json');
  const logPath = join(dir, 'calls.jsonl');
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(logPath, '');
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/bin/sh\nexec '${process.execPath}' '${fakeGh}' "$@"\n`);
  chmodSync(gh, 0o755);
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, FAKE_GH_STATE: statePath, FAKE_GH_LOG: logPath };
  const calls = (): FakeCall[] =>
    readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as FakeCall);
  return {
    run: (...args) => {
      assertApplySafe(args, state.repo);
      // Every case targets the made-up repo unless it is a dry run of the default repo or names its own --repo.
      const target = state.repo === DEFAULT_REPO || args.includes('--repo') ? [] : ['--repo', state.repo];
      const r = spawnSync(process.execPath, [script, ...args, ...target], { encoding: 'utf8', env, cwd: dir });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    state: () => JSON.parse(readFileSync(statePath, 'utf8')) as FakeState,
    calls,
    writes: () => calls().filter((c) => c.method !== 'GET'),
    clearLog: () => writeFileSync(logPath, ''),
  };
}

interface PlanJson {
  repo: string;
  mode: string;
  ciWorkflowOnDefaultBranch: boolean;
  settings: { id: string; current: string; desired: string; status: string; note?: string }[];
  summary: { ok: number; change: number; changed: number; unavailable: number };
}

function setting(plan: PlanJson, id: string) {
  const s = plan.settings.find((x) => x.id === id);
  assert.ok(s, `no setting ${id} in ${JSON.stringify(plan.settings.map((x) => x.id))}`);
  return s;
}

const RULESET = "ruleset 'main protection'";

test('dry run (the default) prints current → desired per setting and changes nothing', () => {
  const f = fixture(initialState({ repo: DEFAULT_REPO }));
  const before = f.state();
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^kwcantrell\/autologger-marketplace \(dry run, nothing changed\)$/m);
  assert.match(r.stdout, /^ {2}\[change\] vulnerability_alerts: disabled → enabled$/m);
  assert.match(r.stdout, /^ {2}\[change\] dependabot_security_updates: disabled → enabled$/m);
  assert.match(r.stdout, /^ {2}\[change\] private_vulnerability_reporting: disabled → enabled$/m);
  assert.match(r.stdout, /^ {2}\[ok\] secret_scanning: enabled → enabled$/m);
  assert.match(r.stdout, /^ {2}\[ok\] secret_scanning_push_protection: enabled → enabled$/m);
  assert.match(r.stdout, /^ {2}\[change\] delete_branch_on_merge: disabled → enabled$/m);
  assert.match(r.stdout, /^ {2}\[change\] actions_sha_pinning_required: disabled → enabled$/m);
  assert.match(r.stdout, /^ {2}\[ok\] workflow_permissions: default_workflow_permissions=read/m);
  assert.match(r.stdout, /^ {2}\[change\] ruleset 'main protection': absent → branch active; refs ~DEFAULT_BRANCH; bypass admin:always; rules deletion, non_fast_forward, pull_request\(required_approving_review_count=0 dismiss_stale_reviews_on_push=true .*\), required_status_checks\(checks=ci@15368 strict_required_status_checks_policy=false\) \(create\)$/m);
  assert.match(r.stdout, /^Summary: 6 to change, 3 already set, 0 unavailable/m);
  assert.deepEqual(f.writes(), []);
  assert.deepEqual(f.state(), before);
  // --dry-run is the same as no mode flag.
  assert.equal(f.run('--dry-run').stdout, r.stdout);
});

test('--json emits the plan as one JSON value', () => {
  const f = fixture(initialState());
  const r = f.run('--json');
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout) as PlanJson;
  assert.equal(plan.repo, REPO);
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.ciWorkflowOnDefaultBranch, true);
  assert.deepEqual(plan.summary, { ok: 3, change: 6, changed: 0, unavailable: 0 });
  assert.deepEqual(setting(plan, 'vulnerability_alerts'), { id: 'vulnerability_alerts', current: 'disabled', desired: 'enabled', status: 'change' });
  assert.equal(setting(plan, RULESET).current, 'absent');
  assert.deepEqual(f.writes(), []);
});

test('--apply makes the changes, and a second --apply changes nothing', () => {
  const f = fixture(initialState());
  const r = f.run('--apply', '--json');
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout) as PlanJson;
  assert.deepEqual(plan.summary, { ok: 3, change: 0, changed: 6, unavailable: 0 });

  const writes = f.writes().map((c) => `${c.method} ${c.path}`);
  const base = `repos/${REPO}`;
  assert.deepEqual(writes, [
    `PUT ${base}/vulnerability-alerts`,
    `PUT ${base}/automated-security-fixes`,
    `PUT ${base}/private-vulnerability-reporting`,
    `PATCH ${base}`,
    `PUT ${base}/actions/permissions`,
    `POST ${base}/rulesets`,
  ]);
  const actionsPut = f.writes().find((c) => c.path === `${base}/actions/permissions`);
  assert.deepEqual(actionsPut?.body, { enabled: true, allowed_actions: 'all', sha_pinning_required: true });
  assert.deepEqual(f.writes().find((c) => c.method === 'PATCH')?.body, { delete_branch_on_merge: true });

  const ruleset = f.writes().find((c) => c.method === 'POST')?.body;
  assert.deepEqual(ruleset, {
    name: 'main protection',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
    rules: [
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
      {
        type: 'required_status_checks',
        parameters: { strict_required_status_checks_policy: false, do_not_enforce_on_create: false, required_status_checks: [{ context: 'ci', integration_id: 15368 }] },
      },
    ],
  });

  const state = f.state();
  assert.equal(state.vulnerabilityAlerts, true);
  assert.equal(state.automatedSecurityFixes, true);
  assert.equal(state.privateVulnerabilityReporting, true);
  assert.equal(state.info.delete_branch_on_merge, true);
  assert.equal(state.actions.sha_pinning_required, true);
  assert.equal(state.rulesets.length, 1);

  f.clearLog();
  const again = f.run('--apply');
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(f.writes(), [], 'second apply wrote something');
  assert.match(again.stdout, /^Summary: 0 changed, 9 already set, 0 unavailable/m);
  assert.doesNotMatch(again.stdout, /\[change/);
  assert.equal(f.state().rulesets.length, 1);
});

test('an existing ruleset with the same name is updated in place, not duplicated', () => {
  const f = fixture(
    initialState({
      rulesets: [
        { id: 7, name: 'other', target: 'tag', enforcement: 'active', source_type: 'Repository', source: REPO, rules: [{ type: 'deletion' }] },
        {
          id: 42,
          name: 'main protection',
          target: 'branch',
          enforcement: 'evaluate',
          source_type: 'Repository',
          source: REPO,
          conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
          bypass_actors: [],
          rules: [{ type: 'deletion' }],
        },
      ],
    }),
  );
  const dry = JSON.parse(f.run('--json').stdout) as PlanJson;
  const item = setting(dry, RULESET);
  assert.equal(item.status, 'change');
  assert.equal(item.note, 'update ruleset 42');
  assert.match(item.current, /^branch evaluate; .*bypass none; rules deletion$/);

  const r = f.run('--apply');
  assert.equal(r.status, 0, r.stderr);
  const rulesetWrites = f.writes().filter((c) => c.path.includes('/rulesets'));
  assert.deepEqual(
    rulesetWrites.map((c) => `${c.method} ${c.path}`),
    [`PUT repos/${REPO}/rulesets/42`],
  );
  const state = f.state();
  assert.deepEqual(
    state.rulesets.map((r) => [r.id, r.name, r.enforcement]),
    [
      [7, 'other', 'active'],
      [42, 'main protection', 'active'],
    ],
  );
  f.clearLog();
  assert.equal(f.run('--apply').status, 0);
  assert.deepEqual(f.writes(), []);
});

test('a live required check without integration_id is a change, shown in the dry run, and --apply pins it to GitHub Actions', () => {
  const f = fixture(
    initialState({
      rulesets: [
        {
          id: 9,
          name: 'main protection',
          target: 'branch',
          enforcement: 'active',
          source_type: 'Repository',
          source: REPO,
          conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
          bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
          rules: [
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
            { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, do_not_enforce_on_create: false, required_status_checks: [{ context: 'ci' }] } },
          ],
        },
      ],
    }),
  );
  const dry = JSON.parse(f.run('--json').stdout) as PlanJson;
  const item = setting(dry, RULESET);
  assert.equal(item.status, 'change');
  assert.equal(item.note, 'update ruleset 9');
  assert.match(item.current, /required_status_checks\(checks=ci strict_/);
  assert.match(item.desired, /required_status_checks\(checks=ci@15368 strict_/);
  assert.deepEqual(f.writes(), []);
  const text = f.run().stdout;
  assert.match(text, /\[change\] ruleset 'main protection': .*checks=ci strict_.* → .*checks=ci@15368 strict_/);

  assert.equal(f.run('--apply').status, 0);
  assert.deepEqual(
    f.writes().filter((c) => c.path.includes('/rulesets')).map((c) => `${c.method} ${c.path}`),
    [`PUT repos/${REPO}/rulesets/9`],
  );
  const checks = f.state().rulesets[0]?.rules?.find((r) => r.type === 'required_status_checks')?.parameters?.required_status_checks;
  assert.deepEqual(checks, [{ context: 'ci', integration_id: 15368 }]);
  f.clearLog();
  assert.equal(f.run('--apply').status, 0);
  assert.deepEqual(f.writes(), []);
});

test('--apply refuses to require the CI check while the CI workflow is not on the default branch', () => {
  const f = fixture(initialState({ files: [] }));
  const dry = f.run();
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /CI workflow \.github\/workflows\/ci\.yml on main: missing/);
  assert.match(dry.stdout, /--apply refuses: \.github\/workflows\/ci\.yml is not on main/);
  assert.ok(f.calls().some((c) => c.method === 'GET' && c.path === `repos/${REPO}/contents/.github/workflows/ci.yml?ref=main`));

  const before = f.state();
  const r = f.run('--apply');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^harden-repo: refusing to apply: .*--skip-required-checks\. Nothing was changed\.$/m);
  assert.deepEqual(f.writes(), []);
  assert.deepEqual(f.state(), before);

  const skipped = f.run('--apply', '--skip-required-checks', '--json');
  assert.equal(skipped.status, 0, skipped.stderr);
  const created = f.state().rulesets[0];
  assert.deepEqual(
    created?.rules?.map((rule) => rule.type),
    ['deletion', 'non_fast_forward', 'pull_request'],
  );
  assert.equal(f.state().privateVulnerabilityReporting, true);
  f.clearLog();
  assert.equal(f.run('--apply', '--skip-required-checks').status, 0);
  assert.deepEqual(f.writes(), []);
});

test('--skip-required-checks keeps an existing required check instead of removing it', () => {
  const f = fixture(initialState());
  assert.equal(f.run('--apply').status, 0);
  f.clearLog();
  const r = f.run('--apply', '--skip-required-checks');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.writes(), []);
  assert.ok(f.state().rulesets[0]?.rules?.some((rule) => rule.type === 'required_status_checks'));
});

test('a setting GitHub answers 403 or 404 for is reported as unavailable and the rest still applies', () => {
  const base = `repos/${REPO}`;
  const f = fixture(
    initialState({
      forced: {
        [`PUT ${base}/private-vulnerability-reporting`]: 403,
        [`GET ${base}/rulesets`]: 403,
        [`GET ${base}/actions/permissions`]: 404,
      },
    }),
  );
  const dry = JSON.parse(f.run('--json').stdout) as PlanJson;
  assert.equal(setting(dry, RULESET).status, 'unavailable');
  assert.equal(setting(dry, 'actions_sha_pinning_required').status, 'unavailable');
  assert.equal(setting(dry, 'private_vulnerability_reporting').status, 'change');

  const r = f.run('--apply');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}\[unavailable\] private_vulnerability_reporting: disabled → enabled \(GitHub answered HTTP 403: Forbidden\)$/m);
  assert.match(r.stdout, /^ {2}\[unavailable\] ruleset 'main protection': unknown → .*HTTP 403/m);
  assert.match(r.stdout, /^ {2}\[unavailable\] actions_sha_pinning_required: unknown → enabled \(GitHub answered HTTP 404/m);
  assert.match(r.stdout, /^ {2}\[changed\] vulnerability_alerts: disabled → enabled$/m);
  assert.match(r.stdout, /^Summary: 3 changed, 3 already set, 3 unavailable \(403\/404: the account or plan can't change it\)\.$/m);
  const state = f.state();
  assert.equal(state.vulnerabilityAlerts, true);
  assert.equal(state.automatedSecurityFixes, true);
  assert.equal(state.info.delete_branch_on_merge, true);
  assert.equal(state.privateVulnerabilityReporting, false);
});

test('any other failure exits 1 with the message on stderr and nothing on stdout', () => {
  const base = `repos/${REPO}`;
  const f = fixture(initialState({ forced: { [`PUT ${base}/private-vulnerability-reporting`]: 500 } }));
  const r = f.run('--apply', '--json');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^harden-repo: changing private_vulnerability_reporting: HTTP 500: Server Error \(already changed: vulnerability_alerts, dependabot_security_updates\)$/m);

  const gone = fixture(initialState({ forced: { [`GET ${base}`]: 404 } })).run();
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /^harden-repo: cannot read example-owner\/example-repo: HTTP 404: Not Found$/m);

  const noGh = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, PATH: join(scratch, 'empty') } });
  assert.equal(noGh.status, 1);
  assert.match(noGh.stderr, /gh not found on PATH/);
});

test('--repo picks the target repo', () => {
  const f = fixture(initialState({ repo: 'someone/else' }));
  const r = f.run('--repo', 'someone/else');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^someone\/else \(dry run/);
  assert.ok(f.calls().every((c) => c.path.startsWith('repos/someone/else')));
});

test('bad arguments exit 2 without calling gh', () => {
  const f = fixture(initialState({ repo: REPO }));
  for (const args of [['--apply', '--dry-run'], ['--nope'], ['--repo', 'not-a-repo'], ['--repo', 'a/b/c'], ['extra'], ['--repo']]) {
    const r = f.run(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^harden-repo: /);
  }
  assert.deepEqual(f.calls(), []);
  const help = f.run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: node scripts\/harden-repo\.ts/);
});

test('the fixture guard refuses an --apply run that would reach the real repo', () => {
  assert.throws(() => assertApplySafe(['--apply'], DEFAULT_REPO), /refusing an --apply run/);
  assert.throws(() => assertApplySafe(['--apply', '--repo', DEFAULT_REPO], REPO), /refusing an --apply run/);
  assert.throws(() => assertApplySafe(['--apply', '--repo', 'other/repo'], REPO), /refusing an --apply run/);
  assert.throws(() => assertApplySafe(['--apply', `--repo=${DEFAULT_REPO}`], REPO), /refusing an --apply run/);
  assert.throws(() => assertApplySafe(['--apply', '--repo', REPO, `--repo=${DEFAULT_REPO}`], REPO), /refusing an --apply run/);
  assert.doesNotThrow(() => assertApplySafe(['--apply'], REPO));
  assert.doesNotThrow(() => assertApplySafe(['--apply', '--repo', REPO], REPO));
  assert.doesNotThrow(() => assertApplySafe([], DEFAULT_REPO), 'a dry run of the default repo is fine');
  const f = fixture(initialState({ repo: DEFAULT_REPO }));
  assert.throws(() => f.run('--apply'), /refusing an --apply run/);
  assert.equal(f.calls().length, 0);
});
