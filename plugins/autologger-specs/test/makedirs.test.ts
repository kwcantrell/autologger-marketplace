// Creating the specs dir: one level at a time, failing (never hanging) where a directory cannot be made.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { makeDirs } from '../src/specs.ts';

const scratch = mkdtempSync(join(tmpdir(), 'autologger-specs-makedirs-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('makeDirs creates every missing directory and is a no-op when it exists', () => {
  const deep = join(scratch, 'a', 'b', 'c');
  makeDirs(deep);
  makeDirs(deep);
  assert.equal(statSync(deep).isDirectory(), true);
});

test('makeDirs throws on a file at the path or at a parent component', () => {
  const file = join(scratch, 'file');
  writeFileSync(file, '');
  assert.throws(() => makeDirs(file), /not a directory/);
  assert.throws(() => makeDirs(join(file, 'x', 'y')), { code: 'ENOTDIR' });
});

// mkdir under /proc fails with ENOENT although /proc exists; Node 24's recursive mkdirSync loops forever.
// Run in a child with a timeout, because a synchronous hang cannot be stopped by --test-timeout.
test('makeDirs under /proc throws instead of hanging', { skip: existsSync('/proc/self') ? false : 'needs Linux /proc' }, () => {
  const specs = new URL('../src/specs.ts', import.meta.url).href;
  const code = `import { makeDirs } from ${JSON.stringify(specs)};
try { makeDirs('/proc/autologger-specs-cannot-write-here/x'); console.log('created'); }
catch (error) { console.log(error.code); process.exitCode = 1; }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '--eval', code], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.signal, null, `makeDirs hung and was killed after 10 s (${process.version})`);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout.trim(), 'ENOENT');
});
