// Verifies the CLI against a real autologger checkout and autologger's own Python gates. Not part of
// `npm test` (which uses fixture repos only); run it by hand:
//
//   node plugins/autologger-specs/test/verify-autologger.ts [/home/autologger/autologger-2]
//
// Needs python3 with PyYAML. It never modifies the given checkout: the parity checks only read it
// (Python runs with -B, so no __pycache__ is written), and the stale/new checks run in a `git clone`
// in a temp dir. Prints one line per check and exits 1 if any check fails.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = process.argv[2] ?? '/home/autologger/autologger-2';
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
let failed = false;

function sh(cmd: string, args: string[], cwd: string, input?: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function cliRun(cwd: string, ...args: string[]) {
  return sh(process.execPath, [cli, ...args], cwd);
}

function check(name: string, body: () => string): void {
  try {
    console.log(`PASS  ${name}: ${body()}`);
  } catch (error) {
    failed = true;
    console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Python reference: autologger's own check_change.py, imported from the checkout.
const PY_WHICH = `
import json, os, sys
sys.path.insert(0, os.path.join(os.getcwd(), 'scripts', 'lib'))
import check_change as cc
spec_map = cc.spec_path_map(cc.load_config())
files = [f for f in cc.git('ls-files', '-z').split('\\0') if f]
print(json.dumps({f: sorted(n for n, g in spec_map.items() if cc.matches(f, g)) for f in files}))
`;

const statusBefore = sh('git', ['status', '--porcelain', '--untracked-files=all'], checkout).stdout;

check('which: identical to check_change.py for every tracked file', () => {
  const py = sh('python3', ['-B', '-c', PY_WHICH], checkout);
  assert.equal(py.status, 0, py.stderr);
  const expected = JSON.parse(py.stdout) as Record<string, string[]>;
  const files = Object.keys(expected);
  // Pass the files through the CLI in batches (argv limits).
  const actual: Record<string, string[]> = {};
  for (let i = 0; i < files.length; i += 500) {
    const r = cliRun(checkout, 'which', '--json', '--', ...files.slice(i, i + 500));
    assert.equal(r.status, 0, r.stderr);
    Object.assign(actual, JSON.parse(r.stdout));
  }
  assert.deepEqual(actual, expected);
  const covered = files.filter((f) => (expected[f] ?? []).length > 0).length;
  return `${files.length} tracked files, ${covered} covered by at least one spec, 0 differences`;
});

check('yaml: scripts/lifecycle.yaml reads the same as PyYAML safe_load', () => {
  const py = sh('python3', ['-B', '-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read()), default=str))'], checkout, readFileSync(join(checkout, 'scripts/lifecycle.yaml'), 'utf8'));
  assert.equal(py.status, 0, py.stderr);
  const node = sh(process.execPath, ['-e', `import(${JSON.stringify(new URL('../src/yaml.ts', import.meta.url).href)}).then((m) => process.stdout.write(JSON.stringify(m.parseYaml(require('fs').readFileSync('scripts/lifecycle.yaml', 'utf8')))))`], checkout);
  assert.equal(node.status, 0, node.stderr);
  assert.deepEqual(JSON.parse(node.stdout), JSON.parse(py.stdout));
  return 'identical';
});

check('lint: clean on docs/specs/, like the specs gate', () => {
  const r = cliRun(checkout, 'lint', '--json');
  assert.equal(r.status, 0, r.stderr);
  const gateRun = sh('scripts/check-change.sh', ['--only', 'specs'], checkout);
  assert.equal(gateRun.status, 0, gateRun.stdout);
  return `${(JSON.parse(r.stdout) as { specs: string[] }).specs.length} specs, 0 problems; check-change.sh --only specs: ${gateRun.stdout.trim()}`;
});

// ---------------------------------------------------------------- scratch clone

const scratch = mkdtempSync(join(tmpdir(), 'autologger-specs-verify-'));
const clone = join(scratch, 'autologger');
try {
  const c = sh('git', ['clone', '-q', checkout, clone], scratch);
  if (c.status !== 0) throw new Error(`git clone failed: ${c.stderr}`);
  const g = (...args: string[]) => {
    const r = sh('git', ['-c', 'user.name=verify', '-c', 'user.email=verify@example.invalid', ...args], clone);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  g('checkout', '-q', '-b', 'scratch/verify-autologger-specs');
  const gateStale = () => sh('scripts/check-change.sh', ['--only', 'specs-with-code'], clone);
  const failedSpecs = (out: string) => [...out.matchAll(/(?:^|  )docs\/specs\/(\S+)\.md not changed/gm)].map((m) => m[1]).sort();

  const covered = 'server/src/routers/wiki.ts';
  check(`stale: agrees with check-change.sh --only specs-with-code after editing ${covered}`, () => {
    appendFileSync(join(clone, covered), '\n// scratch edit\n');
    g('commit', '-qam', 'scratch: edit a covered file');
    const ours = cliRun(clone, 'stale');
    const theirs = gateStale();
    assert.equal(ours.status, 1, ours.stderr);
    assert.equal(theirs.status, 1, theirs.stdout);
    assert.equal(ours.stdout, '');
    assert.deepEqual(failedSpecs(ours.stderr.replace(/^autologger-specs: .*\n/, '')), failedSpecs(theirs.stdout));
    return `both exit 1 naming ${failedSpecs(theirs.stdout).join(', ')}`;
  });

  check('stale: both pass once the specs are edited too', () => {
    for (const spec of ['api-contract-freeze', 'show-wiki']) appendFileSync(join(clone, `docs/specs/${spec}.md`), '\n');
    const ours = cliRun(clone, 'stale', '--json');
    const theirs = gateStale();
    assert.equal(ours.status, 0, ours.stderr);
    assert.equal(theirs.status, 0, theirs.stdout);
    assert.deepEqual((JSON.parse(ours.stdout) as { stale: unknown[] }).stale, []);
    return `stale exit 0; ${theirs.stdout.trim()}`;
  });

  check('stale: a test-only change needs no spec, in both', () => {
    g('checkout', '-q', '--', '.');
    g('reset', '-q', '--hard', 'origin/main');
    writeFileSync(join(clone, 'server/src/routers/wiki.test.ts'), '// scratch test\n');
    const ours = cliRun(clone, 'stale');
    const theirs = gateStale();
    assert.equal(ours.status, 0, ours.stderr);
    assert.equal(theirs.status, 0, theirs.stdout);
    rmSync(join(clone, 'server/src/routers/wiki.test.ts'));
    return 'both exit 0';
  });

  check('new: the created spec passes lint and check-change.sh --only specs once the entry is added', () => {
    const r = cliRun(clone, 'new', 'verify-scratch-spec', '--covers', 'server/src/routers/wiki.ts', '--covers', '**/*.sql', '--json');
    assert.equal(r.status, 0, r.stderr);
    const { entry, unmatched } = JSON.parse(r.stdout) as { entry: string; unmatched: string[] };
    assert.deepEqual(unmatched, []);
    const before = sh('scripts/check-change.sh', ['--only', 'specs'], clone);
    assert.equal(before.status, 1, 'the specs gate should fail before the entry is added');
    // spec_paths is the last block of lifecycle.yaml, so the entry can be appended.
    appendFileSync(join(clone, 'scripts/lifecycle.yaml'), entry);
    const ours = cliRun(clone, 'lint', '--json');
    const theirs = sh('scripts/check-change.sh', ['--only', 'specs'], clone);
    assert.equal(ours.status, 0, ours.stderr);
    assert.equal(theirs.status, 0, theirs.stdout);
    const again = cliRun(clone, 'new', 'verify-scratch-spec');
    assert.equal(again.status, 1);
    const bad = cliRun(clone, 'new', 'Not_Kebab');
    assert.equal(bad.status, 2);
    return `entry ${JSON.stringify(entry)}; lint exit 0; ${theirs.stdout.trim()}; existing -> 1, bad name -> 2`;
  });

  check('gate: runs check-change.sh and exits with its status', () => {
    const ok = cliRun(clone, 'gate', 'specs', '--json');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stderr, /^PASS {2}specs/m);
    appendFileSync(join(clone, 'docs/specs/show-wiki.md'), '\n### Requirement: no scenario here\n');
    // Removing the Purpose heading makes the repo's own gate fail too.
    const text = readFileSync(join(clone, 'docs/specs/show-wiki.md'), 'utf8');
    writeFileSync(join(clone, 'docs/specs/show-wiki.md'), text.replace('## Purpose', '## Purposeless'));
    const bad = cliRun(clone, 'gate', 'specs');
    assert.equal(bad.status, 1, bad.stderr);
    assert.equal(bad.stdout, '');
    return 'exit 0 on a clean tree, 1 with a broken spec';
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

check('the checkout was not modified', () => {
  assert.equal(sh('git', ['status', '--porcelain', '--untracked-files=all'], checkout).stdout, statusBefore);
  return 'git status unchanged';
});

process.exitCode = failed ? 1 : 0;
