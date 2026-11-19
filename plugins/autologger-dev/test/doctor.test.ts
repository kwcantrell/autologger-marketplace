// doctor: every check's ok and not-ok case, with a fake runner, fake fetch and a temp home.
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Check } from '../src/doctor.ts';
import { dashboardsState, googleClient, isDashboardsOn, isPadded, isQuoted, isQuotedAndPadded, parseEnvText } from '../src/stack.ts';
import { EXIT } from '../src/run.ts';
import { answering, cli, type CliOptions, fakeRunner, fixture, GOOD_OVERRIDES, GOOGLE_ID, GOOGLE_SECRET, NOT_FOUND, untrusted } from './helpers.ts';

const NAMES = [
  'checkout',
  'docker',
  'make',
  'node',
  'openbao',
  'openbao_credentials',
  'google_client',
  'custom_dashboards',
  'node_extra_ca_certs',
  'dev_server',
];

/** A fully set-up machine: every check ok. */
function healthy(): CliOptions & { repo: string; stateDir: string } {
  const f = fixture({ overrides: GOOD_OVERRIDES });
  const ca = join(f.home, 'ca.crt');
  writeFileSync(ca, 'cert');
  return { env: { ...f.env, NODE_EXTRA_CA_CERTS: ca }, runner: fakeRunner(), fetch: answering(401), repo: f.repo, stateDir: f.stateDir };
}

async function doctorChecks(opts: CliOptions, ...extra: string[]): Promise<{ checks: Map<string, Check>; ok: boolean; repo: string }> {
  const { code, stdout, stderr } = await cli(opts, 'doctor', '--json', ...extra);
  assert.equal(code, EXIT.ok, stderr);
  const report = JSON.parse(stdout) as { checks: Check[]; ok: boolean; repo: string };
  assert.deepEqual(
    report.checks.map((c) => c.name),
    NAMES,
  );
  for (const c of report.checks) {
    assert.ok(['ok', 'missing', 'fail'].includes(c.status), c.name);
    assert.equal(c.fix === null, c.status === 'ok', `${c.name}: a fix exactly when not ok`);
    if (c.fix !== null) assert.doesNotMatch(c.fix, /\n/);
    assert.doesNotMatch(c.detail, /\n/);
  }
  return { checks: new Map(report.checks.map((c) => [c.name, c])), ok: report.ok, repo: report.repo };
}

test('doctor: everything in place is all ok, exit 0', async () => {
  const h = healthy();
  const { checks, ok, repo } = await doctorChecks(h, '--repo', h.repo);
  assert.equal(repo, h.repo);
  assert.equal(ok, true);
  for (const c of checks.values()) assert.equal(c.status, 'ok', `${c.name}: ${c.detail}`);
});

test('doctor: human output lists each check with its status and fix', async () => {
  const h = healthy();
  const { code, stdout } = await cli({ ...h, fetch: untrusted }, 'doctor', '--repo', h.repo);
  assert.equal(code, EXIT.ok);
  assert.match(stdout, /^\[ok\] checkout: /m);
  assert.match(stdout, /^\[fail\] dev_server: the TLS certificate of https:\/\/localhost:8787 is not trusted/m);
  assert.match(stdout, /^ {4}fix: run autologger-dev ca/m);
  assert.match(stdout, /1 of 10 checks need attention/);
});

test('doctor checkout: --repo, then AUTOLOGGER_REPO, then the current directory', async () => {
  const h = healthy();
  const other = fixture({ checkout: false });
  assert.equal((await doctorChecks({ ...h, env: { ...h.env, AUTOLOGGER_REPO: h.repo }, cwd: other.repo })).checks.get('checkout')?.status, 'ok');
  assert.equal((await doctorChecks({ ...h, cwd: h.repo })).checks.get('checkout')?.status, 'ok');
  const { checks } = await doctorChecks({ ...h, env: { ...h.env, AUTOLOGGER_REPO: h.repo } }, '--repo', other.repo);
  const c = checks.get('checkout');
  assert.equal(c?.status, 'missing');
  assert.match(c?.detail ?? '', /from --repo\) is not an autologger-2 checkout: no Makefile, docker\/scripts\/compose-run\.mjs, docker\/scripts\/local-bao\.mjs/);
  assert.match(c?.fix ?? '', /--repo/);
  assert.equal(checks.get('openbao_credentials')?.status, 'missing');
});

test('doctor docker: not on PATH is missing, daemon down is fail', async () => {
  const h = healthy();
  let c = (await doctorChecks({ ...h, runner: fakeRunner({ 'docker info': NOT_FOUND }) }, '--repo', h.repo)).checks.get('docker');
  assert.equal(c?.status, 'missing');
  assert.match(c?.detail ?? '', /not on PATH/);
  c = (await doctorChecks({ ...h, runner: fakeRunner({ 'docker info': { code: 1, stderr: 'Cannot connect to the Docker daemon' } }) }, '--repo', h.repo)).checks.get('docker');
  assert.equal(c?.status, 'fail');
  assert.match(c?.fix ?? '', /start the Docker daemon/);
});

test('doctor make: missing when not on PATH', async () => {
  const h = healthy();
  const c = (await doctorChecks({ ...h, runner: fakeRunner({ 'make --version': NOT_FOUND }) }, '--repo', h.repo)).checks.get('make');
  assert.equal(c?.status, 'missing');
  assert.match(c?.fix ?? '', /install make/);
});

test('doctor make: fail with its fix when make --version exits non-zero', async () => {
  const h = healthy();
  const c = (await doctorChecks({ ...h, runner: fakeRunner({ 'make --version': { code: 2, stdout: '', stderr: 'make: broken\n' } }) }, '--repo', h.repo)).checks.get('make');
  assert.equal(c?.status, 'fail');
  assert.equal(c?.detail, 'make --version exited 2');
  assert.equal(c?.fix, 'reinstall make');
});

test('doctor node: 22.12 is enough, 22.11 is fail, absent is missing', async () => {
  const h = healthy();
  const node = async (r: Parameters<typeof fakeRunner>[0]) => (await doctorChecks({ ...h, runner: fakeRunner(r) }, '--repo', h.repo)).checks.get('node');
  assert.equal((await node({ 'node --version': { stdout: 'v22.12.0\n' } }))?.status, 'ok');
  assert.equal((await node({ 'node --version': { stdout: 'v24.1.0\n' } }))?.status, 'ok');
  const old = await node({ 'node --version': { stdout: 'v22.11.9\n' } });
  assert.equal(old?.status, 'fail');
  assert.match(old?.detail ?? '', /older than 22\.12/);
  assert.equal((await node({ 'node --version': NOT_FOUND }))?.status, 'missing');
});

test('doctor openbao: running ok; stopped or absent missing with make dev-bao; docker gone fail', async () => {
  const h = healthy();
  const bao = async (r: Parameters<typeof fakeRunner>[0], env = h.env) =>
    (await doctorChecks({ ...h, env, runner: fakeRunner(r) }, '--repo', h.repo)).checks.get('openbao');
  const runner = fakeRunner();
  await doctorChecks({ ...h, runner }, '--repo', h.repo);
  assert.deepEqual(
    runner.calls.find((c) => c.args[0] === 'container')?.args,
    ['container', 'inspect', '--format', '{{.State.Running}}', 'autologger-local-openbao'],
  );
  const stopped = await bao({ 'docker container': { stdout: 'false\n' } });
  assert.equal(stopped?.status, 'missing');
  assert.match(stopped?.detail ?? '', /not running/);
  assert.match(stopped?.fix ?? '', /make dev-bao/);
  const absent = await bao({ 'docker container': { code: 1, stderr: 'Error: No such container: autologger-local-openbao' } });
  assert.equal(absent?.status, 'missing');
  assert.equal((await bao({ 'docker container': NOT_FOUND }))?.status, 'fail');
  // LOCAL_BAO_NAME, as make dev-bao reads it.
  const named = fakeRunner();
  await doctorChecks({ ...h, env: { ...h.env, LOCAL_BAO_NAME: 'bao-test' }, runner: named }, '--repo', h.repo);
  assert.equal(named.calls.find((c) => c.args[0] === 'container')?.args.at(-1), 'bao-test');
});

test('doctor openbao_credentials: missing without .env.openbao.dev', async () => {
  const f = fixture({ credentials: false, overrides: GOOD_OVERRIDES });
  const c = (await doctorChecks({ env: f.env, fetch: answering() }, '--repo', f.repo)).checks.get('openbao_credentials');
  assert.equal(c?.status, 'missing');
  assert.match(c?.fix ?? '', /make dev-bao/);
});

test('doctor google_client and custom_dashboards: placeholders, absent file, unreadable file', async () => {
  const placeholders = fixture({ overrides: 'GOOGLE_CLIENT_ID=REPLACE_ME.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=REPLACE_ME\nCUSTOM_DASHBOARDS_ENABLED=0\n' });
  let { checks } = await doctorChecks({ env: placeholders.env }, '--repo', placeholders.repo);
  assert.equal(checks.get('google_client')?.status, 'missing');
  assert.match(checks.get('google_client')?.detail ?? '', /GOOGLE_CLIENT_ID is placeholder, GOOGLE_CLIENT_SECRET is placeholder/);
  assert.match(checks.get('google_client')?.fix ?? '', /https:\/\/localhost:8787\/auth\/google\/callback/);
  assert.equal(checks.get('custom_dashboards')?.status, 'missing');
  assert.match(checks.get('custom_dashboards')?.fix ?? '', /CUSTOM_DASHBOARDS_ENABLED=1/);

  const partial = fixture({ overrides: `GOOGLE_CLIENT_ID=real-id-1234.apps.googleusercontent.com\n` });
  ({ checks } = await doctorChecks({ env: partial.env }, '--repo', partial.repo));
  assert.match(checks.get('google_client')?.detail ?? '', /GOOGLE_CLIENT_ID is set, GOOGLE_CLIENT_SECRET is not set/);
  assert.equal(checks.get('google_client')?.status, 'missing');

  const absent = fixture();
  ({ checks } = await doctorChecks({ env: absent.env }, '--repo', absent.repo));
  assert.match(checks.get('google_client')?.detail ?? '', /overrides\.env does not exist/);
  assert.equal(checks.get('custom_dashboards')?.status, 'missing');

  if (process.getuid?.() !== 0) {
    const locked = fixture({ overrides: GOOD_OVERRIDES });
    chmodSync(join(locked.stateDir, 'overrides.env'), 0o000);
    ({ checks } = await doctorChecks({ env: locked.env }, '--repo', locked.repo));
    assert.equal(checks.get('google_client')?.status, 'fail');
    assert.equal(checks.get('custom_dashboards')?.status, 'fail');
  }

  // LOCAL_BAO_DIR, as make dev-bao reads it.
  const elsewhere = fixture({ overrides: GOOD_OVERRIDES });
  const empty = fixture();
  ({ checks } = await doctorChecks({ env: { ...empty.env, LOCAL_BAO_DIR: elsewhere.stateDir } }, '--repo', empty.repo));
  assert.equal(checks.get('google_client')?.status, 'ok');
  assert.equal(checks.get('custom_dashboards')?.status, 'ok');
});

test('doctor node_extra_ca_certs: unset is missing, unreadable is fail', async () => {
  const h = healthy();
  const env = { ...h.env } as Record<string, string>;
  delete env.NODE_EXTRA_CA_CERTS;
  let c = (await doctorChecks({ ...h, env }, '--repo', h.repo)).checks.get('node_extra_ca_certs');
  assert.equal(c?.status, 'missing');
  assert.match(c?.fix ?? '', /autologger-dev ca .*export NODE_EXTRA_CA_CERTS=.*\.autologger-dev\/autologger-dev-ca\.crt/);
  c = (await doctorChecks({ ...h, env: { ...env, NODE_EXTRA_CA_CERTS: '/no/such/ca.crt' } }, '--repo', h.repo)).checks.get('node_extra_ca_certs');
  assert.equal(c?.status, 'fail');
});

test('doctor dev_server: refused is missing (up), untrusted TLS is fail (ca), --server is used', async () => {
  const h = healthy();
  let c = (await doctorChecks({ ...h, fetch: undefined }, '--repo', h.repo)).checks.get('dev_server');
  assert.equal(c?.status, 'missing');
  assert.match(c?.detail ?? '', /cannot reach https:\/\/localhost:8787/);
  assert.match(c?.fix ?? '', /autologger-dev up/);
  c = (await doctorChecks({ ...h, fetch: untrusted }, '--repo', h.repo)).checks.get('dev_server');
  assert.equal(c?.status, 'fail');
  const seen: string[] = [];
  const fetchFn: typeof fetch = async (url) => {
    seen.push(String(url));
    return new Response('', { status: 200 });
  };
  c = (await doctorChecks({ ...h, fetch: fetchFn }, '--repo', h.repo, '--server', 'http://127.0.0.1:9999')).checks.get('dev_server');
  assert.equal(c?.status, 'ok');
  assert.deepEqual(seen, ['http://127.0.0.1:9999/']);
});

test('doctor runs only read-only commands', async () => {
  const h = healthy();
  const runner = fakeRunner();
  await doctorChecks({ ...h, runner }, '--repo', h.repo);
  assert.deepEqual(
    runner.calls.map((c) => `${c.command} ${c.args.join(' ')}`),
    ['docker info --format {{.ServerVersion}}', 'make --version', 'node --version', 'docker container inspect --format {{.State.Running}} autologger-local-openbao'],
  );
});

test('doctor rejects a non-loopback http server as a usage error', async () => {
  const { code, stdout, stderr } = await cli({}, 'doctor', '--server', 'http://example.com');
  assert.equal(code, EXIT.usage);
  assert.equal(stdout, '');
  assert.match(stderr, /must be an https:\/\/ URL/);
});

for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const) {
  const other = key === 'GOOGLE_CLIENT_ID' ? `GOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}` : `GOOGLE_CLIENT_ID=${GOOGLE_ID}`;
  for (const empty of ['', '""', "''", '  ""  ', '" "']) {
    test(`doctor and up --dry-run report ${key}=${empty} as not set`, async () => {
      const f = fixture({ overrides: `${other}\n${key}=${empty}\nCUSTOM_DASHBOARDS_ENABLED=1\n` });
      const { checks } = await doctorChecks({ env: f.env }, '--repo', f.repo);
      const c = checks.get('google_client');
      assert.equal(c?.status, 'missing');
      assert.match(c?.detail ?? '', new RegExp(`${key} is not set`));
      assert.doesNotMatch(c?.detail ?? '', new RegExp(`${key} is set`));
      const text = await cli({ env: f.env }, 'doctor', '--repo', f.repo);
      assert.match(text.stdout, /\[missing\] google_client: /);
      const up = await cli({ env: f.env, runner: fakeRunner() }, 'up', '--repo', f.repo, '--dry-run', '--json');
      assert.equal(up.code, EXIT.ok, up.stderr);
      const report = JSON.parse(up.stdout) as { google_client: string; warnings: string[] };
      assert.equal(report.google_client, 'placeholder');
      assert.match(report.warnings[0] ?? '', /is a placeholder or not set/);
    });
  }
}

test('isQuoted, googleClient and dashboardsState: matching quotes around a real value are quoted', () => {
  for (const q of ['"', "'"]) {
    assert.equal(isQuoted(`${q}abc.apps.googleusercontent.com${q}`), true);
    assert.equal(isQuoted(` ${q}x${q} `), true);
    assert.equal(isQuoted(`${q}${q}`), false, 'an empty pair is not set, not quoted');
    assert.equal(isQuoted(`${q} ${q}`), false);
  }
  for (const v of [`"abc'`, `'abc"`, '"abc', "abc'", 'abc', 'a"b"c', '"', '', undefined]) assert.equal(isQuoted(v), false, String(v));

  const google = (text: string) => googleClient(parseEnvText(text)).keys;
  for (const q of ['"', "'"]) {
    assert.deepEqual(google(`GOOGLE_CLIENT_ID=${q}${GOOGLE_ID}${q}\nGOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}\n`), { GOOGLE_CLIENT_ID: 'quoted', GOOGLE_CLIENT_SECRET: 'set' });
    assert.deepEqual(google(`GOOGLE_CLIENT_ID=${GOOGLE_ID}\nGOOGLE_CLIENT_SECRET=${q}${GOOGLE_SECRET}${q}\n`), { GOOGLE_CLIENT_ID: 'set', GOOGLE_CLIENT_SECRET: 'quoted' });
    assert.equal(googleClient(parseEnvText(`GOOGLE_CLIENT_ID=${q}${GOOGLE_ID}${q}\nGOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}\n`)).ok, false);
    assert.deepEqual(google(`GOOGLE_CLIENT_ID=${q}${q}\nGOOGLE_CLIENT_SECRET=${q}REPLACE_ME${q}\n`), { GOOGLE_CLIENT_ID: 'not set', GOOGLE_CLIENT_SECRET: 'placeholder' });
  }
  // Mismatched quotes are not a pair: an ordinary set value.
  assert.deepEqual(google(`GOOGLE_CLIENT_ID="${GOOGLE_ID}'\nGOOGLE_CLIENT_SECRET='${GOOGLE_SECRET}"\n`), { GOOGLE_CLIENT_ID: 'set', GOOGLE_CLIENT_SECRET: 'set' });
  assert.equal(googleClient(parseEnvText(`GOOGLE_CLIENT_ID=${GOOGLE_ID}\nGOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}\n`)).ok, true);

  const dashboards = (line: string) => dashboardsState(parseEnvText(`${line}\n`));
  assert.equal(dashboards('CUSTOM_DASHBOARDS_ENABLED=1'), 'enabled');
  assert.equal(dashboards('CUSTOM_DASHBOARDS_ENABLED="1"'), 'quoted');
  assert.equal(dashboards("CUSTOM_DASHBOARDS_ENABLED='1'"), 'quoted');
  for (const line of ['CUSTOM_DASHBOARDS_ENABLED=0', 'CUSTOM_DASHBOARDS_ENABLED="0"', `CUSTOM_DASHBOARDS_ENABLED="1'`, 'CUSTOM_DASHBOARDS_ENABLED=""', '# none']) {
    assert.equal(dashboards(line), 'not enabled', line);
  }
});

const QUOTES_FIX = /remove the quotes around the value of .*autologger stores the value verbatim.*then run make dev-bao and autologger-dev up again/;

for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const) {
  for (const q of ['"', "'"]) {
    test(`doctor reports ${key}=${q}...${q} as quoted (fail) with the remove-the-quotes fix`, async () => {
      const value = key === 'GOOGLE_CLIENT_ID' ? GOOGLE_ID : GOOGLE_SECRET;
      const other = key === 'GOOGLE_CLIENT_ID' ? `GOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}` : `GOOGLE_CLIENT_ID=${GOOGLE_ID}`;
      const f = fixture({ overrides: `${other}\n${key}=${q}${value}${q}\nCUSTOM_DASHBOARDS_ENABLED=1\n` });
      const { checks, ok } = await doctorChecks({ env: f.env }, '--repo', f.repo);
      assert.equal(ok, false);
      const c = checks.get('google_client');
      assert.equal(c?.status, 'fail');
      assert.equal(c?.keys?.[key], 'quoted');
      assert.equal(c?.keys?.[key === 'GOOGLE_CLIENT_ID' ? 'GOOGLE_CLIENT_SECRET' : 'GOOGLE_CLIENT_ID'], 'set');
      assert.match(c?.detail ?? '', new RegExp(`${key} is quoted`));
      assert.match(c?.fix ?? '', new RegExp(`remove the quotes around the value of ${key} in `));
      assert.match(c?.fix ?? '', QUOTES_FIX);
      assert.doesNotMatch(c?.fix ?? '', /adds their own Google OAuth client/, 'the other key is set: only the quotes need fixing');
      assert.equal(checks.get('custom_dashboards')?.status, 'ok');
      const text = await cli({ env: f.env }, 'doctor', '--repo', f.repo);
      assert.match(text.stdout, /\[fail\] google_client: .*is quoted/);
      assert.match(text.stdout, /fix: remove the quotes/);
    });
  }
}

test('doctor: both Google keys quoted, or one quoted and one not set, gets every fix that applies', async () => {
  const both = fixture({ overrides: `GOOGLE_CLIENT_ID="${GOOGLE_ID}"\nGOOGLE_CLIENT_SECRET='${GOOGLE_SECRET}'\n` });
  let c = (await doctorChecks({ env: both.env }, '--repo', both.repo)).checks.get('google_client');
  assert.equal(c?.status, 'fail');
  assert.deepEqual(c?.keys, { GOOGLE_CLIENT_ID: 'quoted', GOOGLE_CLIENT_SECRET: 'quoted' });
  assert.match(c?.fix ?? '', /remove the quotes around the value of GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in /);
  const half = fixture({ overrides: `GOOGLE_CLIENT_ID="${GOOGLE_ID}"\nGOOGLE_CLIENT_SECRET=""\n` });
  c = (await doctorChecks({ env: half.env }, '--repo', half.repo)).checks.get('google_client');
  assert.equal(c?.status, 'fail');
  assert.deepEqual(c?.keys, { GOOGLE_CLIENT_ID: 'quoted', GOOGLE_CLIENT_SECRET: 'not set' });
  assert.match(c?.fix ?? '', QUOTES_FIX);
  assert.match(c?.fix ?? '', /adds their own Google OAuth client/);
});

test('doctor: mismatched quotes are an ordinary set value; unquoted real values are ok', async () => {
  const mismatched = fixture({ overrides: `GOOGLE_CLIENT_ID="${GOOGLE_ID}'\nGOOGLE_CLIENT_SECRET='${GOOGLE_SECRET}"\nCUSTOM_DASHBOARDS_ENABLED=1\n` });
  let c = (await doctorChecks({ env: mismatched.env }, '--repo', mismatched.repo)).checks.get('google_client');
  assert.equal(c?.status, 'ok');
  assert.deepEqual(c?.keys, { GOOGLE_CLIENT_ID: 'set', GOOGLE_CLIENT_SECRET: 'set' });
  const h = healthy();
  const { checks } = await doctorChecks(h, '--repo', h.repo);
  c = checks.get('google_client');
  assert.equal(c?.status, 'ok');
  assert.deepEqual(c?.keys, { GOOGLE_CLIENT_ID: 'set', GOOGLE_CLIENT_SECRET: 'set' });
  assert.deepEqual(checks.get('custom_dashboards')?.keys, { CUSTOM_DASHBOARDS_ENABLED: 'enabled' });
});

for (const q of ['"', "'"]) {
  test(`doctor reports CUSTOM_DASHBOARDS_ENABLED=${q}1${q} as quoted, not enabled, with the remove-the-quotes fix`, async () => {
    const f = fixture({ overrides: `GOOGLE_CLIENT_ID=${GOOGLE_ID}\nGOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}\nCUSTOM_DASHBOARDS_ENABLED=${q}1${q}\n` });
    const { checks } = await doctorChecks({ env: f.env }, '--repo', f.repo);
    const c = checks.get('custom_dashboards');
    assert.equal(c?.status, 'fail');
    assert.deepEqual(c?.keys, { CUSTOM_DASHBOARDS_ENABLED: 'quoted' });
    assert.match(c?.detail ?? '', /CUSTOM_DASHBOARDS_ENABLED is quoted .*autologger does not read it as on/);
    assert.match(c?.fix ?? '', /remove the quotes around the value of CUSTOM_DASHBOARDS_ENABLED in /);
    assert.match(c?.fix ?? '', QUOTES_FIX);
    assert.doesNotMatch(c?.fix ?? '', /runs make dev-bao-set/, 'not the generic set-it-to-1 fix');
    assert.equal(checks.get('google_client')?.status, 'ok');
  });
}

test('isPadded, googleClient and dashboardsState: spaces before or after a real value are padded', () => {
  for (const v of [' abc', 'abc ', '\tabc', ' abc ', ' 1', '1 ']) assert.equal(isPadded(v), true, JSON.stringify(v));
  for (const v of ['abc', 'a b', '', '   ', ' "abc" ', '"abc"', undefined]) assert.equal(isPadded(v), false, JSON.stringify(v));

  const google = (text: string) => googleClient(parseEnvText(text)).keys;
  assert.deepEqual(google(`GOOGLE_CLIENT_ID= ${GOOGLE_ID}\nGOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}\n`), { GOOGLE_CLIENT_ID: 'padded', GOOGLE_CLIENT_SECRET: 'set' });
  assert.deepEqual(google(`GOOGLE_CLIENT_ID=${GOOGLE_ID}\nGOOGLE_CLIENT_SECRET=${GOOGLE_SECRET} \n`), { GOOGLE_CLIENT_ID: 'set', GOOGLE_CLIENT_SECRET: 'padded' });
  assert.equal(googleClient(parseEnvText(`GOOGLE_CLIENT_ID=${GOOGLE_ID} \nGOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}\n`)).ok, false);
  // Quotes win over spaces; a padded placeholder is still a placeholder; only spaces is not set.
  assert.deepEqual(google(`GOOGLE_CLIENT_ID= "${GOOGLE_ID}"\nGOOGLE_CLIENT_SECRET= REPLACE_ME\n`), { GOOGLE_CLIENT_ID: 'quoted', GOOGLE_CLIENT_SECRET: 'placeholder' });
  assert.deepEqual(google('GOOGLE_CLIENT_ID=   \nGOOGLE_CLIENT_SECRET=\n'), { GOOGLE_CLIENT_ID: 'not set', GOOGLE_CLIENT_SECRET: 'not set' });

  const dashboards = (line: string) => dashboardsState(parseEnvText(`${line}\n`));
  // The server trims CUSTOM_DASHBOARDS_ENABLED, so spaces around an on value leave it on.
  for (const line of ['CUSTOM_DASHBOARDS_ENABLED= 1', 'CUSTOM_DASHBOARDS_ENABLED=1 ', 'CUSTOM_DASHBOARDS_ENABLED=\t1\t']) assert.equal(dashboards(line), 'enabled', JSON.stringify(line));
  assert.equal(dashboards('CUSTOM_DASHBOARDS_ENABLED= "1" '), 'quoted');
  for (const line of ['CUSTOM_DASHBOARDS_ENABLED= 0', 'CUSTOM_DASHBOARDS_ENABLED=  ', 'CUSTOM_DASHBOARDS_ENABLED=1 1']) assert.equal(dashboards(line), 'not enabled', JSON.stringify(line));
});

const SPACES_FIX = /remove the spaces around the value of .*autologger stores the value verbatim, surrounding spaces included.*then run make dev-bao and autologger-dev up again/;

for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const) {
  for (const [where, pad] of [
    ['leading', (v: string) => ` ${v}`],
    ['trailing', (v: string) => `${v}  `],
  ] as const) {
    test(`doctor reports ${key} with ${where} spaces as padded (fail) with the remove-the-spaces fix, never the value`, async () => {
      const value = key === 'GOOGLE_CLIENT_ID' ? GOOGLE_ID : GOOGLE_SECRET;
      const other = key === 'GOOGLE_CLIENT_ID' ? `GOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}` : `GOOGLE_CLIENT_ID=${GOOGLE_ID}`;
      const f = fixture({ overrides: `${other}\n${key}=${pad(value)}\nCUSTOM_DASHBOARDS_ENABLED=1\n` });
      const { checks, ok } = await doctorChecks({ env: f.env }, '--repo', f.repo);
      assert.equal(ok, false);
      const c = checks.get('google_client');
      assert.equal(c?.status, 'fail');
      assert.equal(c?.keys?.[key], 'padded');
      assert.match(c?.detail ?? '', new RegExp(`${key} is padded`));
      assert.match(c?.detail ?? '', /surrounding spaces included, so Google sign-in will not work/);
      assert.match(c?.fix ?? '', new RegExp(`remove the spaces around the value of ${key} in `));
      assert.match(c?.fix ?? '', SPACES_FIX);
      assert.doesNotMatch(c?.fix ?? '', /adds their own Google OAuth client|remove the quotes/);
      assert.equal(checks.get('custom_dashboards')?.status, 'ok');
      const text = await cli({ env: f.env }, 'doctor', '--repo', f.repo);
      assert.match(text.stdout, /\[fail\] google_client: .*is padded/);
      assert.match(text.stdout, /fix: remove the spaces/);
      for (const v of [GOOGLE_ID, GOOGLE_SECRET]) assert.ok(!text.stdout.includes(v), 'no value printed');
    });
  }
}

test('doctor: one Google key quoted and the other padded gets both fixes', async () => {
  const f = fixture({ overrides: `GOOGLE_CLIENT_ID="${GOOGLE_ID}"\nGOOGLE_CLIENT_SECRET=${GOOGLE_SECRET} \n` });
  const c = (await doctorChecks({ env: f.env }, '--repo', f.repo)).checks.get('google_client');
  assert.equal(c?.status, 'fail');
  assert.deepEqual(c?.keys, { GOOGLE_CLIENT_ID: 'quoted', GOOGLE_CLIENT_SECRET: 'padded' });
  assert.match(c?.fix ?? '', QUOTES_FIX);
  assert.match(c?.fix ?? '', SPACES_FIX);
});

const UP_REWRITES = /or just run autologger-dev up, which rewrites it as CUSTOM_DASHBOARDS_ENABLED=1 \(make dev-bao-set\), so editing it by hand is optional/;

// CUSTOM_DASHBOARDS_ENABLED is on exactly when autologger's server reads it as on
// (customDashboardsEnabled, server/src/env.ts): trimmed and lower-cased, it is 1, true or yes.
const DASHBOARDS_ON_SPELLINGS = ['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'Yes', ' 1', '1 ', ' 1 ', '\t1', 'yes ', ' true', ' YES\t'];
const DASHBOARDS_OFF_SPELLINGS = ['0', 'false', 'no', 'on', 'enabled', '2', '1 1', 'yes please', '', '   '];

test('isDashboardsOn and dashboardsState mirror the server: 1, true or yes, any case, spaces around allowed', () => {
  const dashboards = (line: string) => dashboardsState(parseEnvText(`${line}\n`));
  for (const v of DASHBOARDS_ON_SPELLINGS) {
    assert.equal(isDashboardsOn(v), true, JSON.stringify(v));
    assert.equal(dashboards(`CUSTOM_DASHBOARDS_ENABLED=${v}`), 'enabled', JSON.stringify(v));
  }
  for (const v of DASHBOARDS_OFF_SPELLINGS) {
    assert.equal(isDashboardsOn(v), false, JSON.stringify(v));
    assert.equal(dashboards(`CUSTOM_DASHBOARDS_ENABLED=${v}`), 'not enabled', JSON.stringify(v));
  }
  assert.equal(isDashboardsOn(undefined), false);
  assert.equal(dashboards('# no line'), 'not enabled');
  // The server does not remove quotes: a quoted on value is off, and reported as quoted.
  for (const v of ['"1"', "'1'", '"true"', "'true'", '"YES"', ' "yes" ', '" 1 "']) {
    assert.equal(isDashboardsOn(v), false, v);
    assert.equal(dashboards(`CUSTOM_DASHBOARDS_ENABLED=${v}`), 'quoted', v);
  }
  // A quoted off value is just not enabled (up sets it to 1 either way).
  for (const v of ['"0"', "'false'", '""', `"1'`]) assert.equal(dashboards(`CUSTOM_DASHBOARDS_ENABLED=${v}`), 'not enabled', v);
});

for (const value of DASHBOARDS_ON_SPELLINGS) {
  test(`doctor reports CUSTOM_DASHBOARDS_ENABLED=${JSON.stringify(value)} as enabled (ok), as the server reads it`, async () => {
    const f = fixture({ overrides: `GOOGLE_CLIENT_ID=${GOOGLE_ID}\nGOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}\nCUSTOM_DASHBOARDS_ENABLED=${value}\n` });
    const c = (await doctorChecks({ env: f.env }, '--repo', f.repo)).checks.get('custom_dashboards');
    assert.equal(c?.status, 'ok');
    assert.equal(c?.fix, null);
    assert.deepEqual(c?.keys, { CUSTOM_DASHBOARDS_ENABLED: 'enabled' });
    assert.match(c?.detail ?? '', /^CUSTOM_DASHBOARDS_ENABLED is on \(in /);
  });
}

for (const [label, line] of [
  ['0', 'CUSTOM_DASHBOARDS_ENABLED=0\n'],
  ['false', 'CUSTOM_DASHBOARDS_ENABLED=false\n'],
  ['empty', 'CUSTOM_DASHBOARDS_ENABLED=\n'],
  ['unset', ''],
] as const) {
  test(`doctor reports CUSTOM_DASHBOARDS_ENABLED ${label} as not enabled (missing) with the up fix`, async () => {
    const f = fixture({ overrides: `GOOGLE_CLIENT_ID=${GOOGLE_ID}\nGOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}\n${line}` });
    const c = (await doctorChecks({ env: f.env }, '--repo', f.repo)).checks.get('custom_dashboards');
    assert.equal(c?.status, 'missing');
    assert.deepEqual(c?.keys, { CUSTOM_DASHBOARDS_ENABLED: 'not enabled' });
    assert.match(c?.detail ?? '', /^CUSTOM_DASHBOARDS_ENABLED is not 1, true or yes \(/);
    assert.equal(c?.fix, 'autologger-dev up (runs make dev-bao-set CUSTOM_DASHBOARDS_ENABLED=1)');
  });
}

for (const value of ["'true'", '"YES"']) {
  test(`doctor reports CUSTOM_DASHBOARDS_ENABLED=${value} as quoted (fail) with the remove-the-quotes fix`, async () => {
    const f = fixture({ overrides: `GOOGLE_CLIENT_ID=${GOOGLE_ID}\nGOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}\nCUSTOM_DASHBOARDS_ENABLED=${value}\n` });
    const c = (await doctorChecks({ env: f.env }, '--repo', f.repo)).checks.get('custom_dashboards');
    assert.equal(c?.status, 'fail');
    assert.deepEqual(c?.keys, { CUSTOM_DASHBOARDS_ENABLED: 'quoted' });
    assert.match(c?.fix ?? '', /^remove the quotes around the value of CUSTOM_DASHBOARDS_ENABLED in /);
    assert.match(c?.fix ?? '', UP_REWRITES);
  });
}

test("doctor's fix for a quoted CUSTOM_DASHBOARDS_ENABLED says up rewrites it, so removing the quotes is optional", async () => {
  const f = fixture({ overrides: `GOOGLE_CLIENT_ID=${GOOGLE_ID}\nGOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}\nCUSTOM_DASHBOARDS_ENABLED="1"\n` });
  const c = (await doctorChecks({ env: f.env }, '--repo', f.repo)).checks.get('custom_dashboards');
  assert.match(c?.fix ?? '', QUOTES_FIX);
  assert.match(c?.fix ?? '', UP_REWRITES);
});

test('isQuotedAndPadded: a quoted value with spaces outside or just inside its quotes', () => {
  for (const v of [' "abc"', '"abc" ', ' "abc" ', '\t\'abc\'', '" abc"', '"abc "', "' abc '"]) assert.equal(isQuotedAndPadded(v), true, JSON.stringify(v));
  for (const v of ['"abc"', "'abc'", ' abc ', 'abc', '"a b"', '" "', '""', ` "abc'`, undefined]) assert.equal(isQuotedAndPadded(v), false, JSON.stringify(v));
  const google = googleClient(parseEnvText(`GOOGLE_CLIENT_ID= "${GOOGLE_ID}" \nGOOGLE_CLIENT_SECRET="${GOOGLE_SECRET}"\n`));
  assert.deepEqual(google.keys, { GOOGLE_CLIENT_ID: 'quoted', GOOGLE_CLIENT_SECRET: 'quoted' });
  assert.deepEqual(google.quotedAndPadded, ['GOOGLE_CLIENT_ID']);
});

const QUOTES_AND_SPACES_FIX =
  /remove both the quotes and the spaces around the value of .*autologger stores the value verbatim, quotes and surrounding spaces included.*then run make dev-bao and autologger-dev up again/;

for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const) {
  for (const wrap of [(v: string) => ` "${v}" `, (v: string) => `'${v}'  `, (v: string) => `" ${v}"`]) {
    const shape = wrap('v');
    test(`doctor reports ${key}=${shape.replace('v', '...')} as quoted (fail) with one fix for the quotes and the spaces, never the value`, async () => {
      const value = key === 'GOOGLE_CLIENT_ID' ? GOOGLE_ID : GOOGLE_SECRET;
      const other = key === 'GOOGLE_CLIENT_ID' ? `GOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}` : `GOOGLE_CLIENT_ID=${GOOGLE_ID}`;
      const f = fixture({ overrides: `${other}\n${key}=${wrap(value)}\nCUSTOM_DASHBOARDS_ENABLED=1\n` });
      const c = (await doctorChecks({ env: f.env }, '--repo', f.repo)).checks.get('google_client');
      assert.equal(c?.status, 'fail');
      assert.equal(c?.keys?.[key], 'quoted');
      assert.match(c?.detail ?? '', /quotes and surrounding spaces included, so Google sign-in will not work/);
      assert.match(c?.fix ?? '', new RegExp(`^remove both the quotes and the spaces around the value of ${key} in `));
      assert.match(c?.fix ?? '', QUOTES_AND_SPACES_FIX);
      assert.doesNotMatch(c?.fix ?? '', /remove the quotes around|remove the spaces around|adds their own Google OAuth client/, 'one fix, not two');
      const text = await cli({ env: f.env }, 'doctor', '--repo', f.repo);
      const json = await cli({ env: f.env }, 'doctor', '--repo', f.repo, '--json');
      for (const out of [text, json]) for (const v of [GOOGLE_ID, GOOGLE_SECRET]) assert.ok(!(out.stdout + out.stderr).includes(v), 'no value printed');
    });
  }
}

test('doctor: one Google key quoted and padded, the other only quoted, gets each its own fix', async () => {
  const f = fixture({ overrides: `GOOGLE_CLIENT_ID= "${GOOGLE_ID}"\nGOOGLE_CLIENT_SECRET='${GOOGLE_SECRET}'\nCUSTOM_DASHBOARDS_ENABLED=1\n` });
  const c = (await doctorChecks({ env: f.env }, '--repo', f.repo)).checks.get('google_client');
  assert.deepEqual(c?.keys, { GOOGLE_CLIENT_ID: 'quoted', GOOGLE_CLIENT_SECRET: 'quoted' });
  assert.match(c?.fix ?? '', /remove the quotes around the value of GOOGLE_CLIENT_SECRET in /);
  assert.match(c?.fix ?? '', /remove both the quotes and the spaces around the value of GOOGLE_CLIENT_ID in /);
});

for (const value of [' "1" ', '"true" ', "' yes'"]) {
  test(`doctor reports CUSTOM_DASHBOARDS_ENABLED=${value} as quoted with one fix for the quotes and the spaces`, async () => {
    const f = fixture({ overrides: `GOOGLE_CLIENT_ID=${GOOGLE_ID}\nGOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}\nCUSTOM_DASHBOARDS_ENABLED=${value}\n` });
    const c = (await doctorChecks({ env: f.env }, '--repo', f.repo)).checks.get('custom_dashboards');
    assert.equal(c?.status, 'fail');
    assert.deepEqual(c?.keys, { CUSTOM_DASHBOARDS_ENABLED: 'quoted' });
    assert.match(c?.fix ?? '', /^remove both the quotes and the spaces around the value of CUSTOM_DASHBOARDS_ENABLED in /);
    assert.match(c?.fix ?? '', UP_REWRITES);
  });
}
