// file: dry run, the redaction re-check, and filing through a fake gh on PATH (never the real one).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { MARKETPLACE_REPO } from '../src/advisor.ts';
import { EXIT } from '../src/run.ts';
import { fakeGh, sandbox, type Sandbox } from './helpers.ts';

let box: Sandbox;
afterEach(() => box?.cleanup());

const ISSUE_URL = 'https://github.com/kwcantrell/autologger-marketplace/issues/42';

function json(r: { code: number; stdout: string; stderr: string }): any {
  assert.equal(r.code, EXIT.ok, r.stderr);
  return JSON.parse(r.stdout);
}

/** A sandbox whose PATH has only a fake gh (plus node's own dir, for the fake's shebang). */
function withGh(script: string): Sandbox {
  const b = sandbox();
  const bin = fakeGh(b.dir, script);
  b.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  return b;
}

function suggested(b: Sandbox): string {
  let sig = '';
  for (let i = 0; i < 3; i++) sig = json(b.call(['record', '--plugin', 'autologger-mcp', '--kind', 'cli-failure', '--summary', 'call list_events exited 1: not signed in', '--detail', 'after token=abc123 expired', '--json'])).signature;
  assert.equal(json(b.call(['suggest', '--json'])).suggestions.length, 1);
  return sig;
}

function ghCalls(b: Sandbox): Array<{ argv: string[]; stdin: string }> {
  const path = join(b.dir, 'gh-calls.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

test('without --confirm, file prints exactly what would be filed and does not run gh', () => {
  box = withGh(`console.log(${JSON.stringify(ISSUE_URL)});`);
  const sig = suggested(box);
  const r = json(box.call(['file', sig, '--json']));
  const draft = readFileSync(join(box.config, 'drafts', `${sig}.md`), 'utf8');
  assert.equal(r.dryRun, true);
  assert.equal(r.filed, false);
  assert.equal(r.repo, MARKETPLACE_REPO);
  assert.equal(r.knownPublic, true);
  assert.equal(`# ${r.title}\n\n${r.body}`, draft);
  assert.match(r.title, /^plugin-advisor: autologger-mcp: call list_events exited 1: not signed in$/);
  assert.ok(r.body.includes('after token=[redacted] expired'));
  assert.deepEqual(ghCalls(box), []);
  const text = box.call(['file', sig]);
  assert.equal(text.code, EXIT.ok);
  assert.match(text.stdout, /^Dry run: nothing was filed\.\nRepository: kwcantrell\/autologger-marketplace \(public: anyone can read what is filed\)\nTitle: plugin-advisor: /);
  assert.match(text.stdout, /Run file again with --confirm to file exactly this\.\n$/);
  assert.equal(json(box.call(['file', sig, '--repo', 'someone/fork', '--json'])).repo, 'someone/fork');
  assert.deepEqual(ghCalls(box), []);
});

test('--confirm files through gh with the body on stdin, records the URL, and never files twice', () => {
  box = withGh(`console.log('Creating issue in kwcantrell/autologger-marketplace\\n\\n' + ${JSON.stringify(ISSUE_URL)});`);
  const sig = suggested(box);
  const dry = json(box.call(['file', sig, '--json']));
  const r = json(box.call(['file', sig, '--confirm', '--json']));
  assert.equal(r.filed, true);
  assert.equal(r.dryRun, false);
  assert.equal(r.url, ISSUE_URL);
  const calls = ghCalls(box);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.argv, ['issue', 'create', '--repo', MARKETPLACE_REPO, '--title', dry.title, '--body-file', '-']);
  assert.equal(calls[0]?.stdin, dry.body, 'the body gh receives is exactly the dry-run body');
  const issue = json(box.call(['show', sig, '--json']));
  assert.equal(issue.status, 'filed');
  assert.equal(issue.issueUrl, ISSUE_URL);
  const again = box.call(['file', sig, '--confirm']);
  assert.equal(again.code, EXIT.failure);
  assert.match(again.stderr, /already filed as https:\/\/github\.com\/kwcantrell\/autologger-marketplace\/issues\/42/);
  assert.equal(ghCalls(box).length, 1);
});

test('--repo overrides the target repo', () => {
  box = withGh(`console.log('https://github.com/someone/fork/issues/7');`);
  const sig = suggested(box);
  assert.equal(json(box.call(['file', sig, '--repo', 'someone/fork', '--confirm', '--json'])).url, 'https://github.com/someone/fork/issues/7');
  assert.deepEqual(ghCalls(box)[0]?.argv.slice(0, 4), ['issue', 'create', '--repo', 'someone/fork']);
});

test('a title with shell metacharacters reaches gh as one argument, unexpanded', () => {
  box = withGh(`console.log(${JSON.stringify(ISSUE_URL)});`);
  let sig = '';
  for (let i = 0; i < 3; i++) sig = json(box.call(['record', '--plugin', 'autologger-dev', '--kind', 'workaround', '--summary', 'ran $(touch pwned) `id` ; echo "x" > y by hand', '--json'])).signature;
  json(box.call(['suggest', '--json']));
  json(box.call(['file', sig, '--confirm', '--json']));
  const title = ghCalls(box)[0]?.argv[5] ?? '';
  assert.ok(title.includes('$(touch pwned)'), title);
  assert.equal(existsSync(join(box.dir, 'pwned')), false);
});

test('file refuses (exit 1) when the draft holds secret-looking text, without running gh', () => {
  box = withGh(`console.log(${JSON.stringify(ISSUE_URL)});`);
  const sig = suggested(box);
  const path = join(box.config, 'drafts', `${sig}.md`);
  writeFileSync(path, `${readFileSync(path, 'utf8')}\nAlso: Authorization: Bearer abcdefghijklmnop0123456789\n`);
  for (const argv of [['file', sig], ['file', sig, '--confirm']]) {
    const r = box.call(argv);
    assert.equal(r.code, EXIT.failure);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^plugin-advisor: refusing to file [0-9a-f]{12}: the draft at .* still has secret-looking text on line \d+/);
  }
  assert.deepEqual(ghCalls(box), []);
});

// Follow-up 012 #5: capping a ~190-character summary after redaction cut 'token=[redacted]' to
// 'token=[r…', which redact rewrites, so file refused a draft that held no secret.
test('summaries capped next to a redacted value still file (dry run)', () => {
  box = withGh(`console.log(${JSON.stringify(ISSUE_URL)});`);
  let sig = '';
  for (let i = 1; i <= 3; i++) {
    const summary = `${'x'.repeat(190)} token=abc${i}`;
    sig = json(box.call(['record', '--plugin', 'autologger-mcp', '--kind', 'workaround', '--summary', summary, '--json'])).signature;
  }
  assert.equal(json(box.call(['suggest', '--json'])).suggestions.length, 1);
  const r = box.call(['file', sig, '--json']);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(JSON.parse(r.stdout).filed, false);
  assert.deepEqual(ghCalls(box), []);
});

// Review 1: renderDraft appends text after a redacted header on the same line, and file re-checks the
// draft with redact, which used to rewrite `Authorization: [redacted]". plugin-advisor ...` and refuse.
for (const summary of [
  'mcp call fails with Authorization: Token abc123xyz',
  'login fails, Cookie: session=ab1',
  'curl failed\nAuthorization: Token abc123xyz\nstatus 401',
]) {
  test(`a summary with a header still files (dry run): ${JSON.stringify(summary)}`, () => {
    box = withGh(`console.log(${JSON.stringify(ISSUE_URL)});`);
    let sig = '';
    for (let i = 1; i <= 3; i++) {
      sig = json(box.call(['record', '--plugin', 'autologger-mcp', '--kind', 'workaround', '--summary', summary, '--json'])).signature;
    }
    assert.equal(json(box.call(['suggest', '--json'])).suggestions.length, 1);
    const r = box.call(['file', sig, '--json']);
    assert.equal(r.code, EXIT.ok, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.filed, false);
    assert.ok(!/abc123xyz|session=ab1/.test(r.stdout), r.stdout);
    assert.deepEqual(ghCalls(box), []);
  });
}

test('file needs a draft, refuses dismissed issues, and reports gh failures', () => {
  box = withGh(`process.stderr.write('HTTP 401: Bad credentials (token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345)\\n'); process.exit(1);`);
  let sig = '';
  for (let i = 0; i < 2; i++) sig = json(box.call(['record', '--plugin', 'autologger-mcp', '--kind', 'workaround', '--summary', 'x', '--json'])).signature;
  const noDraft = box.call(['file', sig]);
  assert.equal(noDraft.code, EXIT.failure);
  assert.match(noDraft.stderr, /has no draft yet; run suggest first/);
  json(box.call(['record', '--plugin', 'autologger-mcp', '--kind', 'workaround', '--summary', 'x', '--json']));
  json(box.call(['suggest', '--json']));
  const failed = box.call(['file', sig, '--confirm']);
  assert.equal(failed.code, EXIT.failure);
  assert.match(failed.stderr, /^plugin-advisor: gh issue create exited 1: HTTP 401: Bad credentials \(token \[redacted\]\)\n$/);
  assert.equal(json(box.call(['show', sig, '--json'])).status, 'suggested', 'a failed filing records nothing');
  json(box.call(['dismiss', sig, '--json']));
  assert.match(box.call(['file', sig]).stderr, /is dismissed; not filing it/);
});

test('file reports a missing gh clearly', () => {
  box = sandbox({ PATH: '/nonexistent' });
  const sig = suggested(box);
  const r = box.call(['file', sig, '--confirm']);
  assert.equal(r.code, EXIT.failure);
  assert.match(r.stderr, /gh is not on PATH/);
});
