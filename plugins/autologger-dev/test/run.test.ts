// The CLI convention: --help, --version, usage errors (exit 2, stderr only), --json on every command.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLI_NAME, EXIT } from '../src/run.ts';
import { answering, cli, fakeRunner, fixture, GOOD_OVERRIDES } from './helpers.ts';

test('--help prints usage on stdout and names every command', async () => {
  const { code, stdout, stderr } = await cli({}, '--help');
  assert.equal(code, EXIT.ok);
  assert.equal(stderr, '');
  assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
  for (const command of ['doctor', 'up', 'ca', 'status', 'connect', '--json', '--dry-run']) assert.ok(stdout.includes(command), command);
});

test('--version prints the package version', async () => {
  const { code, stdout } = await cli({}, '--version');
  assert.equal(code, EXIT.ok);
  assert.match(stdout, /^\d+\.\d+\.\d+\n$/);
});

for (const argv of [
  ['nope'],
  ['nope', '--json'],
  [],
  ['doctor', '--bogus'],
  ['doctor', 'extra'],
  ['status', '--repo', '/x'],
  ['connect', '--dry-run'],
  ['up', '--out', 'x'],
  ['ca', '--server', 'https://localhost:8787'],
  ['status', '--server'],
  ['status', '--server', 'http://example.com', '--json'],
]) {
  test(`usage error for ${JSON.stringify(argv)}: exit 2, message on stderr only`, async () => {
    const runner = fakeRunner();
    const { code, stdout, stderr } = await cli({ runner }, ...argv);
    assert.equal(code, EXIT.usage);
    assert.equal(stdout, '');
    assert.match(stderr, new RegExp(`^${CLI_NAME}: .+\\nRun '${CLI_NAME} --help' for usage\\.\\n$`));
    assert.deepEqual(runner.calls, []);
  });
}

test('every command with --json prints exactly one JSON value on stdout', async () => {
  const f = fixture({ overrides: GOOD_OVERRIDES });
  const opts = { env: f.env, runner: fakeRunner(), fetch: answering(401) };
  const commands = [['doctor', '--repo', f.repo], ['up', '--dry-run', '--repo', f.repo], ['up', '--repo', f.repo], ['ca', '--repo', f.repo], ['status'], ['connect']];
  for (const argv of commands) {
    const { code, stdout, stderr } = await cli(opts, ...argv, '--json');
    assert.equal(code, EXIT.ok, `${argv.join(' ')}: ${stderr}`);
    assert.equal(stdout.trimEnd().split('\n').length, 1, argv.join(' '));
    JSON.parse(stdout);
  }
});
