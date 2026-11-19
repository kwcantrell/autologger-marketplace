// Dev slots (--slot N, autologger ADR 0038): the slot -> server mapping, --slot validation, the
// DEV_SLOT make gets (and only that one), and the server, names and fixes each command uses.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT } from '../src/run.ts';
import { devPort, googleRedirect, mcpServerName, parseSlot, slotEnv, slotServer } from '../src/slot.ts';
import { answering, cli, fakeRunner, fixture, GOOD_OVERRIDES, INHERITED, untrusted } from './helpers.ts';

/** fetch that answers 401 and records every URL it was asked for. */
function recording(): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const fn = async (input: string | URL | Request): Promise<Response> => {
    urls.push(String(input instanceof Request ? input.url : input));
    return new Response('', { status: 401 });
  };
  return Object.assign(fn as typeof fetch, { urls });
}

const makeEnv = (runner: ReturnType<typeof fakeRunner>, target: string): Readonly<Record<string, string | undefined>> | undefined =>
  runner.calls.find((c) => c.command === 'make' && c.args[0] === target)?.env;

test('slotServer follows autologger: https://localhost:8787 for slot 0, https://localhost:2N787 for slot N', () => {
  assert.equal(slotServer(0), 'https://localhost:8787');
  assert.equal(slotServer(1), 'https://localhost:21787');
  assert.equal(slotServer(9), 'https://localhost:29787');
  assert.equal(mcpServerName(0), 'autologger-dev');
  assert.equal(mcpServerName(1), 'autologger-dev-1');
  assert.equal(mcpServerName(9), 'autologger-dev-9');
  assert.equal(googleRedirect(0), 'https://localhost:8787/auth/google/callback');
  assert.equal(googleRedirect(9), 'https://localhost:29787/auth/google/callback');
  assert.deepEqual(slotEnv(0), {});
  assert.deepEqual(slotEnv(1), { DEV_SLOT: '1' });
  assert.deepEqual(slotEnv(9), { DEV_SLOT: '9' });
});

test('parseSlot takes exactly one digit 0-9', () => {
  assert.equal(parseSlot(undefined), 0);
  for (const d of '0123456789') assert.equal(parseSlot(d), Number(d));
  for (const bad of ['10', '-1', 'a', '', '1.0', ' 1', '1 ', '01', '+1', '١']) assert.throws(() => parseSlot(bad), /--slot must be one digit 0-9/, bad);
});

for (const command of ['doctor', 'up', 'ca', 'status', 'connect']) {
  for (const bad of ['10', '-1', 'a', '', '1.0']) {
    test(`${command} --slot ${JSON.stringify(bad)} is a usage error (exit 2), nothing run or fetched`, async () => {
      const f = fixture({ overrides: GOOD_OVERRIDES });
      const runner = fakeRunner();
      const fetchFn = recording();
      const repo = command === 'up' || command === 'ca' ? ['--repo', f.repo] : [];
      const { code, stdout, stderr } = await cli({ env: f.env, runner, fetch: fetchFn }, command, ...repo, `--slot=${bad}`, '--json');
      assert.equal(code, EXIT.usage, stderr);
      assert.equal(stdout, '');
      assert.match(stderr, /^autologger-dev: --slot must be one digit 0-9/);
      assert.deepEqual(runner.calls, []);
      assert.deepEqual(fetchFn.urls, []);
    });
  }
}

test('--slot with its value as the next argument works, and a missing value is a usage error', async () => {
  const f = fixture();
  const ok = await cli({ env: f.env }, 'connect', '--slot', '2', '--json');
  assert.equal(ok.code, EXIT.ok, ok.stderr);
  assert.equal((JSON.parse(ok.stdout) as { mcp_url: string }).mcp_url, 'https://localhost:22787/mcp');
  const missing = await cli({ env: f.env }, 'connect', '--slot');
  assert.equal(missing.code, EXIT.usage);
  assert.equal(missing.stdout, '');
});

test('up --slot 2 passes DEV_SLOT=2 to make dev-up only, never the inherited DEV_SLOT', async () => {
  const f = fixture({ credentials: false, overrides: 'GOOGLE_CLIENT_ID=REPLACE_ME\n' });
  const runner = fakeRunner({ 'docker container': { code: 1, stderr: 'Error: No such container: autologger-local-openbao' } });
  const { code, stdout, stderr } = await cli({ env: { ...f.env, ...INHERITED }, runner }, 'up', '--repo', f.repo, '--slot', '2', '--json');
  assert.equal(code, EXIT.ok, stderr);
  const makes = runner.calls.filter((c) => c.command === 'make');
  assert.deepEqual(makes.map((c) => c.args[0]), ['dev-bao', 'dev-bao-set', 'dev-up']);
  assert.equal(makeEnv(runner, 'dev-up')?.DEV_SLOT, '2');
  assert.equal(makeEnv(runner, 'dev-up')?.DEV_HTTPS, '1');
  // The local OpenBao is shared by every slot: its steps get no DEV_SLOT at all.
  for (const target of ['dev-bao', 'dev-bao-set']) assert.equal(Object.hasOwn(makeEnv(runner, target) ?? {}, 'DEV_SLOT'), false, target);
  // ...and the inherited DEV_SLOT=3 reaches no make call.
  for (const c of makes) assert.notEqual(c.env?.DEV_SLOT, '3', `${c.command} ${c.args.join(' ')}`);
  assert.match(stderr, /==> DEV_HTTPS=1 DEV_SLOT=2 make dev-up {2}\(migrate, build and start dev slot 2 in HTTPS mode\)/);
  const report = JSON.parse(stdout) as { slot: number; steps: { command: string }[]; warnings: string[] };
  assert.equal(report.slot, 2);
  assert.deepEqual(report.steps.map((s) => s.command), ['make dev-bao', 'make dev-bao-set CUSTOM_DASHBOARDS_ENABLED=1', 'DEV_HTTPS=1 DEV_SLOT=2 make dev-up']);
  // Each slot's Google sign-in needs its own redirect URI on the client.
  assert.match(report.warnings.join('\n'), /authorized redirect https:\/\/localhost:22787\/auth\/google\/callback/);
});

test('up --slot 0 and up with no --slot pass no DEV_SLOT to make, even when the caller has one', async () => {
  for (const slotArgs of [['--slot', '0'], []]) {
    const f = fixture({ overrides: GOOD_OVERRIDES });
    const runner = fakeRunner();
    const { code, stdout, stderr } = await cli({ env: { ...f.env, ...INHERITED }, runner }, 'up', '--repo', f.repo, ...slotArgs);
    assert.equal(code, EXIT.ok, stderr);
    for (const c of runner.calls.filter((c) => c.command === 'make')) assert.equal(Object.hasOwn(c.env ?? {}, 'DEV_SLOT'), false, c.args.join(' '));
    assert.match(stdout, /^Ran in [^\n(]+:\n/);
    assert.match(stdout, /\[ok\] DEV_HTTPS=1 make dev-up/);
    assert.match(stdout, /Next: autologger-dev ca, then autologger-dev connect\.\n$/);
  }
});

test('up --dry-run --slot 5 shows the slot and its command lines, and runs no make', async () => {
  const f = fixture({ overrides: GOOD_OVERRIDES });
  const runner = fakeRunner();
  const { code, stdout } = await cli({ env: f.env, runner }, 'up', '--dry-run', '--slot', '5', '--repo', f.repo);
  assert.equal(code, EXIT.ok);
  assert.match(stdout, /^Would run in .* \(dev slot 5\):\n/);
  assert.match(stdout, /\[run \] DEV_HTTPS=1 DEV_SLOT=5 make dev-up/);
  assert.deepEqual(runner.calls.filter((c) => c.command === 'make'), []);
});

test('up --slot 3 (not dry run) names the slot in its next steps', async () => {
  const f = fixture({ overrides: GOOD_OVERRIDES });
  const { code, stdout } = await cli({ env: f.env, runner: fakeRunner() }, 'up', '--slot', '3', '--repo', f.repo);
  assert.equal(code, EXIT.ok);
  assert.match(stdout, /Next: autologger-dev ca --slot 3, then autologger-dev connect --slot 3\.\n$/);
});

test('ca --slot 4 runs DEV_HTTPS=1 DEV_SLOT=4 make dev-ca, never the inherited DEV_SLOT, and writes the shared default CA file', async () => {
  const f = fixture();
  const runner = fakeRunner();
  const { code, stdout, stderr } = await cli({ env: { ...f.env, ...INHERITED }, runner }, 'ca', '--repo', f.repo, '--slot', '4', '--json');
  assert.equal(code, EXIT.ok, stderr);
  const env = makeEnv(runner, 'dev-ca');
  assert.equal(env?.DEV_SLOT, '4');
  assert.equal(env?.DEV_HTTPS, '1');
  const report = JSON.parse(stdout) as { slot: number; path: string };
  assert.equal(report.slot, 4);
  // One dev CA for every slot (ADR 0038), so one default file.
  assert.equal(report.path, `${f.home}/.autologger-dev/autologger-dev-ca.crt`);
});

test('ca --slot 0 and ca with no --slot pass no DEV_SLOT, even when the caller has one', async () => {
  for (const slotArgs of [['--slot', '0'], []]) {
    const f = fixture();
    const runner = fakeRunner();
    const { code, stderr } = await cli({ env: { ...f.env, ...INHERITED }, runner }, 'ca', '--repo', f.repo, ...slotArgs);
    assert.equal(code, EXIT.ok, stderr);
    assert.equal(Object.hasOwn(makeEnv(runner, 'dev-ca') ?? {}, 'DEV_SLOT'), false);
  }
});

test('ca --slot 6 names the slot\'s command and up in its failure message', async () => {
  const f = fixture();
  const runner = fakeRunner({ 'make dev-ca': { code: 2, stderr: 'no such service: app-gate\n' } });
  const { code, stderr } = await cli({ env: f.env, runner }, 'ca', '--repo', f.repo, '--slot', '6');
  assert.equal(code, EXIT.failure);
  assert.match(stderr, /DEV_HTTPS=1 DEV_SLOT=6 make dev-ca failed \(exit 2\); is the stack up in HTTPS mode\? Run autologger-dev up --slot 6 first\n$/);
});

test('status --slot N probes https://localhost:2N787 over $AUTOLOGGER_URL; --server with --slot must be that slot\'s server', async () => {
  const env = { HOME: '/nonexistent', AUTOLOGGER_URL: 'https://elsewhere.example' };
  let fetchFn = recording();
  let r = await cli({ env, fetch: fetchFn }, 'status', '--slot', '1', '--json');
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(fetchFn.urls, ['https://localhost:21787/', 'https://localhost:21787/.well-known/oauth-protected-resource', 'https://localhost:21787/mcp']);
  assert.equal((JSON.parse(r.stdout) as { server: string; slot: number }).server, 'https://localhost:21787');
  assert.equal((JSON.parse(r.stdout) as { server: string; slot: number }).slot, 1);

  fetchFn = recording();
  r = await cli({ env, fetch: fetchFn }, 'status', '--slot', '9', '--server', 'https://localhost:29787/', '--json');
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(fetchFn.urls[0], 'https://localhost:29787/');

  // Another server with --slot 9 is refused (exit 2), nothing fetched: its fixes would name slot 9.
  fetchFn = recording();
  r = await cli({ env, fetch: fetchFn }, 'status', '--slot', '9', '--server', 'https://localhost:9999', '--json');
  assert.equal(r.code, EXIT.usage);
  assert.equal(r.stdout, '');
  assert.deepEqual(fetchFn.urls, []);

  fetchFn = recording();
  r = await cli({ env, fetch: fetchFn }, 'status', '--slot', '0', '--json');
  assert.equal(fetchFn.urls[0], 'https://localhost:8787/');
});

test('status --slot 7 names the slot in its fixes', async () => {
  let r = await cli({ env: {}, fetch: untrusted }, 'status', '--slot', '7', '--json');
  assert.match((JSON.parse(r.stdout) as { fix: string }).fix, /^run autologger-dev ca --slot 7 to write the dev CA/);
  r = await cli({ env: {} }, 'status', '--slot', '7', '--json');
  assert.equal((JSON.parse(r.stdout) as { fix: string }).fix, 'bring the stack up: autologger-dev up --slot 7 (DEV_HTTPS=1 DEV_SLOT=7 make dev-up in the checkout)');
  r = await cli({ env: {}, fetch: answering(404) }, 'status', '--slot', '7', '--json');
  assert.equal((JSON.parse(r.stdout) as { fix: string }).fix, 'run autologger-dev up --slot 7 (it sets CUSTOM_DASHBOARDS_ENABLED=1 and starts in HTTPS mode)');
});

test('doctor --slot 9 checks https://localhost:29787, names the slot in its fixes and keeps the shared OpenBao container', async () => {
  const f = fixture({ overrides: 'GOOGLE_CLIENT_ID=REPLACE_ME\n' });
  const runner = fakeRunner();
  const fetchFn = recording();
  const { code, stdout, stderr } = await cli({ env: { ...f.env, AUTOLOGGER_URL: 'https://elsewhere.example' }, runner, fetch: fetchFn }, 'doctor', '--repo', f.repo, '--slot', '9', '--json');
  assert.equal(code, EXIT.ok, stderr);
  assert.deepEqual(fetchFn.urls, ['https://localhost:29787/']);
  const report = JSON.parse(stdout) as { server: string; slot: number; checks: { name: string; detail: string; fix: string | null }[] };
  assert.equal(report.server, 'https://localhost:29787');
  assert.equal(report.slot, 9);
  const check = (name: string) => report.checks.find((c) => c.name === name);
  assert.match(check('google_client')?.fix ?? '', /redirect https:\/\/localhost:29787\/auth\/google\/callback.*autologger-dev up --slot 9/);
  assert.match(check('google_client')?.fix ?? '', /; MCP can still be connected without a Google client: the user runs `DEV_SLOT=9 make dev-mcp-token EMAIL=<address> \| autologger-mcp import-tokens --server https:\/\/localhost:29787` with their email in the checkout/);
  assert.match(check('custom_dashboards')?.fix ?? '', /^autologger-dev up --slot 9 /);
  assert.match(check('node_extra_ca_certs')?.fix ?? '', /^run autologger-dev ca --slot 9 /);
  assert.match(check('openbao')?.detail ?? '', /container autologger-local-openbao is running/);
  const inspect = runner.calls.find((c) => c.command === 'docker' && c.args[0] === 'container');
  assert.equal(inspect?.args.at(-1), 'autologger-local-openbao');
  const text = await cli({ env: f.env, runner: fakeRunner(), fetch: answering(401) }, 'doctor', '--repo', f.repo, '--slot', '9');
  assert.match(text.stdout, /^autologger dev stack: .* -> https:\/\/localhost:29787 \(dev slot 9\)\n/);
});

test('doctor --slot 3 names the slot in the dev_server fix', async () => {
  const f = fixture({ overrides: GOOD_OVERRIDES });
  const { stdout } = await cli({ env: f.env, runner: fakeRunner() }, 'doctor', '--repo', f.repo, '--slot', '3', '--json');
  const report = JSON.parse(stdout) as { checks: { name: string; fix: string | null }[] };
  assert.equal(report.checks.find((c) => c.name === 'dev_server')?.fix, 'autologger-dev up --slot 3 (DEV_HTTPS=1 DEV_SLOT=3 make dev-up in the checkout)');
});

test('connect --slot 3 prints the slot\'s /mcp URL, an MCP server name for the slot and its ca step', async () => {
  const f = fixture();
  const { code, stdout } = await cli({ env: { ...f.env, AUTOLOGGER_URL: 'https://elsewhere.example' } }, 'connect', '--slot', '3', '--json');
  assert.equal(code, EXIT.ok);
  const report = JSON.parse(stdout) as Record<string, unknown> & { steps: string[] };
  assert.equal(report.server, 'https://localhost:23787');
  assert.equal(report.slot, 3);
  assert.equal(report.mcp_url, 'https://localhost:23787/mcp');
  assert.equal(report.claude_mcp_add, 'claude mcp add --transport http autologger-dev-3 https://localhost:23787/mcp');
  assert.equal(report.autologger_mcp_login, 'autologger-mcp login --server https://localhost:23787');
  assert.equal(report.dev_mcp_token, 'DEV_SLOT=3 make dev-mcp-token EMAIL=<address> | autologger-mcp import-tokens --server https://localhost:23787');
  assert.ok(report.steps.some((s) => s.includes('`DEV_SLOT=3 make dev-mcp-token EMAIL=<address> | autologger-mcp import-tokens --server https://localhost:23787`')));
  const text = await cli({ env: f.env }, 'connect', '--slot', '3');
  assert.match(text.stdout, /^To connect Claude to https:\/\/localhost:23787\/mcp /);
});

test('connect --slot 3 --server <slot 3\'s URL> names the MCP server autologger-dev-3', async () => {
  const f = fixture();
  for (const url of ['https://localhost:23787', 'https://localhost:23787/', 'https://LOCALHOST:23787/mcp']) {
    const { code, stdout, stderr } = await cli({ env: f.env }, 'connect', '--slot', '3', '--server', url, '--json');
    assert.equal(code, EXIT.ok, stderr);
    const report = JSON.parse(stdout) as Record<string, unknown> & { steps: string[] };
    assert.equal(report.server, 'https://localhost:23787', url);
    assert.equal(report.claude_mcp_add, 'claude mcp add --transport http autologger-dev-3 https://localhost:23787/mcp', url);
    assert.match(report.steps[0] ?? '', /^Write the dev CA first: autologger-dev ca --slot 3 /);
  }
});

test('--slot 3 --server https://example.test is a usage error (exit 2) for connect, status and doctor: no slot-3 name or fix for another server', async () => {
  const f = fixture({ overrides: GOOD_OVERRIDES });
  for (const argv of [['connect'], ['status'], ['doctor', '--repo', f.repo]]) {
    for (const server of ['https://example.test', 'http://localhost:23787', 'https://127.0.0.1:23787', 'https://localhost:8787']) {
      const runner = fakeRunner();
      const fetchFn = recording();
      const { code, stdout, stderr } = await cli({ env: f.env, runner, fetch: fetchFn }, ...argv, '--slot', '3', '--server', server, '--json');
      assert.equal(code, EXIT.usage, `${argv[0]} ${server}`);
      assert.equal(stdout, '');
      assert.match(stderr, /^autologger-dev: --server \S+ is not dev slot 3's server \(https:\/\/localhost:23787\); pass --slot 3 alone for that slot, or --server alone for another server\n/);
      assert.deepEqual(fetchFn.urls, []);
      assert.deepEqual(runner.calls, []);
    }
  }
  // --server alone is still any server, named autologger-dev (slot 0's fixes), as before.
  const alone = JSON.parse((await cli({ env: f.env }, 'connect', '--server', 'https://example.test', '--json')).stdout) as Record<string, unknown>;
  assert.equal(alone.claude_mcp_add, 'claude mcp add --transport http autologger-dev https://example.test/mcp');
});

test('--slot 0 gives exactly the output of no --slot (the JSON has slot 0 either way)', async () => {
  const f = fixture({ overrides: GOOD_OVERRIDES });
  for (const argv of [['connect'], ['status'], ['doctor', '--repo', f.repo], ['up', '--dry-run', '--repo', f.repo], ['ca', '--repo', f.repo]]) {
    for (const json of [['--json'], []]) {
      const opts = () => ({ env: f.env, runner: fakeRunner(), fetch: answering(401) });
      const plain = await cli(opts(), ...argv, ...json);
      const zero = await cli(opts(), ...argv, '--slot', '0', ...json);
      assert.equal(plain.code, EXIT.ok, `${argv.join(' ')}: ${plain.stderr}`);
      assert.deepEqual(zero, plain, argv.join(' '));
      if (json.length > 0) assert.equal((JSON.parse(plain.stdout) as { slot: number }).slot, 0);
    }
  }
});

// Slot 0's DEV_PORT (overrides.env, as compose-run.mjs passes the dev secret's DEV_PORT to compose).

const read = (text: string) => ({ state: 'read' as const, values: new Map(Object.entries({ DEV_PORT: text })) });

test('devPort: digits only, 1-65535, read verbatim; anything else is invalid and keeps no value', () => {
  assert.deepEqual(devPort({ state: 'absent' }), { state: 'not set' });
  assert.deepEqual(devPort({ state: 'unreadable' }), { state: 'not set' });
  assert.deepEqual(devPort({ state: 'read', values: new Map() }), { state: 'not set' });
  assert.deepEqual(devPort(read('')), { state: 'not set' });
  for (const [text, port] of [['9787', 9787], ['1', 1], ['65535', 65535], ['08787', 8787]] as const) assert.deepEqual(devPort(read(text)), { state: 'set', port }, text);
  for (const bad of ['0', '65536', '70000', '123456', 'abc', '"9787"', "'9787'", ' 9787', '9787 ', '-1', '+9787', '9787.0', '1e4', '0x10', '９７８７']) {
    assert.deepEqual(devPort(read(bad)), { state: 'invalid' }, bad);
  }
});

test('slotServer: slot 0 follows a valid DEV_PORT, slot N never does', () => {
  const set = { state: 'set', port: 9787 } as const;
  assert.equal(slotServer(0, set), 'https://localhost:9787');
  assert.equal(slotServer(0, { state: 'invalid' }), 'https://localhost:8787');
  assert.equal(slotServer(0, { state: 'not set' }), 'https://localhost:8787');
  assert.equal(slotServer(2, set), 'https://localhost:22787');
  assert.equal(googleRedirect(0, set), 'https://localhost:9787/auth/google/callback');
  assert.equal(googleRedirect(2, set), 'https://localhost:22787/auth/google/callback');
});

const withPort = (line: string) => fixture({ overrides: `${GOOD_OVERRIDES}${line}\n` });

test('DEV_PORT=9787 in overrides.env: status, connect and doctor default to https://localhost:9787', async () => {
  const f = withPort('DEV_PORT=9787');
  for (const slotArgs of [[], ['--slot', '0']]) {
    let fetchFn = recording();
    const st = await cli({ env: f.env, fetch: fetchFn }, 'status', ...slotArgs, '--json');
    assert.equal(st.code, EXIT.ok, st.stderr);
    assert.equal(fetchFn.urls[0], 'https://localhost:9787/');
    assert.equal((JSON.parse(st.stdout) as { server: string }).server, 'https://localhost:9787');

    const co = JSON.parse((await cli({ env: f.env }, 'connect', ...slotArgs, '--json')).stdout) as Record<string, unknown>;
    assert.equal(co.claude_mcp_add, 'claude mcp add --transport http autologger-dev https://localhost:9787/mcp');
    assert.equal(co.autologger_mcp_login, 'autologger-mcp login --server https://localhost:9787');

    fetchFn = recording();
    const doc = await cli({ env: f.env, runner: fakeRunner(), fetch: fetchFn }, 'doctor', '--repo', f.repo, ...slotArgs, '--json');
    assert.equal(doc.code, EXIT.ok, doc.stderr);
    assert.deepEqual(fetchFn.urls, ['https://localhost:9787/']);
    const report = JSON.parse(doc.stdout) as { server: string; notes: string[] };
    assert.equal(report.server, 'https://localhost:9787');
    assert.deepEqual(report.notes, []);
  }
});

test('DEV_PORT=9787: the Google redirect in doctor\'s fix and up\'s warning uses it', async () => {
  const f = fixture({ overrides: 'GOOGLE_CLIENT_ID=REPLACE_ME\nDEV_PORT=9787\n' });
  const doc = JSON.parse((await cli({ env: f.env, runner: fakeRunner() }, 'doctor', '--repo', f.repo, '--json')).stdout) as { checks: { name: string; fix: string | null }[] };
  assert.match(doc.checks.find((c) => c.name === 'google_client')?.fix ?? '', /redirect https:\/\/localhost:9787\/auth\/google\/callback/);
  const up = await cli({ env: f.env, runner: fakeRunner() }, 'up', '--dry-run', '--repo', f.repo, '--json');
  assert.equal(up.code, EXIT.ok, up.stderr);
  assert.match((JSON.parse(up.stdout) as { warnings: string[] }).warnings.join('\n'), /authorized redirect https:\/\/localhost:9787\/auth\/google\/callback/);
  // Slot N's redirect never follows DEV_PORT.
  const up2 = await cli({ env: f.env, runner: fakeRunner() }, 'up', '--dry-run', '--repo', f.repo, '--slot', '2', '--json');
  assert.match((JSON.parse(up2.stdout) as { warnings: string[] }).warnings.join('\n'), /authorized redirect https:\/\/localhost:22787\/auth\/google\/callback/);
});

test('DEV_PORT unset: the default server stays https://localhost:8787', async () => {
  for (const f of [fixture({ overrides: GOOD_OVERRIDES }), withPort('DEV_PORT='), fixture()]) {
    const fetchFn = recording();
    const st = await cli({ env: f.env, fetch: fetchFn }, 'status', '--json');
    assert.equal(st.code, EXIT.ok, st.stderr);
    assert.equal(fetchFn.urls[0], 'https://localhost:8787/');
    const doc = JSON.parse((await cli({ env: f.env, runner: fakeRunner(), fetch: answering(401) }, 'doctor', '--repo', f.repo, '--json')).stdout) as { server: string; notes: string[] };
    assert.equal(doc.server, 'https://localhost:8787');
    assert.deepEqual(doc.notes, []);
  }
});

test('an invalid DEV_PORT falls back to https://localhost:8787 and doctor says so in one line naming the key, never the value', async () => {
  for (const bad of ['not-a-port-value', '"9787"', "'9787'", ' 9787', '9787 ', '70000', '0']) {
    const f = withPort(`DEV_PORT=${bad}`);
    const fetchFn = recording();
    const st = await cli({ env: f.env, fetch: fetchFn }, 'status', '--json');
    assert.equal(fetchFn.urls[0], 'https://localhost:8787/', bad);
    const co = JSON.parse((await cli({ env: f.env }, 'connect', '--json')).stdout) as { server: string };
    assert.equal(co.server, 'https://localhost:8787', bad);

    const json = await cli({ env: f.env, runner: fakeRunner(), fetch: answering(401) }, 'doctor', '--repo', f.repo, '--json');
    const report = JSON.parse(json.stdout) as { server: string; notes: string[] };
    assert.equal(report.server, 'https://localhost:8787', bad);
    assert.deepEqual(report.notes, [
      `DEV_PORT in ${f.stateDir}/overrides.env is not a port number (digits only, 1-65535, no quotes or spaces), so slot 0's server falls back to https://localhost:8787`,
    ]);
    const text = await cli({ env: f.env, runner: fakeRunner(), fetch: answering(401) }, 'doctor', '--repo', f.repo);
    const notes = text.stdout.split('\n').filter((l) => l.includes('DEV_PORT'));
    assert.deepEqual(notes, [`note: ${report.notes[0] ?? ''}`], bad);
    assert.match(text.stdout, /^autologger dev stack: .* -> https:\/\/localhost:8787\nnote: DEV_PORT /);
    // The value itself is never printed ('0' is too short to look for: it is in every path and port).
    if (bad !== '0') for (const out of [st.stdout, st.stderr, json.stdout, json.stderr, text.stdout, text.stderr]) assert.equal(out.includes(bad.trim()), false, bad);
  }
});

test('--slot 2 ignores DEV_PORT (22787, no note even when DEV_PORT is invalid)', async () => {
  for (const line of ['DEV_PORT=9787', 'DEV_PORT=bogus']) {
    const f = withPort(line);
    const fetchFn = recording();
    await cli({ env: f.env, fetch: fetchFn }, 'status', '--slot', '2', '--json');
    assert.equal(fetchFn.urls[0], 'https://localhost:22787/');
    const co = JSON.parse((await cli({ env: f.env }, 'connect', '--slot', '2', '--json')).stdout) as Record<string, unknown>;
    assert.equal(co.claude_mcp_add, 'claude mcp add --transport http autologger-dev-2 https://localhost:22787/mcp');
    const doc = JSON.parse((await cli({ env: f.env, runner: fakeRunner(), fetch: answering(401) }, 'doctor', '--repo', f.repo, '--slot', '2', '--json')).stdout) as { server: string; notes: string[] };
    assert.equal(doc.server, 'https://localhost:22787');
    assert.deepEqual(doc.notes, []);
  }
});

test('precedence with DEV_PORT: --server, then --slot, then $AUTOLOGGER_URL, then https://localhost:<DEV_PORT>', async () => {
  const f = withPort('DEV_PORT=9787');
  const env = { ...f.env, AUTOLOGGER_URL: 'https://elsewhere.example' };
  const first = async (...argv: string[]): Promise<string | undefined> => {
    const fetchFn = recording();
    const r = await cli({ env, fetch: fetchFn }, 'status', ...argv, '--json');
    assert.equal(r.code, EXIT.ok, r.stderr);
    return fetchFn.urls[0];
  };
  // --server wins over $AUTOLOGGER_URL and DEV_PORT.
  assert.equal(await first('--server', 'https://example.test'), 'https://example.test/');
  // --server with --slot: the slot's own server (DEV_PORT for slot 0) is accepted.
  assert.equal(await first('--slot', '0', '--server', 'https://localhost:9787'), 'https://localhost:9787/');
  // --slot wins over $AUTOLOGGER_URL; slot 0's server is DEV_PORT's.
  assert.equal(await first('--slot', '0'), 'https://localhost:9787/');
  assert.equal(await first('--slot', '2'), 'https://localhost:22787/');
  // $AUTOLOGGER_URL wins over DEV_PORT.
  assert.equal(await first(), 'https://elsewhere.example/');
  // DEV_PORT is the default when neither is given.
  const fetchFn = recording();
  await cli({ env: f.env, fetch: fetchFn }, 'status', '--json');
  assert.equal(fetchFn.urls[0], 'https://localhost:9787/');
  // With DEV_PORT set, --slot 0 --server https://localhost:8787 names another stack: refused.
  const r = await cli({ env, fetch: recording() }, 'status', '--slot', '0', '--server', 'https://localhost:8787', '--json');
  assert.equal(r.code, EXIT.usage);
  assert.match(r.stderr, /is not dev slot 0's server \(https:\/\/localhost:9787\)/);
});
