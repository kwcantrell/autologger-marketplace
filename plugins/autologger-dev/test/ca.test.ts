// ca: runs DEV_HTTPS=1 make dev-ca (injected runner), accepts exactly one PEM certificate, writes it
// mode 644 and prints the NODE_EXTRA_CA_CERTS export.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync as renameReal, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeCreatedDirs, singleCertificate, writeCertificate } from '../src/ca.ts';
import { CliError } from '../src/errors.ts';
import { EXIT } from '../src/run.ts';
import { type Call, cli, fakeRunner, fixture, INHERITED, NOT_FOUND, TEST_CA } from './helpers.ts';

const KEY_BLOCK = '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg\n-----END PRIVATE KEY-----\n';

test('ca writes the certificate to ~/.autologger-dev/autologger-dev-ca.crt (mode 644) and prints the export line', async () => {
  const f = fixture();
  const runner = fakeRunner();
  const { code, stdout, stderr } = await cli({ env: f.env, runner }, 'ca', '--repo', f.repo);
  assert.equal(code, EXIT.ok, stderr);
  const path = join(f.home, '.autologger-dev', 'autologger-dev-ca.crt');
  assert.equal(readFileSync(path, 'utf8'), TEST_CA);
  assert.equal(statSync(path).mode & 0o777, 0o644);
  assert.match(stdout, new RegExp(`to ${path}\\.`));
  assert.match(stdout, new RegExp(`\\n  export NODE_EXTRA_CA_CERTS=${path}\\n`));
  // Only the origin remote is read before make dev-ca runs.
  assert.deepEqual(
    runner.calls.map((c) => [c.command, c.args, c.cwd]),
    [
      ['git', ['remote', 'get-url', 'origin'], f.repo],
      ['make', ['dev-ca'], f.repo],
    ],
  );
  assert.equal(runner.calls[1]?.env?.DEV_HTTPS, '1');
});

test('ca --out writes there (relative to the cwd, parents created) and --json has the fields', async () => {
  const f = fixture();
  const { code, stdout } = await cli({ env: f.env, cwd: f.home }, 'ca', '--repo', f.repo, '--out', 'certs/my ca.crt', '--json');
  assert.equal(code, EXIT.ok);
  const path = join(f.home, 'certs', 'my ca.crt');
  const report = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(report.path, path);
  assert.equal(report.export, `export NODE_EXTRA_CA_CERTS='${path}'`);
  assert.equal(report.subject, 'CN=autologger-dev test root CA');
  assert.equal(report.is_ca, true);
  assert.match(String(report.fingerprint256), /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.equal(readFileSync(path, 'utf8'), TEST_CA);
});

for (const [name, output, reason] of [
  ['a private key next to the certificate', TEST_CA + KEY_BLOCK, /looks like a private key/],
  ['a private key alone', KEY_BLOCK, /looks like a private key/],
  ['an RSA private key', TEST_CA.replace(/CERTIFICATE/g, 'RSA PRIVATE KEY'), /looks like a private key/],
  ['two certificates', TEST_CA + TEST_CA, /2 PEM blocks/],
  ['no PEM at all', 'Error: service "app-gate" is not running\n', /no PEM certificate/],
  ['extra text around the certificate', `make: noise\n${TEST_CA}`, /other text/],
  ['a PEM block that is not a certificate', TEST_CA.replace(/CERTIFICATE/g, 'PUBLIC KEY'), /not a CERTIFICATE/],
  ['a broken certificate', '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n', /not a valid X\.509/],
] as const) {
  test(`ca refuses ${name} with exit 1 and writes nothing`, async () => {
    const f = fixture();
    const { code, stdout, stderr } = await cli({ env: f.env, runner: fakeRunner({ 'make dev-ca': { stdout: output } }) }, 'ca', '--repo', f.repo);
    assert.equal(code, EXIT.failure);
    assert.equal(stdout, '');
    assert.match(stderr, /^autologger-dev: refusing the output of DEV_HTTPS=1 make dev-ca: /);
    assert.match(stderr, reason);
    assert.match(stderr, /nothing was written\n$/);
    assert.doesNotMatch(stderr, /MIG|AAAA|BEGIN/, 'the output itself is never echoed');
    assert.equal(existsSync(join(f.home, '.autologger-dev')), false);
  });
}

test('singleCertificate accepts surrounding whitespace only', () => {
  assert.equal(singleCertificate(`\n\n${TEST_CA}\n`).ok, true);
});

test('ca: make failing, make missing and no checkout are exit 1', async () => {
  const f = fixture();
  let r = await cli({ env: f.env, runner: fakeRunner({ 'make dev-ca': { code: 2, stdout: '', stderr: 'service "app-gate" is not running\n' } }) }, 'ca', '--repo', f.repo);
  assert.equal(r.code, EXIT.failure);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /service "app-gate" is not running\nautologger-dev: DEV_HTTPS=1 make dev-ca failed \(exit 2\); is the stack up in HTTPS mode\?/);
  r = await cli({ env: f.env, runner: fakeRunner({ 'make dev-ca': NOT_FOUND }) }, 'ca', '--repo', f.repo);
  assert.match(r.stderr, /make is not on PATH/);
  const empty = fixture({ checkout: false });
  const runner = fakeRunner();
  r = await cli({ env: empty.env, runner }, 'ca', '--repo', empty.repo);
  assert.equal(r.code, EXIT.failure);
  assert.deepEqual(runner.calls, []);
});

test('ca --out with an empty path is a usage error', async () => {
  const r = await cli({}, 'ca', '--out', '');
  assert.equal(r.code, EXIT.usage);
});

/**
 * make dev-ca as GNU make answers it: in a sub-make (MAKELEVEL set) or with w / --print-directory
 * in MAKEFLAGS, GNUMAKEFLAGS or MFLAGS it prints "Entering directory" lines around the recipe's
 * output, which would no longer be a single certificate.
 */
function gnuMakeDevCa(call: Call): { stdout: string } {
  const env = call.env ?? {};
  const flags = `${env.MAKEFLAGS ?? ''} ${env.GNUMAKEFLAGS ?? ''} ${env.MFLAGS ?? ''}`;
  const printDirectory = (env.MAKELEVEL ?? '') !== '' || /(^|\s)-?w|--print-directory/.test(flags);
  const level = Number(env.MAKELEVEL ?? '0') || 0;
  return {
    stdout: printDirectory
      ? `make[${level + 1}]: Entering directory '${call.cwd ?? ''}'\n${TEST_CA}make[${level + 1}]: Leaving directory '${call.cwd ?? ''}'\n`
      : TEST_CA,
  };
}

test('ca run from inside another make (MAKELEVEL, MAKEFLAGS, ... inherited) still gets the bare certificate', async () => {
  // The fake really would wrap the output: proof that the stripping is what makes this pass.
  assert.match(gnuMakeDevCa({ command: 'make', args: ['dev-ca'], cwd: '/r', env: { MAKELEVEL: '1' } }).stdout, /Entering directory/);
  for (const inherited of [{ MAKELEVEL: '1' }, { MAKEFLAGS: 'w' }, { GNUMAKEFLAGS: '--print-directory' }, { MFLAGS: '-w' }, INHERITED]) {
    const f = fixture();
    const runner = fakeRunner({ 'make dev-ca': (call) => gnuMakeDevCa(call) });
    const { code, stderr } = await cli({ env: { ...f.env, ...inherited }, runner }, 'ca', '--repo', f.repo);
    assert.equal(code, EXIT.ok, `${JSON.stringify(inherited)}: ${stderr}`);
    const make = runner.calls.find((c) => c.command === 'make');
    for (const k of Object.keys(INHERITED)) assert.equal(make?.env?.[k], k === 'DEV_HTTPS' ? '1' : undefined, k);
    assert.equal(readFileSync(join(f.home, '.autologger-dev', 'autologger-dev-ca.crt'), 'utf8'), TEST_CA);
  }
});

test('ca --out to a path that does not exist yet writes it', async () => {
  const f = fixture();
  const out = join(f.home, 'new', 'ca.crt');
  const { code, stderr } = await cli({ env: f.env }, 'ca', '--repo', f.repo, '--out', out);
  assert.equal(code, EXIT.ok, stderr);
  assert.equal(readFileSync(out, 'utf8'), TEST_CA);
});

test('ca replaces an existing certificate file (re-running ca refreshes it) and makes it mode 644', async () => {
  const f = fixture();
  const out = join(f.home, '.autologger-dev', 'autologger-dev-ca.crt');
  mkdirSync(join(f.home, '.autologger-dev'));
  // An older certificate, padded with whitespace, mode 600.
  writeFileSync(out, `\n${TEST_CA}\n\n`, { mode: 0o600 });
  const { code, stderr } = await cli({ env: f.env }, 'ca', '--repo', f.repo);
  assert.equal(code, EXIT.ok, stderr);
  assert.equal(readFileSync(out, 'utf8'), TEST_CA);
  assert.equal(statSync(out).mode & 0o777, 0o644);
});

for (const [name, content] of [
  ['a shell profile', 'export PATH=/usr/bin\n'],
  ['an empty file', ''],
  ['a CA bundle with two certificates', TEST_CA + TEST_CA],
  ['a certificate with its private key', TEST_CA + '-----BEGIN PRIVATE KEY-----\nMIGH\n-----END PRIVATE KEY-----\n'],
] as const) {
  test(`ca --out refuses to overwrite ${name}, leaves it byte-for-byte unchanged and runs no make`, async () => {
    const f = fixture();
    const out = join(f.home, 'existing file');
    writeFileSync(out, content, { mode: 0o600 });
    const runner = fakeRunner();
    for (const json of [[], ['--json']]) {
      const { code, stdout, stderr } = await cli({ env: f.env, runner }, 'ca', '--repo', f.repo, '--out', out, ...json);
      assert.equal(code, EXIT.failure);
      assert.equal(stdout, '');
      assert.equal(stderr, `autologger-dev: refusing to write ${out}: it exists and is not a single PEM certificate; only a missing file or an existing single-certificate file is replaced. Nothing was written; pass another --out\n`);
      assert.equal(readFileSync(out, 'utf8'), content);
      assert.equal(statSync(out).mode & 0o777, 0o600);
    }
    assert.deepEqual(runner.calls.filter((c) => c.command === 'make'), []);
  });
}

test('ca --out refuses a symlink (even to a certificate) and a directory, and leaves them as they were', async () => {
  const f = fixture();
  const target = join(f.home, 'real.crt');
  writeFileSync(target, TEST_CA);
  const link = join(f.home, 'link.crt');
  symlinkSync(target, link);
  const dangling = join(f.home, 'dangling.crt');
  symlinkSync(join(f.home, 'nowhere.crt'), dangling);
  const dir = join(f.home, 'certs');
  mkdirSync(dir);
  for (const [out, why] of [
    [link, 'it is a symlink'],
    [dangling, 'it is a symlink'],
    [dir, 'it is a directory'],
  ] as const) {
    const runner = fakeRunner();
    const { code, stdout, stderr } = await cli({ env: f.env, runner }, 'ca', '--repo', f.repo, '--out', out);
    assert.equal(code, EXIT.failure, out);
    assert.equal(stdout, '');
    assert.match(stderr, new RegExp(`^autologger-dev: refusing to write ${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: ${why};`));
    assert.deepEqual(runner.calls.filter((c) => c.command === 'make'), []);
  }
  assert.equal(readlinkSync(link), target);
  assert.equal(readlinkSync(dangling), join(f.home, 'nowhere.crt'));
  assert.equal(existsSync(join(f.home, 'nowhere.crt')), false);
  assert.equal(readFileSync(target, 'utf8'), TEST_CA);
  assert.equal(lstatSync(dir).isDirectory(), true);
});

test('ca --out refuses a symlink planted while make dev-ca ran (nothing written through it)', async () => {
  const f = fixture();
  const out = join(f.home, 'ca.crt');
  const victim = join(f.home, 'victim');
  writeFileSync(victim, 'keep me\n');
  const runner = fakeRunner({
    'make dev-ca': () => {
      symlinkSync(victim, out);
      return { stdout: TEST_CA };
    },
  });
  const { code, stderr } = await cli({ env: f.env, runner }, 'ca', '--repo', f.repo, '--out', out);
  assert.equal(code, EXIT.failure);
  assert.match(stderr, /it is a symlink/);
  assert.equal(readFileSync(victim, 'utf8'), 'keep me\n');
});

/** Temp files ca may have left in a directory (they are named .<target>.<random>.tmp). */
const leftovers = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith('.tmp'));

test('ca --out replaces the target by renaming a new file over it: a hard link to another file is not written through', async () => {
  const f = fixture();
  const other = join(f.home, 'other.crt');
  writeFileSync(other, `\n${TEST_CA}\n`, { mode: 0o600 });
  const out = join(f.home, 'ca.crt');
  linkSync(other, out);
  const { code, stderr } = await cli({ env: f.env }, 'ca', '--repo', f.repo, '--out', out);
  assert.equal(code, EXIT.ok, stderr);
  assert.equal(readFileSync(out, 'utf8'), TEST_CA);
  assert.equal(statSync(out).mode & 0o777, 0o644);
  // Written in place, the other name would show the new bytes and mode.
  assert.equal(readFileSync(other, 'utf8'), `\n${TEST_CA}\n`);
  assert.equal(statSync(other).mode & 0o777, 0o600);
  assert.notEqual(statSync(out).ino, statSync(other).ino);
  assert.deepEqual(leftovers(f.home), []);
});

test('ca --out refuses a non-certificate file swapped in at the target while make dev-ca ran, leaves it and no temp file', async () => {
  const f = fixture();
  const out = join(f.home, 'ca.crt');
  const runner = fakeRunner({
    'make dev-ca': () => {
      writeFileSync(out, 'export PATH=/usr/bin\n', { mode: 0o600 });
      return { stdout: TEST_CA };
    },
  });
  const { code, stdout, stderr } = await cli({ env: f.env, runner }, 'ca', '--repo', f.repo, '--out', out);
  assert.equal(code, EXIT.failure);
  assert.equal(stdout, '');
  assert.match(stderr, /refusing to write .*: it exists and is not a single PEM certificate;.*Nothing was written/);
  assert.equal(readFileSync(out, 'utf8'), 'export PATH=/usr/bin\n');
  assert.deepEqual(leftovers(f.home), []);
});

test('writeCertificate writes a new file mode 644 and leaves no temp file', () => {
  const dir = join(fixture().home, 'new', 'dir');
  const out = join(dir, 'ca.crt');
  writeCertificate(out, TEST_CA);
  assert.equal(readFileSync(out, 'utf8'), TEST_CA);
  assert.equal(statSync(out).mode & 0o777, 0o644);
  assert.deepEqual(readdirSync(dir), ['ca.crt']);
});

for (const [name, ops] of [
  [
    'the write',
    {
      write: () => {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      },
    },
  ],
  [
    'the rename',
    {
      rename: () => {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' });
      },
    },
  ],
] as const) {
  test(`writeCertificate: a failing ${name} is exit-1 material, leaves the target as it was and no temp file`, () => {
    const home = fixture().home;
    const out = join(home, 'ca.crt');
    writeFileSync(out, `\n${TEST_CA}`, { mode: 0o600 });
    const real = { write: (fd: number, text: string) => void writeFileSync(fd, text), rename: (a: string, b: string) => void renameReal(a, b) };
    assert.throws(() => writeCertificate(out, TEST_CA, { ...real, ...ops }), (error: unknown) => error instanceof CliError && /^cannot write .*ca\.crt: .*; nothing was written$/.test(error.message));
    assert.equal(readFileSync(out, 'utf8'), `\n${TEST_CA}`);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(home).sort(), ['.autologger-local-openbao', 'ca.crt']);
  });
}

test('writeCertificate refuses a target that changed into a non-certificate before the rename, removing its temp file', () => {
  const home = fixture().home;
  const out = join(home, 'ca.crt');
  let checked = false;
  const ops = {
    write: (fd: number, text: string) => {
      writeFileSync(fd, text);
      // Swapped in after the temp file is written, before the rename.
      writeFileSync(out, 'keep me\n');
      checked = true;
    },
    rename: () => assert.fail('a refused target is never renamed over'),
  };
  assert.throws(() => writeCertificate(out, TEST_CA, ops), /refusing to write .*it exists and is not a single PEM certificate/);
  assert.equal(checked, true);
  assert.equal(readFileSync(out, 'utf8'), 'keep me\n');
  assert.deepEqual(leftovers(home), []);
});

test('ca --out into a directory it cannot write fails with exit 1 and no temp file', { skip: process.getuid?.() === 0 ? 'root can write anywhere' : false }, async () => {
  const f = fixture();
  const dir = join(f.home, 'locked');
  mkdirSync(dir);
  chmodSync(dir, 0o555);
  try {
    const { code, stdout, stderr } = await cli({ env: f.env }, 'ca', '--repo', f.repo, '--out', join(dir, 'ca.crt'));
    assert.equal(code, EXIT.failure);
    assert.equal(stdout, '');
    assert.match(stderr, /^autologger-dev: cannot write .*ca\.crt: .*nothing was written\n$/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    chmodSync(dir, 0o755);
  }
});

// Folders ca --out created: removed again when it fails, kept when it succeeds; folders that were
// there before are never removed.
const RENAME_FAILS = {
  write: (fd: number, text: string) => void writeFileSync(fd, text),
  rename: () => {
    throw Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' });
  },
};
const WRITE_FAILS = {
  write: () => {
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  },
  rename: (a: string, b: string) => void renameReal(a, b),
};

for (const [name, ops] of [
  ['the write', WRITE_FAILS],
  ['the rename', RENAME_FAILS],
] as const) {
  test(`writeCertificate: when ${name} fails, the parent folders it created are removed, and the folder that was there survives`, () => {
    const home = fixture().home;
    const before = readdirSync(home).sort();
    const out = join(home, 'new', 'deeper', 'ca.crt');
    assert.throws(() => writeCertificate(out, TEST_CA, ops), /nothing was written$/);
    assert.equal(existsSync(join(home, 'new')), false, 'created folders are gone');
    assert.deepEqual(readdirSync(home).sort(), before, 'home itself (pre-existing) is untouched');
  });
}

test('writeCertificate: a pre-existing parent survives a failure, only the folders below it that it created go', () => {
  const home = fixture().home;
  const existing = join(home, 'existing');
  mkdirSync(existing);
  assert.throws(() => writeCertificate(join(existing, 'a', 'b', 'ca.crt'), TEST_CA, RENAME_FAILS), /nothing was written$/);
  assert.equal(statSync(existing).isDirectory(), true);
  assert.deepEqual(readdirSync(existing), []);
  // A pre-existing direct parent (nothing created) also survives, even though it is empty.
  assert.throws(() => writeCertificate(join(existing, 'ca.crt'), TEST_CA, RENAME_FAILS), /nothing was written$/);
  assert.equal(statSync(existing).isDirectory(), true);
});

test('writeCertificate: a created folder that something else filled in the meantime is kept', () => {
  const home = fixture().home;
  const out = join(home, 'made', 'ca.crt');
  const ops = {
    write: (fd: number, text: string) => {
      writeFileSync(fd, text);
      writeFileSync(join(home, 'made', 'other.txt'), 'not ours\n');
    },
    rename: RENAME_FAILS.rename,
  };
  assert.throws(() => writeCertificate(out, TEST_CA, ops), /nothing was written$/);
  assert.deepEqual(readdirSync(join(home, 'made')), ['other.txt']);
});

test('writeCertificate: success keeps the folders it created', () => {
  const home = fixture().home;
  const out = join(home, 'kept', 'deeper', 'ca.crt');
  writeCertificate(out, TEST_CA);
  assert.equal(readFileSync(out, 'utf8'), TEST_CA);
  assert.deepEqual(readdirSync(join(home, 'kept', 'deeper')), ['ca.crt']);
});

test('removeCreatedDirs never goes above the first created folder, or anywhere when that is not an ancestor', () => {
  const home = fixture().home;
  mkdirSync(join(home, 'keep', 'x', 'y'), { recursive: true });
  removeCreatedDirs(join(home, 'keep', 'x', 'y'), join(home, 'keep', 'x'));
  assert.equal(existsSync(join(home, 'keep', 'x')), false);
  assert.equal(statSync(join(home, 'keep')).isDirectory(), true, 'the empty folder above the first created one stays');
  mkdirSync(join(home, 'other', 'z'), { recursive: true });
  removeCreatedDirs(join(home, 'other', 'z'), join(home, 'keep'));
  assert.equal(existsSync(join(home, 'other', 'z')), true, 'not under firstCreated: nothing removed');
});

test('ca --out into new folders: make failing, refused output or a failed mkdir leave no new folder', { skip: process.getuid?.() === 0 ? 'root can write anywhere' : false }, async () => {
  for (const runner of [fakeRunner({ 'make dev-ca': { code: 2, stdout: '', stderr: 'not running\n' } }), fakeRunner({ 'make dev-ca': { stdout: TEST_CA + TEST_CA } })]) {
    const f = fixture();
    const r = await cli({ env: f.env, runner }, 'ca', '--repo', f.repo, '--out', join(f.home, 'fresh', 'sub', 'ca.crt'));
    assert.equal(r.code, EXIT.failure);
    assert.equal(existsSync(join(f.home, 'fresh')), false);
  }
  // Creating the folder itself fails (read-only parent): the pre-existing parent survives, empty.
  const f = fixture();
  const locked = join(f.home, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o555);
  try {
    const r = await cli({ env: f.env }, 'ca', '--repo', f.repo, '--out', join(locked, 'new', 'ca.crt'));
    assert.equal(r.code, EXIT.failure);
    assert.match(r.stderr, /nothing was written\n$/);
    assert.deepEqual(readdirSync(locked), []);
  } finally {
    chmodSync(locked, 0o755);
  }
});
