// Creating the credentials directories: owner-only, and failing (never hanging) where a directory
// cannot be made.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CredentialStore, makeDirs } from '../src/store.ts';
import { tempConfigDir } from './helpers.ts';

test('makeDirs creates every missing directory with the mode, and is a no-op when it exists', () => {
  const scratch = tempConfigDir();
  const deep = join(scratch, 'a', 'b', 'c');
  makeDirs(deep, 0o700);
  makeDirs(deep, 0o700);
  for (const dir of [join(scratch, 'a'), join(scratch, 'a', 'b'), deep]) {
    assert.equal(statSync(dir).isDirectory(), true, dir);
    assert.equal(statSync(dir).mode & 0o077, 0, `${dir} is owner-only`);
  }
});

test('makeDirs rejects a regular file at the path or at a component (ENOTDIR)', () => {
  const scratch = tempConfigDir();
  const file = join(scratch, 'file');
  writeFileSync(file, '');
  assert.throws(() => makeDirs(file, 0o700), { code: 'ENOTDIR' });
  assert.throws(() => makeDirs(join(file, 'x', 'y'), 0o700), { code: 'ENOTDIR' });
  assert.equal(statSync(file).isFile(), true, 'the file is left as it was');
});

test('saving credentials where the config dir is a regular file fails with a message, not a chmod of the file', () => {
  const scratch = tempConfigDir();
  const file = join(scratch, 'config');
  writeFileSync(file, '', { mode: 0o644 });
  const store = new CredentialStore({ AUTOLOGGER_MCP_CONFIG_DIR: file }, 'https://localhost:8787');
  assert.throws(() => store.save({ version: 1, server: 'https://localhost:8787' }), /^Error: cannot create .*config: ENOTDIR/);
  assert.equal(statSync(file).mode & 0o777, 0o644);
});

// mkdir under /proc fails with ENOENT although /proc exists. Node 24's mkdirSync({ recursive: true })
// loops forever on that; makeDirs must throw instead. Run in a child with a timeout, because a
// synchronous hang cannot be stopped by --test-timeout.
test('makeDirs under /proc throws ENOENT instead of hanging', { skip: existsSync('/proc/self') ? false : 'needs Linux /proc' }, () => {
  const store = new URL('../src/store.ts', import.meta.url).href;
  const code = `import { makeDirs } from ${JSON.stringify(store)};
try { makeDirs('/proc/autologger-mcp-cannot-write-here/x', 0o700); console.log('created'); }
catch (error) { console.log(error.code); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '--eval', code], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.signal, null, `makeDirs hung and was killed after 10 s (${process.version})`);
  assert.equal(r.stdout.trim(), 'ENOENT', r.stderr);
});

test('saving credentials under /proc fails with a message instead of hanging', { skip: existsSync('/proc/self') ? false : 'needs Linux /proc' }, () => {
  const store = new URL('../src/store.ts', import.meta.url).href;
  const code = `import { CredentialStore } from ${JSON.stringify(store)};
try { new CredentialStore({ AUTOLOGGER_MCP_CONFIG_DIR: '/proc/autologger-mcp-cannot-write-here' }, 'https://localhost:8787').save({ version: 1, server: 'https://localhost:8787' }); console.log('created'); }
catch (error) { console.log(error.message); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '--eval', code], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.signal, null, `saving hung and was killed after 10 s (${process.version})`);
  assert.match(r.stdout, /^cannot create \/proc\/autologger-mcp-cannot-write-here: ENOENT/, r.stderr);
});
