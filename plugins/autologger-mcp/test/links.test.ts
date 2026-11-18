import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkLinks, classifyUrl } from '../src/links.ts';
import { cli, tempConfigDir } from './helpers.ts';

const at = (body: string) => checkLinks(body).map((p) => `${p.line}:${p.column} ${p.kind} ${p.text}`);

test('the wiki:/cite: grammar matches autologger wikiLinks.ts', () => {
  for (const ok of ['wiki:abc', 'wiki:A_b-9', `wiki:${'a'.repeat(64)}`, 'cite:S1@0', 'cite:s_1-x@120', 'cite:S@12.5', 'cite:S@12.125']) {
    assert.equal(classifyUrl(ok), 'valid', ok);
  }
  for (const bad of [
    'wiki:',
    `wiki:${'a'.repeat(65)}`,
    'wiki:has space',
    'wiki:Some.Page',
    'WIKI:abc',
    'Cite:S1@1',
    'cite:S1',
    'cite:S1@',
    'cite:S1@1.2345',
    'cite:S1@-1',
    'cite:S%31@1',
    'cite:@1',
    'wiki:a/b',
  ]) {
    assert.equal(classifyUrl(bad), 'invalid', bad);
  }
  assert.equal(classifyUrl('https://example.com'), 'other');
  assert.equal(classifyUrl('wikipedia:x'), 'other');
});

test('reports [[...]] links with line and column', () => {
  assert.deepEqual(at('# Page\n\nSee [[Jane Doe]] and\nalso [[Bits]].\n'), ['3:5 double-bracket [[Jane Doe]]', '4:6 double-bracket [[Bits]]']);
});

test('skips code spans, fenced and indented code blocks', () => {
  const body = [
    'Inline `[[not a link]]` and ``a `[[x]]` b`` here.', // 1
    '', // 2
    '```md', // 3
    '[[In fence]] [x](wiki:bad id)', // 4
    '```', // 5
    '', // 6
    '~~~~', // 7
    '[[tilde]]', // 8
    '~~~~', // 9
    '', // 10
    '    [[indented code]]', // 11
    '', // 12
    'After [[Real]].', // 13
  ].join('\n');
  assert.deepEqual(at(body), ['13:7 double-bracket [[Real]]']);
});

test('a code span may span lines within a paragraph; a lone backtick is not one', () => {
  assert.deepEqual(at('a `[[x]]\n[[y]]` b'), []);
  assert.deepEqual(at('a ` [[x]]'), ['1:5 double-bracket [[x]]']);
});

test('indented lines under a list item are content, not code', () => {
  assert.deepEqual(at('- item\n\n    [[Nested]]\n'), ['3:5 double-bracket [[Nested]]']);
});

test('reports inline links whose wiki:/cite: target is off the grammar, and accepts valid ones', () => {
  const body = [
    'Good [Jane](wiki:p_123) and [quote](cite:S1@120.5) and [web](https://x.y/a_(b)).',
    'Bad [Jane](wiki:Jane Doe) [q](cite:S1@1:02) [up](WIKI:abc)',
    'Angle [x](<wiki:has space>) title [y](wiki:ok "title") escaped [z](wiki:a\\_b)',
    '[ref]: cite:S1',
    '<wiki:bad.id> <cite:S1@3>',
  ].join('\n');
  assert.deepEqual(at(body), [
    '2:12 invalid-target wiki:Jane Doe',
    '2:31 invalid-target cite:S1@1:02',
    '2:50 invalid-target WIKI:abc',
    '3:11 invalid-target wiki:has space',
    '4:8 invalid-target cite:S1',
    '5:2 invalid-target wiki:bad.id',
  ]);
});

test('check-links: exit 0 when clean, 1 with file:line:col problems on stderr, from a file or stdin', async () => {
  const dir = tempConfigDir();
  const clean = join(dir, 'clean.md');
  const dirty = join(dir, 'dirty.md');
  writeFileSync(clean, 'See [Jane](wiki:p1) at [here](cite:S1@12).\n');
  writeFileSync(dirty, 'line one\nSee [[Jane]] and [q](cite:S1).\n');

  const ok = await cli({ configDir: dir }, 'check-links', clean, '--json');
  assert.deepEqual({ code: ok.code, stderr: ok.stderr }, { code: 0, stderr: '' });
  assert.deepEqual(JSON.parse(ok.stdout), { file: clean, problems: [] });

  const bad = await cli({ configDir: dir }, 'check-links', dirty, '--json');
  assert.equal(bad.code, 1);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /^autologger-mcp: 2 link problems:\n/);
  assert.ok(bad.stderr.includes(`${dirty}:2:5: '[[Jane]]' is not a link in autologger; write [Jane](wiki:<page_id>)`));
  assert.ok(bad.stderr.includes(`${dirty}:2:22: 'cite:S1' does not match`));

  const piped = await cli({ configDir: dir, stdin: '[[X]]' }, 'check-links', '-');
  assert.equal(piped.code, 1);
  assert.match(piped.stderr, /<stdin>:1:1: /);

  assert.equal((await cli({ configDir: dir }, 'check-links', join(dir, 'missing.md'))).code, 1);
  assert.equal((await cli({ configDir: dir }, 'check-links')).code, 2);
  assert.equal((await cli({ configDir: dir }, 'check-links', 'a', 'b')).code, 2);
});
