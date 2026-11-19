// timeline: clip list + media map -> FCPXML 1.10 / OTIO, with exact in/out times at 29.97 drop-frame
// and 24 fps, merging (after padding), clamping and dropping.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { checkFcpxml, find, parseXml, timeFraction } from './fcpxmlDtd.ts';
import { call, mp4, sandbox } from './helpers.ts';

const box = sandbox();
const ctx = { env: box.env, cwd: box.cwd };
const s1Video = join(box.cwd, 'session one.mp4'); // a space: the file URL must encode it
const s2Video = join(box.cwd, 's2.mp4');
writeFileSync(s1Video, mp4({ durationS: 1800, fpsNum: 30000, fpsDen: 1001, width: 1920, height: 1080 }));
writeFileSync(s2Video, mp4({ durationS: 60, fpsNum: 24, width: 1280, height: 720 }));
const hasXmllint = spawnSync('xmllint', ['--version']).status === 0;

const json = (file: string, value: unknown): string => {
  writeFileSync(join(box.cwd, file), JSON.stringify(value));
  return file;
};

test('setup: map both sessions', async () => {
  assert.equal((await call(ctx, 'media', 'set', 'S1', 'session one.mp4', '--offset', '600')).code, 0);
  assert.equal((await call(ctx, 'media', 'set', 'S2', 's2.mp4')).code, 0);
});

const CLIPS_2997 = [
  { session_id: 'S1', start_s: 1200, end_s: 1205.5, label: 'Pasta' },
  { session_id: 'S1', start_s: 1205.5, end_s: 1210, label: 'more' },
  { session_id: 'S1', start_s: 610, end_s: 615, label: 'intro' },
  { session_id: 'S1', start_s: 2390, end_s: 2500, label: 'tail' },
  { session_id: 'S1', start_s: 100, end_s: 200, label: 'before the video' },
];

test('FCPXML at 29.97 drop-frame: exact in/out, list order, adjacent ranges merged, clamped and dropped reported', async () => {
  const { code, stdout, stderr } = await call(ctx, 'timeline', '--clips', json('c2997.json', CLIPS_2997), '--out', 'out/a.fcpxml', '--fps', '29.97', '--json');
  assert.equal(code, 0, stderr);
  const report = JSON.parse(stdout);
  assert.equal(report.out, join(box.cwd, 'out', 'a.fcpxml'));
  assert.deepEqual([report.fps, report.frame_duration, report.drop_frame, report.duration_frames, report.duration_tc], ['29.97', '1001/30000s', true, 750, '00:00:25;00']);
  assert.deepEqual(
    report.clips.map((c: Record<string, unknown>) => [c.from, c.name, c.source_in, c.source_out, c.record_in, c.source_in_tc, c.source_out_tc, c.record_in_tc]),
    [
      [[1, 2], 'Pasta / more', '2999997/5000s', '3050047/5000s', '0s', '00:10:00;00', '00:10:10;00', '00:00:00;00'],
      [[3], 'intro', '1001/100s', '3003/200s', '1001/100s', '00:00:10;00', '00:00:15;00', '00:00:10;00'],
      [[4], 'tail', '8949941/5000s', '8999991/5000s', '3003/200s', '00:29:50;00', '00:30:00;00', '00:00:15;00'],
    ],
  );
  assert.deepEqual(report.merged, [{ from: [1, 2], session_id: 'S1', session_start_s: 1200, session_end_s: 1210 }]);
  assert.deepEqual(report.clamped, [{ from: [4], session_id: 'S1', requested_video_s: [1790, 1900], kept_video_s: [1790, 1800] }]);
  assert.deepEqual(report.dropped, [{ from: [5], session_id: 'S1', requested_video_s: [-500, -400], reason: 'ends before the video starts' }]);
  assert.deepEqual(report.media_files, [s1Video]);

  const text = readFileSync(report.out, 'utf8');
  assert.match(text, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1\.10">/);
  if (hasXmllint) assert.equal(spawnSync('xmllint', ['--noout', report.out]).status, 0, 'xmllint: not well-formed');
  const doc = parseXml(text);
  assert.deepEqual(checkFcpxml(doc), []);
  const [format] = find(doc, 'format');
  assert.deepEqual(format?.attrs, { id: 'r1', name: 'FFVideoFormat1080p2997', frameDuration: '1001/30000s', width: '1920', height: '1080' });
  const [asset] = find(doc, 'asset');
  assert.equal(asset?.attrs.duration, '8999991/5000s'); // 53946 frames: the whole 1800 s video, on the frame grid
  assert.equal(find(doc, 'media-rep')[0]?.attrs.src, pathToFileURL(s1Video).href);
  assert.match(find(doc, 'media-rep')[0]?.attrs.src ?? '', /session%20one\.mp4$/);
  const [sequence] = find(doc, 'sequence');
  assert.deepEqual([sequence?.attrs.tcFormat, sequence?.attrs.duration, sequence?.attrs.format], ['DF', '1001/40s', 'r1']);
  const clips = find(doc, 'asset-clip');
  assert.deepEqual(
    clips.map((c) => [c.attrs.ref, c.attrs.name, c.attrs.offset, c.attrs.start, c.attrs.duration]),
    [
      ['r2', 'Pasta / more', '0s', '2999997/5000s', '1001/100s'],
      ['r2', 'intro', '1001/100s', '1001/100s', '1001/200s'],
      ['r2', 'tail', '3003/200s', '8949941/5000s', '1001/100s'],
    ],
  );
  // The spine has no holes: each clip starts where the previous one ends, all on the frame grid.
  let end = 0;
  for (const c of clips) {
    const [on, od] = timeFraction(c.attrs.offset as string);
    assert.equal(on / od, end);
    for (const t of [c.attrs.offset, c.attrs.start, c.attrs.duration]) {
      const [n, d] = timeFraction(t as string);
      assert.ok(Number.isInteger(Math.round(((n * 30000) / d / 1001) * 1e6) / 1e6), `${t} is not a whole frame`);
    }
    const [dn, dd] = timeFraction(c.attrs.duration as string);
    end = on / od + dn / dd;
  }
});

test('OTIO at 24 fps: --pad is applied, exact source ranges, file references, linked audio track', async () => {
  const clips = [
    { session_id: 'S2', start_s: 10.25, end_s: 12.5, label: 'a' },
    { session_id: 'S2', start_s: 30, end_s: 31, label: 'b' },
  ];
  const { code, stdout, stderr } = await call(ctx, 'timeline', '--clips', json('c24.json', clips), '--out', 'b.otio', '--fps', '24', '--pad', '0.5', '--json');
  assert.equal(code, 0, stderr);
  const report = JSON.parse(stdout);
  assert.deepEqual(report.clips.map((c: Record<string, unknown>) => [c.video_in_s, c.video_out_s, c.source_in_tc, c.source_out_tc]), [
    [9.75, 13, '00:00:09:18', '00:00:13:00'],
    [29.5, 31.5, '00:00:29:12', '00:00:31:12'],
  ]);
  const doc = JSON.parse(readFileSync(report.out, 'utf8'));
  assert.equal(doc.OTIO_SCHEMA, 'Timeline.1');
  assert.deepEqual(doc.global_start_time, { OTIO_SCHEMA: 'RationalTime.1', rate: 24, value: 0 });
  assert.equal(doc.tracks.OTIO_SCHEMA, 'Stack.1');
  const [video, audio] = doc.tracks.children;
  assert.deepEqual([video.OTIO_SCHEMA, video.kind, audio.OTIO_SCHEMA, audio.kind], ['Track.1', 'Video', 'Track.1', 'Audio']);
  for (const track of [video, audio]) {
    for (const key of ['name', 'children', 'source_range', 'effects', 'markers', 'enabled', 'metadata']) assert.ok(key in track, `Track.1 ${key}`);
    assert.deepEqual(
      track.children.map((c: { OTIO_SCHEMA: string; source_range: { start_time: { value: number; rate: number }; duration: { value: number; rate: number } } }) => [
        c.OTIO_SCHEMA,
        c.source_range.start_time.value,
        c.source_range.duration.value,
        c.source_range.start_time.rate,
      ]),
      [
        ['Clip.2', 234, 78, 24],
        ['Clip.2', 708, 48, 24],
      ],
    );
  }
  const clip = video.children[0];
  for (const key of ['name', 'source_range', 'media_references', 'active_media_reference_key', 'effects', 'markers', 'enabled', 'metadata']) assert.ok(key in clip, `Clip.2 ${key}`);
  assert.equal(clip.name, 'a');
  const ref = clip.media_references[clip.active_media_reference_key];
  assert.equal(ref.OTIO_SCHEMA, 'ExternalReference.1');
  assert.equal(ref.target_url, pathToFileURL(s2Video).href);
  assert.deepEqual(ref.available_range, {
    OTIO_SCHEMA: 'TimeRange.1',
    duration: { OTIO_SCHEMA: 'RationalTime.1', rate: 24, value: 1440 },
    start_time: { OTIO_SCHEMA: 'RationalTime.1', rate: 24, value: 0 },
  });
  assert.equal(clip.metadata.openreel.linkId, audio.children[0].metadata.openreel.linkId);
  assert.equal(audio.metadata.openreel.linkedAudioOf, 'V1');
});

test('FCPXML at 24 fps: whole-second rationals', async () => {
  const clips = [{ session_id: 'S2', start_s: 10.25, end_s: 12.5, label: 'a' }];
  const { code, stdout } = await call(ctx, 'timeline', '--clips', json('c24b.json', clips), '--out', 'c.fcpxml', '--fps', '24', '--json');
  assert.equal(code, 0);
  const doc = parseXml(readFileSync(JSON.parse(stdout).out, 'utf8'));
  assert.deepEqual(checkFcpxml(doc), []);
  assert.equal(find(doc, 'format')[0]?.attrs.frameDuration, '1/24s');
  assert.equal(find(doc, 'sequence')[0]?.attrs.tcFormat, 'NDF');
  const [c] = find(doc, 'asset-clip');
  assert.deepEqual([c?.attrs.start, c?.attrs.duration, c?.attrs.offset], ['41/4s', '9/4s', '0s']);
});

test('padding is applied before merging: ranges that touch only once padded become one clip', async () => {
  const clips = [
    { session_id: 'S2', start_s: 1, end_s: 2, label: 'x' },
    { session_id: 'S2', start_s: 2.6, end_s: 3, label: 'y' },
  ];
  const file = json('pad.json', clips);
  const unpadded = JSON.parse((await call(ctx, 'timeline', '--clips', file, '--out', 'p.otio', '--fps', '24', '--json')).stdout);
  assert.equal(unpadded.clips.length, 2);
  const padded = JSON.parse((await call(ctx, 'timeline', '--clips', file, '--out', 'p.otio', '--fps', '24', '--pad', '0.3', '--json')).stdout);
  assert.deepEqual(padded.clips.map((c: Record<string, unknown>) => [c.from, c.name, c.video_in_s, c.video_out_s]), [[[1, 2], 'x / y', 0.7, 3.3]]);
});

test('without --fps the first clip video rate is used', async () => {
  const { stdout } = await call(ctx, 'timeline', '--clips', 'c24b.json', '--out', 'd.fcpxml', '--json');
  assert.equal(JSON.parse(stdout).fps, '24');
});

test('labels are data: escaped in XML, control characters removed', async () => {
  const clips = [{ session_id: 'S2', start_s: 1, end_s: 2, label: 'a "quote" <b>&\u0007 ]]> \n x' }];
  const { code, stdout } = await call(ctx, 'timeline', '--clips', json('esc.json', clips), '--out', 'e.fcpxml', '--json');
  assert.equal(code, 0);
  const text = readFileSync(JSON.parse(stdout).out, 'utf8');
  assert.match(text, /name="a &quot;quote&quot; &lt;b&gt;&amp; \]\]&gt; x"/);
  assert.equal(find(parseXml(text), 'asset-clip')[0]?.attrs.name, 'a "quote" <b>& ]]> x');
});

test('errors: unmapped session (exit 1, names media set), bad clip list (1), bad --out or missing options (2)', async () => {
  const unmapped = await call(ctx, 'timeline', '--clips', json('u.json', [{ session_id: 'S9', start_s: 0, end_s: 1 }]), '--out', 'u.fcpxml');
  assert.equal(unmapped.code, 1);
  assert.equal(unmapped.stdout, '');
  assert.match(unmapped.stderr, /^autologger-clips: no video is mapped for session S9; map one with `media set <session_id> <video file>`/);
  for (const [bad, message] of [
    [[{ session_id: 'S2', start_s: 5, end_s: 5 }], /clip 1: end_s \(5\) must be after start_s \(5\)/],
    [[{ session_id: '../x', start_s: 0, end_s: 1 }], /clip 1: session_id must be a session id string/],
    [{ nope: 1 }, /must be a JSON array of clips/],
    [[], /has no clips/],
  ] as const) {
    const r = await call(ctx, 'timeline', '--clips', json('bad.json', bad), '--out', 'x.otio');
    assert.equal(r.code, 1, JSON.stringify(bad));
    assert.match(r.stderr, message);
  }
  const allDropped = await call(ctx, 'timeline', '--clips', json('gone.json', [{ session_id: 'S2', start_s: 100, end_s: 120 }]), '--out', 'g.otio');
  assert.equal(allDropped.code, 1);
  assert.match(allDropped.stderr, /no clip is left/);
  for (const argv of [
    ['timeline', '--clips', 'c24.json', '--out', 'x.mov'],
    ['timeline', '--out', 'x.otio'],
    ['timeline', '--clips', 'c24.json'],
    ['timeline', '--clips', 'c24.json', '--out', 'x.otio', '--fps', '31'],
    ['timeline', '--clips', 'c24.json', '--out', 'x.otio', '--pad', '-1'],
    ['timeline', '--clips', 'c24.json', '--out', 'x.otio', '--title-cards'],
    ['timeline', '--clips', 'nope.json', '--out', 'x.otio'],
  ]) {
    const r = await call(ctx, ...argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.equal(r.stdout, '');
  }
});
