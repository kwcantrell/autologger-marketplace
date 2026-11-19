// up and ca run the checkout's Makefile, so they need an explicit checkout (--repo or
// $AUTOLOGGER_REPO, never the current directory) whose origin remote is
// github.com/kwcantrell/autologger-2. doctor, which runs no Makefile, keeps the current-directory default.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT } from '../src/run.ts';
import { displayRemote, isAutologgerOrigin } from '../src/stack.ts';
import { cli, fakeRunner, fixture, NOT_FOUND } from './helpers.ts';

const MAKEFILE_RUNS: string[][] = [['up'], ['up', '--dry-run'], ['ca'], ['ca', '--out', 'ca.crt']];

for (const argv of MAKEFILE_RUNS) {
  test(`${argv.join(' ')} without --repo or AUTOLOGGER_REPO is a usage error, even inside a checkout`, async () => {
    const f = fixture();
    for (const env of [f.env, { ...f.env, AUTOLOGGER_REPO: '' }]) {
      const runner = fakeRunner();
      // The current directory is a complete checkout with the right remote: still refused.
      const { code, stdout, stderr } = await cli({ env, cwd: f.repo, runner }, ...argv, '--json');
      assert.equal(code, EXIT.usage);
      assert.equal(stdout, '');
      assert.match(stderr, new RegExp(`^autologger-dev: ${argv[0]} runs the checkout's Makefile, so it needs --repo <path> or AUTOLOGGER_REPO; it does not default to the current directory\\n`));
      assert.deepEqual(runner.calls, [], 'nothing is run');
    }
  });
}

test('--repo with an empty path is a usage error', async () => {
  const f = fixture();
  for (const command of ['up', 'ca', 'doctor']) {
    const runner = fakeRunner();
    const r = await cli({ env: f.env, cwd: f.repo, runner }, command, '--repo', '');
    assert.equal(r.code, EXIT.usage, command);
    assert.match(r.stderr, /--repo needs a path/);
    assert.deepEqual(runner.calls, []);
  }
});

test('up and ca accept the checkout from AUTOLOGGER_REPO', async () => {
  const f = fixture();
  for (const argv of [['up', '--dry-run'], ['ca']]) {
    const runner = fakeRunner();
    const r = await cli({ env: { ...f.env, AUTOLOGGER_REPO: f.repo }, runner }, ...argv);
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.deepEqual(runner.calls[0]?.args, ['remote', 'get-url', 'origin']);
    assert.equal(runner.calls[0]?.cwd, f.repo);
  }
});

test('doctor still defaults to the current directory (it never runs the Makefile)', async () => {
  const f = fixture();
  const runner = fakeRunner();
  const { code, stdout } = await cli({ env: f.env, cwd: f.repo, runner }, 'doctor', '--json');
  assert.equal(code, EXIT.ok);
  const report = JSON.parse(stdout) as { repo: string; checks: { name: string; status: string; detail: string }[] };
  assert.equal(report.repo, f.repo);
  assert.match(report.checks.find((c) => c.name === 'checkout')?.detail ?? '', /from current directory/);
  assert.equal(runner.calls.some((c) => c.command === 'make' && c.args[0] !== '--version'), false);
});

const ACCEPTED = [
  'https://github.com/kwcantrell/autologger-2.git',
  'https://github.com/kwcantrell/autologger-2',
  'https://github.com/kwcantrell/autologger-2/',
  'https://github.com/KWCantrell/Autologger-2.git',
  'https://x-access-token:abc@github.com/kwcantrell/autologger-2.git',
  'git@github.com:kwcantrell/autologger-2.git',
  'git@github.com:kwcantrell/autologger-2',
  'ssh://git@github.com/kwcantrell/autologger-2.git',
  'ssh://git@github.com/kwcantrell/autologger-2',
  'ssh://git@github.com:22/kwcantrell/autologger-2.git',
];

const REFUSED = [
  'https://github.com/someone-else/autologger-2.git',
  'https://github.com/kwcantrell/autologger-2-fork.git',
  'https://github.com/kwcantrell/autologger.git',
  'https://gitlab.com/kwcantrell/autologger-2.git',
  'https://github.com.evil.example/kwcantrell/autologger-2.git',
  'https://evil.example/github.com/kwcantrell/autologger-2.git',
  'http://github.com/kwcantrell/autologger-2.git',
  'git@evil.example:kwcantrell/autologger-2.git',
  'https://github.com/kwcantrell/autologger-2.git/extra',
  '/home/someone/autologger-2',
  'file:///home/someone/autologger-2',
  '',
];

test('isAutologgerOrigin accepts https and ssh forms of github.com/kwcantrell/autologger-2, .git optional', () => {
  for (const url of ACCEPTED) assert.equal(isAutologgerOrigin(url), true, url);
  for (const url of REFUSED) assert.equal(isAutologgerOrigin(url), false, url);
});

for (const url of ACCEPTED) {
  test(`up and ca run with origin ${url}`, async () => {
    const f = fixture();
    for (const argv of [['up'], ['ca']]) {
      const runner = fakeRunner({ 'git remote': { stdout: `${url}\n` } });
      const r = await cli({ env: f.env, runner }, ...argv, '--repo', f.repo);
      assert.equal(r.code, EXIT.ok, `${argv[0]}: ${r.stderr}`);
      assert.ok(runner.calls.some((c) => c.command === 'make'), argv.join(' '));
    }
  });
}

for (const url of REFUSED.filter((u) => u !== '')) {
  test(`up, up --dry-run and ca refuse origin ${url} with exit 1, naming it, and run no make`, async () => {
    const f = fixture();
    for (const argv of [['up'], ['up', '--dry-run'], ['ca']]) {
      const runner = fakeRunner({ 'git remote': { stdout: `${url}\n` } });
      const { code, stdout, stderr } = await cli({ env: f.env, runner }, ...argv, '--repo', f.repo, '--json');
      assert.equal(code, EXIT.failure, argv.join(' '));
      assert.equal(stdout, '');
      assert.equal(
        stderr,
        `autologger-dev: the origin remote of ${f.repo} is ${JSON.stringify(url)}, not github.com/kwcantrell/autologger-2; refusing to run its Makefile\n`,
      );
      assert.deepEqual(
        runner.calls.map((c) => c.command),
        ['git'],
        'only the remote is read',
      );
    }
  });
}

test('a checkout with no origin remote (or not a git repository) is refused with exit 1', async () => {
  const f = fixture();
  for (const argv of [['up'], ['ca']]) {
    const runner = fakeRunner({ 'git remote': { code: 2, stderr: "error: No such remote 'origin'\n" } });
    const r = await cli({ env: f.env, runner }, ...argv, '--repo', f.repo);
    assert.equal(r.code, EXIT.failure);
    assert.match(r.stderr, /has no git origin remote \(or is not a git repository\); refusing to run its Makefile/);
    assert.deepEqual(runner.calls.map((c) => c.command), ['git']);
  }
});

test('git missing from PATH is exit 1 and nothing else runs', async () => {
  const f = fixture();
  const runner = fakeRunner({ 'git remote': NOT_FOUND });
  const r = await cli({ env: f.env, runner }, 'ca', '--repo', f.repo);
  assert.equal(r.code, EXIT.failure);
  assert.match(r.stderr, /git is not on PATH/);
  assert.deepEqual(runner.calls.map((c) => c.command), ['git']);
});

test('the remote is read without GIT_* variables that could point git at another repository', async () => {
  const f = fixture();
  const runner = fakeRunner();
  const env = { ...f.env, GIT_DIR: '/elsewhere/.git', GIT_CONFIG_GLOBAL: '/elsewhere/config', GIT_CONFIG_COUNT: '1' };
  assert.equal((await cli({ env, runner }, 'up', '--dry-run', '--repo', f.repo)).code, EXIT.ok);
  const git = runner.calls.find((c) => c.command === 'git');
  for (const k of ['GIT_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT']) assert.equal(git?.env?.[k], undefined, k);
  assert.equal(git?.env?.HOME, f.home);
});

test('credentials in a refused https remote are not printed', async () => {
  assert.equal(displayRemote('https://user:tok3n-value@gitlab.com/x/y.git'), '"https://[credentials]@gitlab.com/x/y.git"');
  const f = fixture();
  const runner = fakeRunner({ 'git remote': { stdout: 'https://user:tok3n-value@gitlab.com/x/y.git\n' } });
  const r = await cli({ env: f.env, runner }, 'up', '--repo', f.repo);
  assert.equal(r.code, EXIT.failure);
  assert.doesNotMatch(r.stderr, /tok3n-value/);
  assert.match(r.stderr, /is "https:\/\/\[credentials\]@gitlab\.com\/x\/y\.git", not github\.com/);
});
