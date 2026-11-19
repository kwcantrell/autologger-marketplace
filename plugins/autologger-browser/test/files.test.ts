// ensureDirs: setup's `mkdir -p` for the folder above ~/.autologger-dev/browser, one level at a time,
// mode 700, failing (never hanging) where a directory cannot be made.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ensureDirs } from '../src/files.ts';
import { run } from '../src/run.ts';
import { CA1, capture, fakeRunner } from './helpers.ts';

const scratch = mkdtempSync(join(tmpdir(), 'autologger-browser-files-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('ensureDirs creates every missing directory with mode 700, and is a no-op when it exists', () => {
  const deep = join(scratch, 'a', 'b', 'c');
  ensureDirs(deep);
  ensureDirs(deep);
  for (const dir of [join(scratch, 'a'), join(scratch, 'a', 'b'), deep]) {
    assert.equal(statSync(dir).isDirectory(), true, dir);
    assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
  }
});

test('ensureDirs rejects a non-directory at an existing component', () => {
  const file = join(scratch, 'file');
  writeFileSync(file, '');
  assert.throws(() => ensureDirs(file), /refusing to use .*file: it is not a directory/);
  assert.throws(() => ensureDirs(join(file, 'x', 'y')), { code: 'ENOTDIR' });
  const dangling = join(scratch, 'dangling');
  symlinkSync(join(scratch, 'nowhere'), dangling);
  assert.throws(() => ensureDirs(dangling), /broken symlink/);
});

test('setup still refuses a symlink at its own folder after ensureDirs', async () => {
  const home = join(scratch, 'home-symlink');
  mkdirSync(join(home, '.autologger-dev'), { recursive: true });
  const real = join(scratch, 'elsewhere');
  mkdirSync(real);
  symlinkSync(real, join(home, '.autologger-dev', 'browser'));
  const bin = join(scratch, 'bin-symlink');
  mkdirSync(bin);
  writeFileSync(join(bin, 'chromium'), '#!/bin/sh\necho Chromium\n', { mode: 0o755 });
  const c = capture({ env: { HOME: home, PATH: bin }, runner: fakeRunner().runner });
  assert.equal(await run(['setup', '--ca', CA1], c.io), 1);
  assert.match(c.err(), /it is a symlink/);
});

// mkdir under /proc fails with ENOENT although /proc exists. Node 24's mkdirSync({ recursive: true })
// loops forever on that; ensureDirs, and setup with a HOME under /proc, must fail instead. Run in a
// child with a timeout, because a synchronous hang cannot be stopped by --test-timeout.
const noProc = existsSync('/proc/self') ? false : 'needs Linux /proc';

test('ensureDirs under /proc throws ENOENT instead of hanging', { skip: noProc }, () => {
  const files = new URL('../src/files.ts', import.meta.url).href;
  const code = `import { ensureDirs } from ${JSON.stringify(files)};
try { ensureDirs('/proc/autologger-browser-cannot-write-here/x'); console.log('created'); }
catch (error) { console.log(error.code); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '--eval', code], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.signal, null, `ensureDirs hung and was killed after 10 s (${process.version})`);
  assert.equal(r.stdout.trim(), 'ENOENT', r.stderr);
});

test('setup with HOME under /proc exits 1 instead of hanging', { skip: noProc }, () => {
  const bin = join(scratch, 'bin-proc');
  mkdirSync(bin);
  writeFileSync(join(bin, 'chromium'), '#!/bin/sh\necho Chromium\n', { mode: 0o755 });
  const runTs = new URL('../src/run.ts', import.meta.url).href;
  const helpers = new URL('./helpers.ts', import.meta.url).href;
  const code = `import { run } from ${JSON.stringify(runTs)};
import { capture, fakeRunner } from ${JSON.stringify(helpers)};
const c = capture({ env: { HOME: '/proc/autologger-browser-cannot-write-here', PATH: ${JSON.stringify(bin)} }, runner: fakeRunner().runner });
const status = await run(['setup', '--ca', ${JSON.stringify(CA1)}], c.io);
console.log(status, c.err().trim());`;
  const r = spawnSync(process.execPath, ['--input-type=module', '--eval', code], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.signal, null, `setup hung and was killed after 10 s (${process.version})`);
  assert.match(r.stdout.trim(), /^1 autologger-browser: .*ENOENT/, r.stderr);
});
