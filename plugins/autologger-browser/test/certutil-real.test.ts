// setup against the real certutil (libnss3-tools), in a temp HOME; skipped when certutil is missing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/run.ts';
import { spawnRunner } from '../src/runner.ts';
import { slotPaths } from '../src/slot.ts';
import { CA2, capture, tempHome } from './helpers.ts';

const haveCertutil = spawnSync('certutil', ['-H'], { stdio: 'ignore' }).error === undefined;

test('with the real certutil, setup trusts the CA as C,, in the slot database, then no-ops, then replaces it', { skip: haveCertutil ? false : 'certutil is not installed' }, async () => {
  const t = tempHome();
  try {
    const env = { ...t.env, PATH: `${t.env.PATH}:${process.env.PATH ?? ''}` };
    const go = async (): Promise<Record<string, unknown>> => {
      const c = capture({ env, runner: spawnRunner });
      assert.equal(await run(['setup', '--json'], c.io), 0, c.err());
      return JSON.parse(c.out()) as Record<string, unknown>;
    };
    assert.equal((await go()).trust, 'added');
    const db = `sql:${slotPaths(env, 0).nssdb}`;
    const list = spawnSync('certutil', ['-d', db, '-L'], { encoding: 'utf8' });
    assert.match(list.stdout, /^autologger-dev-ca\s+C,,\s*$/m);
    assert.equal((await go()).trust, 'unchanged');
    copyFileSync(CA2, join(t.home, '.autologger-dev', 'autologger-dev-ca.crt'));
    assert.equal((await go()).trust, 'replaced');
    const pem = spawnSync('certutil', ['-d', db, '-L', '-n', 'autologger-dev-ca', '-a'], { encoding: 'utf8' }).stdout;
    assert.equal((pem.match(/BEGIN CERTIFICATE/g) ?? []).length, 1);
    const doctor = capture({ env, runner: spawnRunner, probe: async () => ({ ok: true, status: 200 }) });
    assert.equal(await run(['doctor', '--json'], doctor.io), 0);
    const profile = (JSON.parse(doctor.out()) as { checks: Array<{ name: string; status: string }> }).checks.find((c) => c.name === 'profile');
    assert.equal(profile?.status, 'ok');
  } finally {
    t.cleanup();
  }
});
