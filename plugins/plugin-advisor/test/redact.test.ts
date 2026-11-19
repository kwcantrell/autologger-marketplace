import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cap, cleanDetail, cleanSummary, containsSecret, DETAIL_MAX, normalise, redact, signature, SUMMARY_MAX } from '../src/redact.ts';

const R = '[redacted]';

const SECRETS: Array<[string, string, string]> = [
  ['bearer token', 'Authorization header was Bearer abcDEF123456ghiJKL789', `Authorization header was Bearer ${R}`],
  ['alm_ access token', 'stored alm_Zx81kPq0rT5vW2yB in the file', `stored ${R} in the file`],
  ['alr_ refresh token', 'refresh with alr_9q8w7e6r5t4y and retry', `refresh with ${R} and retry`],
  ['autologger_sid cookie', 'Cookie: autologger_sid=s%3Aabc.def123; Path=/', `Cookie: autologger_sid=${R}; Path=/`],
  ['bare autologger_sid', 'autologger_sid: 8f3k2a9d', `autologger_sid: ${R}`],
  ['KEY=value with a secret key', 'set OPENBAO_SECRET_ID=1234-abcd and DEV_PORT=8787', `set OPENBAO_SECRET_ID=${R} and DEV_PORT=8787`],
  ['password in quotes', 'password="hello world" user=ada', `password="${R}" user=ada`],
  ['json key', '{"access_token": "abc.def", "scope": "read"}', `{"access_token": "${R}", "scope": "read"}`],
  ['client_secret query', 'https://x.example/cb?code=1&client_secret=s3cr3t&state=2', `https://x.example/cb?code=1&client_secret=${R}&state=2`],
  ['api key flag', 'ran it with --api-key k_live_12345', `ran it with --api-key ${R}`],
  ['JWT', 'id_token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk', `id_token ${R}`],
  ['url credentials', 'cloned https://ada:pa55word@github.com/x/y', `cloned https://${R}@github.com/x/y`],
  ['long random string', 'got 9fQ2xLk7Pz0aB3cD4eF5gH6iJ7kL8mN9oP back', `got ${R} back`],
  ['github token', 'GH_TOKEN is ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345', `GH_TOKEN is ${R}`],
  ['private key', 'key -----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY----- end', `key ${R} end`],
];

for (const [name, input, expected] of SECRETS) {
  test(`redact: ${name}`, () => {
    assert.equal(redact(input), expected);
    assert.equal(containsSecret(input), true);
    assert.equal(containsSecret(expected), false, 'redacted text must not look secret');
    assert.equal(redact(expected), expected, 'redact is idempotent');
  });
}

test('redact leaves ordinary text alone', () => {
  for (const text of [
    'autologger-mcp call list_events exited 1: not signed in; run login',
    'Signature: `99abeb0274f0` (plugin-advisor)',
    'DEV_PORT=8787 make dev-up failed at /home/user/autologger-2/Makefile:12',
    'the token expired and the user had to sign in again',
    'see https://code.claude.com/docs/en/hooks for the hook format',
    'autologger-specs-with-code-checker-and-friends',
  ]) {
    assert.equal(redact(text), text, text);
  }
});

test('cap cuts to the limit with an ellipsis', () => {
  assert.equal(cap('abc', 3), 'abc');
  assert.equal(cap('abcd', 3), 'ab…');
  assert.equal([...cap('x'.repeat(500), 10)].length, 10);
});

test('summaries are redacted, made one line and capped', () => {
  const s = cleanSummary(`first\nsecond\t${'word '.repeat(100)} token=abc123`);
  assert.equal(s.includes('\n'), false);
  assert.equal([...s].length, SUMMARY_MAX);
  assert.ok(s.startsWith('first second word'));
  // Redaction runs before the cap, so a secret at the cut is never stored half-visible.
  const long = cleanSummary(`${'a '.repeat(95)}Bearer abcdefghijklmnopqrstuvwxyz0123456789`);
  assert.ok(!long.includes('abcdefgh'), long);
});

test('details keep newlines, are redacted and capped', () => {
  const d = cleanDetail('line one\r\nline two password=hunter22\u0007');
  assert.equal(d, `line one\nline two password=${R}`);
  assert.equal([...cleanDetail('y'.repeat(DETAIL_MAX * 2))].length, DETAIL_MAX);
});

test('normalise masks case, numbers, paths, URLs, hex and ids', () => {
  assert.equal(normalise('Call list_events failed for session 98 at /home/u/y.json'), 'call list_events failed for session <n> at <path>');
  assert.equal(normalise('call list_events failed for session 7 at ./rel/path.'), 'call list_events failed for session <n> at <path>');
  assert.equal(normalise('fetch https://localhost:8787/mcp?x=1 failed'), 'fetch <url> failed');
  assert.equal(normalise('commit 3f9a2b7c not found'), 'commit <hex> not found');
  assert.equal(normalise('session ses_8f3k2a missing'), 'session <id> missing');
  assert.equal(normalise('mail ada@example.com bounced'), 'mail <email> bounced');
  assert.equal(normalise('  many   spaces  '), 'many spaces');
  assert.equal(normalise('request req-123e4567-e89b-12d3-a456-426614174000 timed out'), normalise('request req-00000000-1111-2222-3333-444444444444 timed out'));
});

test('signature is stable across wording noise and differs by plugin, kind and words', () => {
  const a = signature('autologger-mcp', 'workaround', 'Call list_events failed for session 98 at /home/u/y.json');
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(signature('autologger-mcp', 'workaround', 'call list_events failed for session 7 at /tmp/z'), a);
  assert.equal(signature('autologger-mcp', 'workaround', 'call LIST_EVENTS failed for session 7 at /tmp/z.'), a);
  assert.notEqual(signature('autologger-dev', 'workaround', 'call list_events failed for session 7 at /tmp/z'), a);
  assert.notEqual(signature('autologger-mcp', 'manual-step', 'call list_events failed for session 7 at /tmp/z'), a);
  assert.notEqual(signature('autologger-mcp', 'workaround', 'call list_topics failed for session 7 at /tmp/z'), a);
  // Different secrets in the same place count as one issue.
  assert.equal(signature('p', 'workaround', 'login with Bearer abcdefghij1234567890'), signature('p', 'workaround', 'login with Bearer zyxwvutsrq0987654321'));
});
