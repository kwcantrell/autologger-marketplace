import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run, USAGE } from '../src/run.ts';
import { appOrigin, cookieName, runtimeOrigin, sessionName, slotPaths } from '../src/slot.ts';
import { capture, fakeRunner } from './helpers.ts';

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const c = capture({ env: { HOME: '/nonexistent-home', PATH: '/nonexistent' }, runner: fakeRunner().runner });
  const code = await run(args, c.io);
  return { code, out: c.out(), err: c.err() };
}

test('--help prints usage on stdout and exits 0', async () => {
  const { code, out } = await cli(['--help']);
  assert.equal(code, 0);
  assert.equal(out, USAGE);
  assert.match(out, /^Usage: autologger-browser /);
});

test('usage errors exit 2 with the message on stderr and nothing on stdout', async () => {
  for (const [args, message] of [
    [[], /missing command/],
    [['nope'], /unknown command 'nope'/],
    [['setup', '--slot', '10'], /--slot must be one digit/],
    [['setup', 'extra'], /takes no arguments/],
    [['signin', '--ca', 'x'], /signin does not take --ca/],
    [['doctor', '--bogus'], /Unknown option/],
  ] as const) {
    const { code, out, err } = await cli([...args]);
    assert.equal(code, 2, args.join(' '));
    assert.equal(out, '');
    assert.match(err, message);
  }
});

test('slot rules: origins, cookie names, sessions and folders', () => {
  assert.equal(appOrigin(0), 'https://localhost:8787');
  assert.equal(appOrigin(7), 'https://localhost:27787');
  assert.equal(runtimeOrigin(0), 'https://dashboards.localhost');
  assert.equal(runtimeOrigin(7), 'https://dashboards-7.localhost');
  assert.equal(cookieName(0), 'autologger_sid');
  assert.equal(cookieName(7), 'autologger_sid_7');
  assert.equal(sessionName(7), 'autologger-dev-7');
  assert.equal(slotPaths({ HOME: '/h' }, 7).dir, '/h/.autologger-dev/browser/slot-7');
});
