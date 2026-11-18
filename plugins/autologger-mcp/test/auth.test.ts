// Login, credentials, refresh, 401 retry, invalid_grant, status and logout against the fake server.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { after, test } from 'node:test';
import { FakeAutologger } from './fakeServer.ts';
import { cli, credentialsPath, HOUR, storedCredentials, tempConfigDir, transcript } from './helpers.ts';

const servers: FakeAutologger[] = [];
async function fake(options: ConstructorParameters<typeof FakeAutologger>[0] = {}): Promise<FakeAutologger> {
  const server = await new FakeAutologger(options).start();
  servers.push(server);
  return server;
}

after(async () => {
  // Token non-disclosure: nothing any command printed in this file carries a token the server issued.
  const printed = transcript.join('\n');
  for (const server of servers) {
    for (const t of server.issued) assert.ok(!printed.includes(t), 'a token was printed');
    await server.close();
  }
});

async function signedIn(options: ConstructorParameters<typeof FakeAutologger>[0] = {}, ...loginArgs: string[]) {
  const server = await fake(options);
  const configDir = tempConfigDir();
  const result = await cli({ configDir, server: server.base }, 'login', '--json', ...loginArgs);
  assert.equal(result.code, 0, result.stderr);
  return { server, configDir, login: result };
}

test('login registers a client, runs code + PKCE through a loopback redirect, and stores the granted scope', async () => {
  const { server, configDir, login } = await signedIn();
  const report = JSON.parse(login.stdout);
  assert.equal(report.server, server.base);
  assert.equal(report.scope, 'dashboards');
  assert.equal(report.can_write, false);
  assert.equal(report.registered, true);
  assert.match(report.expires_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(server.counts.registrations, 1);
  // The URL was shown on stderr, with every parameter the server requires.
  const url = new URL(/(http:\/\/127\.0\.0\.1:\d+\/as\/v2\/authorize\S+)/.exec(login.stderr)?.[1] ?? '');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'dashboards');
  assert.equal(url.searchParams.get('resource'), server.resource);
  assert.match(url.searchParams.get('redirect_uri') ?? '', /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.ok((url.searchParams.get('state') ?? '').length >= 16);
  const creds = storedCredentials(configDir, server.base);
  assert.equal(creds.tokens?.scope, 'dashboards');
  assert.equal(creds.endpoints?.token_endpoint, `${server.base}/as/v2/token`);
  assert.equal(creds.endpoints?.resource, server.resource);
});

test('a second login reuses the stored client registration', async () => {
  const { server, configDir } = await signedIn();
  const again = await cli({ configDir, server: server.base }, 'login', '--json');
  assert.equal(again.code, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).registered, false);
  assert.equal(server.counts.registrations, 1);
});

test('login --write asks for both scopes; the scope stored is the one granted', async () => {
  const both = await signedIn({}, '--write');
  assert.equal(JSON.parse(both.login.stdout).scope, 'dashboards session-data:write');
  assert.match(both.login.stderr, /scope=dashboards\+session-data%3Awrite/);

  // The user unticks the write line at consent: dashboards only is stored and reported.
  const declined = await signedIn({ grantWrite: false }, '--write');
  const report = JSON.parse(declined.login.stdout);
  assert.equal(report.scope, 'dashboards');
  assert.equal(report.can_write, false);
  assert.equal(storedCredentials(declined.configDir, declined.server.base).tokens?.scope, 'dashboards');
});

test('login ignores a callback with the wrong state, and fails on a callback without the issuer', async () => {
  const server = await fake();
  const configDir = tempConfigDir();
  const forged = await cli(
    {
      configDir,
      server: server.base,
      openUrl: (url) => {
        void (async () => {
          const redirect = new URL(url).searchParams.get('redirect_uri') ?? '';
          const answer = await fetch(`${redirect}?code=forged&state=wrong`);
          assert.equal(answer.status, 400);
          const { browse } = await import('./fakeServer.ts');
          await browse(url);
        })();
      },
    },
    'login',
    '--json',
  );
  assert.equal(forged.code, 0, forged.stderr);

  const noIss = await fake({ omitIss: true });
  const result = await cli({ configDir: tempConfigDir(), server: noIss.base }, 'login', '--json');
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /issuer/);
});

test('login times out when the browser never comes back', async () => {
  const server = await fake();
  const result = await cli({ configDir: tempConfigDir(), server: server.base, openUrl: () => {} }, 'login', '--timeout', '1');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /timed out after 1 s/);
});

test('discovery: endpoints come from the metadata documents, and a mismatched issuer is refused', async () => {
  const server = await fake({ wrongIssuer: true });
  const result = await cli({ configDir: tempConfigDir(), server: server.base }, 'login');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /issuer 'https:\/\/evil\.example' does not match/);
  assert.ok(!server.calls.some((c) => c.path.includes('/register')));
});

test('server selection: --server beats AUTOLOGGER_URL; non-https non-loopback URLs are usage errors', async () => {
  const configDir = tempConfigDir();
  const status = await cli({ configDir, server: 'https://from-env.example' }, 'status', '--json', '--server', 'https://flag.example/x');
  assert.equal(JSON.parse(status.stdout).server, 'https://flag.example');
  const env = await cli({ configDir, server: 'https://from-env.example' }, 'status', '--json');
  assert.equal(JSON.parse(env.stdout).server, 'https://from-env.example');
  const dflt = await cli({ configDir }, 'status', '--json');
  assert.equal(JSON.parse(dflt.stdout).server, 'https://localhost:8787');
  const bad = await cli({ configDir }, 'status', '--server', 'http://example.com');
  assert.equal(bad.code, 2);
  assert.equal(bad.stdout, '');
});

test('credentials are mode 0600 in a 0700 directory, even if the directory existed wider', async () => {
  const server = await fake();
  const configDir = tempConfigDir();
  const path = credentialsPath(configDir, server.base);
  mkdirSync(dirname(path), { recursive: true });
  chmodSync(dirname(path), 0o755);
  chmodSync(configDir, 0o755);
  const result = await cli({ configDir, server: server.base }, 'login');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assert.equal(statSync(configDir).mode & 0o777, 0o700);
});

test('the default credentials directory is $XDG_CONFIG_HOME/autologger-mcp', async () => {
  const xdg = tempConfigDir();
  const result = await cli({ configDir: '', env: { XDG_CONFIG_HOME: xdg } }, 'status', '--json');
  assert.ok(JSON.parse(result.stdout).credentials_file.startsWith(`${xdg}/autologger-mcp/credentials/`));
});

test('an expired access token is refreshed once; the rotated refresh token is persisted', async () => {
  const { server, configDir } = await signedIn();
  const before = storedCredentials(configDir, server.base).tokens;
  const later = () => Date.now() + 2 * HOUR;
  const result = await cli({ configDir, server: server.base, now: later }, 'tools', '--json');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(server.counts.refreshes, 1);
  const afterTokens = storedCredentials(configDir, server.base).tokens;
  assert.notEqual(afterTokens?.refresh_token, before?.refresh_token);
  assert.notEqual(afterTokens?.access_token, before?.access_token);
  assert.equal(server.refresh.get(before?.refresh_token ?? '')?.used, true);
  assert.equal(server.refresh.get(afterTokens?.refresh_token ?? '')?.used, false);
  assert.equal(afterTokens?.scope, 'dashboards');
});

test('a 401 from /mcp refreshes once and retries the call', async () => {
  const { server, configDir } = await signedIn();
  server.dropAccessTokens();
  const result = await cli({ configDir, server: server.base }, 'call', 'list_studios', '--json');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(server.counts.refreshes, 1);
  assert.equal(JSON.parse(result.stdout).structuredContent.total, 1);
});

test('a 401 that persists after the refresh fails with a sign-in message, not a loop', async () => {
  const { server, configDir } = await signedIn();
  server.options.rejectAllBearers = true;
  const result = await cli({ configDir, server: server.base }, 'tools');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /rejected the access token even after a refresh to http:\/\/127\.0\.0\.1:\d+; run 'autologger-mcp login'/);
  assert.equal(server.counts.refreshes, 1);
});

test('invalid_grant on refresh clears the tokens and tells the user to log in', async () => {
  const { server, configDir } = await signedIn();
  server.revokeAll();
  const result = await cli({ configDir, server: server.base, now: () => Date.now() + 2 * HOUR }, 'tools', '--json');
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /invalid_grant.*run 'autologger-mcp login'/);
  const creds = storedCredentials(configDir, server.base);
  assert.equal(creds.tokens, undefined);
  assert.ok(creds.client !== undefined, 'the client registration is kept');
  const status = await cli({ configDir, server: server.base }, 'status', '--json');
  assert.equal(JSON.parse(status.stdout).signed_in, false);
});

test('concurrent invocations with an expired token refresh once, without tripping reuse detection', async () => {
  const { server, configDir } = await signedIn();
  const later = () => Date.now() + 2 * HOUR;
  const results = await Promise.all(
    [1, 2, 3, 4].map(() => cli({ configDir, server: server.base, now: later }, 'call', 'list_studios', '--json')),
  );
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  assert.equal(server.counts.refreshes, 1);
  assert.equal(server.counts.reuses, 0);
});

test('status reads only the local file unless --check is given', async () => {
  const { server, configDir } = await signedIn({}, '--write');
  const offline: typeof fetch = async () => {
    throw new Error('network used');
  };
  const status = await cli({ configDir, server: server.base, fetch: offline }, 'status', '--json');
  assert.equal(status.code, 0, status.stderr);
  const report = JSON.parse(status.stdout);
  assert.equal(report.signed_in, true);
  assert.equal(report.scope, 'dashboards session-data:write');
  assert.equal(report.can_write, true);
  assert.equal(report.access_token_expired, false);
  assert.match(report.access_token_expires_at, /^\d{4}-/);
  assert.match(report.login_command, /^npx --yes --offline --loglevel=error --package=.+ -- autologger-mcp login --server http:\/\/127\.0\.0\.1:\d+$/);

  const human = await cli({ configDir, server: server.base, fetch: offline }, 'status');
  assert.match(human.stdout, /Signed in, scope 'dashboards session-data:write'; access token expires /);

  const checked = await cli({ configDir, server: server.base }, 'status', '--check', '--json');
  assert.equal(checked.code, 0, checked.stderr);
  const checkedReport = JSON.parse(checked.stdout);
  assert.equal(checkedReport.discovery.resource, server.resource);
  assert.equal(checkedReport.token_valid, true);
});

test('logout revokes the refresh token at the advertised endpoint and deletes the local tokens', async () => {
  const { server, configDir } = await signedIn();
  const refresh = storedCredentials(configDir, server.base).tokens?.refresh_token ?? '';
  const result = await cli({ configDir, server: server.base }, 'logout', '--json');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { server: server.base, was_signed_in: true, revoked: true, signed_in: false });
  assert.equal(server.counts.revocations, 1);
  assert.equal(server.refresh.get(refresh)?.grant.revoked, true);
  assert.equal(storedCredentials(configDir, server.base).tokens, undefined);
  const tools = await cli({ configDir, server: server.base }, 'tools');
  assert.equal(tools.code, 1);
  assert.match(tools.stderr, /not signed in/);
});

test('logout succeeds with a warning when the server is unreachable', async () => {
  const { server, configDir } = await signedIn();
  await server.close();
  const result = await cli({ configDir, server: server.base }, 'logout', '--json');
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).revoked, false);
  assert.match(result.stderr, /warning: could not revoke/);
  assert.equal(storedCredentials(configDir, server.base).tokens, undefined);
});

test('logout without a revocation endpoint deletes the local tokens with a warning', async () => {
  const { server, configDir } = await signedIn({ noRevocation: true });
  const result = await cli({ configDir, server: server.base }, 'logout');
  assert.equal(result.code, 0);
  assert.match(result.stderr, /no revocation endpoint/);
  assert.equal(storedCredentials(configDir, server.base).tokens, undefined);
});

test('no command prints a token: --help, --json, status, errors (tokens in server text are redacted)', async () => {
  const { server, configDir } = await signedIn({}, '--write');
  const outputs = [
    await cli({ configDir, server: server.base }, '--help'),
    await cli({ configDir, server: server.base }, 'status', '--json'),
    await cli({ configDir, server: server.base }, 'status', '--check'),
    await cli({ configDir, server: server.base }, 'tools', '--json'),
    await cli({ configDir, server: server.base }, 'call', 'fail_tool', '--json'),
    await cli({ configDir, server: server.base }, 'call', 'no_such_tool'),
  ];
  const { access_token: access = '', refresh_token: refresh = '' } = storedCredentials(configDir, server.base).tokens ?? {};
  // A tool result that happens to contain the token (the fake echoes its arguments) is scrubbed.
  outputs.push(await cli({ configDir, server: server.base }, 'call', 'create_wiki_page', '--json', '--args', JSON.stringify({ body_md: access })));
  assert.match(outputs.at(-1)?.stdout ?? '', /\[redacted\]/);
  for (const o of outputs) {
    for (const t of [access, refresh, ...server.issued]) {
      assert.ok(!o.stdout.includes(t) && !o.stderr.includes(t), 'token printed');
    }
  }
});
