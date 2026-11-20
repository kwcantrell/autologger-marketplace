// annotate's dashboards: the built-in session overview keeps autologger's custom-dashboard save rules
// with hostile text in its heading, the pre-check catches what those rules refuse, and the copied
// rules match autologger-2's contract.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { dashboardProblems, OVERVIEW_IMPORTS, OVERVIEW_TSX, overviewTsx } from '../src/dashboard.ts';
import { DATA_EXPORTS, DENIED_ELEMENTS, DENIED_GLOBALS, IMPORT_ALLOWLIST, MAX_TSX_CHARS, REACT_EXPORTS, UI_COMPONENTS } from '../src/dashboardRules.ts';
import { FakeAutologger } from './fakeServer.ts';
import { cli, tempConfigDir } from './helpers.ts';

const servers: FakeAutologger[] = [];
after(async () => {
  for (const server of servers) await server.close();
});

/** The DATA constant's JSON, and the file with it put back to the template's placeholder. */
function split(tsx: string): { data: { title: string }; code: string } {
  const lines = tsx.split('\n');
  const at = lines.findIndex((l) => l.startsWith('const DATA = '));
  assert.ok(at > 0, 'no DATA constant');
  const line = lines[at] as string;
  assert.ok(line.endsWith(';'));
  lines[at] = 'const DATA = __DATA__;';
  return { data: JSON.parse(line.slice('const DATA = '.length, -1)), code: lines.join('\n') };
}

/** The code with comments and string literals blanked, for identifier checks (independent of src). */
const codeOnly = (code: string): string =>
  code
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");

/** autologger's save rules, checked on a generated source with a test-side reading of them. */
function checkSaveRules(tsx: string): void {
  assert.ok(tsx.length <= MAX_TSX_CHARS);
  assert.ok(!tsx.includes('\0'));
  const { code } = split(tsx);
  const imports = [...code.matchAll(/^import (.*) from '([^']+)';$/gm)];
  assert.equal(imports.length, code.split('\n').filter((l) => /\bimport\b/.test(l)).length, 'every import is one static import line');
  let bindings = 0;
  for (const [, clause, from] of imports) {
    const allowed = IMPORT_ALLOWLIST[from as string];
    assert.ok(allowed, `${from} is not on the allowlist`);
    const names = /^\{ (.*) \}$/.exec(clause as string)?.[1]?.split(', ') ?? [];
    assert.ok(names.length > 0, `named imports only: ${clause}`);
    for (const name of names) assert.ok(allowed.includes(name), `${name} is not allowed from ${from}`);
    bindings += names.length;
  }
  assert.ok(bindings <= 60);
  assert.doesNotMatch(code, /\bimport\s*\(|\brequire\b|import\.meta/);
  assert.equal([...code.matchAll(/\bexport\b/g)].length, 1);
  assert.match(code, /^export default function [A-Z]\w*\(\) \{$/m);
  const bare = codeOnly(code);
  for (const [, tag] of bare.matchAll(/<\/?([A-Za-z][\w.:-]*)/g)) assert.ok(!(DENIED_ELEMENTS as readonly string[]).includes((tag as string).toLowerCase().split(':').pop() as string), String(tag));
  assert.doesNotMatch(bare, /dangerouslySetInnerHTML|srcDoc/i);
  assert.doesNotMatch(bare, /\son[A-Z]\w*=\s*['"]/);
  for (const name of DENIED_GLOBALS) assert.doesNotMatch(bare, new RegExp(`(?<![\\w$.])${name}(?![\\w$])`), name);
  assert.doesNotMatch(bare, /\bawait\b/);
}

const HOSTILE = [
  'Plain title',
  '"; fetch("https://evil.example"); const x = "',
  "'); window.location = 'https://evil.example'; ('",
  '</script><script>alert(1)</script>',
  '${globalThis.eval("1")}',
  '`; import("x"); `',
  'Line\u2028separator\u2029and $& $\' $` patterns',
  '*/ export const x = 1; /*',
  '{DATA.title}<iframe src=x>',
];

test('the overview template imports only allowlisted names', () => {
  for (const [from, names] of Object.entries(OVERVIEW_IMPORTS)) {
    const allowed = IMPORT_ALLOWLIST[from];
    assert.ok(allowed, from);
    for (const name of names) assert.ok(allowed.includes(name), `${name} from ${from}`);
  }
});

for (const title of HOSTILE) {
  test(`a hostile heading stays data: ${JSON.stringify(title).slice(0, 40)}`, () => {
    const tsx = overviewTsx(title);
    checkSaveRules(tsx);
    assert.deepEqual(dashboardProblems(tsx), []);
    const { data, code } = split(tsx);
    assert.equal(data.title, title, 'the title comes back whole from the JSON');
    assert.equal(code, OVERVIEW_TSX, 'nothing outside DATA depends on the title');
    // The DATA line holds no raw <, >, &, U+2028 or U+2029.
    const line = tsx.split('\n').find((l) => l.startsWith('const DATA = ')) ?? '';
    assert.doesNotMatch(line, /[<>&\u2028\u2029]/);
  });
}

test('the pre-check finds what autologger refuses', () => {
  const ok = "import { useState } from 'react';\nimport { useEvents } from '@autologger/dashboard';\n\nexport default function D() {\n  const [n] = useState(0);\n  const e = useEvents();\n  return <div style={{ top: 0 }}>{\"don't\"} {n} {e.data?.length}</div>;\n}\n";
  assert.deepEqual(dashboardProblems(ok), []);
  const cases: [string, RegExp][] = [
    [ok.replace('return', 'window.alert(1);\n  return'), /^line 7: window is not allowed$/],
    [ok.replace('return', 'fetch("/x");\n  return'), /fetch is not allowed/],
    [`import fs from 'node:fs';\n${ok}`, /'node:fs' is not a module a dashboard may import/],
    [`import { useWiki } from '@autologger/dashboard';\n${ok}`, /'useWiki' is not allowed from '@autologger\/dashboard'/],
    [`import Dash from '@autologger/dashboard';\n${ok}`, /only named imports are allowed/],
    [ok.replace('return', "import('x');\n  return"), /only static "import \.\.\. from '<module>'" statements/],
    [ok.replace('<div', '<script>x</script><div'), /the element <script> is not allowed/],
    [ok.replace('<div', '<div dangerouslySetInnerHTML={{ __html: "x" }}'), /dangerouslySetInnerHTML/],
    [`${ok}export const x = 1;\n`, /exactly one export/],
    [ok.replace('return', 'setInterval(() => {}, 1);\n  return'), /setInterval is not allowed/],
    [`${ok}// ${'x'.repeat(MAX_TSX_CHARS)}`, /over autologger's 100000/],
  ];
  for (const [source, expected] of cases) assert.match(dashboardProblems(source).join('\n'), expected);
  // Names in strings, comments and property access are not references.
  assert.deepEqual(dashboardProblems(ok.replace('return', '// window\n  const t = "fetch me";\n  const p = e.top;\n  return')), []);
});

// The pre-check reads plan TSX in the pre-approved dry run, so it must stay linear on hostile input:
// a long whitespace run or comment after `import` once backtracked for minutes at 10,000 characters.
test('the pre-check stays fast on 200 KB and just-under-the-limit hostile sources', () => {
  const near = MAX_TSX_CHARS - 100;
  const cases: [string, string, RegExp][] = [
    ['import + 200 KB of spaces', `import${' '.repeat(200_000)}x`, /over autologger's 100000/],
    ['import + a 200 KB comment', `import /*${'x'.repeat(200_000)}*/ x`, /over autologger's 100000/],
    ['import + spaces', `import${' '.repeat(near)}x`, /only static "import/],
    ['import + a comment', `import /*${'x'.repeat(near)}*/ x`, /only static "import/],
    ['import + spaces + from, no module', `import a${' '.repeat(near / 2)}from${' '.repeat(near / 2 - 20)}x`, /only static "import/],
    ['a clause of spaces', `import a${' '.repeat(near)}x from 'react';`, /cannot read the import clause/],
    ['a clause of commas and spaces', `import a${' ,'.repeat(near / 2)} from 'react';`, /cannot read the import clause/],
    ['many import keywords', 'import '.repeat(Math.floor(near / 7)), /only static "import/],
    ['many import statements', "import { useState } from 'react';\n".repeat(Math.floor(near / 34)), /imported bindings, over/],
    ['many denied elements', '<script>'.repeat(Math.floor(near / 8)), /the element <script> is not allowed/],
    ['a denied global then spaces', `window${' '.repeat(near)}x`, /window is not allowed/],
    ['an unterminated string after from', `import a from '${'x'.repeat(near)}`, /only static "import/],
  ];
  for (const [name, source, expected] of cases) {
    const started = performance.now();
    const problems = dashboardProblems(source).join('\n');
    const ms = performance.now() - started;
    assert.match(problems, expected, name);
    assert.ok(ms < 1000, `${name} took ${Math.round(ms)} ms`);
  }
});

// The copied rules match autologger's contract, when an autologger-2 checkout is on this machine.
const contract = join(process.env.AUTOLOGGER_REPO ?? '/home/autologger/autologger-2', 'packages', 'contract', 'src', 'customDashboards.ts');
test('the copied allowlist, denylists and limits match autologger-2 packages/contract/src/customDashboards.ts', { skip: existsSync(contract) ? false : `no ${contract}` }, () => {
  const text = readFileSync(contract, 'utf8');
  const list = (name: string): string[] => {
    const body = new RegExp(`export const ${name}[^=]*= \\[([\\s\\S]*?)\\] as const;`).exec(text)?.[1];
    assert.ok(body !== undefined, name);
    return [...body.replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
  };
  assert.deepEqual(list('DASHBOARD_DATA_EXPORTS'), [...DATA_EXPORTS]);
  assert.deepEqual(list('DASHBOARD_REACT_EXPORTS'), [...REACT_EXPORTS]);
  assert.deepEqual(list('DASHBOARD_DENIED_ELEMENTS'), [...DENIED_ELEMENTS]);
  assert.deepEqual(list('DASHBOARD_DENIED_GLOBALS'), [...DENIED_GLOBALS]);
  const ui = /export const DASHBOARD_UI_COMPONENTS[^=]*= \{([\s\S]*?)\n\};/.exec(text)?.[1] ?? '';
  const parsed = Object.fromEntries([...ui.matchAll(/^ {2}'?([a-z-]+)'?: \[([\s\S]*?)\],?$/gm)].map((m) => [m[1], [...(m[2] as string).matchAll(/'([^']+)'/g)].map((n) => n[1])]));
  assert.deepEqual(parsed, UI_COMPONENTS);
  assert.match(text, new RegExp(`sourceChars: ${MAX_TSX_CHARS.toLocaleString('en').replace(',', '_')},`));
  assert.match(text, /titleMaxChars: 200,/);
  assert.match(text, /importSpecifiers: 60,/);
});

test('annotate dashboard writes the overview for a session (read tools only), refusing a link or a non-.tsx --out', async () => {
  const server = await new FakeAutologger({ data: { sessions: [{ session_id: 'S1', show_id: 'shw_1', title: '</script> & "quotes"', events: [], topics: [] }], pages: [] } }).start();
  servers.push(server);
  const dir = tempConfigDir();
  assert.equal((await cli({ configDir: dir, server: server.base, stdin: server.mintDevTokens('dashboards session-data:write') }, 'import-tokens')).code, 0);
  const run = (...argv: string[]) => cli({ configDir: dir, server: server.base }, ...argv);
  const out = join(dir, 'overview.tsx');
  const r = await run('annotate', 'dashboard', '--session', 'S1', '--out', out, '--json');
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.title, 'Overview: </script> & "quotes"');
  const tsx = readFileSync(out, 'utf8');
  checkSaveRules(tsx);
  assert.equal(split(tsx).data.title, report.title);
  assert.deepEqual(report.save_dashboard_args, { title: report.title, scope: { kind: 'session', session_id: 'S1' } });
  const titled = await run('annotate', 'dashboard', '--session', 'S1', '--out', out, '--title', 'Mine', '--json');
  assert.equal(JSON.parse(titled.stdout).title, 'Mine');
  assert.equal(server.writeCounts.attempted, 0);

  symlinkSync(join(dir, 'elsewhere.tsx'), join(dir, 'link.tsx'));
  const link = await run('annotate', 'dashboard', '--session', 'S1', '--out', join(dir, 'link.tsx'));
  assert.equal(link.code, 2);
  assert.match(link.stderr, /is a symbolic link/);
  assert.equal(existsSync(join(dir, 'elsewhere.tsx')), false);
  assert.equal((await run('annotate', 'dashboard', '--session', 'S1', '--out', join(dir, 'x.ts'))).code, 2);
  writeFileSync(join(dir, 'dir.tsx'), '');
  assert.equal((await run('annotate', 'dashboard', '--out', join(dir, 'y.tsx'))).code, 2, 'needs --session');
});
