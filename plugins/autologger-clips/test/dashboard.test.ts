// dashboard: clip list + list_session_media results -> autologger custom dashboard TSX. Checks the
// ranges (as timeline plans them), the refusals, and that the file keeps autologger's save-time rules
// with hostile session data in it.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanText } from '../src/clips.ts';
import { DASHBOARD_IMPORTS, MAX_TSX_CHARS, TEMPLATE } from '../src/dashboard.ts';
import { EXIT } from '../src/run.ts';
import { DATA_EXPORTS, DENIED_ELEMENTS, DENIED_GLOBALS, IMPORT_ALLOWLIST, REACT_EXPORTS, UI_COMPONENTS } from './dashboardRules.ts';
import { call, sandbox } from './helpers.ts';

const box = sandbox();
const ctx = { env: box.env, cwd: box.cwd };

const ids = { a: 'dQw4w9WgXcQ', b: 'jNQXAC9IVRw', c: 'M7lc1UVf-VE' };

function item(videoId: string, takeStart: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ordinal: 1, recording_ordinal: 1, kind: 'youtube', url: `https://www.youtube.com/watch?v=${videoId}`, video_id: videoId, file_name: null, duration_s: 600, take_start_s: takeStart, take_stop_s: takeStart + 600, ...extra };
}

/** Writes a file in the work dir and returns its name. */
function file(name: string, data: unknown): string {
  writeFileSync(join(box.cwd, name), typeof data === 'string' ? data : JSON.stringify(data));
  return name;
}

/** As `autologger-mcp call list_session_media --json` prints it. */
const toolResult = (items: unknown[]): unknown => ({ content: [{ type: 'text', text: JSON.stringify({ items, total: items.length }) }], structuredContent: { items, total: items.length } });

/** The DATA constant's JSON, and the file with it put back to the template's placeholder. */
function split(tsx: string): { data: { title: string; players: { video_id: string; title: string; clips: { label: string; session_start: number; start: number; end: number; length: number }[] }[] }; code: string } {
  const lines = tsx.split('\n');
  const at = lines.findIndex((l) => l.startsWith('const DATA = '));
  assert.ok(at > 0, 'no DATA constant');
  const line = lines[at] as string;
  assert.ok(line.endsWith(';'));
  const literal = line.slice('const DATA = '.length, -1);
  lines[at] = 'const DATA = __DATA__;';
  return { data: JSON.parse(literal), code: lines.join('\n') };
}

/** The code with comments and string literals blanked, for identifier checks. */
const codeOnly = (code: string): string =>
  code
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");

async function dashboard(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string; report: any; tsx: string }> {
  const r = await call(ctx, 'dashboard', ...argv, '--json');
  const report = r.code === 0 ? JSON.parse(r.stdout) : null;
  return { ...r, report, tsx: report ? readFileSync(report.out, 'utf8') : '' };
}

test('one session: padded, merged ranges in video time (session time - take_start_s), as timeline plans them', async () => {
  file('clips1.json', [
    { session_id: 'S1', start_s: 30, end_s: 40, label: 'Pasta', session_title: 'Episode 1' },
    { session_id: 'S1', start_s: 38, end_s: 45, label: 'More pasta' },
    { session_id: 'S1', start_s: 100, end_s: 120 },
    { session_id: 'S1', start_s: 5, end_s: 20, label: 'Before the take' },
  ]);
  file('media1.json', toolResult([item(ids.a, 12.5)]));
  const r = await dashboard('--clips', 'clips1.json', '--media-json', 'media1.json', '--out', 'out/d1.tsx', '--pad', '1');
  assert.equal(r.code, EXIT.ok, r.stderr);
  const { players } = r.report;
  assert.equal(players.length, 1);
  assert.equal(players[0].video_id, ids.a);
  assert.equal(players[0].url, `https://www.youtube.com/watch?v=${ids.a}`);
  assert.equal(players[0].title, 'Episode 1');
  assert.deepEqual(
    players[0].clips.map((c: any) => [c.label, c.from, c.session_start_s, c.video_start_s, c.video_end_s, c.length_s]),
    [
      ['Pasta / More pasta', [1, 2], 29, 16.5, 33.5, 17],
      ['Clip at 1:39', [3], 99, 86.5, 108.5, 22],
      // 4-21 s of session time starts before the video (take at 12.5 s): clamped to 0.
      ['Before the take', [4], 4, 0, 8.5, 8.5],
    ],
  );
  assert.deepEqual(r.report.merged.map((m: any) => m.from), [[1, 2]]);
  assert.deepEqual(r.report.clamped.map((c: any) => c.from), [[4]]);
  assert.equal(r.report.title, 'Clips: Episode 1');
  assert.equal(r.report.session_id, 'S1');
  assert.equal(r.report.save_args, null);
  // The player's range is the picked clip's video range.
  const { data } = split(r.tsx);
  assert.deepEqual(data.players[0]?.clips.map((c) => [c.start, c.end, c.session_start, c.length]), [[16.5, 33.5, 29, 17], [86.5, 108.5, 99, 22], [0, 8.5, 4, 8.5]]);
  assert.match(r.tsx, /<YouTubePlayer videoId=\{player\.video_id\} start=\{current\.start\} end=\{current\.end\} title=\{current\.label\} autoplay=\{state\.play\} \/>/);
  assert.match(r.tsx, /onClick=\{\(\) => pick\(p, c\)\}/);
  assert.match(r.tsx, /const pick = \(p, index\) => setPicked\(\(prev\) => prev\.map\(\(s, i\) => \(i === p \? \{ index, play: true \} : s\)\)\);/);
});

test('a range past the video is clamped to list_session_media duration_s, and one outside it dropped', async () => {
  file('clips-long.json', [
    { session_id: 'S1', start_s: 590, end_s: 640, label: 'End' },
    { session_id: 'S1', start_s: 700, end_s: 710, label: 'Gone' },
  ]);
  file('media-long.json', { items: [item(ids.a, 10, { duration_s: 615 })] });
  const r = await dashboard('--clips', 'clips-long.json', '--media-json', 'media-long.json', '--out', 'long.tsx');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.report.players[0].clips.map((c: any) => [c.video_start_s, c.video_end_s]), [[580, 615]]);
  assert.deepEqual(r.report.dropped.map((d: any) => [d.from, d.reason]), [[[2], 'starts after the video ends']]);
});

test('hostile labels and titles are only JSON data: the code is the fixed template, and the save-time rules hold', async () => {
  const hostile = [
    'back`tick` ${globalThis.fetch("x")} `${window}`',
    '</script><script>alert(1)</script>',
    '<iframe src="https://evil.example"></iframe>',
    '{window.location} }} {{ {DATA.title}',
    'quotes " \' \\" \\\' and \\u0022',
    'new\nline\r\nand\ttab\u2028sep\u2029para',
    '*/ /* // <!-- --> ]]> $& $1 $\' $`',
    '}; export const x = 1; export default function y() {}; //',
    '"; import("evil"); const z = "',
  ];
  file('clips-hostile.json', hostile.map((label, i) => ({ session_id: 'S1', start_s: i * 100, end_s: i * 100 + 10, label, session_title: '</script>`${document.cookie}`' })));
  file('media-hostile.json', [item(ids.a, 0, { duration_s: 5000 })]);
  const title = 'T `${eval("1")}` </script> {x} "q"\n<iframe>';
  const r = await dashboard('--clips', 'clips-hostile.json', '--media-json', 'media-hostile.json', '--out', 'hostile.tsx', '--title', title, '--save-args', 'hostile-args.json');
  assert.equal(r.code, 0, r.stderr);
  const { data, code } = split(r.tsx);

  // Data in, data out: exactly the cleaned labels and titles, as JSON.
  assert.deepEqual(data.players[0]?.clips.map((c) => c.label), hostile.map((l) => cleanText(l)));
  assert.equal(data.title, cleanText(title));
  assert.equal(data.players[0]?.title, cleanText('</script>`${document.cookie}`'));
  // The code does not depend on the data: it is the template, byte for byte.
  assert.equal(code, TEMPLATE);
  // The DATA line holds no character that could end a string or a script context.
  const dataLine = r.tsx.split('\n').find((l) => l.startsWith('const DATA = ')) as string;
  assert.doesNotMatch(dataLine, /[<>&\n\r\u2028\u2029]/);
  assert.doesNotMatch(r.tsx, /<\/script/i);
  assert.doesNotMatch(r.tsx, /<(script|iframe)\b/i);

  checkSaveRules(r.tsx);
  // save_dashboard arguments carry the same source.
  const args = JSON.parse(readFileSync(join(box.cwd, 'hostile-args.json'), 'utf8'));
  assert.deepEqual(args, { title: cleanText(title), tsx: r.tsx, scope: { kind: 'session', session_id: 'S1' } });
});

/** autologger's save-time rules ("Save-time validation"), checked on the source. */
function checkSaveRules(tsx: string): void {
  assert.ok(tsx.length <= MAX_TSX_CHARS);
  assert.ok(!tsx.includes('\0'));
  const { code } = split(tsx);
  // Imports: static, named, from the allowlist; at most 60 bindings.
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
  // Exports: exactly one export default, a function component; no other export.
  assert.equal([...code.matchAll(/\bexport\b/g)].length, 1);
  assert.match(code, /^export default function [A-Z]\w*\(\) \{$/m);
  // JSX: no denied intrinsic element, no raw HTML, no string handlers.
  const bare = codeOnly(code);
  for (const [, tag] of bare.matchAll(/<\/?([A-Za-z][\w.:-]*)/g)) assert.ok(!(DENIED_ELEMENTS as readonly string[]).includes((tag as string).toLowerCase().split(':').pop() as string), String(tag));
  assert.doesNotMatch(bare, /dangerouslySetInnerHTML|srcDoc/i);
  assert.doesNotMatch(bare, /\son[A-Z]\w*=\s*['"]/);
  assert.doesNotMatch(bare, /\bref=/);
  // Denylist: no free reference to a denied global (the template uses none of these names at all).
  for (const name of DENIED_GLOBALS) assert.doesNotMatch(bare, new RegExp(`(?<![\\w$.])${name}(?![\\w$])`), name);
  assert.doesNotMatch(bare, /\bawait\b/);
}

test('the generated imports are on the custom-dashboards allowlist', () => {
  for (const [from, names] of Object.entries(DASHBOARD_IMPORTS)) {
    const allowed = IMPORT_ALLOWLIST[from];
    assert.ok(allowed, from);
    for (const name of names) assert.ok(allowed.includes(name), `${name} from ${from}`);
  }
  assert.ok(DASHBOARD_IMPORTS['@autologger/dashboard']?.includes('YouTubePlayer'));
});

// The copied rules match autologger's contract, when an autologger-2 checkout is on this machine.
const contract = join(process.env.AUTOLOGGER_REPO ?? '/home/autologger/autologger-2', 'packages', 'contract', 'src', 'customDashboards.ts');
test('the copied allowlist and denylists match autologger-2 packages/contract/src/customDashboards.ts', { skip: existsSync(contract) ? false : `no ${contract}` }, () => {
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
});

test('a session whose media is not YouTube is refused (exit 1)', async () => {
  file('clips-s1.json', [{ session_id: 'S1', start_s: 1, end_s: 5 }]);
  file('media-local.json', [{ ordinal: 1, kind: 'local', url: null, video_id: null, file_name: 'Episode', duration_s: 60, take_start_s: 0 }]);
  const r = await dashboard('--clips', 'clips-s1.json', '--media-json', 'media-local.json', '--out', 'x.tsx');
  assert.equal(r.code, EXIT.failure);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^autologger-clips: session S1 has no YouTube media \(it has local\); a dashboard can only embed a YouTube video\n$/);
  assert.equal(existsSync(join(box.cwd, 'x.tsx')), false);
});

for (const bad of ['dQw4w9WgXc', 'dQw4w9WgXcQQ', '../evil/xx', 'dQw4w9WgX"Q', 'dQw4w9WgX?Q']) {
  test(`a video_id that is not one (${JSON.stringify(bad)}) is refused (exit 1)`, async () => {
    file('media-bad.json', [{ ...item(ids.a, 0), video_id: bad, url: null }]);
    const r = await dashboard('--clips', 'clips-s1.json', '--media-json', 'media-bad.json', '--out', 'bad.tsx');
    assert.equal(r.code, EXIT.failure);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /has no valid YouTube video id/);
    assert.equal(existsSync(join(box.cwd, 'bad.tsx')), false);
  });
}

test('clips of sessions with different videos need --compilation; with it, one player per video in compile order', async () => {
  file('clips-multi.json', [
    { session_id: 'S2', start_s: 50, end_s: 60, label: 'Two', session_date: '2026-02-01', session_title: 'Episode 2' },
    { session_id: 'S1', start_s: 10, end_s: 20, label: 'One', session_date: '2026-01-01', session_title: 'Episode 1' },
    { session_id: 'S1', start_s: 30, end_s: 40, label: 'One b', session_date: '2026-01-01', session_title: 'Episode 1' },
  ]);
  file('media-s1.json', toolResult([item(ids.a, 5)]));
  file('media-s2.json', toolResult([item(ids.b, 0)]));
  const media = ['--media-json', 'S1=media-s1.json', '--media-json', 'S2=media-s2.json'];
  const refused = await dashboard('--clips', 'clips-multi.json', ...media, '--out', 'multi.tsx');
  assert.equal(refused.code, EXIT.failure);
  assert.match(refused.stderr, /the clips come from 2 different YouTube videos \(sessions S2, S1\); pass --compilation/);
  assert.equal(existsSync(join(box.cwd, 'multi.tsx')), false);

  const r = await dashboard('--clips', 'clips-multi.json', ...media, '--out', 'multi.tsx', '--compilation');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.report.players.map((p: any) => [p.video_id, p.title, p.session_ids, p.clips.map((c: any) => [c.label, c.video_start_s, c.video_end_s])]), [
    [ids.a, 'Episode 1', ['S1'], [['One', 5, 15], ['One b', 25, 35]]],
    [ids.b, 'Episode 2', ['S2'], [['Two', 50, 60]]],
  ]);
  assert.equal(r.report.title, 'Clip compilation');
  assert.equal(r.report.session_id, null);
  const { data } = split(r.tsx);
  assert.deepEqual(data.players.map((p) => p.video_id), [ids.a, ids.b]);
  checkSaveRules(r.tsx);

  const listOrder = await dashboard('--clips', 'clips-multi.json', ...media, '--out', 'multi-list.tsx', '--compilation', '--order', 'list');
  assert.deepEqual(listOrder.report.players.map((p: any) => p.video_id), [ids.b, ids.a]);

  // Saving needs one session: --session picks it.
  const noScope = await call(ctx, 'dashboard', '--clips', 'clips-multi.json', ...media, '--out', 'm.tsx', '--compilation', '--save-args', 'm.json');
  assert.equal(noScope.code, EXIT.usage);
  assert.match(noScope.stderr, /name the one to save the dashboard on with --session <session_id>/);
  const scoped = await dashboard('--clips', 'clips-multi.json', ...media, '--out', 'm.tsx', '--compilation', '--save-args', 'm.json', '--session', 'S2');
  assert.equal(scoped.code, 0, scoped.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(box.cwd, 'm.json'), 'utf8')).scope, { kind: 'session', session_id: 'S2' });
  const notInList = await call(ctx, 'dashboard', '--clips', 'clips-multi.json', ...media, '--out', 'm.tsx', '--compilation', '--save-args', 'm.json', '--session', 'S9');
  assert.equal(notInList.code, EXIT.usage);
});

test('sessions sharing one video need no --compilation', async () => {
  file('clips-shared.json', [
    { session_id: 'S1', start_s: 10, end_s: 20 },
    { session_id: 'S2', start_s: 10, end_s: 20 },
  ]);
  file('media-shared.json', [item(ids.a, 0)]);
  file('media-shared2.json', [item(ids.a, 5)]);
  const r = await dashboard('--clips', 'clips-shared.json', '--media-json', 'S1=media-shared.json', '--media-json', 'S2=media-shared2.json', '--out', 'shared.tsx', '--save-args', 'shared.json', '--session', 'S1');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.report.players.length, 1);
  assert.deepEqual(r.report.players[0].session_ids, ['S1', 'S2']);
});

test('more than 8 videos are refused: autologger draws at most 8 players at once', async () => {
  const sessions = Array.from({ length: 9 }, (_, i) => `S${i + 1}`);
  file('clips-nine.json', sessions.map((s) => ({ session_id: s, start_s: 1, end_s: 2 })));
  const media = sessions.flatMap((s, i) => ['--media-json', `${s}=${file(`media-nine-${i}.json`, [item(`video${String(i).padStart(6, '0')}`, 0)])}`]);
  const r = await dashboard('--clips', 'clips-nine.json', ...media, '--out', 'nine.tsx', '--compilation', '--order', 'list');
  assert.equal(r.code, EXIT.failure);
  assert.match(r.stderr, /from 9 YouTube videos; autologger shows at most 8 players/);
});

test('a dashboard over 100,000 characters is refused, never truncated', async () => {
  file('clips-big.json', Array.from({ length: 600 }, (_, i) => ({ session_id: 'S1', start_s: i * 10, end_s: i * 10 + 5, label: `${'x'.repeat(190)} ${i}` })));
  file('media-big.json', [item(ids.a, 0, { duration_s: 10_000 })]);
  const r = await dashboard('--clips', 'clips-big.json', '--media-json', 'media-big.json', '--out', 'big.tsx');
  assert.equal(r.code, EXIT.failure);
  assert.match(r.stderr, /over autologger's 100000; split the clip list/);
  assert.equal(existsSync(join(box.cwd, 'big.tsx')), false);
});

test('a range past 86,400 s of video is refused (the player cannot play it)', async () => {
  file('clips-late.json', [{ session_id: 'S1', start_s: 90_000, end_s: 90_010 }]);
  file('media-late.json', [item(ids.a, 0, { duration_s: null })]);
  const r = await dashboard('--clips', 'clips-late.json', '--media-json', 'media-late.json', '--out', 'late.tsx');
  assert.equal(r.code, EXIT.failure);
  assert.match(r.stderr, /past the 86400 s the YouTube player accepts/);
});

test('when every range falls outside the video, the refusal names the take offset', async () => {
  file('media-after.json', [item(ids.a, 3000)]);
  const r = await dashboard('--clips', 'clips-s1.json', '--media-json', 'media-after.json', '--out', 'after.tsx');
  assert.equal(r.code, EXIT.failure);
  assert.match(r.stderr, /no clip is left: every range falls outside its session's YouTube video \(video time = session time - take_start_s\)/);
});

test('several YouTube takes: --ordinal picks one', async () => {
  file('media-takes.json', [item(ids.a, 0), { ...item(ids.b, 0), ordinal: 2 }]);
  const refused = await dashboard('--clips', 'clips-s1.json', '--media-json', 'media-takes.json', '--out', 'takes.tsx');
  assert.equal(refused.code, EXIT.failure);
  assert.match(refused.stderr, /pick one with --ordinal <n>/);
  const r = await dashboard('--clips', 'clips-s1.json', '--media-json', 'media-takes.json', '--out', 'takes.tsx', '--ordinal', '2');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.report.players[0].video_id, ids.b);
});

for (const [argv, message] of [
  [['--media-json', 'media1.json', '--out', 'x.tsx'], /needs --clips/],
  [['--clips', 'clips1.json', '--out', 'x.tsx'], /needs --media-json/],
  [['--clips', 'clips1.json', '--media-json', 'media1.json'], /needs --out <file\.tsx>/],
  [['--clips', 'clips1.json', '--media-json', 'media1.json', '--out', 'x.html'], /--out must end in \.tsx/],
  [['--clips', 'clips-multi.json', '--media-json', 'media-s1.json', '--out', 'x.tsx', '--compilation'], /give --media-json <session_id>=<file> for each/],
  [['--clips', 'clips-multi.json', '--media-json', 'S1=media-s1.json', '--out', 'x.tsx', '--compilation'], /no --media-json for session S2/],
  [['--clips', 'clips1.json', '--media-json', 'S9=media1.json', '--out', 'x.tsx'], /session S9 is not in the clip list/],
  [['--clips', 'clips1.json', '--media-json', 'media1.json', '--media-json', 'S1=media1.json', '--out', 'x.tsx'], /given twice for session S1/],
  [['--clips', 'clips1.json', '--media-json', 'media1.json', '--out', 'x.tsx', '--session', 'S1'], /needs --save-args/],
  [['--clips', 'clips1.json', '--media-json', 'media1.json', '--out', 'x.tsx', '--fps', '30'], /dashboard does not take --fps/],
  [['--clips', 'clips1.json', '--media-json', 'nope.json', '--out', 'x.tsx'], /--media-json file .* does not exist/],
] as const) {
  test(`dashboard usage error: ${argv.join(' ')}`, async () => {
    const r = await call(ctx, 'dashboard', ...argv, '--json');
    assert.equal(r.code, EXIT.usage, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, message);
  });
}

test('media fetch still takes exactly one --media-json', async () => {
  const r = await call(ctx, 'media', 'fetch', 'S1', '--media-json', 'a.json', '--media-json', 'b.json');
  assert.equal(r.code, EXIT.usage);
  assert.match(r.stderr, /media fetch takes one --media-json <file>/);
});

test('without --json, dashboard prints a short summary', async () => {
  const r = await call(ctx, 'dashboard', '--clips', 'clips1.json', '--media-json', 'media1.json', '--out', 'plain.tsx');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Wrote .*plain\.tsx \("Clips: Episode 1", 1 player, 3 clips, \d+ characters\)\.\n/);
});
