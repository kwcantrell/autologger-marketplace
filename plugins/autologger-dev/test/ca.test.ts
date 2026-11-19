// ca: runs DEV_HTTPS=1 make dev-ca (injected runner), accepts exactly one PEM certificate, writes it
// mode 644 and prints the NODE_EXTRA_CA_CERTS export.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { singleCertificate } from '../src/ca.ts';
import { EXIT } from '../src/run.ts';
import { cli, fakeRunner, fixture, NOT_FOUND, TEST_CA } from './helpers.ts';

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
  const [call] = runner.calls;
  assert.deepEqual([call?.command, call?.args, call?.cwd, call?.env?.DEV_HTTPS], ['make', ['dev-ca'], f.repo, '1']);
  assert.equal(runner.calls.length, 1);
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
