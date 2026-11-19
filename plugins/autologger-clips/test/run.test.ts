import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLI_NAME, EXIT } from '../src/run.ts';
import { call, sandbox } from './helpers.ts';

const box = sandbox();
const ctx = { env: box.env, cwd: box.cwd };

test('--help prints usage on stdout naming every command', async () => {
  const { code, stdout } = await call(ctx, '--help');
  assert.equal(code, EXIT.ok);
  assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
  for (const c of ['timeline', 'compile', 'media set', 'media list', 'media remove', 'media fetch', 'editor start', 'editor status', 'editor stop', 'desktop doctor', '--json']) assert.ok(stdout.includes(c), c);
});

test('--version prints the package version', async () => {
  const { code, stdout } = await call(ctx, '--version');
  assert.equal(code, EXIT.ok);
  assert.match(stdout, /^\d+\.\d+\.\d+\n$/);
});

for (const argv of [['nope'], ['nope', '--json'], [], ['timeline', '--bogus'], ['media', 'list', '--clips', 'x'], ['desktop'], ['compile', 'extra', '--clips', 'a.json', '--out', 'b.otio']]) {
  test(`usage error for ${JSON.stringify(argv)}: exit 2, message on stderr only`, async () => {
    const { code, stdout, stderr } = await call(ctx, ...argv);
    assert.equal(code, EXIT.usage);
    assert.equal(stdout, '');
    assert.match(stderr, new RegExp(`^${CLI_NAME}: .+\\nRun '${CLI_NAME} --help' for usage\\.\\n$`));
  });
}

test('media list --json on an empty map prints one JSON value', async () => {
  const { code, stdout } = await call(ctx, 'media', 'list', '--json');
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout).sessions, []);
});
