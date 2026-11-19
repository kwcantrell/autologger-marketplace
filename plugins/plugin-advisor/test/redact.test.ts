import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cap, cleanDetail, cleanSummary, containsSecret, DETAIL_MAX, normalise, redact, signature, SUMMARY_MAX } from '../src/redact.ts';

const R = '[redacted]';

const SECRETS: Array<[string, string, string]> = [
  ['bearer token', 'Authorization header was Bearer abcDEF123456ghiJKL789', `Authorization header was Bearer ${R}`],
  ['alm_ access token', 'stored alm_Zx81kPq0rT5vW2yB in the file', `stored ${R} in the file`],
  ['alr_ refresh token', 'refresh with alr_9q8w7e6r5t4y and retry', `refresh with ${R} and retry`],
  // A request Cookie: header has no attributes (job 024), so `Path` there is a cookie like any other.
  ['autologger_sid cookie', 'Cookie: autologger_sid=s%3Aabc.def123; Path=/', `Cookie: autologger_sid=${R}; Path=${R}`],
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
  // A secret key=value that is itself the value of an ordinary key.
  ['secret pair after an ordinary key', 'login failed: password=hunter2', `login failed: password=${R}`],
  ['secret pair after an ordinary key=', 'error=token=abc', `error=token=${R}`],
  // Review 2: a header that ends in `;`.
  ['Cookie ending in ;', 'login fails, Cookie: session=ab1;', `login fails, Cookie: session=${R};`],
  ['Set-Cookie ending in ;', 'Set-Cookie: a=b; Path=/;', `Set-Cookie: a=${R}; Path=/;`],
  // Job 024 (follow-up 017 #1): -p is a password only after mysql and similar commands, in every form.
  ['mysql -p value', 'mysql -p secret', `mysql -p ${R}`],
  ['mysql -pvalue', 'mysql -psecret', `mysql -p${R}`],
  ['mysqldump -p=value', 'mysqldump -p=secret', `mysqldump -p=${R}`],
  ['mysqldump -p value', 'mysqldump -u root -p secret db', `mysqldump -u root -p ${R} db`],
  ['mariadb -pvalue', 'mariadb -psecret', `mariadb -p${R}`],
  ['mariadb-dump -p=value', 'mariadb-dump -p=secret', `mariadb-dump -p=${R}`],
  ['mysqladmin -p value', 'mysqladmin -u root -p secret status', `mysqladmin -u root -p ${R} status`],
  ['mysql by path, any case', '/usr/bin/MySQL --host db -p"a b"', `/usr/bin/MySQL --host db -p"${R}"`],
  ['every -p in one mysql command', 'mysql -pone -p two', `mysql -p${R} -p ${R}`],
  // Round 1: other tools whose -p takes a password.
  ['sshpass -p', 'sshpass -p hunter2 ssh host', `sshpass -p ${R} ssh host`],
  ['mongosh -p', 'mongosh -u admin -p hunter2', `mongosh -u admin -p ${R}`],
  ['mongo -p', 'mongo -u admin -phunter2 db', `mongo -u admin -p${R} db`],
  ['mongodump -p', 'mongodump -u a -p hunter2 --db x', `mongodump -u a -p ${R} --db x`],
  ['mongorestore -p', 'mongorestore -u a -p=hunter2 dump/', `mongorestore -u a -p=${R} dump/`],
  ['mongoexport -p', 'mongoexport -u a -p hunter2 -c c', `mongoexport -u a -p ${R} -c c`],
  ['mongoimport -p', 'mongoimport -u a -p hunter2 -c c', `mongoimport -u a -p ${R} -c c`],
  ['mongostat -p', 'mongostat -u a -p hunter2', `mongostat -u a -p ${R}`],
  ['mongotop -p', 'mongotop -u a -p hunter2', `mongotop -u a -p ${R}`],
  ['mongofiles -p', 'mongofiles -u a -p hunter2 list', `mongofiles -u a -p ${R} list`],
  ['mysqlsh -p', 'mysqlsh -u root -phunter2', `mysqlsh -u root -p${R}`],
  ['mysqlimport -p', 'mysqlimport -u root -phunter2 db f.txt', `mysqlimport -u root -p${R} db f.txt`],
  ['mysqlcheck -p', 'mysqlcheck -u root -phunter2 db', `mysqlcheck -u root -p${R} db`],
  ['mysqlshow -p', 'mysqlshow -u root -phunter2', `mysqlshow -u root -p${R}`],
  ['mysqlslap -p', 'mysqlslap -u root -phunter2', `mysqlslap -u root -p${R}`],
  ['mysqlpump -p', 'mysqlpump -u root -phunter2', `mysqlpump -u root -p${R}`],
  ['mysqlbinlog -p', 'mysqlbinlog -u root -phunter2 log.1', `mysqlbinlog -u root -p${R} log.1`],
  ['mysql_upgrade -p', 'mysql_upgrade -u root -phunter2', `mysql_upgrade -u root -p${R}`],
  ['mysql_secure_installation -p', 'mysql_secure_installation -u root -phunter2', `mysql_secure_installation -u root -p${R}`],
  ['mariadb-admin -p', 'mariadb-admin -u root -phunter2 status', `mariadb-admin -u root -p${R} status`],
  ['mariadb-import -p', 'mariadb-import -u root -phunter2 db f', `mariadb-import -u root -p${R} db f`],
  ['mariadb-check -p', 'mariadb-check -u root -phunter2 db', `mariadb-check -u root -p${R} db`],
  ['mariadb-show -p', 'mariadb-show -u root -phunter2', `mariadb-show -u root -p${R}`],
  ['mariadb-slap -p', 'mariadb-slap -u root -phunter2', `mariadb-slap -u root -p${R}`],
  ['mariadb-binlog -p', 'mariadb-binlog -u root -phunter2 log.1', `mariadb-binlog -u root -p${R} log.1`],
  ['mariadb-upgrade -p', 'mariadb-upgrade -u root -phunter2', `mariadb-upgrade -u root -p${R}`],
  ['mariadb-secure-installation -p', 'mariadb-secure-installation -u root -phunter2', `mariadb-secure-installation -u root -p${R}`],
  ['cqlsh -p', 'cqlsh -u cassandra -p hunter2 host', `cqlsh -u cassandra -p ${R} host`],
  ['rabbitmqadmin -p', 'rabbitmqadmin -u admin -p hunter2 list queues', `rabbitmqadmin -u admin -p ${R} list queues`],
  ['rdesktop -p', 'rdesktop -u ada -p hunter2 host', `rdesktop -u ada -p ${R} host`],
  ['7z -p', '7z x -phunter2 a.7z', `7z x -p${R} a.7z`],
  ['7za -p', '7za a -phunter2 a.7z f', `7za a -p${R} a.7z f`],
  ['7zr -p', '7zr x -phunter2 a.7z', `7zr x -p${R} a.7z`],
  ['rar -p', 'rar a -phunter2 a.rar f', `rar a -p${R} a.rar f`],
  ['unrar -p', 'unrar x -phunter2 a.rar', `unrar x -p${R} a.rar`],
  // Round 1: a command continued with a backslash is one command, also in details (newlines kept).
  ['mysql continued with \\ onto a -p line', 'mysql -u root \\\n  -p s3cret db', `mysql -u root \\\n  -p ${R} db`],
  ['mysql continued with \\ (CRLF)', 'mysql -u root \\\r\n  -ps3cret db', `mysql -u root \\\r\n  -p${R} db`],
  ['sshpass continued over two lines', 'sshpass \\\n -p s3cret \\\n ssh host', `sshpass \\\n -p ${R} \\\n ssh host`],
  ['mysql -p after a quoted ; in the same command', "mysql -e 'select 1; select 2' -psecret", `mysql -e 'select 1; select 2' -p${R}`],
  ['mysql -p after another command on the line', 'cd /x && mysql -psecret', `cd /x && mysql -p${R}`],
  ['--password after any command', 'psql --password secret', `psql --password ${R}`],
  ['--password= after any command', 'ssh --password=secret', `ssh --password=${R}`],
  // Job 024 (follow-up 017 #2): the authorization= form, any casing, to the end of the line or the closing quote.
  ['authorization=Token', 'authorization=Token abc123', `authorization=${R}`],
  ['AUTHORIZATION=Bearer with a short token', 'AUTHORIZATION=Bearer xyz', `AUTHORIZATION=${R}`],
  ['Authorization=, mixed case, to the end of the line', 'sent Authorization=Digest u="a", n=1\nnext line', `sent Authorization=${R}\nnext line`],
  ['proxy-authorization=', 'proxy-authorization=Negotiate YII', `proxy-authorization=${R}`],
  ['PROXY-AUTHORIZATION=', 'PROXY-AUTHORIZATION=Basic Zm9v', `PROXY-AUTHORIZATION=${R}`],
  ['authorization= with spaces around =', 'authorization = Token abc', `authorization = ${R}`],
  ['authorization= double-quoted, to the closing quote', 'curl -d "authorization=Token abc" then 401', `curl -d "authorization=${R}" then 401`],
  ['authorization= value in double quotes', 'authorization="Token abc" then 401', `authorization="${R}" then 401`],
  ["authorization= value in single quotes", "authorization='Token abc' then 401", `authorization='${R}' then 401`],
  ['authorization= single-quoted pair, to the closing quote', "curl -d 'Authorization=Token abc' x", `curl -d 'Authorization=${R}' x`],
  ['HTTP_AUTHORIZATION=', 'env HTTP_AUTHORIZATION=Token abc', `env HTTP_AUTHORIZATION=${R}`],
  // Job 024 (follow-up 017 #2): attribute names keep their values only in Set-Cookie.
  ['Cookie: attribute-named cookies are cookies', 'Cookie: a=b; path=s3cret', `Cookie: a=${R}; path=${R}`],
  ['Cookie: every attribute name', 'Cookie: Domain=s1; Expires=s2; Max-Age=s3; SameSite=s4; Secure; HttpOnly', `Cookie: Domain=${R}; Expires=${R}; Max-Age=${R}; SameSite=${R}; ${R}; ${R}`],
  ['Set-Cookie keeps every attribute', 'Set-Cookie: id=s3cret; Path=/; Domain=x.example; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Max-Age=60; Secure; HttpOnly; SameSite=Lax', `Set-Cookie: id=${R}; Path=/; Domain=x.example; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Max-Age=60; Secure; HttpOnly; SameSite=Lax`],
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

test('-p outside mysql and similar commands is left alone (job 024)', () => {
  for (const text of [
    'mkdir -p /x/y',
    'ssh -p 2222 host',
    'docker run -p 8080:80 img',
    'psql -p 5433',
    'gcc -pthread',
    'find . -print',
    'git log -p HEAD',
    'mysql failed; ssh -p 2222 host',
    'mysql failed\nmkdir -p /x/y',
    // A newline without a backslash ends the command.
    'mysql -u root\n-p 5433 is a port',
    'redis-cli -p 6380 ping',
    'mysql_config -p x',
  ]) {
    assert.equal(redact(text), text, text);
    assert.equal(containsSecret(text), false, text);
  }
});

test('a backslash-continued mysql command keeps no password in details (round 1)', () => {
  for (const input of ['mysql -u root \\\n  -p s3cret db', 'mysql -u r \\\n -p s3cret', 'mysqldump \\\n  -u root \\\n  -ps3cret db', 'mongosh \\\n -u a \\\n -p s3cret']) {
    const out = cleanDetail(input);
    assert.ok(!out.includes('s3cret'), `${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    assert.ok(out.includes('\n'), 'details keep their newlines');
    assert.equal(containsSecret(input), true, input);
    assert.equal(containsSecret(out), false, out);
  }
});

test('a -p with no value, or followed by another flag, is left alone', () => {
  for (const text of ['ran it with -p', 'ran it with -p -v', 'a-p b']) assert.equal(redact(text), text, text);
});

test('authorization= keeps no token, whatever its length (job 024)', () => {
  for (const [input, token] of [
    ['authorization=Token abc123', 'abc123'],
    ['AUTHORIZATION=Bearer xyz', 'xyz'],
    ['Authorization=Token a', ' a'],
    [`authorization=Token ${'k'.repeat(300)}`, 'kkk'],
    ['aUtHoRiZaTiOn=Basic q', ' q'],
    ['Proxy-Authorization=Bearer t0', 't0'],
  ] as const) {
    const out = redact(input);
    assert.ok(!out.includes(token), `${input} -> ${out}`);
    assert.equal(containsSecret(out), false, out);
  }
  for (const text of ['authorization=', 'authorization=[redacted]']) assert.equal(redact(text), text, text);
});

test('the redaction scan is linear: 20000 a= segments return in under 1 s (job 024)', () => {
  const input = `${'a='.repeat(20000)}x`;
  const start = performance.now();
  const out = redact(input);
  const ms = performance.now() - start;
  assert.equal(typeof out, 'string');
  assert.ok(ms < 1000, `${ms} ms`);
  assert.doesNotThrow(() => cleanSummary(input));
  assert.doesNotThrow(() => cleanDetail(`${'a: '.repeat(20000)}x`));
  // A secret pair deep in a chain of ordinary pairs is still found.
  assert.equal(redact(`${'a='.repeat(20000)}password=x`), `${'a='.repeat(20000)}password=${R}`);
});

test('the word Authorization in prose, with no colon, is left alone', () => {
  assert.equal(redact('see the Authorization header'), 'see the Authorization header');
});

// Review 1 and 2: a draft appends text to a redacted line, and file used to re-run redact over that
// line. Now file checks each stored field on its own instead (file.test.ts covers drafts end to end),
// so redact no longer treats a value that merely starts with the marker as redacted.
test('a typed [redacted] shields nothing after it', () => {
  for (const [input, secret] of [
    ['Cookie: a=[redacted] x; b=realsecret', 'realsecret'],
    ['Cookie: [redacted]; b=realsecret', 'realsecret'],
    ['Set-Cookie: a=[redacted]; b=realsecret; Path=/', 'realsecret'],
    ['Authorization: [redacted] abc123', 'abc123'],
    ['Proxy-Authorization: [redacted]x', ']x'],
    ['token=[redacted]realsecret', 'realsecret'],
    ['password="[redacted] realsecret"', 'realsecret'],
    ['autologger_sid=[redacted]realsecret', 'realsecret'],
    ['--password [redacted]realsecret', 'realsecret'],
    ['mysql -p [redacted]realsecret', 'realsecret'],
  ] as const) {
    assert.equal(containsSecret(input), true, input);
    const out = redact(input);
    assert.ok(!out.includes(secret), `${input} -> ${out}`);
    assert.equal(containsSecret(out), false, `${input} -> ${out}`);
  }
});

test('a multi-line summary with a header is clean once joined onto one line', () => {
  for (const input of [
    'a\nAuthorization: Token x\nb',
    'curl failed\nAuthorization: Token abc123xyz\nstatus 401',
    'Cookie: session=ab1\nthen 403',
    'Set-Cookie: a=b; Secure\nthen; c=d',
    // Review 2.
    'Cookie: a=b;\nthen 403',
    'Set-Cookie: a=b; Path=/;\nthen 403',
    'Cookie: a=b\n; x',
  ]) {
    const out = cleanSummary(input);
    assert.equal(containsSecret(out), false, `${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    assert.equal(redact(out), out, `${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
  }
  // The header's value runs to the end of the joined line, so what followed it is redacted with it.
  assert.equal(cleanSummary('a\nAuthorization: Token x\nb'), `a Authorization: ${R}`);
  assert.equal(cleanSummary('Cookie: a=b;\nthen 403'), `Cookie: a=${R}; ${R}`);
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
  // Quoted JSON tails (review 2): a cut must not leave `"api_key": "…` either.
  '"api_key": "k1" more',
  '"session": "abc"',
  'token="abc1" more',
  "password='x' more",
  // Job 024.
  'mysql -p hunter2',
  'mysql -u root -phunter2 db',
  'authorization=Token abc then more words',
  'Cookie: a=b; path=s3cret then more',
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
        // A cut leaves no dangling fragment, also once quoted (as the draft's Factory request line does).
        if (out.endsWith('…')) assert.equal(containsSecret(`"${out}"`), false, `quoted: ${JSON.stringify(out)}`);
        assert.ok([...out].length <= SUMMARY_MAX, out);
        assert.equal(/\[r[a-z]*…$/.test(out), false, `cut marker: ${out}`);
      }
    }
  }
});

test('cap leaves text that already looks secret to the caller (it never redacts)', () => {
  assert.equal(cap('token=abc and more words', 10), 'token=abc…');
});

// Job 030 (follow-up 024 #1): no rule starts a scan at every character of a long run.
function timed(f: () => unknown): number {
  const start = performance.now();
  f();
  return performance.now() - start;
}

test('redact is linear on long runs: 40000 characters return in under 200 ms (job 030)', () => {
  for (const input of ['a'.repeat(40000), '-'.repeat(40000), 'A1_'.repeat(15000)]) {
    const ms = timed(() => redact(input));
    assert.ok(ms < 200, `${JSON.stringify(input.slice(0, 6))}x${input.length}: ${ms} ms`);
  }
});

test('redact stays fast on other long runs that used to rescan (job 030)', () => {
  for (const input of [
    'a.'.repeat(20000),
    'a-'.repeat(20000),
    '1-'.repeat(20000),
    'eyJ-'.repeat(10000),
    `${'x'.repeat(40000)}=`,
    `--${'a'.repeat(40000)}`,
    'Authorization'.repeat(3000),
    `${'a'.repeat(40000)}://`,
    // Round 1: a quoted key may start at any quote, so runs of quotes and key characters stay linear too.
    `x"${'a'.repeat(40000)}`,
    '"a'.repeat(20000),
    "b'a".repeat(13000),
    `"${'a'.repeat(40000)}"\u00a0`,
  ]) {
    const ms = timed(() => redact(input));
    assert.ok(ms < 200, `${JSON.stringify(input.slice(0, 6))}x${input.length}: ${ms} ms`);
  }
});

/** Deterministic pseudo-random text, so the timing test is the same on every run. */
function mixed(bytes: number): string {
  let seed = 30;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const pick = (chars: string, n: number): string => Array.from({ length: n }, () => chars[rand(chars.length)]).join('');
  const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const b64url = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const ident = (): string => pick('abcdefghijklmnopqrstuvwxyz_', 1 + rand(6));
  const parts: string[] = [];
  let size = 0;
  while (size < bytes) {
    const part = [
      () => `${pick('abcdefghij klmnop qrstuvwxyz,.:=-_"\'', 400)}\n`,
      () => `${pick(b64, 2000)}==\n`,
      () => `${pick(b64url, 2000)}\n`,
      // A minified line: long member chains with no space, then a call.
      () => `${Array.from({ length: 600 }, ident).join('.')}(a,b);var c=a.token||b;`,
      () => `error: key=value a.b.c-d_e:f --flag-x y -p 1 mysql -u u \\ \n`,
    ][rand(5)]!();
    parts.push(part);
    size += part.length;
  }
  return parts.join('').slice(0, bytes);
}

test('cleanSummary and cleanDetail take under 500 ms on 64 KB of mixed text (job 030)', () => {
  const input = mixed(64 * 1024);
  assert.equal(input.length, 64 * 1024);
  const summary = timed(() => cleanSummary(input));
  const detail = timed(() => cleanDetail(input));
  assert.ok(summary < 500, `cleanSummary: ${summary} ms`);
  assert.ok(detail < 500, `cleanDetail: ${detail} ms`);
});

// Job 030 (follow-up 024 #2): the key=value separator stays on one line.
test('a key at the end of a line leaves the next line alone (job 030)', () => {
  assert.equal(redact('authorization=\nnext line'), 'authorization=\nnext line');
  assert.equal(redact('status:\ntoken'), 'status:\ntoken');
  assert.equal(redact('password=\nhunter2 was typed later'), 'password=\nhunter2 was typed later');
  assert.equal(redact('token:\r\nnext'), 'token:\r\nnext');
  // On one line, any spaces or tabs around the separator still count.
  assert.equal(redact('token = abc'), `token = ${R}`);
  assert.equal(redact('password:\tabc'), `password:\t${R}`);
  assert.equal(redact('api_key \t=\t abc'), `api_key \t=\t ${R}`);
});

// Job 030 (follow-up 024 #4): every key that ends in authorization, with `:` as with `=`.
const COLON_AUTHORIZATION: Array<[string, string, string]> = [
  ['HTTP_AUTHORIZATION: Token', 'HTTP_AUTHORIZATION: Token abc', `HTTP_AUTHORIZATION: ${R}`],
  ['x_authorization:Token', 'x_authorization:Token abc', `x_authorization:${R}`],
  ['Proxy-Authorization: Basic', 'Proxy-Authorization: Basic xyz', `Proxy-Authorization: ${R}`],
  ['X-Authorization: Token', 'sent X-Authorization: Token abc', `sent X-Authorization: ${R}`],
  ['authorization: lower case', 'authorization: Token abc', `authorization: ${R}`],
  ['HTTP_PROXY_AUTHORIZATION:', 'HTTP_PROXY_AUTHORIZATION:Basic xyz', `HTTP_PROXY_AUTHORIZATION:${R}`],
  ['aUtHoRiZaTiOn: any casing', 'my.aUtHoRiZaTiOn :  Token abc', `my.aUtHoRiZaTiOn :  ${R}`],
  ['to the end of the line', 'HTTP_AUTHORIZATION: Token abc def\nnext line', `HTTP_AUTHORIZATION: ${R}\nnext line`],
  ['double-quoted pair, to the closing quote', 'curl -H "Authorization: Token abc" https://x.example', `curl -H "Authorization: ${R}" https://x.example`],
  ['single-quoted pair, to the closing quote', "curl -H 'x_authorization: Token abc' x", `curl -H 'x_authorization: ${R}' x`],
  ['double-quoted value', 'HTTP_AUTHORIZATION: "Token abc" then 401', `HTTP_AUTHORIZATION: "${R}" then 401`],
];

for (const [name, input, expected] of COLON_AUTHORIZATION) {
  test(`redact colon-form authorization: ${name} (job 030)`, () => {
    assert.equal(redact(input), expected);
    assert.equal(containsSecret(input), true);
    assert.equal(containsSecret(expected), false);
    assert.equal(redact(expected), expected);
    for (const word of ['Token', 'Basic', 'abc', 'xyz']) {
      if (!expected.includes(word)) assert.ok(!redact(input).includes(word), `${input} keeps ${word}`);
    }
  });
}

// Job 030 (follow-up 024 #5): continuation with trailing blanks, and versioned tool names.
const CONTINUED_AND_VERSIONED: Array<[string, string, string]> = [
  ['\\ with trailing spaces continues', 'mysql -u root \\  \n  -p s3cret db', `mysql -u root \\  \n  -p ${R} db`],
  ['\\ with a trailing tab continues', 'mysql -u root \\\t\n-ps3cret db', `mysql -u root \\\t\n-p${R} db`],
  ['\\ with trailing blanks and CRLF continues', 'sshpass \\ \t \r\n -p s3cret ssh host', `sshpass \\ \t \r\n -p ${R} ssh host`],
  ['mysql5.7', 'mysql5.7 -u root -p s3cret db', `mysql5.7 -u root -p ${R} db`],
  ['mysql8', 'mysql8 -ps3cret', `mysql8 -p${R}`],
  ['mariadb10.11', 'mariadb10.11 -u root -p=s3cret', `mariadb10.11 -u root -p=${R}`],
  ['mongosh2', 'mongosh2 -u a -p s3cret', `mongosh2 -u a -p ${R}`],
  ['versioned name by path', '/opt/bin/mysql8.0.33 -ps3cret', `/opt/bin/mysql8.0.33 -p${R}`],
];

for (const [name, input, expected] of CONTINUED_AND_VERSIONED) {
  test(`redact password command: ${name} (job 030)`, () => {
    assert.equal(redact(input), expected);
    assert.equal(containsSecret(input), true);
    assert.equal(containsSecret(expected), false);
    assert.ok(!cleanDetail(input).includes('s3cret'), cleanDetail(input));
    assert.ok(!cleanSummary(input).includes('s3cret'), cleanSummary(input));
  });
}

test('cleanDetail keeps no password after a \\ with trailing spaces (job 030)', () => {
  const out = cleanDetail('mysql -u root \\  \n  -p s3cret db');
  assert.ok(!out.includes('s3cret'), out);
  assert.ok(out.includes('\n'), out);
});

test('job 024 unchanged cases, versioned look-alikes and redis-cli stay unchanged (job 030)', () => {
  for (const text of [
    'mkdir -p /x/y',
    'ssh -p 2222 host',
    'docker run -p 8080:80 img',
    'psql -p 5433',
    'gcc -pthread',
    'find . -print',
    'redis-cli -p 6380',
    'mysql_config -p x',
    'mysql-workbench -p x',
    'mysql -u root\n-p 5433 is a port',
    // A backslash not at the end of the line does not continue the command.
    'mysql -u root \\ x\n-p 5433 is a port',
  ]) {
    assert.equal(redact(text), text, text);
    assert.equal(containsSecret(text), false, text);
  }
});

// Job 030 round 1 (behavior review, blocking; follow-up 030 #2): a quoted key starts at its quote,
// whatever comes before it, and a quoted value may carry a string prefix (Python b'...', u'...').
// Round 1 (security review, blocking): the same-line separator takes Unicode spaces, as `\s` did.
const ROUND_1: Array<[string, string, string, string]> = [
  ["Python bytes key", "{b'token': 'hunter2'}", `{b'token': '${R}'}`, 'hunter2'],
  ["Python unicode key", "{u'api_key': 'hunter2abc'}", `{u'api_key': '${R}'}`, 'hunter2abc'],
  ["Python bytes authorization key", "{b'authorization': 'Token abc'}", `{b'authorization': '${R}'}`, 'abc'],
  ['quoted key after a letter', 'x"token": "abc123"', `x"token": "${R}"`, 'abc123'],
  ['quoted key after a letter, = form', 'x"password"=secret', `x"password"=${R}`, 'secret'],
  ['quoted key after a digit', '0"token":"abc"', `0"token":"${R}"`, 'abc'],
  ['raw-string key', 'r"token": "x1"', `r"token": "${R}"`, 'x1'],
  ['Python bytes key and value', "{b'token': b'abc123'}", `{b'token': b'${R}'}`, 'abc123'],
  ['Python unicode key and value', "{u'password': u'hunter2'}", `{u'password': u'${R}'}`, 'hunter2'],
  ['Python bytes value, double quotes', '{"token": b"abc123"}', `{"token": b"${R}"}`, 'abc123'],
  ['NBSP around =', 'error: token = abc123 rejected', `error: token = ${R} rejected`, 'abc123'],
  ['narrow NBSP before :', 'password : hunter2', `password : ${R}`, 'hunter2'],
  ['en quad after =', 'api_key= k3y', `api_key= ${R}`, 'k3y'],
  ['hair space after :', 'secret: s3', `secret: ${R}`, 's3'],
  ['ideographic space around =', 'token　=　abc', `token　=　${R}`, 'abc'],
  ['NBSP after Authorization:', 'Authorization: Token abc', `Authorization: ${R}`, 'abc'],
  ['NBSP after HTTP_AUTHORIZATION=', 'HTTP_AUTHORIZATION= Token abc', `HTTP_AUTHORIZATION= ${R}`, 'abc'],
];

for (const [name, input, expected, secret] of ROUND_1) {
  test(`redact round 1: ${name} (job 030)`, () => {
    assert.equal(redact(input), expected);
    assert.equal(containsSecret(input), true);
    assert.equal(containsSecret(expected), false);
    assert.equal(redact(expected), expected);
    const detail = cleanDetail(input);
    assert.equal(detail, expected);
    assert.equal(containsSecret(detail), false, detail);
    assert.ok(!cleanSummary(input).includes(secret), cleanSummary(input));
  });
}

test('round 1: a Unicode line separator still ends the line for a key=value separator (job 030)', () => {
  assert.equal(redact('token= next'), 'token= next');
  assert.equal(redact('password: next'), 'password: next');
});

// Job 034 (follow-up 030 #1): JSON logged inside a JSON string, its quotes escaped once or more.
const ESCAPED_JSON: Array<[string, string, string, string]> = [
  ['escaped password', String.raw`{\"password\": \"hunter2\"}`, String.raw`{\"password\": \"${R}\"}`, 'hunter2'],
  ['escaped token, no space', String.raw`{\"token\":\"abc123\"}`, String.raw`{\"token\":\"${R}\"}`, 'abc123'],
  ['double-escaped api_key', String.raw`"{\\\"api_key\\\": \\\"xyz\\\"}"`, String.raw`"{\\\"api_key\\\": \\\"${R}\\\"}"`, 'xyz'],
  ['escaped api_key in a JSON string', String.raw`"{\"api_key\": \"xyz\"}"`, String.raw`"{\"api_key\": \"${R}\"}"`, 'xyz'],
  ['escaped authorization', String.raw`{\"authorization\": \"Bearer abc.def\"}`, String.raw`{\"authorization\": \"${R}\"}`, 'abc.def'],
  ['escaped body in a logged JSON field', String.raw`"body": "{\"password\": \"hunter2\"}"`, String.raw`"body": "{\"password\": \"${R}\"}"`, 'hunter2'],
];

for (const [name, input, expected, secret] of ESCAPED_JSON) {
  test(`redact escaped JSON: ${name} (job 034)`, () => {
    assert.equal(redact(input), expected);
    assert.equal(containsSecret(input), true);
    assert.equal(containsSecret(expected), false);
    assert.equal(redact(expected), expected);
    const detail = cleanDetail(input);
    assert.equal(detail, expected);
    assert.equal(containsSecret(detail), false, detail);
    assert.ok(!cleanSummary(input).includes(secret), cleanSummary(input));
  });
}

test('escaped JSON with an ordinary key is left unchanged (job 034)', () => {
  for (const text of [String.raw`{\"status\": \"ok\"}`, String.raw`"{\\\"status\\\": \\\"ok\\\"}"`, String.raw`{\"user\":\"ada\", \"n\": 3}`]) {
    assert.equal(redact(text), text, text);
    assert.equal(cleanDetail(text), text, text);
    assert.equal(containsSecret(text), false, text);
  }
});

// Job 034 (follow-up 030 #3): the --flag rule takes a flag run once, however often it holds the word.
const FLAG_RUNS = [(n: number) => '--token-'.repeat(n / 8), (n: number) => '--password-'.repeat(n / 11), (n: number) => '--secret-x'.repeat(n / 10)];

test('the --flag rule is linear: 64 KB runs of secret flag words return in under 200 ms (job 034)', () => {
  for (const input of ['--token-'.repeat(8192), '--password-'.repeat(6000), '--secret-x'.repeat(6500)]) {
    const ms = timed(() => redact(input));
    assert.ok(ms < 200, `${JSON.stringify(input.slice(0, 12))}x${input.length}: ${ms} ms`);
    const summary = timed(() => cleanSummary(input));
    const detail = timed(() => cleanDetail(input));
    assert.ok(summary < 600, `cleanSummary ${JSON.stringify(input.slice(0, 12))}: ${summary} ms`);
    assert.ok(detail < 600, `cleanDetail ${JSON.stringify(input.slice(0, 12))}: ${detail} ms`);
  }
});

test('the --flag rule time grows about linearly from 64 KB to 200 KB (job 034)', () => {
  for (const make of FLAG_RUNS) {
    const small = make(66000);
    const large = make(206250);
    const best = (input: string): number => Math.min(...[0, 1, 2].map(() => timed(() => redact(input))));
    best(small);
    const ratio = best(large) / Math.max(best(small), 1);
    // 3.1x the input: linear is about 3x, quadratic about 10x. The floor of 1 ms absorbs timer noise.
    assert.ok(ratio < 6, `${JSON.stringify(small.slice(0, 12))}: ${ratio.toFixed(1)}x for 3.1x the input`);
  }
});

test('flags redacted before are still redacted (job 034)', () => {
  const cases: Array<[string, string]> = [
    ['--token=x', `--token=${R}`],
    ['--token x', `--token ${R}`],
    ['--api-token=x', `--api-token=${R}`],
    ['--password x', `--password ${R}`],
    ['--client-secret=x', `--client-secret=${R}`],
    ['run --api-token "abc" now', `run --api-token "${R}" now`],
    ['x--token-token-token abc', `x--token-token-token ${R}`],
    // A flag with no secret word does not hide a secret flag in the word after it.
    ['--foo bar--token x', `--foo bar--token ${R}`],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redact(input), expected, input);
    assert.equal(containsSecret(expected), false, expected);
  }
  for (const text of ['--foo bar', '--token -x', 'token-x y']) assert.equal(redact(text), text, text);
});

// Job 034 (follow-up 030 #4): a password command after an authorization value on the same line,
// continued onto the next, is redacted before the authorization rule takes the rest of the line.
const AUTHORIZATION_THEN_PASSWORD: Array<[string, string, string]> = [
  ['Authorization: Token; mysql \\', 'Authorization: Token abc; mysql -u root \\\n-p s3cret db', `Authorization: ${R}\n-p ${R} db`],
  ['HTTP_AUTHORIZATION: Token; mysql \\', 'HTTP_AUTHORIZATION: Token abc; mysql \\\n -p s3cret', `HTTP_AUTHORIZATION: ${R}\n -p ${R}`],
  ['authorization=Bearer && mysqldump \\', 'authorization=Bearer x && mysqldump \\\n-ps3cret', `authorization=${R}\n-p${R}`],
];

for (const [name, input, expected] of AUTHORIZATION_THEN_PASSWORD) {
  test(`redact authorization then a password command: ${name} (job 034)`, () => {
    assert.equal(redact(input), expected);
    assert.equal(containsSecret(input), true);
    assert.equal(containsSecret(expected), false);
    for (const out of [redact(input), cleanDetail(input), cleanSummary(input)]) {
      for (const word of ['s3cret', 'abc', 'Token', 'Bearer']) assert.ok(!out.includes(word), `${JSON.stringify(out)} keeps ${word}`);
    }
  });
}

// Job 034: what the differential fuzz against the job 030 code turned up while this was built. Each
// of these lost its secret in a draft of this change and is redacted by the code before it.
test('a -p value read as a key or flag keeps its value redacted (job 034)', () => {
  const cases: Array<[string, string, Array<(text: string) => string>]> = [
    ['mysql -ptoken zq8m8w', 'zq8m8w', [redact, cleanDetail, cleanSummary]],
    ['Authorization: x; mysql \\\n-ptoken zq8m8w', 'zq8m8w', [redact, cleanDetail, cleanSummary]],
    ['Authorization: x; mysql \\\n-pAuthorization: zq3ank', 'zq3ank', [redact, cleanDetail, cleanSummary]],
    ['authorization=sshpass\\\n-p"mysql"-pzqhhvk', 'zqhhvk', [redact, cleanDetail, cleanSummary]],
    // A U+2028 ends the key's line: only the summary, which joins the lines, makes this a pair.
    ['"Authorization=\n"Authorization:mariadb\\\n-p[session:\u2028zq4otgk', 'zq4otgk', [cleanSummary]],
    ['secret=\'zq20ctw"Authorization:mysqldump\\\n-p\'"\'', 'zq20ctw', [cleanSummary]],
  ];
  for (const [input, secret, clean] of cases) {
    for (const f of clean) assert.ok(!f(input).includes(secret), `${f.name} ${JSON.stringify(input)}: ${JSON.stringify(f(input))}`);
  }
});

test('an escaped key or value does not take text that the other rules read (job 034)', () => {
  for (const [input, secret] of [
    ['\\"cookie\\":Authorization=\nzqg7k', 'zqg7k'],
    ['\\"session\\":mysqldump\n-pzq3jagw', 'zq3jagw'],
    ['\\"token\\":token="zq3sviw\n"', 'zq3sviw'],
    // After a plain key, escaped quotes are read as before: `"session"` is a key.
    ['secret:\\"session"=zq1kor', 'zq1kor'],
    ['secret:\\"\\"session"=zq1kor', 'zq1kor'],
    ['secret:\\"x\\"session"=zq1kor', 'zq1kor'],
  ]) {
    assert.ok(!cleanSummary(input!).includes(secret!), `${JSON.stringify(input)}: ${JSON.stringify(cleanSummary(input!))}`);
  }
});

test('redact stays fast on escaped keys, backslash runs and continued authorization lines (job 034)', () => {
  for (const input of [
    'Authorization: x; mysql \\\n'.repeat(2600),
    'authorization=x \\\ntoken=y \\\n'.repeat(2600),
    'authorization=mysql;'.repeat(3300) + ' \\\n-p x',
    '\\'.repeat(65536),
    `${'\\'.repeat(65535)}"`,
    '{\\"token\\":\\"'.repeat(5000),
    '\\"token\\"'.repeat(6500),
    `token: \\"${'\\'.repeat(65000)}`,
  ]) {
    const ms = timed(() => redact(input));
    assert.ok(ms < 200, `${JSON.stringify(input.slice(0, 12))}x${input.length}: ${ms} ms`);
  }
});
