// No secret value ever leaves the CLI: with known secret strings in overrides.env, secrets.json,
// secret_id and .env.openbao.dev, no command prints any of them, in text or --json, on success or
// failure. The CLI's own output never contains them (no [redacted] needed); when make or docker
// print one, it is scrubbed on the way out.
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../src/run.ts';
import { answering, cli, fakeRunner, fixture, GOOD_OVERRIDES, GOOGLE_ID, GOOGLE_SECRET, type Outcome, SECRET, untrusted } from './helpers.ts';

const SECRETS = [SECRET, GOOGLE_SECRET, GOOGLE_ID];

function assertClean(label: string, outcome: Outcome): void {
  for (const secret of SECRETS) {
    for (const part of [secret, secret.slice(0, 20), secret.slice(-20)]) {
      assert.ok(!outcome.stdout.includes(part), `${label}: stdout has a secret`);
      assert.ok(!outcome.stderr.includes(part), `${label}: stderr has a secret`);
    }
  }
}

test("no command's own output carries a value from the state directory or .env.openbao.dev", async () => {
  const f = fixture({ overrides: GOOD_OVERRIDES });
  const placeholders = fixture({ overrides: `GOOGLE_CLIENT_ID=REPLACE_ME.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=REPLACE_ME\nDEEPGRAM_API_KEY=${SECRET}\n` });
  const runs: [string, Outcome][] = [];
  for (const fx of [f, placeholders]) {
    for (const json of [[], ['--json']]) {
      for (const fetchFn of [answering(401), untrusted]) {
        const opts = { env: { ...fx.env, NODE_EXTRA_CA_CERTS: '/nope' }, runner: fakeRunner(), fetch: fetchFn };
        for (const argv of [
          ['doctor', '--repo', fx.repo],
          ['up', '--dry-run', '--repo', fx.repo],
          ['up', '--repo', fx.repo],
          ['ca', '--repo', fx.repo],
          ['status'],
          ['connect'],
        ]) {
          runs.push([`${argv.join(' ')} ${json.join(' ')}`, await cli(opts, ...argv, ...json)]);
        }
      }
    }
  }
  for (const [label, outcome] of runs) {
    assert.equal(outcome.code, EXIT.ok, `${label}: ${outcome.stderr}`);
    assertClean(label, outcome);
    assert.doesNotMatch(outcome.stdout + outcome.stderr, /\[redacted\]/, `${label}: the CLI itself never printed a value`);
  }
});

test('a secret printed by make (up and ca, success and failure) is scrubbed before it leaves', async () => {
  const f = fixture({ credentials: true, overrides: `GOOGLE_CLIENT_SECRET=${GOOGLE_SECRET}\nCUSTOM_DASHBOARDS_ENABLED=0\n` });
  // The leak is split across output chunks: the line buffer must still catch it.
  const leaky = fakeRunner({
    'make dev-bao-set': (_call, options) => {
      options.onOutput?.(`recorded GOOGLE_CLIENT_SECRET=${GOOGLE_SECRET.slice(0, 10)}`);
      options.onOutput?.(`${GOOGLE_SECRET.slice(10)}\nJWT_SECRET=${SECRET}\n`);
      return { code: 0 };
    },
    'make dev-up': { code: 1, stderr: `compose: bad value ${SECRET} for BAO_SECRET_ID` },
    'make dev-ca': { code: 2, stderr: `secret_id ${SECRET}\n` },
  });
  for (const json of [[], ['--json']]) {
    const up = await cli({ env: f.env, runner: leaky }, 'up', '--repo', f.repo, ...json);
    assert.equal(up.code, EXIT.failure);
    assertClean('up', up);
    assert.match(up.stderr, /recorded GOOGLE_CLIENT_SECRET=\[redacted\]\nJWT_SECRET=\[redacted\]\n/);
    assert.match(up.stderr, /compose: bad value \[redacted\] for BAO_SECRET_ID\n/);
    const ca = await cli({ env: f.env, runner: leaky }, 'ca', '--repo', f.repo, ...json);
    assert.equal(ca.code, EXIT.failure);
    assertClean('ca', ca);
    assert.match(ca.stderr, /secret_id \[redacted\]/);
  }
});

test('a secret that make dev-bao generates during up is scrubbed from the output after it', async () => {
  const f = fixture({ credentials: false, secrets: false, overrides: GOOD_OVERRIDES });
  const fresh = 'freshly-generated-secret-0123456789abcdef';
  const runner = fakeRunner({
    'docker container': { code: 1, stderr: 'No such container' },
    'make dev-bao': () => {
      writeFileSync(join(f.stateDir, 'secrets.json'), JSON.stringify({ JWT_SECRET: fresh }));
      return { code: 0, stdout: 'generated secrets.json\n' };
    },
    'make dev-up': { code: 1, stderr: `boot refused JWT_SECRET=${fresh}\n` },
  });
  const outcome = await cli({ env: f.env, runner }, 'up', '--repo', f.repo);
  assert.equal(outcome.code, EXIT.failure);
  assert.ok(!outcome.stderr.includes(fresh), outcome.stderr);
  assert.match(outcome.stderr, /boot refused JWT_SECRET=\[redacted\]/);
});

for (const [file, write] of [
  ['secrets.json', (f: { stateDir: string }, v: string) => writeFileSync(join(f.stateDir, 'secrets.json'), JSON.stringify({ JWT_SECRET: v }))],
  ['secret_id', (f: { stateDir: string }, v: string) => writeFileSync(join(f.stateDir, 'secret_id'), `${v}\n`)],
  ['.env.openbao.dev', (f: { repo: string }, v: string) => writeFileSync(join(f.repo, '.env.openbao.dev'), `BAO_SECRET_ID=${v}\n`)],
  ['overrides.env', (f: { stateDir: string }, v: string) => writeFileSync(join(f.stateDir, 'overrides.env'), `DEEPGRAM_API_KEY=${v}\n`)],
] as const) {
  test(`a secret make dev-bao writes to ${file} and prints in the same step is scrubbed`, async () => {
    const f = fixture({ credentials: false, secrets: false });
    const fresh = `generated-in-step-${file}-0123456789abcdef`;
    for (const json of [[], ['--json']]) {
      const runner = fakeRunner({
        'docker container': { code: 1, stderr: 'No such container' },
        'make dev-bao': (_call, options) => {
          write(f, fresh);
          // Printed whole, then split across chunks, then at the end with no newline.
          options.onOutput?.(`wrote ${fresh}\n`);
          options.onOutput?.(`again ${fresh.slice(0, 12)}`);
          options.onOutput?.(`${fresh.slice(12)}\nlast ${fresh}`);
          return { code: 0 };
        },
        'make dev-up': { code: 1, stderr: `boot refused ${fresh}\n` },
      });
      const outcome = await cli({ env: f.env, runner }, 'up', '--repo', f.repo, ...json);
      assert.equal(outcome.code, EXIT.failure);
      assert.ok(!(outcome.stdout + outcome.stderr).includes(fresh), outcome.stderr);
      for (const part of [fresh.slice(0, 20), fresh.slice(-20)]) assert.ok(!(outcome.stdout + outcome.stderr).includes(part));
      assert.match(outcome.stderr, /wrote \[redacted\]\nagain \[redacted\]\nlast \[redacted\]/);
      assert.match(outcome.stderr, /boot refused \[redacted\]\n/);
    }
  });
}

test('a secret passed as an argument value never comes back in an error', async () => {
  const f = fixture({ overrides: GOOD_OVERRIDES });
  for (const argv of [
    ['doctor', '--repo', f.repo, '--server', SECRET],
    ['up', '--repo', `/nowhere/${SECRET}`],
  ]) {
    const outcome = await cli({ env: f.env, runner: fakeRunner() }, ...argv);
    assert.notEqual(outcome.code, EXIT.ok);
    assertClean(argv.join(' '), outcome);
  }
});

test('a quoted secret value (with or without its quotes) appears in no output of doctor or up', async () => {
  for (const q of ['"', "'"]) {
    const f = fixture({ overrides: `GOOGLE_CLIENT_ID=${q}${GOOGLE_ID}${q}\nGOOGLE_CLIENT_SECRET=${q}${GOOGLE_SECRET}${q}\nCUSTOM_DASHBOARDS_ENABLED=${q}1${q}\nDEEPGRAM_API_KEY=${q}${SECRET}${q}\n` });
    for (const json of [[], ['--json']]) {
      for (const argv of [
        ['doctor', '--repo', f.repo],
        ['up', '--dry-run', '--repo', f.repo],
        ['up', '--repo', f.repo],
      ]) {
        const label = `${argv.join(' ')} ${json.join(' ')} (${q})`;
        const outcome = await cli({ env: { ...f.env, NODE_EXTRA_CA_CERTS: '/nope' }, runner: fakeRunner(), fetch: answering(401) }, ...argv, ...json);
        assert.equal(outcome.code, EXIT.ok, `${label}: ${outcome.stderr}`);
        assertClean(label, outcome);
        for (const secret of SECRETS) {
          assert.ok(!(outcome.stdout + outcome.stderr).includes(`${q}${secret}${q}`), `${label}: quoted value printed`);
        }
        assert.match(outcome.stdout, /quote/, `${label}: the quotes are named`);
      }
    }
  }
});

for (const [file, write] of [
  ['secret_id', (f: { stateDir: string }, v: string) => writeFileSync(join(f.stateDir, 'secret_id'), `${v}\n`)],
  ['secrets.json', (f: { stateDir: string }, v: string) => writeFileSync(join(f.stateDir, 'secrets.json'), JSON.stringify({ JWT_SECRET: v }))],
  ['.env.openbao.dev', (f: { repo: string }, v: string) => writeFileSync(join(f.repo, '.env.openbao.dev'), `BAO_SECRET_ID=${v}\n`)],
] as const) {
  test(`a secret a step replaces in ${file} stays hidden when a later step prints the old value`, async () => {
    for (const json of [[], ['--json']]) {
      const f = fixture({ credentials: false, secrets: false });
      const old = `old-${file}-value-0123456789abcdef`;
      const replacement = `new-${file}-value-fedcba9876543210`;
      write(f, old);
      const runner = fakeRunner({
        'docker container': { code: 1, stderr: 'No such container' },
        'make dev-bao': () => {
          write(f, replacement);
          return { code: 0, stdout: 'rotated\n' };
        },
        'make dev-bao-set': { code: 0, stdout: `still had ${old}\nand ${replacement}\n` },
        'make dev-up': { code: 1, stderr: `boot refused ${old}` },
      });
      const outcome = await cli({ env: f.env, runner }, 'up', '--repo', f.repo, ...json);
      assert.equal(outcome.code, EXIT.failure);
      for (const v of [old, replacement]) assert.ok(!(outcome.stdout + outcome.stderr).includes(v), outcome.stderr);
      assert.match(outcome.stderr, /still had \[redacted\]\nand \[redacted\]\n/);
      assert.match(outcome.stderr, /boot refused \[redacted\]\n/);
    }
  });
}

test('a secret removed from the state files by a step stays hidden for the rest of the run', async () => {
  const f = fixture({ credentials: false, secrets: false });
  const old = 'removed-secret-value-0123456789abcdef';
  writeFileSync(join(f.stateDir, 'secrets.json'), JSON.stringify({ JWT_SECRET: old }));
  const runner = fakeRunner({
    'docker container': { code: 1, stderr: 'No such container' },
    'make dev-bao': () => {
      rmSync(join(f.stateDir, 'secrets.json'));
      return { code: 0 };
    },
    'make dev-up': { code: 0, stdout: `gone but printed ${old}\n` },
  });
  const outcome = await cli({ env: f.env, runner }, 'up', '--repo', f.repo);
  assert.equal(outcome.code, EXIT.ok, outcome.stderr);
  assert.ok(!(outcome.stdout + outcome.stderr).includes(old));
  assert.match(outcome.stderr, /gone but printed \[redacted\]\n/);
});
