// import-tokens: storing the JSON line autologger's dev-only `make dev-mcp-token` prints (played by
// the fake server's mintDevTokens), and the imported sign-in behaving like a browser login.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
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

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const noNetwork: typeof fetch = async () => {
  throw new Error('network used');
};

async function imported(scope = 'dashboards', now: () => number = () => NOW) {
  const server = await fake();
  const configDir = tempConfigDir();
  const json = server.mintDevTokens(scope);
  const result = await cli({ configDir, server: server.base, stdin: json, now }, 'import-tokens', '--json');
  assert.equal(result.code, 0, result.stderr);
  return { server, configDir, json, result, minted: JSON.parse(json) as Record<string, string | number> };
}

/** Nothing under the config directory: no credentials file, no directory, no lock. */
function assertNothingWritten(configDir: string): void {
  assert.deepEqual(readdirSync(configDir), []);
}

test('import-tokens stores endpoints, the client and the tokens (mode 0600) and prints server, scope and expiry', async () => {
  const { server, configDir, result, minted } = await imported();
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report, {
    server: server.base,
    scope: 'dashboards',
    expires_at: new Date(NOW + 3600 * 1000).toISOString(),
    client_id: minted.client_id,
    replaced: false,
    revoked_previous: false,
    can_write: false,
  });
  const path = credentialsPath(configDir, server.base);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(existsSync(`${path}.lock`), false, 'the lock is released');
  const creds = storedCredentials(configDir, server.base);
  assert.equal(creds.endpoints?.token_endpoint, `${server.base}/as/v2/token`);
  assert.equal(creds.endpoints?.revocation_endpoint, `${server.base}/as/v2/revoke`);
  assert.equal(creds.endpoints?.resource, server.resource);
  assert.equal(creds.client?.client_id, minted.client_id);
  assert.equal(creds.client?.registration_endpoint, `${server.base}/as/v2/register`);
  assert.equal(creds.tokens?.access_token, minted.access_token);
  assert.equal(creds.tokens?.refresh_token, minted.refresh_token);
  assert.equal(creds.tokens?.expires_at, NOW + 3600 * 1000);
  assert.equal(creds.tokens?.scope, 'dashboards');
  // Discovery ran (as login's does); no client was registered by the CLI.
  assert.ok(server.calls.some((c) => c.path === '/.well-known/oauth-protected-resource'));
  assert.ok(!server.calls.some((c) => c.path === '/as/v2/register'));

  const text = await cli({ configDir, server: server.base, stdin: server.mintDevTokens(), now: () => NOW }, 'import-tokens');
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^Signed in to http:\/\/127\.0\.0\.1:\d+ with imported tokens, scope 'dashboards'; the access token expires 2026-11-19T13:00:00\.000Z\.\n/);
});

test('imported credentials behave like a browser login: status, tools, call, refresh and logout', async () => {
  const { server, configDir, minted } = await imported('dashboards session-data:write', Date.now);

  const status = await cli({ configDir, server: server.base, fetch: noNetwork }, 'status', '--json');
  assert.equal(status.code, 0, status.stderr);
  const report = JSON.parse(status.stdout);
  assert.equal(report.signed_in, true);
  assert.equal(report.scope, 'dashboards session-data:write');
  assert.equal(report.can_write, true);
  assert.equal(report.can_refresh, true);
  assert.match(report.import_tokens_command, /^npx --yes --offline --loglevel=error --package=.+ -- autologger-mcp import-tokens --server http:\/\/127\.0\.0\.1:\d+$/);

  const tools = await cli({ configDir, server: server.base }, 'tools', '--json');
  assert.equal(tools.code, 0, tools.stderr);
  assert.ok(JSON.parse(tools.stdout).tools.some((t: { name: string }) => t.name === 'create_wiki_page'));
  const call = await cli({ configDir, server: server.base }, 'call', 'list_studios', '--json');
  assert.equal(call.code, 0, call.stderr);
  assert.equal(JSON.parse(call.stdout).structuredContent.total, 1);
  assert.equal(server.counts.refreshes, 0);

  // Expired: refreshed at the token endpoint with the imported client_id and refresh token.
  const later = await cli({ configDir, server: server.base, now: () => Date.now() + 2 * HOUR }, 'call', 'list_studios', '--json');
  assert.equal(later.code, 0, later.stderr);
  assert.equal(server.counts.refreshes, 1);
  assert.equal(server.refresh.get(String(minted.refresh_token))?.used, true);
  const rotated = storedCredentials(configDir, server.base).tokens;
  assert.notEqual(rotated?.refresh_token, minted.refresh_token);
  assert.equal(rotated?.scope, 'dashboards session-data:write');

  const logout = await cli({ configDir, server: server.base }, 'logout', '--json');
  assert.equal(logout.code, 0, logout.stderr);
  assert.equal(JSON.parse(logout.stdout).revoked, true);
  assert.equal(server.counts.revocations, 1);
  assert.equal(server.refresh.get(String(minted.refresh_token))?.grant.revoked, true);
  assert.equal(storedCredentials(configDir, server.base).tokens, undefined);
});

test('import-tokens replaces a browser sign-in, revoking its grant first', async () => {
  const server = await fake();
  const configDir = tempConfigDir();
  const login = await cli({ configDir, server: server.base }, 'login', '--json');
  assert.equal(login.code, 0, login.stderr);
  const old = storedCredentials(configDir, server.base);
  const json = server.mintDevTokens();
  const result = await cli({ configDir, server: server.base, stdin: json }, 'import-tokens', '--json');
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.replaced, true);
  assert.equal(report.revoked_previous, true);
  assert.equal(server.counts.revocations, 1);
  assert.equal(server.refresh.get(old.tokens?.refresh_token ?? '')?.grant.revoked, true);
  const now = storedCredentials(configDir, server.base);
  assert.equal(now.client?.client_id, JSON.parse(json).client_id);
  assert.notEqual(now.client?.client_id, old.client?.client_id);
  assert.equal(now.tokens?.access_token, JSON.parse(json).access_token);
  const tools = await cli({ configDir, server: server.base }, 'tools');
  assert.equal(tools.code, 0, tools.stderr);
});

test('a failed revoke of the previous sign-in warns but does not block the import', async () => {
  const server = await fake();
  const configDir = tempConfigDir();
  assert.equal((await cli({ configDir, server: server.base }, 'login')).code, 0);
  const failingRevoke: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/as/v2/revoke')) throw new TypeError('fetch failed');
    return fetch(input, init);
  };
  const json = server.mintDevTokens();
  const result = await cli({ configDir, server: server.base, stdin: json, fetch: failingRevoke }, 'import-tokens', '--json');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /warning: could not revoke the previous sign-in at the server .*replaced anyway/);
  const report = JSON.parse(result.stdout);
  assert.equal(report.replaced, true);
  assert.equal(report.revoked_previous, false);
  assert.equal(server.counts.revocations, 0);
  assert.equal(storedCredentials(configDir, server.base).tokens?.access_token, JSON.parse(json).access_token);
});

test('importing the same tokens again does not revoke them', async () => {
  const { server, configDir, json } = await imported();
  const again = await cli({ configDir, server: server.base, stdin: json }, 'import-tokens', '--json');
  assert.equal(again.code, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).revoked_previous, false);
  assert.equal(server.counts.revocations, 0);
  assert.equal((await cli({ configDir, server: server.base }, 'tools')).code, 0);
});

test('tokens for another server are refused with exit 1 and nothing written (issuer, then resource)', async () => {
  const mine = await fake();
  const other = await fake();
  const configDir = tempConfigDir();
  // --server names the target; AUTOLOGGER_URL (other) is not used.
  const wrongIssuer = await cli({ configDir, server: other.base, stdin: other.mintDevTokens() }, 'import-tokens', '--server', mine.base, '--json');
  assert.equal(wrongIssuer.code, 1);
  assert.equal(wrongIssuer.stdout, '');
  assert.match(wrongIssuer.stderr, /^autologger-mcp: the token JSON's issuer 'http:\/\/127\.0\.0\.1:\d+' is not http:\/\/127\.0\.0\.1:\d+'s .*nothing was stored\n$/);
  assertNothingWritten(configDir);

  const resource = { ...JSON.parse(mine.mintDevTokens()), resource: `${mine.base}/elsewhere/mcp` };
  const wrongResource = await cli({ configDir, server: mine.base, stdin: JSON.stringify(resource) }, 'import-tokens');
  assert.equal(wrongResource.code, 1);
  assert.match(wrongResource.stderr, /the token JSON's resource '.*\/elsewhere\/mcp' is not .*nothing was stored/);
  assertNothingWritten(configDir);

  // The default target is $AUTOLOGGER_URL: other's tokens into other.
  const fromEnv = await cli({ configDir, server: other.base, stdin: other.mintDevTokens() }, 'import-tokens', '--json');
  assert.equal(fromEnv.code, 0, fromEnv.stderr);
  assert.equal(JSON.parse(fromEnv.stdout).server, other.base);
});

test('a refused import leaves an existing sign-in as it was, unrevoked', async () => {
  const mine = await fake();
  const other = await fake();
  const configDir = tempConfigDir();
  assert.equal((await cli({ configDir, server: mine.base }, 'login')).code, 0);
  const before = storedCredentials(configDir, mine.base);
  const result = await cli({ configDir, server: mine.base, stdin: other.mintDevTokens() }, 'import-tokens');
  assert.equal(result.code, 1);
  assert.deepEqual(storedCredentials(configDir, mine.base), before);
  assert.equal(mine.counts.revocations, 0);
});

test('invalid input is refused with exit 1 before any request, naming fields but never printing a token', async () => {
  const server = await fake();
  const valid = JSON.parse(server.mintDevTokens()) as Record<string, unknown>;
  const secret = String(valid.access_token);
  const cases: [string, RegExp][] = [
    ['', /standard input is empty; pipe the output of make dev-mcp-token/],
    [`not json ${secret}`, /standard input is not the JSON object make dev-mcp-token prints/],
    [`{"access_token": "${secret}", `, /standard input is not the JSON object/],
    ['[1, 2]', /standard input is not the JSON object/],
    [`${JSON.stringify(valid)}\n${JSON.stringify(valid)}\n`, /standard input is not the JSON object/],
    [JSON.stringify({ ...valid, refresh_token: undefined, expires_in: undefined }), /the token JSON lacks refresh_token, expires_in$/m],
    [JSON.stringify({ ...valid, token_type: 'mac' }), /token_type is 'mac', not Bearer/],
    [JSON.stringify({ ...valid, scope: 'admin' }), /scope 'admin' is not one this CLI understands \('dashboards' or 'dashboards session-data:write'\)/],
    [JSON.stringify({ ...valid, scope: 'session-data:write dashboards' }), /is not one this CLI understands/],
    [JSON.stringify({ ...valid, expires_in: -5 }), /expires_in is not a positive number of seconds/],
    [JSON.stringify({ ...valid, expires_in: '3600' }), /expires_in is not a positive number/],
    [JSON.stringify({ ...valid, client_id: 42 }), /client_id is not a string/],
  ];
  for (const [stdin, message] of cases) {
    const configDir = tempConfigDir();
    const result = await cli({ configDir, server: server.base, stdin, fetch: noNetwork }, 'import-tokens', '--json');
    assert.equal(result.code, 1, stdin);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, message, stdin);
    assert.ok(!result.stderr.includes(secret), `token printed for input ${stdin.slice(0, 20)}`);
    assertNothingWritten(configDir);
  }
});

test('tolerates chatter around the one JSON line (make printing on stdout)', async () => {
  const server = await fake();
  const configDir = tempConfigDir();
  const stdin = `make[1]: Entering directory '/x'\n${server.mintDevTokens()}make[1]: Leaving directory '/x'\n`;
  const result = await cli({ configDir, server: server.base, stdin }, 'import-tokens', '--json');
  assert.equal(result.code, 0, result.stderr);
});

test('tokens are never taken from an argument: any positional is a usage error (exit 2)', async () => {
  const server = await fake();
  const configDir = tempConfigDir();
  const json = server.mintDevTokens();
  const secret = String(JSON.parse(json).access_token);
  const result = await cli({ configDir, server: server.base, stdin: json, fetch: noNetwork }, 'import-tokens', json);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /import-tokens takes no arguments; pipe the output of make dev-mcp-token into it/);
  assert.ok(!result.stderr.includes(secret));
  assertNothingWritten(configDir);
  const option = await cli({ configDir, server: server.base, stdin: json }, 'import-tokens', '--write');
  assert.equal(option.code, 2);
  assert.match(option.stderr, /import-tokens does not take --write/);
});
