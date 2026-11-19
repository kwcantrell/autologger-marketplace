// No secret value ever leaves the CLI: with known secret strings in overrides.env, secrets.json,
// secret_id and .env.openbao.dev, no command prints any of them, in text or --json, on success or
// failure. The CLI's own output never contains them (no [redacted] needed); when make or docker
// print one, it is scrubbed on the way out.
import assert from 'node:assert/strict';
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
