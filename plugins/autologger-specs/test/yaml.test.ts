import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { YamlError, YamlTimestamp, parseYaml } from '../src/yaml.ts';
import { LIFECYCLE } from './fixture.ts';

// Documents the reader accepts. Each is compared with PyYAML's safe_load when python3 + PyYAML are
// installed (autologger's own gates read lifecycle.yaml with it); the expected values below are
// checked either way.
const ACCEPTED: Array<[string, string, unknown]> = [
  ['the fixture lifecycle.yaml', LIFECYCLE, undefined],
  ['empty document', '', null],
  ['only comments', '# nothing\n  # here\n', null],
  ['leading --- and trailing ...', '---\na: 1\n...\n', { a: 1 }],
  ['nested maps and comments', 'a:\n  b:\n    c: d # trailing\n  # between\n  e: f\n', { a: { b: { c: 'd' }, e: 'f' } }],
  ['indentless block list', 'a:\n- x\n- y\nb: z\n', { a: ['x', 'y'], b: 'z' }],
  ['indented block list', 'a:\n    - x\n    -   y\n', { a: ['x', 'y'] }],
  ['list of maps', '- a: 1\n  b: two\n-   c: 3\n- - nested\n  - list\n-\n  d: 4\n', [{ a: 1, b: 'two' }, { c: 3 }, ['nested', 'list'], { d: 4 }]],
  ['empty values', 'a:\nb: ~\nc: null\nd: ""\ne: \'\'\nf:\n  -\n', { a: null, b: null, c: null, d: '', e: '', f: [null] }],
  ['YAML 1.1 scalars', 'a: yes\nb: Off\nc: 0x1F\nd: 017\ne: 1_000\nf: 1:30\ng: 1.5e+3\nh: .5\ni: -.5\nin: -1.5\nj: 0b101\nk: +12\nl: true\nm: "true"\n', { a: true, b: false, c: 31, d: 15, e: 1000, f: 90, g: 1500, h: 0.5, i: '-.5', in: -1.5, j: 5, k: 12, l: true, m: 'true' }],
  ['strings that look special', 'a: docker://x@sha256:abc\nb: x:y\nc: a#b\nd: -x\ne: ?x\nf: :x\ng: 1.2.3\nh: 12abc\ni: a, b\nj: x]\n', { a: 'docker://x@sha256:abc', b: 'x:y', c: 'a#b', d: '-x', e: '?x', f: ':x', g: '1.2.3', h: '12abc', i: 'a, b', j: 'x]' }],
  ['globs', "- '**/test/**'\n- \"**/*.spec.*\"\n- server/src/**\n- supabase/migrations/*_x.sql\n- web/src/a?.ts\n", ['**/test/**', '**/*.spec.*', 'server/src/**', 'supabase/migrations/*_x.sql', 'web/src/a?.ts']],
  ['quoted keys and escapes', '\'a b\': 1\n"c\\td": \'it\'\'s\'\n"e": "\\u00e9\\x41\\"\\\\"\n', { 'a b': 1, 'c\td': "it's", e: 'éA"\\' }],
  ['multi-line single quotes', "a: 'one\n  two\n\n  three\n\n\n  '\nb: 'x\n  '\n", { a: 'one two\nthree\n\n', b: 'x ' }],
  ['multi-line double quotes', 'a: "one\n  two\\\n  three\n\n  four"\n', { a: 'one twothree\nfour' }],
  ['multi-line plain', 'a: one\n  two\n\n  three\nb: x\n', { a: 'one two\nthree', b: 'x' }],
  ['plain list item over lines', '- one\n  two\n- three\n', ['one two', 'three']],
  ['literal block', 'a: |\n  line 1\n    indented\n\n  line 3\nb: |-\n  stripped\n\nc: |+\n  kept\n\nd: x\n', { a: 'line 1\n  indented\n\nline 3\n', b: 'stripped', c: 'kept\n\n', d: 'x' }],
  ['folded block', 'a: >\n  one\n  two\n\n  three\n    more\n  four\nb: >-\n  x\n  y\n', { a: 'one two\nthree\n  more\nfour\n', b: 'x y' }],
  ['block with indentation indicator', 'a: |2\n    two extra\n  base\n', { a: '  two extra\nbase\n' }],
  ['flow collections on one line', 'a: []\nb: {}\nc: [x, \'y z\', "w", 1, [n]]\nd: {k: v, n: 2}\n', { a: [], b: {}, c: ['x', 'y z', 'w', 1, ['n']], d: { k: 'v', n: 2 } }],
  ['duplicate keys: the last wins', 'a: 1\na: 2\n', { a: 2 }],
  ['non-string keys (1 and true are one Python key)', '1: one\ntrue: t\n~: n\nno: f\n', { '1': 't', None: 'n', False: 'f' }],
  ['CRLF and BOM', '\uFEFFa:\r\n- x\r\n', { a: ['x'] }],
  ['top-level scalar', 'just text\n', 'just text'],
  ['timestamp', 'a: 2001-12-14\n', { a: '2001-12-14' }],
];

const REJECTED: Array<[string, string, RegExp]> = [
  ['anchor', 'a: &x 1\n', /line 1: anchors/],
  ['alias', 'a: 1\nb: *x\n', /line 2: aliases/],
  ['unquoted leading * glob', '- *.ts\n', /line 1: aliases/],
  ['tag', 'a: !!str 1\n', /line 1: tags/],
  ['complex key', '? a\n: b\n', /line 1: complex keys/],
  ['merge key', 'a:\n  <<: {b: 1}\n', /line 2: merge keys/],
  ['directive', '%YAML 1.1\n---\na: 1\n', /line 1: directives/],
  ['two documents', 'a: 1\n---\nb: 2\n', /line 2: multiple YAML documents/],
  ['tab indentation', 'a:\n\t- x\n', /line 2: tabs/],
  ['multi-line flow', 'a: [x,\n  y]\n', /line 1: multi-line flow/],
  ['bad indentation', 'a:\n    b: 1\n  c: 2\n', /line 3: bad indentation|line 3: unexpected content/],
  ['sequence after key on the same line', 'a: - x\n', /line 1: a block sequence cannot start/],
  ['mapping on one line', 'a: b: c\n', /line 1: a mapping value cannot be a mapping/],
  ['unterminated quote', "a: 'x\nb: 1\n", /unterminated single-quoted/],
  ['text after a quote', "a: 'x' y\n", /line 1: unexpected text after a quoted value/],
  ['plain value with ": " inside a continuation', 'a: x\n  b: c\n', /line 2: a plain value cannot contain/],
  ['bad escape', 'a: "\\q"\n', /unknown escape/],
  ['reserved indicator', 'a: @x\n', /line 1: .*@/],
  ['map then list at the same level', 'a: 1\n- x\n', /line 2/],
];

// Keys go through str(), as autologger's spec_path_map does for spec names (json.dumps would turn
// True into "true").
const PY = `
import json, sys, yaml
def norm(v):
    if isinstance(v, dict): return {str(k): norm(x) for k, x in v.items()}
    if isinstance(v, list): return [norm(x) for x in v]
    return v
print(json.dumps(norm(yaml.safe_load(sys.stdin.read())), default=str))
`;
const hasPyYaml = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' }).status === 0;

function pyLoad(text: string): { ok: true; value: unknown } | { ok: false } {
  const r = spawnSync('python3', ['-c', PY], { input: text, encoding: 'utf8' });
  return r.status === 0 ? { ok: true, value: JSON.parse(r.stdout) } : { ok: false };
}

const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

for (const [name, text, expected] of ACCEPTED) {
  test(`yaml accepts: ${name}`, () => {
    const value = parseYaml(text);
    if (expected !== undefined) assert.deepEqual(asJson(value), asJson(expected));
  });
  test(`yaml matches PyYAML safe_load: ${name}`, { skip: !hasPyYaml && 'python3 with PyYAML not installed' }, () => {
    const py = pyLoad(text);
    assert.ok(py.ok, 'PyYAML rejected it');
    assert.deepEqual(asJson(parseYaml(text)), py.value);
  });
}

for (const [name, text, message] of REJECTED) {
  test(`yaml refuses with a line number: ${name}`, () => {
    assert.throws(() => parseYaml(text), (error: unknown) => error instanceof YamlError && message.test(error.message));
  });
}

test('timestamps are not strings, so a glob list would drop them like PyYAML dates', () => {
  assert.ok((parseYaml('a: 2001-12-14\n') as { a: unknown }).a instanceof YamlTimestamp);
});
