// editor start|status|stop against fake git and pnpm on PATH (real processes, no network).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { alive, freePort, OPENREEL_COMMIT, OPENREEL_REPO, stateFile } from '../src/editor.ts';
import { FAKE_SHA, fakeTools } from './fakeTools.ts';
import { call, sandbox } from './helpers.ts';

const box = sandbox();
const bin = join(box.home, 'bin');
const { log } = fakeTools(bin);
const env = { ...box.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
const ctx = { env, cwd: box.cwd, readyTimeoutMs: 15_000 };
const calls = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);

test('start clones the pinned commit once, installs, runs pnpm dev on 127.0.0.1 and records the pid; status answers; stop stops it', async () => {
  // An explicit port: the end-to-end test runs `editor start` with the default one at the same time.
  const started = await call(ctx, 'editor', 'start', '--port', '5194', '--json');
  assert.equal(started.code, 0, started.stderr);
  const s = JSON.parse(started.stdout);
  const dir = join(box.home, '.autologger-clips', 'openreel', OPENREEL_COMMIT);
  assert.deepEqual([s.sha, s.dir, s.cloned, s.installed, s.already_running], [OPENREEL_COMMIT, dir, true, true, false]);
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(s.port, 5194);
  assert.ok(alive(s.pid));
  assert.match(started.stderr, /pnpm install in .* \(first start; this takes a few minutes\)[\s\S]*Packages: \+1234/);
  const ran = calls();
  assert.ok(ran.some((c) => c.startsWith(`git clone --filter=blob:none --no-checkout ${OPENREEL_REPO} `)), ran.join('\n'));
  assert.ok(ran.some((c) => c.endsWith(`checkout --detach ${OPENREEL_COMMIT}`)));
  assert.ok(ran.includes(`pnpm install --frozen-lockfile (in ${dir})`));
  assert.ok(ran.includes(`pnpm dev --host 127.0.0.1 --port ${s.port} --strictPort (in ${dir})`));
  assert.equal(JSON.parse(readFileSync(stateFile(env), 'utf8')).pid, s.pid);

  const status = JSON.parse((await call(ctx, 'editor', 'status', '--json')).stdout);
  assert.deepEqual([status.running, status.answers, status.url, status.pid], [true, true, s.url, s.pid]);
  const again = JSON.parse((await call(ctx, 'editor', 'start', '--json')).stdout);
  assert.deepEqual([again.already_running, again.pid], [true, s.pid]);

  const stopped = JSON.parse((await call(ctx, 'editor', 'stop', '--json')).stdout);
  assert.deepEqual(stopped, { stopped: true, pid: s.pid });
  assert.equal(alive(s.pid), false);
  const after = JSON.parse((await call(ctx, 'editor', 'status', '--json')).stdout);
  assert.deepEqual([after.running, after.answers, after.pid], [false, false, null]);

  // A second start reuses the checkout and the install.
  const before = calls().length;
  const second = JSON.parse((await call(ctx, 'editor', 'start', '--port', '5195', '--json')).stdout);
  assert.deepEqual([second.cloned, second.installed, second.port], [false, false, 5195]);
  assert.ok(!calls().slice(before).some((c) => c.startsWith('git clone') || c.startsWith('pnpm install')));
  assert.equal(JSON.parse((await call(ctx, 'editor', 'stop', '--json')).stdout).stopped, true);
});

test('--ref clones another commit or tag into its own sha folder', async () => {
  const r = await call(ctx, 'editor', 'start', '--ref', 'v1.0.0-alpha.17', '--port', '5196', '--json');
  assert.equal(r.code, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.deepEqual([s.sha, s.dir], [FAKE_SHA, join(box.home, '.autologger-clips', 'openreel', FAKE_SHA)]);
  assert.ok(calls().some((c) => c.endsWith('checkout --detach v1.0.0-alpha.17')));
  await call(ctx, 'editor', 'stop');
  for (const bad of ['--upload-pack=x', '../x', 'a b']) assert.equal((await call(ctx, 'editor', 'start', `--ref=${bad}`)).code, 2, bad);
});

test('stop leaves alone a process it did not start, and says when nothing runs', async () => {
  const nothing = JSON.parse((await call(ctx, 'editor', 'stop', '--json')).stdout);
  assert.deepEqual(nothing, { stopped: false, pid: null, reason: 'no editor was started by autologger-clips' });
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    mkdirSync(dirname(stateFile(env)), { recursive: true });
    writeFileSync(stateFile(env), JSON.stringify({ pid: other.pid, port: 5199, url: 'http://127.0.0.1:5199/', sha: FAKE_SHA, dir: '/x', log: '/x', started_at: '' }));
    const r = JSON.parse((await call(ctx, 'editor', 'stop', '--json')).stdout);
    assert.equal(r.stopped, false);
    assert.match(r.reason, /is no longer pnpm dev; it was left alone/);
    assert.ok(alive(other.pid as number), 'stop killed a process it did not start');
    assert.equal(existsSync(stateFile(env)), false);
  } finally {
    other.kill();
  }
});

test('missing git, node or pnpm is a clear error with the fix; a failing install or dev server is reported', async () => {
  const only = join(box.home, 'only-git');
  mkdirSync(only, { recursive: true });
  symlinkSync(join(bin, 'git'), join(only, 'git'));
  const noNode = await call({ ...ctx, env: { ...env, PATH: only } }, 'editor', 'start');
  assert.equal(noNode.code, 1);
  assert.match(noNode.stderr, /^autologger-clips: node is not on PATH; install Node\.js 18 or newer/);
  symlinkSync(process.execPath, join(only, 'node'));
  const noPnpm = await call({ ...ctx, env: { ...env, PATH: only } }, 'editor', 'start');
  assert.equal(noPnpm.code, 1);
  assert.match(noPnpm.stderr, /^autologger-clips: pnpm is not on PATH; install pnpm \(https:\/\/pnpm\.io\/installation/);
  const noGit = await call({ ...ctx, env: { ...env, PATH: '/nonexistent' } }, 'editor', 'start');
  assert.match(noGit.stderr, /^autologger-clips: git is not on PATH; install git/);

  const fresh = sandbox();
  const freshEnv = { ...fresh.env, PATH: env.PATH };
  const install = await call({ ...ctx, env: { ...freshEnv, FAKE_PNPM_INSTALL_FAIL: '1' } }, 'editor', 'start');
  assert.equal(install.code, 1);
  assert.match(install.stderr, /ERR_PNPM_FAKE[\s\S]*pnpm install failed in /);
  const dev = await call({ ...ctx, env: { ...freshEnv, FAKE_PNPM_DEV_FAIL: '1' } }, 'editor', 'start', '--port', '5197');
  assert.equal(dev.code, 1);
  assert.match(dev.stderr, /pnpm dev exited \(code 3\) before http:\/\/127\.0\.0\.1:5197\/ answered[\s\S]*vite: port in use/);
  assert.equal(existsSync(stateFile(freshEnv)), false);
});

test('editor usage errors exit 2', async () => {
  for (const argv of [['editor'], ['editor', 'restart'], ['editor', 'status', 'x'], ['editor', 'start', '--port', '80'], ['editor', 'stop', '--ref', 'x']]) {
    const r = await call(ctx, ...argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.equal(r.stdout, '');
  }
});

test('the default port is the first free one from the base', async () => {
  const taken = createServer();
  await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
  const port = (taken.address() as { port: number }).port;
  try {
    const next = await freePort(port);
    assert.ok(next > port && next < port + 20, String(next));
  } finally {
    taken.close();
  }
});
