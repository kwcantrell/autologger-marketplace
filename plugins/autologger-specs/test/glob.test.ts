import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { byCodePoint, globSource, matches } from '../src/glob.ts';

// A verbatim copy of autologger's matcher (scripts/lib/check_change.py, `glob_re` and `matches`), the
// reference this port must agree with. The real checkout is compared by test/verify-autologger.ts.
const PY_REFERENCE = `
import json, re, sys

def glob_re(pattern: str) -> re.Pattern[str]:
    """Git-style glob: \`**/\` spans directories, \`*\` stays within one."""
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif pattern.startswith("**", i):
            out, i = out + ".*", i + 2
        elif pattern[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif pattern[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(pattern[i]), i + 1
    return re.compile(out + r"\\Z")


def matches(path: str, patterns: list[str]) -> bool:
    return any(glob_re(p).match(path) for p in patterns)

data = json.load(sys.stdin)
print(json.dumps([[bool(matches(p, [g])) for g in data["globs"]] for p in data["paths"]]))
`;

const GLOBS = [
  'server/src/**', 'server/src/routers/**', '**/test/**', '**/*.test.*', '**/test_*', '**/__tests__/**',
  'packages/*/package.json', 'supabase/migrations/*_x.sql', 'web/src/a?.ts', 'docker/companion.Dockerfile*',
  'compose.yaml', '.cursor/**', '**', '*', '**/', 'a/**/b', 'a**b', '**.ts', 'src/[ab].ts', 'src/(x)+.ts',
  'src/a.b', 'src/a|b', 'src/$x^', 'src/{a,b}', 'web/src/pages/index/utils/*Csv.ts', 'x/é?.ts', 'x/?.ts',
];

const PATHS = [
  'server/src/a.ts', 'server/src/routers/ai.ts', 'server/src', 'server/srcx/a.ts', 'server/test/a.ts', 'test/a.ts',
  'a/test/b/c.ts', 'a.test.ts', 'dir/a.test.tsx', 'dir/test_a.py', 'test_a.py', 'x/__tests__/y', 'packages/a/package.json',
  'packages/a/b/package.json', 'supabase/migrations/2024_x.sql', 'supabase/migrations/a/b_x.sql', 'web/src/ab.ts',
  'web/src/abc.ts', 'web/src/a/.ts', 'docker/companion.Dockerfile', 'docker/companion.Dockerfile.dev', 'compose.yaml',
  'compose_yaml', '.cursor/rules/a.mdc', 'a/b', 'a/x/y/b', 'ab', 'a/b/c', 'a.ts', 'deep/a.ts', 'src/[ab].ts', 'src/a.ts',
  'src/(x)+.ts', 'src/xx.ts', 'src/a.b', 'src/axb', 'src/a|b', 'src/$x^', 'src/{a,b}', 'web/src/pages/index/utils/aCsv.ts',
  'x/é1.ts', 'x/éé.ts', 'x/😀.ts', 'line\nbreak/a.ts', 'cr\r/a.ts', 'u2028 /a.ts', '',
];

const hasPython = spawnSync('python3', ['-c', 'import re'], { encoding: 'utf8' }).status === 0;

test('glob matcher agrees with check_change.py for every glob x path pair', { skip: !hasPython && 'python3 not installed' }, () => {
  const r = spawnSync('python3', ['-c', PY_REFERENCE], { input: JSON.stringify({ globs: GLOBS, paths: PATHS }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const expected = JSON.parse(r.stdout) as boolean[][];
  const actual = PATHS.map((p) => GLOBS.map((g) => matches(p, [g])));
  const diffs = PATHS.flatMap((p, i) => GLOBS.filter((_, j) => actual[i]?.[j] !== expected[i]?.[j]).map((g) => `${JSON.stringify(p)} vs ${g}`));
  assert.deepEqual(diffs, []);
});

test('git-style semantics', () => {
  assert.ok(matches('server/src/a/b.ts', ['server/src/**']));
  assert.ok(matches('test/x.ts', ['**/test/**']), '**/ also matches no directory');
  assert.ok(!matches('server/src/a/b.ts', ['server/src/*']), '* stays within one segment');
  assert.ok(!matches('xsrc/a.ts', ['src/*']), 'anchored at the start');
  assert.ok(!matches('src/a.tsx', ['src/*.ts']), 'anchored at the end');
  assert.ok(matches('src/a.ts', ['nope', 'src/a.ts']), 'any of several globs');
  assert.ok(!matches('src/a.ts', []));
  assert.equal(globSource('a.b'), '^(?:a\\.b)$');
});

test('byCodePoint sorts like Python', () => {
  assert.deepEqual(['b', 'a', '￿', '😀', 'B'].sort(byCodePoint), ['B', 'a', 'b', '￿', '😀']);
});
