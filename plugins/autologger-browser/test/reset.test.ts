import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/run.ts';
import { slotPaths } from '../src/slot.ts';
import { capture, fakeRunner, tempHome } from './helpers.ts';

async function cli(env: Record<string, string>, args: string[], fake = fakeRunner()): Promise<{ code: number; out: string; err: string }> {
  const c = capture({ env, runner: fake.runner });
  const code = await run(args, c.io);
  return { code, out: c.out(), err: c.err() };
}

test('reset removes only the slot folder, after closing its session', async () => {
  const t = tempHome();
  try {
    assert.equal((await cli(t.env, ['setup'])).code, 0);
    assert.equal((await cli(t.env, ['setup', '--slot', '1'])).code, 0);
    writeFileSync(join(t.home, '.autologger-dev', 'browser', 'keep.txt'), 'x');
    const fake = fakeRunner();
    const { code, out } = await cli(t.env, ['reset', '--json'], fake);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out), { slot: 0, dir: slotPaths(t.env, 0).dir, removed: true });
    assert.deepEqual(fake.calls.map((c) => [c.command, ...c.args]), [['agent-browser', '--session', 'autologger-dev-0', 'close']]);
    assert.deepEqual(readdirSync(join(t.home, '.autologger-dev', 'browser')).sort(), ['keep.txt', 'slot-1']);
    assert.ok(existsSync(join(t.home, '.autologger-dev', 'autologger-dev-ca.crt')));
    const again = await cli(t.env, ['reset', '--json']);
    assert.equal((JSON.parse(again.out) as { removed: boolean }).removed, false);
  } finally {
    t.cleanup();
  }
});

test('reset refuses a symlinked slot folder or plugin folder and removes nothing', async () => {
  const t = tempHome();
  try {
    const outside = join(t.home, 'precious');
    mkdirSync(outside);
    writeFileSync(join(outside, 'file'), 'keep');
    mkdirSync(join(t.home, '.autologger-dev', 'browser'));
    symlinkSync(outside, join(t.home, '.autologger-dev', 'browser', 'slot-0'));
    const first = await cli(t.env, ['reset']);
    assert.equal(first.code, 1);
    assert.match(first.err, /refusing to remove .*not a real directory/);
    assert.deepEqual(readdirSync(outside), ['file']);

    rmSync(join(t.home, '.autologger-dev', 'browser'), { recursive: true });
    mkdirSync(join(outside, 'slot-0'));
    symlinkSync(outside, join(t.home, '.autologger-dev', 'browser'));
    const second = await cli(t.env, ['reset']);
    assert.equal(second.code, 1);
    assert.deepEqual(readdirSync(outside).sort(), ['file', 'slot-0']);
  } finally {
    t.cleanup();
  }
});
