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
  // Follow-up 012 #4: any Authorization scheme, short cookie values, session keys, -p values.
  ['Authorization: Token (follow-up repro)', 'Authorization: Token abc123xyz', `Authorization: ${R}`],
  ['Authorization, any scheme, to the end of the line', 'sent authorization: Digest username="ada", nonce="x1"\nnext line', `sent authorization: ${R}\nnext line`],
  ['Authorization: Bearer with a short token', 'Authorization: Bearer abc', `Authorization: ${R}`],
  ['Proxy-Authorization', 'Proxy-Authorization: Negotiate YII', `Proxy-Authorization: ${R}`],
  ['Cookie: session=<short value> (follow-up repro)', 'Cookie: session=ab1', `Cookie: session=${R}`],
  ['every cookie value in a Cookie header', 'Cookie: a=1; theme=x; autologger_sid=z', `Cookie: a=${R}; theme=${R}; autologger_sid=${R}`],
  ['Set-Cookie keeps attributes', 'Set-Cookie: sid2=q; Path=/; HttpOnly; Secure', `Set-Cookie: sid2=${R}; Path=/; HttpOnly; Secure`],
  ['session key', 'login set session=k9 and DEV_PORT=1', `login set session=${R} and DEV_PORT=1`],
  ['session key in JSON', '{"session": "x"}', `{"session": "${R}"}`],
  ['dotted session key', 'flask.session: ab', `flask.session: ${R}`],
  ['short secret key value', 'retry with token=a', `retry with token=${R}`],
  ['-p value (follow-up repro)', 'mysql -u root -p hunter2 db', `mysql -u root -p ${R} db`],
  ['-p attached value', 'ran mysql -pab', `ran mysql -p${R}`],
  ['-p quoted value', "mysql -p'a b' x", `mysql -p'${R}' x`],
  ['--password value', 'login --password x', `login --password ${R}`],
  ['--password=value', 'login --password=x', `login --password=${R}`],
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

test('git SHAs and UUIDs: short SHAs are kept; full 40-character SHAs and UUIDs are redacted, as before', () => {
  assert.equal(redact('commit 3f9a2b7 broke it'), 'commit 3f9a2b7 broke it');
  assert.equal(redact('commit 3f9a2b7c4d5e6f708192a3b4c5d6e7f8091a2b3c broke it'), `commit ${R} broke it`);
  assert.equal(redact('id 123e4567-e89b-12d3-a456-426614174000 missing'), `id ${R} missing`);
});

test('a -p with no value, or followed by another flag, is left alone', () => {
  for (const text of ['ran it with -p', 'ran it with -p -v', 'a-p b']) assert.equal(redact(text), text, text);
});

test('the word Authorization in prose, with no colon, is left alone', () => {
  assert.equal(redact('see the Authorization header'), 'see the Authorization header');
});

// Review 1: a draft appends text to a redacted line (the Factory request ends `...". plugin-advisor
// signature <sig>.`, evidence gets ` (command ..., exit 1, ...)`), and file re-checks it with redact.
// A header value that starts with the marker must count as redacted, or file refuses a clean draft.
const APPENDED = [' (exit 1)', '". plugin-advisor signature 0123456789ab.', ' (command curl -H a=1; ls, exit 1, recorded by the hook)', ' then 401'];

test('redacted text stays clean with more text appended on the same line', () => {
  for (const [name, input] of SECRETS) {
    for (const suffix of APPENDED) {
      const text = redact(input) + suffix;
      assert.equal(containsSecret(text), false, `${name}: ${JSON.stringify(text)} -> ${JSON.stringify(redact(text))}`);
    }
  }
});

test('a multi-line summary with a header is clean once joined onto one line', () => {
  for (const input of ['a\nAuthorization: Token x\nb', 'curl failed\nAuthorization: Token abc123xyz\nstatus 401', 'Cookie: session=ab1\nthen 403', 'Set-Cookie: a=b; Secure\nthen; c=d']) {
    const out = cleanSummary(input);
    assert.equal(containsSecret(out), false, `${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
  }
  assert.equal(cleanSummary('a\nAuthorization: Token x\nb'), `a Authorization: ${R} b`);
});

test('a cookie part that only starts with an attribute name is still redacted', () => {
  // Attributes keep their value only when the name is the whole attribute, until a marker has been seen.
  assert.equal(redact('Cookie: path abc=s3; theme=x'), redact(redact('Cookie: path abc=s3; theme=x')));
  assert.ok(!redact('Cookie: path abc=s3').includes('s3'));
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

test('cap never cuts inside a [redacted] marker', () => {
  const text = `abc ${R} def`;
  for (let max = 1; max <= text.length + 1; max++) {
    const out = cap(text, max);
    assert.ok([...out].length <= max, `${max}: ${out}`);
    const rest = out.endsWith('…') ? out.slice(0, -1) : out;
    assert.ok(!/\[[a-z]*$/.test(rest) || rest.endsWith(R), `${max}: ${out}`);
    for (let i = 1; i < R.length; i++) assert.ok(!(rest.endsWith(R.slice(0, i)) && !rest.endsWith(R)), `${max}: ${out}`);
  }
});

// Follow-up 012 #5: a cap after redaction could leave 'token=[r…' or 'token=…', which redact rewrites,
// so file refused a draft that held no secret.
const TAILS = [
  'token=abc1',
  'password=hunter22',
  'session=k9',
  'Authorization: Token abc123xyz',
  'Cookie: session=ab1; theme=x',
  '-p hunter2',
  '--password x',
  'api_key: "s3cr3t value"',
  'and Bearer abcdefghijklmnop',
  // Header tails with more words after them (review 1).
  'Authorization: Token abc123xyz then 401 again',
  'Cookie: session=ab1 then 403 again',
  'Set-Cookie: a=b; Path=/; Secure then it failed',
];

test('cleanSummary output never looks secret, for every length from 150 to 260 characters', () => {
  for (const tail of TAILS) {
    for (let length = 150; length <= 260; length++) {
      for (const word of ['x', 'word', 'a-b']) {
        let prefix = '';
        while (prefix.length + tail.length + 1 < length) prefix += `${word} `;
        const input = `${prefix}${tail}`.slice(-length);
        const out = cleanSummary(input);
        assert.equal(containsSecret(out), false, `${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
        assert.ok([...out].length <= SUMMARY_MAX, out);
        assert.equal(/\[r[a-z]*…$/.test(out), false, `cut marker: ${out}`);
      }
    }
  }
});

test('cap leaves text that already looks secret to the caller (it never redacts)', () => {
  assert.equal(cap('token=abc and more words', 10), 'token=abc…');
});
