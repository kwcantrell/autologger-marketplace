import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { parseGateOutput } from '../src/gate.ts';
import { CLI_NAME, EXIT, run } from '../src/run.ts';
import { lint, shapeProblems, specPathsEntry, specTemplate } from '../src/specs.ts';
import { parseYaml } from '../src/yaml.ts';
import { GOOD_SPEC, LIFECYCLE, fixture } from './fixture.ts';
import type { Fixture } from './fixture.ts';

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function call(cwd: string, ...argv: string[]): Promise<Result> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd });
  return { code, stdout, stderr };
}

function failure(r: Result, code: number): void {
  assert.equal(r.code, code, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, new RegExp(`^${CLI_NAME}: `));
}

const fixtures: Fixture[] = [];
function repo(files?: Record<string, string | null>): Fixture {
  const f = fixture(files);
  fixtures.push(f);
  return f;
}
after(() => {
  for (const f of fixtures) f.cleanup();
});

describe('usage', () => {
  test('--help prints usage on stdout', async () => {
    const r = await call(tmpdir(), '--help');
    assert.equal(r.code, EXIT.ok);
    assert.match(r.stdout, new RegExp(`^Usage: ${CLI_NAME} `));
    for (const command of ['which', 'stale', 'lint', 'new', 'gate']) assert.match(r.stdout, new RegExp(`\\n  ${command} `));
  });

  test('--version prints the package version', async () => {
    const r = await call(tmpdir(), '--version');
    assert.equal(r.code, EXIT.ok);
    assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
  });

  for (const argv of [[], ['nope'], ['nope', '--json'], ['which'], ['which', '--bogus', 'x'], ['stale', 'extra'], ['new'], ['new', 'a', 'b'], ['which', 'x', '--covers', 'y'], ['lint', '--base', 'main'], ['gate', 'bad;name']]) {
    test(`usage error for ${JSON.stringify(argv)}: exit 2, message on stderr only`, async () => {
      const f = repo();
      const r = await call(f.root, ...argv);
      assert.equal(r.code, EXIT.usage);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, new RegExp(`^${CLI_NAME}: .+\\nRun '${CLI_NAME} --help' for usage\\.\\n$`));
    });
  }
});

describe('finding the checkout', () => {
  test('outside a git checkout: exit 2 with a clear message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autologger-specs-nogit-'));
    try {
      const r = await call(dir, 'lint', '--json');
      failure(r, EXIT.usage);
      assert.match(r.stderr, /not inside a git checkout/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a git checkout without scripts/lifecycle.yaml: exit 2', async () => {
    const f = repo({ 'scripts/lifecycle.yaml': null });
    for (const argv of [['which', 'src/x.ts'], ['stale'], ['lint'], ['new', 'x'], ['gate']]) {
      const r = await call(f.root, ...argv, '--json');
      failure(r, EXIT.usage);
      assert.match(r.stderr, /not an autologger checkout: .* has no scripts\/lifecycle\.yaml/);
    }
    assert.equal(existsSync(join(f.root, 'docs/specs/x.md')), false);
  });

  test('works from a subdirectory (git toplevel) and with --repo from elsewhere', async () => {
    const f = repo();
    const fromSub = await call(join(f.root, 'src/alpha'), 'which', 'a.ts', '--json');
    assert.deepEqual(JSON.parse(fromSub.stdout), { 'src/alpha/a.ts': ['alpha'] });
    const fromElsewhere = await call(tmpdir(), 'which', 'src/alpha/a.ts', '--repo', f.root, '--json');
    assert.deepEqual(JSON.parse(fromElsewhere.stdout), { 'src/alpha/a.ts': ['alpha'] });
    const viaSub = await call(tmpdir(), 'lint', '--repo', join(f.root, 'docs'), '--json');
    assert.equal(viaSub.code, EXIT.ok, viaSub.stderr);
  });

  test('--repo that does not exist: exit 2', async () => {
    failure(await call(tmpdir(), 'lint', '--repo', join(tmpdir(), 'no-such-dir-autologger-specs')), EXIT.usage);
  });

  test('an unparseable lifecycle.yaml: exit 1 naming the line, not a misread', async () => {
    const f = repo({ 'scripts/lifecycle.yaml': `lifecycle:\n  spec_paths:\n    alpha: &a\n    - src/alpha/**\n` });
    const r = await call(f.root, 'which', 'src/alpha/a.ts');
    failure(r, EXIT.failure);
    assert.match(r.stderr, /cannot read scripts\/lifecycle\.yaml: line 3: anchors/);
  });
});

describe('which', () => {
  test('maps each path to the specs whose globs match it', async () => {
    const f = repo();
    const r = await call(f.root, 'which', '--json', 'src/alpha/deep/b.ts', 'src/shared.ts', 'src/beta1.ts', 'src/beta/x.ts', 'src/other.ts', './src/alpha/a.ts');
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      'src/alpha/deep/b.ts': ['alpha'],
      'src/shared.ts': ['alpha', 'beta'],
      'src/beta1.ts': ['beta'],
      'src/beta/x.ts': [],
      'src/other.ts': [],
      'src/alpha/a.ts': ['alpha'],
    });
  });

  test('text output names the specs or (no spec)', async () => {
    const f = repo();
    const r = await call(f.root, 'which', 'src/shared.ts', 'src/other.ts');
    assert.equal(r.stdout, 'src/shared.ts: alpha, beta\nsrc/other.ts: (no spec)\n');
  });

  test('uses the working tree map, and absolute paths work', async () => {
    const f = repo();
    f.write('scripts/lifecycle.yaml', LIFECYCLE.replace('    - src/alpha/**\n', '    - src/alpha/**\n    - src/other.ts\n'));
    const r = await call(f.root, 'which', join(f.root, 'src/other.ts'), '--json');
    assert.deepEqual(JSON.parse(r.stdout), { 'src/other.ts': ['alpha'] });
  });

  test('a path outside the checkout is a usage error', async () => {
    const f = repo();
    failure(await call(f.root, 'which', '../elsewhere.ts'), EXIT.usage);
    failure(await call(f.root, 'which', '/'), EXIT.usage);
  });
});

describe('stale', () => {
  test('a covered file changed without its spec: exit 1, specs and files on stderr', async () => {
    const f = repo();
    f.write('src/shared.ts', 'changed\n');
    f.write('src/alpha/new.ts', 'untracked\n');
    const r = await call(f.root, 'stale', '--json');
    failure(r, EXIT.failure);
    assert.match(r.stderr, /2 spec\(s\) not updated for the code they cover, against main \([0-9a-f]{12}\)/);
    assert.match(r.stderr, /^docs\/specs\/alpha\.md not changed, but its spec_paths cover: src\/alpha\/new\.ts, src\/shared\.ts$/m);
    assert.match(r.stderr, /^docs\/specs\/beta\.md not changed, but its spec_paths cover: src\/shared\.ts$/m);
  });

  test('committed and staged changes count too; editing the spec clears it', async () => {
    const f = repo();
    f.write('src/beta1.ts', 'changed\n');
    f.git('commit', '-qam', 'change beta');
    f.write('src/alpha/a.ts', 'staged\n');
    f.git('add', 'src/alpha/a.ts');
    let r = await call(f.root, 'stale');
    failure(r, EXIT.failure);
    assert.match(r.stderr, /alpha\.md not changed/);
    assert.match(r.stderr, /beta\.md not changed/);
    appendFileSync(join(f.root, 'docs/specs/alpha.md'), '\n');
    appendFileSync(join(f.root, 'docs/specs/beta.md'), '\n');
    r = await call(f.root, 'stale', '--json');
    assert.equal(r.code, EXIT.ok, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.deepEqual(result.stale, []);
    assert.equal(result.baseRef, 'main');
    assert.equal(result.mapFrom, 'base');
    assert.equal(result.active, true);
  });

  test('test files and managed paths need no spec', async () => {
    const f = repo();
    f.write('src/alpha/test/a.test.ts', 'changed\n');
    f.write('src/alpha/x.test.ts', 'new\n');
    f.write('scripts/check-change.sh', '#!/bin/sh\n');
    f.write('scripts/lifecycle.yaml', LIFECYCLE.replace('  - src/generated.ts\n', '  - src/generated.ts\n  - src/shared.ts\n'));
    f.write('src/generated.ts', 'regenerated\n');
    const r = await call(f.root, 'stale', '--json');
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).stale, []);
  });

  test('the map, test_globs and managed_paths are read from the base, not the working tree', async () => {
    const f = repo();
    // Unmapping src/shared.ts on this branch does not let it change without its specs.
    f.write('scripts/lifecycle.yaml', LIFECYCLE.replaceAll('    - src/shared.ts\n', '').replace("  - '**/*.test.*'\n", "  - '**/*.test.*'\n  - src/beta1.ts\n"));
    f.write('src/shared.ts', 'changed\n');
    f.write('src/beta1.ts', 'changed\n');
    const r = await call(f.root, 'stale');
    failure(r, EXIT.failure);
    assert.match(r.stderr, /alpha\.md not changed, but its spec_paths cover: src\/shared\.ts$/m);
    assert.match(r.stderr, /beta\.md not changed, but its spec_paths cover: src\/beta1\.ts, src\/shared\.ts$/m);
  });

  test('a base without a lifecycle config falls back to the working tree map', async () => {
    const f = repo();
    f.git('checkout', '-q', 'main');
    f.git('rm', '-q', 'scripts/lifecycle.yaml');
    f.git('commit', '-qm', 'no config on main');
    f.git('checkout', '-q', '-b', 'work2');
    f.write('scripts/lifecycle.yaml', LIFECYCLE);
    f.write('src/shared.ts', 'changed\n');
    const r = await call(f.root, 'stale', '--json');
    failure(r, EXIT.failure);
    assert.match(r.stderr, /alpha\.md not changed/);
  });

  test('origin/main is preferred over main', async () => {
    const f = repo();
    f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    f.write('src/shared.ts', 'changed\n');
    f.git('commit', '-qam', 'change shared');
    f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const r = await call(f.root, 'stale', '--json');
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.equal(JSON.parse(r.stdout).baseRef, 'origin/main');
  });

  test('--base picks the base; an unknown --base is an error', async () => {
    const f = repo();
    f.write('src/shared.ts', 'changed\n');
    f.git('commit', '-qam', 'change shared');
    f.git('tag', 'after');
    let r = await call(f.root, 'stale', '--base', 'after', '--json');
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.equal(JSON.parse(r.stdout).baseRef, 'after');
    failure(await call(f.root, 'stale', '--base', 'main'), EXIT.failure);
    r = await call(f.root, 'stale', '--base', 'no-such-ref');
    failure(r, EXIT.failure);
    assert.match(r.stderr, /--base no-such-ref: not a known ref/);
  });

  test('with no base at all every tracked file counts as changed', async () => {
    const f = repo();
    f.git('branch', '-q', '-m', 'main', 'trunk');
    const r = await call(f.root, 'stale', '--json');
    // Every spec file is "changed" too, so nothing is stale; the base is reported as null.
    assert.equal(r.code, EXIT.ok, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.base, null);
    assert.equal(result.mapFrom, 'working-tree');
    assert.equal(result.changed, 12);
  });

  test('an empty spec_paths on the base: gate not active, exit 0', async () => {
    const f = repo({ 'scripts/lifecycle.yaml': 'lifecycle:\n  test_globs: []\n' });
    f.write('src/shared.ts', 'changed\n');
    const r = await call(f.root, 'stale', '--json');
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.equal(JSON.parse(r.stdout).active, false);
  });
});

describe('lint', () => {
  test('clean fixture: exit 0 and JSON', async () => {
    const f = repo();
    const r = await call(f.root, 'lint', '--json');
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { specs: ['alpha', 'beta'], problems: [] });
  });

  const broken: Array<[string, string, RegExp]> = [
    ['no title', GOOD_SPEC('beta').replace('# beta Specification\n', '\n'), /docs\/specs\/beta\.md: missing a `# ` title on the first line$/m],
    ['title not on line 1', `\n${GOOD_SPEC('beta')}`, /beta\.md: missing a `# ` title on the first line/],
    ['no Purpose', GOOD_SPEC('beta').replace('## Purpose\nWhat beta does.\n', ''), /beta\.md: missing a `## Purpose` section$/m],
    ['empty Purpose', GOOD_SPEC('beta').replace('What beta does.\n', '  \n'), /beta\.md: missing text under `## Purpose`$/m],
    ['no Requirement', GOOD_SPEC('beta').replace('### Requirement: It works', '### It works'), /beta\.md: missing a `### Requirement:` heading$/m],
    ['several missing', '## Purpose\n\n', /beta\.md: missing a `# ` title on the first line, text under `## Purpose`, a `### Requirement:` heading$/m],
    ['Requirement without Scenario', `${GOOD_SPEC('beta')}\n### Requirement: Lonely\n\nNo scenario.\n\n## Notes\n\n#### Scenario: not under it\n`, /beta\.md:17: `### Requirement: Lonely` has no `#### Scenario:`$/m],
    ['CRLF line endings are fine', GOOD_SPEC('beta').replaceAll('\n', '\r\n'), /^$/],
  ];
  for (const [name, text, expected] of broken) {
    test(`reports: ${name}`, async () => {
      const f = repo({ 'docs/specs/beta.md': text });
      const r = await call(f.root, 'lint', '--json');
      if (expected.source === '^$') {
        assert.equal(r.code, EXIT.ok, r.stderr);
        return;
      }
      failure(r, EXIT.failure);
      assert.match(r.stderr, expected);
    });
  }

  test('reports map problems: spec without entry, entry without spec, bad entries', async () => {
    const f = repo({
      'docs/specs/gamma.md': GOOD_SPEC('gamma'),
      'scripts/lifecycle.yaml': `${LIFECYCLE}    ghost:\n    - src/other.ts\n    empty: []\n    nomatch:\n    - src/nothing/**\n`,
      'docs/specs/empty.md': GOOD_SPEC('empty'),
      'docs/specs/nomatch.md': GOOD_SPEC('nomatch'),
    });
    const r = await call(f.root, 'lint');
    failure(r, EXIT.failure);
    assert.match(r.stderr, /^docs\/specs\/gamma\.md has no lifecycle\.spec_paths entry$/m);
    assert.match(r.stderr, /^lifecycle\.spec_paths\.ghost names a spec that doesn't exist \(no docs\/specs\/ghost\.md\)$/m);
    assert.match(r.stderr, /^lifecycle\.spec_paths\.empty must be a non-empty list of globs$/m);
    assert.match(r.stderr, /^lifecycle\.spec_paths\.nomatch: `src\/nothing\/\*\*` matches no tracked file$/m);
    assert.match(r.stderr, /4 spec problem\(s\)/);
  });

  test('a spec_paths that is not a mapping, and no specs at all', async () => {
    let f = repo({ 'scripts/lifecycle.yaml': 'lifecycle:\n  spec_paths:\n  - alpha\n' });
    let r = await call(f.root, 'lint');
    failure(r, EXIT.failure);
    assert.match(r.stderr, /lifecycle\.spec_paths must be a mapping of spec name to a list of globs/);
    f = repo({ 'docs/specs/alpha.md': null, 'docs/specs/beta.md': null });
    r = await call(f.root, 'lint');
    failure(r, EXIT.failure);
    assert.match(r.stderr, /no specs in docs\/specs\//);
  });

  test('named specs: only those, and their own map entries', async () => {
    const f = repo({ 'docs/specs/beta.md': '# broken\n', 'docs/specs/gamma.md': GOOD_SPEC('gamma') });
    let r = await call(f.root, 'lint', 'alpha', '--json');
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).specs, ['alpha']);
    r = await call(f.root, 'lint', 'docs/specs/beta.md', 'gamma.md');
    failure(r, EXIT.failure);
    assert.match(r.stderr, /beta\.md: missing/);
    assert.match(r.stderr, /gamma\.md has no lifecycle\.spec_paths entry/);
    r = await call(f.root, 'lint', 'nope');
    failure(r, EXIT.failure);
    assert.match(r.stderr, /docs\/specs\/nope\.md does not exist/);
  });

  test('shapeProblems: a fenced or deeper heading is not a Requirement boundary', () => {
    assert.deepEqual(shapeProblems('x.md', GOOD_SPEC('x')), []);
    const text = `${GOOD_SPEC('x')}\n### Requirement: Two\n\n##### Detail\n\n#### Scenario: ok\n`;
    assert.deepEqual(shapeProblems('x.md', text), []);
  });
});

describe('new', () => {
  test('creates the spec, prints the entry; lint passes once the entry is added', async () => {
    const f = repo();
    const r = await call(f.root, 'new', 'gamma-ray', '--covers', 'src/other.ts', '--covers', '**/*.test.*', '--json');
    assert.equal(r.code, EXIT.ok, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.file, 'docs/specs/gamma-ray.md');
    assert.equal(result.entry, "    gamma-ray:\n    - src/other.ts\n    - '**/*.test.*'\n");
    assert.deepEqual(result.unmatched, []);
    assert.equal(result.mapped, false);
    assert.equal(readFileSync(join(f.root, result.file), 'utf8'), specTemplate('gamma-ray'));
    // Not mapped yet: lint names exactly that problem.
    let lintRun = await call(f.root, 'lint', 'gamma-ray');
    failure(lintRun, EXIT.failure);
    assert.match(lintRun.stderr, /gamma-ray\.md has no lifecycle\.spec_paths entry/);
    // The YAML is not edited by `new`; add the printed entry (spec_paths is the last block).
    assert.equal(readFileSync(join(f.root, 'scripts/lifecycle.yaml'), 'utf8'), LIFECYCLE);
    appendFileSync(join(f.root, 'scripts/lifecycle.yaml'), result.entry);
    lintRun = await call(f.root, 'lint', '--json');
    assert.equal(lintRun.code, EXIT.ok, lintRun.stderr);
    assert.deepEqual(JSON.parse(lintRun.stdout).specs, ['alpha', 'beta', 'gamma-ray']);
    const whichRun = await call(f.root, 'which', 'src/other.ts', '--json');
    assert.deepEqual(JSON.parse(whichRun.stdout), { 'src/other.ts': ['gamma-ray'] });
  });

  test('text output shows the entry; no --covers gives a placeholder; unmatched globs are flagged', async () => {
    const f = repo();
    let r = await call(f.root, 'new', 'delta');
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.match(r.stdout, /^Created docs\/specs\/delta\.md\./);
    assert.match(r.stdout, /\n {4}delta:\n {4}- path\/to\/covered\/source\/\*\*\n/);
    assert.match(r.stdout, /Replace the placeholder glob/);
    r = await call(f.root, 'new', 'epsilon', '--covers', 'src/none/**', '--json');
    assert.deepEqual(JSON.parse(r.stdout).unmatched, ['src/none/**']);
    r = await call(f.root, 'new', 'alpha-two', '--covers', 'src/alpha/**');
    assert.equal(r.code, EXIT.ok);
  });

  test('refuses an existing spec (exit 1) and a non-kebab-case name (exit 2), writing nothing', async () => {
    const f = repo();
    const before = readFileSync(join(f.root, 'docs/specs/alpha.md'), 'utf8');
    const r = await call(f.root, 'new', 'alpha', '--json');
    failure(r, EXIT.failure);
    assert.match(r.stderr, /docs\/specs\/alpha\.md already exists/);
    assert.equal(readFileSync(join(f.root, 'docs/specs/alpha.md'), 'utf8'), before);
    for (const name of ['Alpha', 'alpha_beta', 'alpha--beta', '-alpha', 'alpha-', '1alpha', 'a/b', '../x', 'x'.repeat(65), 'README']) {
      const bad = await call(f.root, 'new', '--json', '--', name);
      failure(bad, EXIT.usage);
      assert.match(bad.stderr, /kebab-case|not a spec name/);
    }
    assert.equal(f.git('status', '--porcelain'), '');
  });

  test('the entry quotes globs that YAML would not read back as the same string', () => {
    const globs = ['src/a.ts', '**/x', '*.ts', 'a: b', 'a #b', 'yes', '123', '~', "it's", '"q"', ' lead', '@x', '!x', '&x', '[x]', '{x}', '-x', '- x', '?x', 'x:', '%x', '|x', '>x', 'a\\b'];
    const parsed = parseYaml(`lifecycle:\n  spec_paths:\n${specPathsEntry('s', globs)}`) as { lifecycle: { spec_paths: { s: unknown } } };
    assert.deepEqual(parsed.lifecycle.spec_paths.s, globs);
    assert.equal(specPathsEntry('s', ['src/a.ts']), '    s:\n    - src/a.ts\n');
  });

  test('creates docs/specs/ if it is missing', async () => {
    const f = repo({ 'docs/specs/alpha.md': null, 'docs/specs/beta.md': null, 'docs/specs/README.md': null });
    const r = await call(f.root, 'new', 'first', '--json');
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.ok(existsSync(join(f.root, 'docs/specs/first.md')));
  });
});

describe('gate', () => {
  test('runs scripts/check-change.sh --only specs,specs-with-code by default, streaming to stderr', async () => {
    const f = repo();
    const r = await call(f.root, 'gate', '--json');
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.match(r.stderr, /^args: --only specs,specs-with-code$/m);
    assert.match(r.stderr, /^PASS {2}specs/m);
    const result = JSON.parse(r.stdout);
    assert.deepEqual(result.command, ['scripts/check-change.sh', '--only', 'specs,specs-with-code']);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.checks, [{ status: 'PASS', check: 'specs', message: 'fake gate ok' }]);
  });

  test('passes named checks (separate or comma-separated) and --base', async () => {
    const f = repo();
    const r = await call(join(f.root, 'src'), 'gate', 'specs', 'yaml,workflows', '--base', 'main');
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.match(r.stderr, /^args: --only specs,yaml,workflows --base main$/m);
    assert.equal(r.stdout, 'gate passed: scripts/check-change.sh --only specs,yaml,workflows --base main\n');
  });

  for (const status of [1, 2, 3]) {
    test(`exits with the script's status ${status}, stdout empty`, async () => {
      const f = repo();
      process.env.FAKE_GATE_EXIT = String(status);
      try {
        const r = await call(f.root, 'gate', '--json');
        assert.equal(r.code, status);
        assert.equal(r.stdout, '');
        assert.match(r.stderr, /FAIL {2}specs/);
        assert.match(r.stderr, /autologger-specs: scripts\/check-change\.sh --only specs,specs-with-code exited \d\n$/);
      } finally {
        delete process.env.FAKE_GATE_EXIT;
      }
    });
  }

  test('a missing script is a failure', async () => {
    const f = repo({ 'scripts/check-change.sh': null });
    const r = await call(f.root, 'gate');
    failure(r, EXIT.failure);
    assert.match(r.stderr, /scripts\/check-change\.sh not found/);
  });

  test('parseGateOutput keeps multi-line messages with their check', () => {
    assert.deepEqual(parseGateOutput('FAIL  specs-with-code  docs/specs/a.md not changed\ndocs/specs/b.md not changed\nPASS  specs            ok\n'), [
      { status: 'FAIL', check: 'specs-with-code', message: 'docs/specs/a.md not changed\ndocs/specs/b.md not changed' },
      { status: 'PASS', check: 'specs', message: 'ok' },
    ]);
  });
});

test('lint() reports the checkout-relative file for each spec', () => {
  const f = repo();
  mkdirSync(join(f.root, 'docs/specs/dir.md'));
  writeFileSync(join(f.root, 'docs/specs/notes.txt'), 'not a spec');
  assert.deepEqual(lint({ root: f.root, cwd: f.root }), { specs: ['alpha', 'beta'], problems: [] });
});
