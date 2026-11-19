import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCookieLine } from '../src/signin.ts';
import { run } from '../src/run.ts';
import { slotPaths } from '../src/slot.ts';
import { capture, fakeRunner, tempHome } from './helpers.ts';

const TOKEN = 'tok3n-SECRET_value.never+printed/9=';

async function signin(env: Record<string, string>, input: string, fake = fakeRunner(), extra: string[] = []): Promise<{ code: number; out: string; err: string; fake: ReturnType<typeof fakeRunner> }> {
  const c = capture({ env, runner: fake.runner, readStdin: async () => input, stdinIsTty: false });
  const code = await run(['signin', '--json', ...extra], c.io);
  return { code, out: c.out(), err: c.err(), fake };
}

async function withProfile(slot: number, body: (env: Record<string, string>) => Promise<void>): Promise<void> {
  const t = tempHome();
  try {
    const c = capture({ env: t.env, runner: fakeRunner().runner });
    assert.equal(await run(['setup', '--slot', String(slot)], c.io), 0, c.err());
    await body(t.env);
  } finally {
    t.cleanup();
  }
}

test('signin sets the slot cookie (Secure, HttpOnly, path /) through agent-browser batch on stdin, never on its command line', async () => {
  await withProfile(0, async (env) => {
    const { code, out, err, fake } = await signin(env, `autologger_sid=${TOKEN}\n`);
    assert.equal(code, 0, err);
    const paths = slotPaths(env, 0);
    const call = fake.calls.find((c) => c.command === 'agent-browser');
    assert.ok(call);
    assert.deepEqual(call.args, ['--session', 'autologger-dev-0', '--profile', paths.profile, '--executable-path', paths.launcher, 'batch', '--bail', '--json', '--omit-command']);
    const batch = JSON.parse(call.options?.input ?? '') as string[][];
    assert.equal(batch.length, 1);
    const cmd = batch[0] ?? [];
    assert.deepEqual(cmd.slice(0, 13), ['cookies', 'set', 'autologger_sid', TOKEN, '--url', 'https://localhost:8787/', '--path', '/', '--secure', '--http-only', '--same-site', 'Lax', '--expires']);
    assert.match(cmd[13] ?? '', /^\d+$/);
    for (const c of fake.calls) assert.ok(!c.args.some((a) => a.includes(TOKEN)), `token on the command line of ${c.command}`);
    assert.ok(!out.includes(TOKEN) && !err.includes(TOKEN));
    const json = JSON.parse(out) as Record<string, unknown>;
    assert.equal(json.cookie, 'autologger_sid');
    assert.equal(json.origin, 'https://localhost:8787');
    assert.equal(json.secure, true);
    assert.equal(json.http_only, true);
    assert.equal(json.path, '/');
  });
});

test('signin on slot N uses autologger_sid_N and the slot origin', async () => {
  await withProfile(4, async (env) => {
    const { code, fake } = await signin(env, `autologger_sid_4=${TOKEN}`, fakeRunner(), ['--slot', '4']);
    assert.equal(code, 0);
    const cmd = (JSON.parse(fake.calls.find((c) => c.command === 'agent-browser')?.options?.input ?? '') as string[][])[0] ?? [];
    assert.equal(cmd[2], 'autologger_sid_4');
    assert.equal(cmd[5], 'https://localhost:24787/');
  });
});

test('signin refuses anything but exactly one line with the slot cookie name, runs nothing, and never echoes the input', async () => {
  await withProfile(0, async (env) => {
    const bad: Array<[string, string[], RegExp]> = [
      ['', [], /got nothing/],
      [`autologger_sid=${TOKEN}\nautologger_sid=${TOKEN}\n`, [], /more than one/],
      [`autologger_sid=${TOKEN}\n\n`, [], /more than one/],
      [`${TOKEN}`, [], /cookie name is not one/],
      ['justatoken', [], /not <cookie name>=<token>/],
      [`autologger_sid_2=${TOKEN}`, [], /dev slot 0's is autologger_sid/],
      [`autologger_sid=${TOKEN}`, ['--slot', '2'], /dev slot 2's is autologger_sid_2/],
      ['autologger_sid=', [], /empty/],
      [`autologger_sid=${TOKEN} x`, [], /characters a cookie cannot hold/],
      [`autologger_sid=${TOKEN};x`, [], /characters a cookie cannot hold/],
      [`bad name=${TOKEN}`, [], /cookie name is not one/],
    ];
    for (const [input, extra, message] of bad) {
      const { code, out, err, fake } = await signin(env, input, fakeRunner(), extra);
      assert.equal(code, 2, JSON.stringify(input));
      assert.equal(out, '');
      assert.match(err, message);
      assert.ok(!err.includes(TOKEN), 'the error echoed the token');
      assert.equal(fake.calls.length, 0, 'something ran');
    }
  });
});

test('signin needs the profile from setup first, and a piped stdin', async () => {
  const t = tempHome();
  try {
    const { code, err, fake } = await signin(t.env, `autologger_sid=${TOKEN}`);
    assert.equal(code, 1);
    assert.match(err, /run autologger-browser setup first/);
    assert.equal(fake.calls.length, 0);
    const c = capture({ env: t.env, runner: fakeRunner().runner, readStdin: async () => '', stdinIsTty: true });
    assert.equal(await run(['signin'], c.io), 2);
    assert.match(c.err(), /pipe make dev-login/);
  } finally {
    t.cleanup();
  }
});

test('a failed agent-browser batch is exit 1 with the token scrubbed from the message', async () => {
  await withProfile(0, async (env) => {
    const leaky = fakeRunner({ batchStdout: JSON.stringify([{ success: false, error: `CDP error: bad cookie ${TOKEN}` }]) });
    const { code, out, err } = await signin(env, `autologger_sid=${TOKEN}`, leaky);
    assert.equal(code, 1);
    assert.equal(out, '');
    assert.match(err, /did not set the autologger_sid cookie \(CDP error: bad cookie \[redacted\]\)/);
    assert.ok(!err.includes(TOKEN));
    const garbage = fakeRunner({ batchStdout: `oops ${TOKEN}`, batchCode: 1 });
    const second = await signin(env, `autologger_sid=${TOKEN}`, garbage);
    assert.equal(second.code, 1);
    assert.ok(!second.err.includes(TOKEN));
    const missing = await signin(env, `autologger_sid=${TOKEN}`, fakeRunner({ agentBrowser: false }));
    assert.equal(missing.code, 1);
    assert.match(missing.err, /agent-browser is not on PATH/);
  });
});

test('parseCookieLine accepts CRLF and returns only the token', () => {
  assert.equal(parseCookieLine(`autologger_sid=${TOKEN}\r\n`, 0), TOKEN);
  assert.equal(parseCookieLine(`autologger_sid_9=${TOKEN}`, 9), TOKEN);
});
