import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { launcherScript } from '../src/launcher.ts';
import { parseList } from '../src/nss.ts';
import { run } from '../src/run.ts';
import { slotPaths } from '../src/slot.ts';
import { CA1, CA2, capture, fakeRunner, tempHome } from './helpers.ts';

/** Every file under `dir` with its sha256 (or 'absent'), to prove a folder is left exactly as it was. */
function snapshot(dir: string): string {
  if (!existsSync(dir)) return 'absent';
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(`${p} ${statSync(p).mtimeMs} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir);
  return out.sort().join('\n');
}

async function setupJson(env: Record<string, string>, runner = fakeRunner().runner, extra: string[] = []): Promise<{ code: number; json: Record<string, unknown>; err: string }> {
  const c = capture({ env, runner });
  const code = await run(['setup', '--json', ...extra], c.io);
  return { code, json: code === 0 ? (JSON.parse(c.out()) as Record<string, unknown>) : {}, err: c.err() };
}

test('setup creates the slot folder (mode 700), the NSS database trusting the CA as C,, and the launcher, and prints the flags', async () => {
  const t = tempHome();
  try {
    const fake = fakeRunner();
    const { code, json } = await setupJson(t.env, fake.runner);
    assert.equal(code, 0);
    const paths = slotPaths(t.env, 0);
    assert.equal(json.trust, 'added');
    assert.equal(json.session, 'autologger-dev-0');
    assert.deepEqual(json.flags, ['--session', 'autologger-dev-0', '--profile', paths.profile, '--executable-path', paths.launcher]);
    assert.equal(json.command, `agent-browser --session autologger-dev-0 --profile ${paths.profile} --executable-path ${paths.launcher}`);
    assert.equal(json.app_url, 'https://localhost:8787');
    assert.equal(json.runtime_url, 'https://dashboards.localhost');
    assert.equal(paths.dir, join(t.home, '.autologger-dev', 'browser', 'slot-0'));
    for (const dir of [paths.base, paths.dir, paths.profile, paths.home, paths.nssdb]) assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
    assert.equal(statSync(paths.launcher).mode & 0o777, 0o700);
    assert.equal(readlinkSync(paths.legacyNssdb), join('..', '.local', 'share', 'pki', 'nssdb'));
    // The CA went in with trust C,, (TLS server CA only), under the plugin's nickname, in the slot's database.
    const add = fake.calls.find((c) => c.command === 'certutil' && c.args.includes('-A'));
    assert.deepEqual(add?.args, ['-d', `sql:${paths.nssdb}`, '-A', '-n', 'autologger-dev-ca', '-t', 'C,,', '-i', join(t.home, '.autologger-dev', 'autologger-dev-ca.crt')]);
    // certutil only ever touched the slot's own database.
    for (const call of fake.calls.filter((c) => c.command === 'certutil' && c.args[0] !== '-H')) {
      assert.deepEqual(call.args.slice(0, 2), ['-d', `sql:${paths.nssdb}`]);
    }
  } finally {
    t.cleanup();
  }
});

test('setup never writes the user NSS databases (the real ~/.pki/nssdb and the HOME it runs with)', async () => {
  const real = userInfo().homedir;
  const realBefore = [snapshot(join(real, '.pki', 'nssdb')), snapshot(join(real, '.local', 'share', 'pki', 'nssdb'))];
  const t = tempHome();
  try {
    // A user database in the HOME setup runs with: it must be left byte for byte.
    for (const dir of [join(t.home, '.pki', 'nssdb'), join(t.home, '.local', 'share', 'pki', 'nssdb')]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'cert9.db'), 'user database');
    }
    const before = [snapshot(join(t.home, '.pki')), snapshot(join(t.home, '.local'))];
    assert.equal((await setupJson(t.env)).code, 0);
    assert.equal((await setupJson(t.env, fakeRunner().runner)).code, 0);
    assert.deepEqual([snapshot(join(t.home, '.pki')), snapshot(join(t.home, '.local'))], before);
    // Everything setup wrote is inside ~/.autologger-dev/browser.
    assert.deepEqual(readdirSync(join(t.home, '.autologger-dev')).sort(), ['autologger-dev-ca.crt', 'browser']);
  } finally {
    t.cleanup();
  }
  assert.deepEqual([snapshot(join(real, '.pki', 'nssdb')), snapshot(join(real, '.local', 'share', 'pki', 'nssdb'))], realBefore);
});

test('setup is a no-op when the CA is unchanged, and replaces it when the file changed', async () => {
  const t = tempHome();
  try {
    assert.equal((await setupJson(t.env)).json.trust, 'added');
    const paths = slotPaths(t.env, 0);
    const launcherMtime = statSync(paths.launcher).mtimeMs;
    const again = fakeRunner();
    const second = await setupJson(t.env, again.runner);
    assert.equal(second.json.trust, 'unchanged');
    assert.equal(second.json.launcher_written, false);
    assert.equal(second.json.restart_needed, false);
    assert.equal(statSync(paths.launcher).mtimeMs, launcherMtime);
    assert.ok(!again.calls.some((c) => c.args.includes('-A') || c.args.includes('-D') || c.args.includes('-N')), 'a no-op run wrote to the database');

    // make dev-reset makes a new CA: autologger-dev ca writes a different file.
    copyFileSync(CA2, join(t.home, '.autologger-dev', 'autologger-dev-ca.crt'));
    const changed = fakeRunner();
    const third = await setupJson(t.env, changed.runner);
    assert.equal(third.json.trust, 'replaced');
    assert.equal(third.json.restart_needed, true);
    const ops = changed.calls.filter((c) => c.command === 'certutil').map((c) => c.args[2]);
    assert.ok(ops.indexOf('-D') < ops.indexOf('-A'), 'the old CA is removed before the new one is added');
    assert.equal(readFileSync(join(paths.nssdb, 'fake-ca.pem'), 'utf8'), readFileSync(CA2, 'utf8'));
  } finally {
    t.cleanup();
  }
});

test('setup --ca uses another file and --slot N its own folder', async () => {
  const t = tempHome(false);
  try {
    const { code, json } = await setupJson(t.env, fakeRunner().runner, ['--slot', '3', '--ca', CA2]);
    assert.equal(code, 0);
    assert.equal(json.dir, join(t.home, '.autologger-dev', 'browser', 'slot-3'));
    assert.equal(json.session, 'autologger-dev-3');
    assert.equal(json.app_url, 'https://localhost:23787');
    assert.equal(json.runtime_url, 'https://dashboards-3.localhost');
    assert.equal((json.ca as { path: string }).path, CA2);
  } finally {
    t.cleanup();
  }
});

test('setup writes nothing when certutil, the CA file or Chromium is missing (exit 1)', async () => {
  const cases: Array<[string, () => ReturnType<typeof tempHome>, ReturnType<typeof fakeRunner>, RegExp]> = [
    ['certutil', () => tempHome(), fakeRunner({ certutil: false }), /certutil is not on PATH; install it: sudo apt-get install libnss3-tools \(or agent-browser install --with-deps\)/],
    ['ca', () => tempHome(false), fakeRunner(), /does not exist; write it first with autologger-dev ca/],
  ];
  for (const [name, make, fake, message] of cases) {
    const t = make();
    try {
      const { code, err } = await setupJson(t.env, fake.runner);
      assert.equal(code, 1, name);
      assert.match(err, message);
      assert.equal(existsSync(join(t.home, '.autologger-dev', 'browser')), false, name);
    } finally {
      t.cleanup();
    }
  }
  const t = tempHome();
  try {
    const { code, err } = await setupJson({ ...t.env, PATH: '/nonexistent' });
    assert.equal(code, 1);
    assert.match(err, /no Chromium found/);
    assert.equal(existsSync(join(t.home, '.autologger-dev', 'browser')), false);
  } finally {
    t.cleanup();
  }
});

test('setup refuses a CA file that is not exactly one certificate', async () => {
  const t = tempHome();
  try {
    const caFile = join(t.home, '.autologger-dev', 'autologger-dev-ca.crt');
    writeFileSync(caFile, `${readFileSync(CA1, 'utf8')}${readFileSync(CA2, 'utf8')}`);
    const { code, err } = await setupJson(t.env);
    assert.equal(code, 1);
    assert.match(err, /holds 2 PEM blocks/);
  } finally {
    t.cleanup();
  }
});

test('setup refuses a symlink where its folder should be', async () => {
  const t = tempHome();
  try {
    const { symlinkSync } = await import('node:fs');
    mkdirSync(join(t.home, 'elsewhere'));
    symlinkSync(join(t.home, 'elsewhere'), join(t.home, '.autologger-dev', 'browser'));
    const { code, err } = await setupJson(t.env);
    assert.equal(code, 1);
    assert.match(err, /it is a symlink/);
    assert.deepEqual(readdirSync(join(t.home, 'elsewhere')), []);
  } finally {
    t.cleanup();
  }
});

test('the launcher sets HOME and XDG_DATA_HOME for Chromium and passes the arguments unchanged, adding no flag', () => {
  const t = tempHome();
  try {
    const paths = slotPaths(t.env, 0);
    const fakeChromium = join(t.home, 'fake chromium');
    writeFileSync(fakeChromium, '#!/bin/sh\necho "HOME=$HOME"\necho "XDG_DATA_HOME=$XDG_DATA_HOME"\nfor a in "$@"; do echo "ARG=$a"; done\n', { mode: 0o755 });
    const script = launcherScript(paths, fakeChromium, t.env);
    assert.doesNotMatch(script, /ignore-certificate|ignore-https|spki/i);
    const file = join(t.home, 'launcher.sh');
    writeFileSync(file, script, { mode: 0o700 });
    const args = ['--user-data-dir=/x y', '--remote-debugging-port=0', "it's", '$HOME'];
    const result = spawnSync(file, args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/home/someone', XDG_DATA_HOME: '/home/someone/.local/share' } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [`HOME=${paths.home}`, `XDG_DATA_HOME=${join(paths.home, '.local', 'share')}`, ...args.map((a) => `ARG=${a}`)]);
  } finally {
    t.cleanup();
  }
});

test('parseList reads certutil -L output', () => {
  const out = 'Certificate Nickname                                         Trust Attributes\n                                                             SSL,S/MIME,JAR/XPI\n\nautologger-dev-ca                                            C,,  \nsome other ca                                                CT,C,C\n';
  assert.deepEqual([...parseList(out)], [['autologger-dev-ca', 'C,,'], ['some other ca', 'CT,C,C']]);
});

test('setup --json output and its files hold no private key material', async () => {
  const t = tempHome();
  try {
    const { json } = await setupJson(t.env);
    assert.doesNotMatch(JSON.stringify(json), /PRIVATE KEY/);
    assert.equal(lstatSync(slotPaths(t.env, 0).launcher).isFile(), true);
  } finally {
    t.cleanup();
  }
});
