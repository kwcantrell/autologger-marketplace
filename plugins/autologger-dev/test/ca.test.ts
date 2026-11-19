// ca: runs DEV_HTTPS=1 make dev-ca (injected runner), accepts exactly one PEM certificate, writes it
// mode 644 and prints the NODE_EXTRA_CA_CERTS export.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { singleCertificate } from '../src/ca.ts';
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
