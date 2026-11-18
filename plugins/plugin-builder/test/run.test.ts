import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CLI_NAME, EXIT, run } from '../src/run.ts';
import { findCheckout } from '../src/repo.ts';
import { findOnPath } from '../src/verify.ts';
import { cleanEnv, fixture, scaffoldInto, withFakeClaude, withoutClaude } from './fixture.ts';
import type { Fixture } from './fixture.ts';

const fixtures: Fixture[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'plugin-builder-run-'));
after(() => {
  fixtures.forEach((f) => f.cleanup());
  rmSync(scratch, { recursive: true, force: true });
});

function checkout(options: { typecheckExit?: number } = {}): Fixture {
  const f = fixture(options);
  fixtures.push(f);
  return f;
}

async function call(cwd: string, argv: string[], env: NodeJS.ProcessEnv = cleanEnv()): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd, env });
  return { code, stdout, stderr };
}

function marketplaceNames(f: Fixture): string[] {
  return JSON.parse(readFileSync(join(f.root, '.claude-plugin', 'marketplace.json'), 'utf8')).plugins.map((p: { name: string }) => p.name);
}

test('--help prints usage on stdout', async () => {
  const { code, stdout } = await call(scratch, ['--help']);
  assert.equal(code, EXIT.ok);
  assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
  for (const word of ['new <name>', 'check <name>', 'verify <name>', '--json', '--repo']) assert.ok(stdout.includes(word), word);
});

test('--version prints the package version', async () => {
  const { code, stdout } = await call(scratch, ['--version']);
  assert.equal(code, EXIT.ok);
  assert.match(stdout, /^\d+\.\d+\.\d+\n$/);
});

for (const argv of [[], ['nope'], ['nope', '--json'], ['check'], ['check', 'a', '--all'], ['check', 'Bad_Name'], ['new'], ['new', 'a', 'b'], ['verify'], ['verify', '--all'], ['check', '--description', 'x', 'a'], ['check', '--bogus']]) {
  test(`usage error for ${JSON.stringify(argv)}: exit 2, message on stderr only`, async () => {
    const { code, stdout, stderr } = await call(scratch, argv);
    assert.equal(code, EXIT.usage);
    assert.equal(stdout, '');
    assert.match(stderr, new RegExp(`^${CLI_NAME}: .+\\nRun '${CLI_NAME} --help' for usage\\.\\n$`));
  });
}

test('outside a marketplace checkout: exit 2 with a clear message, for every command', async () => {
  for (const argv of [['new', 'x-y'], ['check', '--all'], ['verify', 'x-y']]) {
    const { code, stdout, stderr } = await call(scratch, [...argv, '--json']);
    assert.equal(code, EXIT.usage, argv.join(' '));
    assert.equal(stdout, '');
    assert.match(stderr, /^plugin-builder: not inside an autologger-marketplace checkout: .*pass --repo <path>\n$/);
  }
});

test('a marketplace.json with another name is not a checkout', async () => {
  const dir = join(scratch, 'other-market');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'someone-else', plugins: [] }));
  assert.throws(() => findCheckout(dir), /not inside an autologger-marketplace checkout/);
  const { code } = await call(dir, ['check', '--all']);
  assert.equal(code, EXIT.usage);
});

test('the checkout is the nearest ancestor of the cwd, or --repo', async () => {
  const f = checkout();
  scaffoldInto(f, 'demo-a');
  const deep = join(f.root, 'plugins', 'demo-a', 'src');
  assert.equal(findCheckout(deep), f.root);
  assert.equal((await call(deep, ['check', 'demo-a'])).code, EXIT.ok);
  const viaRepo = await call(scratch, ['check', '--all', '--json', '--repo', deep]);
  assert.equal(viaRepo.code, EXIT.ok, viaRepo.stderr);
  assert.deepEqual(JSON.parse(viaRepo.stdout), { plugins: ['demo-a'], findings: [] });
  const missing = await call(scratch, ['check', '--all', '--repo', join(scratch, 'nope')]);
  assert.equal(missing.code, EXIT.usage);
  assert.match(missing.stderr, /--repo .*nope: no such directory/);
});

test('new runs the checkout scaffold: same result as npm run new-plugin', async () => {
  const f = checkout();
  const { code, stdout, stderr } = await call(f.root, ['new', 'log-tools', '--description', 'Tools for logs.', '--json']);
  assert.equal(code, EXIT.ok, stderr);
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), { name: 'log-tools', path: 'plugins/log-tools', marketplace: '.claude-plugin/marketplace.json' });
  const manifest = JSON.parse(readFileSync(join(f.root, 'plugins', 'log-tools', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.deepEqual([manifest.name, manifest.description], ['log-tools', 'Tools for logs.']);
  assert.ok(existsSync(join(f.root, 'plugins', 'log-tools', 'skills', 'log-tools', 'SKILL.md')));
  assert.deepEqual(marketplaceNames(f), ['log-tools']);
  // and the result follows the convention
  assert.equal((await call(f.root, ['check', 'log-tools'])).code, EXIT.ok);
});

test('new without --json passes the scaffold message through', async () => {
  const f = checkout();
  const { code, stdout } = await call(f.root, ['new', 'log-tools']);
  assert.equal(code, EXIT.ok);
  assert.match(stdout, /^Created .*plugins\/log-tools and added 'log-tools' to \.claude-plugin\/marketplace\.json\.\n$/);
});

test('new: an existing name exits 1 with the scaffold message, writing nothing', async () => {
  const f = checkout();
  scaffoldInto(f, 'log-tools');
  const { code, stdout, stderr } = await call(f.root, ['new', 'log-tools', '--json']);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /^plugin-builder: new-plugin: plugins\/log-tools already exists\n$/);
  assert.deepEqual(marketplaceNames(f), ['log-tools']);
});

test('new: a bad name exits 2 with the scaffold message, writing nothing', async () => {
  const f = checkout();
  const { code, stdout, stderr } = await call(f.root, ['new', 'Bad_Name', '--json']);
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /^plugin-builder: new-plugin: invalid plugin name 'Bad_Name'/);
  assert.deepEqual(marketplaceNames(f), []);
});

test('new: a checkout without the scaffold script exits 1', async () => {
  const f = checkout();
  rmSync(join(f.root, 'scripts'), { recursive: true });
  const { code, stderr } = await call(f.root, ['new', 'log-tools']);
  assert.equal(code, 1);
  assert.match(stderr, /scripts\/new-plugin\.ts not found/);
});

test('check: findings go to stderr with file, line, rule and fix; exit 1, stdout empty', async () => {
  const f = checkout();
  scaffoldInto(f, 'demo-a');
  const cli = join(f.root, 'plugins', 'demo-a', 'src', 'cli.ts');
  writeFileSync(cli, readFileSync(cli, 'utf8').replace('#!/usr/bin/env node\n', '// no shebang\n'));
  const { code, stdout, stderr } = await call(f.root, ['check', 'demo-a', '--json']);
  assert.equal(code, EXIT.failure);
  assert.equal(stdout, '');
  assert.equal(
    stderr,
    'plugin-builder: 1 convention finding(s):\n' +
      'plugins/demo-a/src/cli.ts:1: [bin-shebang] first line is "// no shebang"; npx runs the bin as an executable script\n' +
      '  fix: make the first line exactly #!/usr/bin/env node\n',
  );
});

test('check: an unknown plugin exits 1', async () => {
  const f = checkout();
  const { code, stderr } = await call(f.root, ['check', 'nope']);
  assert.equal(code, EXIT.failure);
  assert.match(stderr, /plugins\/nope does not exist/);
});

test('check --all without --json prints a short summary', async () => {
  const f = checkout();
  scaffoldInto(f, 'demo-a');
  scaffoldInto(f, 'demo-b');
  assert.deepEqual(await call(f.root, ['check', '--all']), { code: 0, stdout: '2 plugin(s) follow the convention: demo-a, demo-b\n', stderr: '' });
});

test('verify: every step passes with a working claude; it runs from the checkout root', async () => {
  const f = checkout();
  scaffoldInto(f, 'demo-a');
  const { code, stdout, stderr } = await call(join(f.root, 'plugins'), ['verify', 'demo-a', '--json'], withFakeClaude(cleanEnv(), f));
  assert.equal(code, EXIT.ok, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.steps.map((s: { name: string; status: string; command: string[] }) => [s.name, s.status, s.command.join(' ')]),
    [
      ['check', 'pass', 'plugin-builder check demo-a'],
      ['validate-plugin', 'pass', 'claude plugin validate plugins/demo-a'],
      ['validate-marketplace', 'pass', 'claude plugin validate .'],
      ['typecheck', 'pass', 'npm run typecheck'],
      ['test', 'pass', 'node --test plugins/demo-a/test/**/*.test.ts'],
    ],
  );
  assert.equal(readFileSync(f.claudeLog, 'utf8'), 'plugin validate plugins/demo-a\nplugin validate .\n');
  // the plugin's own tests ran (their output streams on stderr), and only that plugin's
  assert.match(stderr, /^(#|ℹ) pass [1-9]/m);
  assert.match(stderr, /^(#|ℹ) fail 0$/m);
});

test('verify: claude not on PATH is reported as skipped, not passed', async () => {
  const f = checkout();
  scaffoldInto(f, 'demo-a');
  const { code, stdout, stderr } = await call(f.root, ['verify', 'demo-a'], withoutClaude(cleanEnv()));
  assert.equal(code, EXIT.ok, stderr);
  assert.match(stdout, /^SKIP {2}validate-plugin +claude plugin validate plugins\/demo-a \(claude is not on PATH\)$/m);
  assert.match(stdout, /^SKIP {2}validate-marketplace /m);
  assert.match(stdout, /^PASS {2}typecheck /m);
  assert.match(stdout, /every step passed or was skipped/);
});

test('verify: a failing step and a failing check make it exit 1 with every step reported on stderr', async () => {
  const f = checkout({ typecheckExit: 3 });
  scaffoldInto(f, 'demo-a');
  const pkg = join(f.root, 'plugins', 'demo-a', 'package.json');
  writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"private": true', '"private": false'));
  const { code, stdout, stderr } = await call(f.root, ['verify', 'demo-a', '--json'], withFakeClaude(cleanEnv(), f));
  assert.equal(code, EXIT.failure);
  assert.equal(stdout, '');
  assert.match(stderr, /\[package-private\]/);
  assert.match(stderr, /^plugin-builder: verify demo-a failed: check, typecheck$/m);
  assert.match(stderr, /^FAIL {2}typecheck +npm run typecheck \(exit 3\)$/m);
  assert.match(stderr, /^PASS {2}test /m);
});

test('verify: a failing claude plugin validate fails the step', async () => {
  const f = checkout();
  scaffoldInto(f, 'demo-a');
  writeFileSync(join(f.fakeBin, 'claude'), '#!/bin/sh\necho "invalid manifest" >&2\nexit 1\n');
  const { code, stderr } = await call(f.root, ['verify', 'demo-a'], withFakeClaude(cleanEnv(), f));
  assert.equal(code, EXIT.failure);
  assert.match(stderr, /invalid manifest/);
  assert.match(stderr, /failed: validate-plugin, validate-marketplace$/m);
});

test('verify: an unknown plugin exits 1 before running any step', async () => {
  const f = checkout();
  const { code, stderr } = await call(f.root, ['verify', 'nope'], withFakeClaude(cleanEnv(), f));
  assert.equal(code, EXIT.failure);
  assert.match(stderr, /plugins\/nope does not exist/);
});

const realClaude = findOnPath('claude', cleanEnv());
test('verify with the real claude validates the fixture plugin and marketplace', { skip: realClaude === null ? 'claude is not installed' : false }, async () => {
  const f = checkout();
  scaffoldInto(f, 'demo-a');
  const { code, stdout, stderr } = await call(f.root, ['verify', 'demo-a', '--json']);
  assert.equal(code, EXIT.ok, stderr);
  const steps = JSON.parse(stdout).steps as { name: string; status: string }[];
  assert.deepEqual(steps.map((s) => s.status), ['pass', 'pass', 'pass', 'pass', 'pass']);
  assert.match(stderr, /Validation passed/);
});
