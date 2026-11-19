// compile: a compilation across three sessions, ordered by session date then time (or list order),
// with optional title cards.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkFcpxml, find, parseXml } from './fcpxmlDtd.ts';
import { call, mp4, sandbox } from './helpers.ts';

const box = sandbox();
const ctx = { env: box.env, cwd: box.cwd };
for (const s of ['A', 'B', 'C']) writeFileSync(join(box.cwd, `${s}.mp4`), mp4({ durationS: 600, fpsNum: 25, width: 1280, height: 720 }));

// A playlist's three sessions, listed out of date order, B twice.
const CLIPS = [
  { session_id: 'A', start_s: 100, end_s: 110, label: 'A late', session_date: '2026-03-01T19:00:00Z', session_title: 'Episode 3' },
  { session_id: 'B', start_s: 200, end_s: 205, label: 'B second', session_date: '2026-01-15', session_title: 'Episode 1' },
  { session_id: 'C', start_s: 50, end_s: 60, label: 'C only', session_date: '2026-02-10', session_title: 'Episode 2' },
  { session_id: 'B', start_s: 20, end_s: 25, label: 'B first', session_date: '2026-01-15', session_title: 'Episode 1' },
];
writeFileSync(join(box.cwd, 'playlist.json'), JSON.stringify(CLIPS));

test('setup: map the three sessions (B starts 5 s into its video)', async () => {
  for (const s of ['A', 'C']) assert.equal((await call(ctx, 'media', 'set', s, `${s}.mp4`)).code, 0);
  assert.equal((await call(ctx, 'media', 'set', 'B', 'B.mp4', '--offset=-5')).code, 0);
});

test('date order: sessions by date, clips by time, one title card per session', async () => {
  const { code, stdout, stderr } = await call(ctx, 'compile', '--clips', 'playlist.json', '--out', 'p.fcpxml', '--title-cards', '--json');
  assert.equal(code, 0, stderr);
  const report = JSON.parse(stdout);
  assert.equal(report.fps, '25');
  assert.deepEqual(report.clips.map((c: Record<string, unknown>) => [c.position, c.name, c.video_in_s, c.record_in_tc]), [
    [2, 'B first', 25, '00:00:03:00'],
    [3, 'B second', 205, '00:00:08:00'],
    [5, 'C only', 50, '00:00:16:00'],
    [7, 'A late', 100, '00:00:29:00'],
  ]);
  assert.deepEqual(report.title_cards.map((t: Record<string, unknown>) => [t.position, t.text, t.record_in_tc]), [
    [1, 'Episode 1 (2026-01-15)', '00:00:00:00'],
    [4, 'Episode 2 (2026-02-10)', '00:00:13:00'],
    [6, 'Episode 3 (2026-03-01)', '00:00:26:00'],
  ]);
  assert.equal(report.duration_tc, '00:00:39:00');
  const doc = parseXml(readFileSync(report.out, 'utf8'));
  assert.deepEqual(checkFcpxml(doc), []);
  const spine = find(doc, 'spine')[0];
  assert.deepEqual(spine?.children.map((c) => [c.name, c.attrs.name, c.attrs.offset, c.attrs.duration]), [
    ['gap', 'Episode 1 (2026-01-15)', '0s', '3s'],
    ['asset-clip', 'B first', '3s', '5s'],
    ['asset-clip', 'B second', '8s', '5s'],
    ['gap', 'Episode 2 (2026-02-10)', '13s', '3s'],
    ['asset-clip', 'C only', '16s', '10s'],
    ['gap', 'Episode 3 (2026-03-01)', '26s', '3s'],
    ['asset-clip', 'A late', '29s', '10s'],
  ]);
  const gap = spine?.children[0];
  assert.deepEqual(gap?.children.map((c) => c.name), ['title', 'marker']);
  assert.equal(find(gap!, 'text-style')[0]?.text, 'Episode 1 (2026-01-15)');
  assert.equal(find(doc, 'effect')[0]?.attrs.name, 'Basic Title');
  // Three assets, one per session, each clip pointing at its own session's file.
  assert.deepEqual(find(doc, 'asset').map((a) => a.attrs.name).sort(), ['A.mp4', 'B.mp4', 'C.mp4']);
  const refOf = Object.fromEntries(find(doc, 'asset').map((a) => [a.attrs.id, a.attrs.name]));
  assert.deepEqual(find(doc, 'asset-clip').map((c) => refOf[c.attrs.ref as string]), ['B.mp4', 'B.mp4', 'C.mp4', 'A.mp4']);
});

test('--order list keeps the list order, with a title card each time the session changes (OTIO)', async () => {
  const { code, stdout } = await call(ctx, 'compile', '--clips', 'playlist.json', '--out', 'p.otio', '--order', 'list', '--title-cards', '--title-seconds', '2', '--json');
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.deepEqual(report.clips.map((c: Record<string, unknown>) => c.name), ['A late', 'B second', 'C only', 'B first']);
  assert.equal(report.title_cards.length, 4);
  const doc = JSON.parse(readFileSync(report.out, 'utf8'));
  const video = doc.tracks.children[0];
  assert.deepEqual(video.children.map((c: { OTIO_SCHEMA: string; name: string; source_range: { duration: { value: number } } }) => [c.OTIO_SCHEMA, c.name, c.source_range.duration.value]), [
    ['Gap.1', 'Episode 3 (2026-03-01)', 50],
    ['Clip.2', 'A late', 250],
    ['Gap.1', 'Episode 1 (2026-01-15)', 50],
    ['Clip.2', 'B second', 125],
    ['Gap.1', 'Episode 2 (2026-02-10)', 50],
    ['Clip.2', 'C only', 250],
    ['Gap.1', 'Episode 1 (2026-01-15)', 50],
    ['Clip.2', 'B first', 125],
  ]);
  assert.deepEqual(doc.tracks.markers.map((m: { OTIO_SCHEMA: string; name: string; marked_range: { start_time: { value: number } } }) => [m.OTIO_SCHEMA, m.name, m.marked_range.start_time.value]), [
    ['Marker.2', 'Episode 3 (2026-03-01)', 0],
    ['Marker.2', 'Episode 1 (2026-01-15)', 300],
    ['Marker.2', 'Episode 2 (2026-02-10)', 475],
    ['Marker.2', 'Episode 1 (2026-01-15)', 775],
  ]);
});

test('without --title-cards there are only clips; a session with no date fails date order (exit 1)', async () => {
  const plain = JSON.parse((await call(ctx, 'compile', '--clips', 'playlist.json', '--out', 'q.otio', '--json')).stdout);
  assert.equal(plain.title_cards.length, 0);
  assert.equal(plain.duration_tc, '00:00:30:00');
  writeFileSync(join(box.cwd, 'undated.json'), JSON.stringify([...CLIPS, { session_id: 'C', start_s: 1, end_s: 2 }, { session_id: 'D', start_s: 1, end_s: 2 }]));
  assert.equal((await call(ctx, 'media', 'set', 'D', 'C.mp4')).code, 0);
  const r = await call(ctx, 'compile', '--clips', 'undated.json', '--out', 'u.otio');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /session D has no session_date in the clip list; add session_date .* or use --order list/);
  assert.equal((await call(ctx, 'compile', '--clips', 'undated.json', '--out', 'u.otio', '--order', 'list')).code, 0);
  assert.equal((await call(ctx, 'compile', '--clips', 'playlist.json', '--out', 'u.otio', '--order', 'random')).code, 2);
});
