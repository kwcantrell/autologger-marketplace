// media set|list|remove (the per-user map, 0600) and media fetch (yt-dlp, faked: no network).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { YTDLP_FORMAT, ytdlpArgs } from '../src/fetch.ts';
import { configDir } from '../src/media.ts';
import type { RunOptions, Runner } from '../src/runner.ts';
import { call, mp4, sandbox } from './helpers.ts';

test('set, list and remove keep a 0600 map in the config dir', async () => {
  const box = sandbox();
  const ctx = { env: box.env, cwd: box.cwd };
  writeFileSync(join(box.cwd, 'v.mp4'), mp4({ durationS: 30 }));
  const set = await call(ctx, 'media', 'set', 'S1', 'v.mp4', '--offset', '12.5', '--json');
  assert.equal(set.code, 0, set.stderr);
  const result = JSON.parse(set.stdout);
  assert.deepEqual([result.entry.session_id, result.entry.path, result.entry.offset_s, result.replaced, result.probe.duration_s], ['S1', join(box.cwd, 'v.mp4'), 12.5, false, 30]);
  const file = join(box.home, 'config', 'media.json');
  assert.equal(result.map_file, file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(box.home, 'config')).mode & 0o777, 0o700);

  const again = JSON.parse((await call(ctx, 'media', 'set', 'S1', 'v.mp4', '--duration', '29', '--json')).stdout);
  assert.deepEqual([again.replaced, again.entry.offset_s, again.entry.duration_s], [true, 0, 29]);

  const listed = JSON.parse((await call(ctx, 'media', 'list', '--json')).stdout);
  assert.deepEqual(listed.sessions.map((e: Record<string, unknown>) => [e.session_id, e.exists]), [['S1', true]]);
  assert.match((await call(ctx, 'media', 'list')).stdout, /^S1 {2}.*v\.mp4 {2}offset 0 s\n$/);

  const removed = JSON.parse((await call(ctx, 'media', 'remove', 'S1', '--json')).stdout);
  assert.equal(removed.removed, true);
  assert.equal(JSON.parse((await call(ctx, 'media', 'remove', 'S1', '--json')).stdout).removed, false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).sessions, {});
});

test('set refuses a missing file (1) and bad ids or numbers (2)', async () => {
  const box = sandbox();
  const ctx = { env: box.env, cwd: box.cwd };
  const missing = await call(ctx, 'media', 'set', 'S1', 'nope.mp4');
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /video file .*nope\.mp4 does not exist/);
  writeFileSync(join(box.cwd, 'v.mp4'), 'x');
  for (const argv of [
    ['media', 'set', '../etc', 'v.mp4'],
    ['media', 'set', 'S1', 'v.mp4', '--offset', 'soon'],
    ['media', 'set', 'S1'],
    ['media', 'set', 'S1', 'v.mp4', '--dir', 'x'],
    ['media', 'list', 'extra'],
    ['media', 'frobnicate'],
    ['media'],
  ]) {
    const r = await call(ctx, ...argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.equal(r.stdout, '');
  }
  assert.equal(existsSync(join(box.home, 'config', 'media.json')), false);
});

test('the config dir: override, else XDG_CONFIG_HOME, else ~/.config', () => {
  assert.equal(configDir({ AUTOLOGGER_CLIPS_CONFIG_DIR: '/x', HOME: '/h' }), '/x');
  assert.equal(configDir({ XDG_CONFIG_HOME: '/xdg', HOME: '/h' }), '/xdg/autologger-clips');
  assert.equal(configDir({ HOME: '/h' }), '/h/.config/autologger-clips');
});

/** A fake yt-dlp runner: records calls and "downloads" a small MP4 where -P and -o say. */
function fakeYtdlp(options: { missing?: boolean; fail?: boolean; print?: (dir: string) => string } = {}): { runner: Runner; calls: { args: readonly string[]; options?: RunOptions }[] } {
  const calls: { args: readonly string[]; options?: RunOptions }[] = [];
  const runner: Runner = async (command, args, runOptions) => {
    assert.equal(command, 'yt-dlp');
    calls.push({ args, ...(runOptions ? { options: runOptions } : {}) });
    if (options.missing) return { code: null, stdout: '', stderr: '', error: 'ENOENT' };
    if (args[0] === '--version') return { code: 0, stdout: '2026.11.01\n', stderr: '' };
    if (options.fail) {
      runOptions?.onStderr?.('ERROR: Video unavailable\n');
      return { code: 1, stdout: '', stderr: '' };
    }
    const dir = args[args.indexOf('-P') + 1] as string;
    const id = new URL(args[args.length - 1] as string).searchParams.get('v');
    runOptions?.onStderr?.('[download] 100%\n');
    writeFileSync(join(dir, `${id}.mp4`), mp4({ durationS: 3600, fpsNum: 30 }));
    return { code: 0, stdout: `${options.print ? options.print(dir) : join(dir, `${id}.mp4`)}\n`, stderr: '' };
  };
  return { runner, calls };
}

const ITEMS = [
  { ordinal: 1, recording_ordinal: 1, kind: 'recorded', url: null, video_id: null, file_name: null, duration_s: 100, take_start_s: 0, take_stop_s: 100 },
  {
    ordinal: 2,
    recording_ordinal: 2,
    kind: 'youtube',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    video_id: 'dQw4w9WgXcQ',
    file_name: null,
    duration_s: 3600,
    take_start_s: 754.25,
    take_stop_s: 4354.25,
    take_start_timecode: '00:12:34:06',
    take_stop_timecode: '01:12:34:06',
  },
];

test('fetch downloads the YouTube item with the documented flags into ~/Documents/autologger-clips/<session> and maps it with the take offset', async () => {
  const box = sandbox();
  const yt = fakeYtdlp();
  const ctx = { env: box.env, cwd: box.cwd, runner: yt.runner };
  // The whole MCP tool result, as `autologger-mcp call list_session_media --json` prints it.
  writeFileSync(join(box.cwd, 'media.json'), JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ items: ITEMS }) }], structuredContent: { items: ITEMS } }));
  const r = await call(ctx, 'media', 'fetch', 'S1', '--media-json', 'media.json', '--json');
  assert.equal(r.code, 0, r.stderr);
  const dir = join(box.home, 'Documents', 'autologger-clips', 'S1');
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.url, out.path, out.offset_s, out.dir], ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', join(dir, 'dQw4w9WgXcQ.mp4'), 754.25, dir]);
  assert.deepEqual(yt.calls[1]?.args, [
    '--no-playlist', '--no-progress', '--restrict-filenames', '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b', '--merge-output-format', 'mp4',
    '-P', dir, '-o', '%(id)s.%(ext)s', '--print', 'after_move:filepath', '--', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  ]);
  assert.equal(r.stderr, '[download] 100%\n');
  const listed = JSON.parse((await call(ctx, 'media', 'list', '--json')).stdout);
  assert.deepEqual(listed.sessions[0].source, { kind: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', video_id: 'dQw4w9WgXcQ', ordinal: 2 });
  assert.equal(listed.sessions[0].offset_s, 754.25);

  // Session time T plays at video time T - take_start_s.
  writeFileSync(join(box.cwd, 'c.json'), JSON.stringify([{ session_id: 'S1', start_s: 1000, end_s: 1010 }]));
  const t = JSON.parse((await call(ctx, 'timeline', '--clips', 'c.json', '--out', 't.otio', '--json')).stdout);
  assert.deepEqual([t.clips[0].video_in_s, t.clips[0].video_out_s], [245.75, 255.75]);
});

test('fetch accepts the bare item list or {items}, --dir and --ordinal', async () => {
  const box = sandbox();
  const yt = fakeYtdlp();
  const ctx = { env: box.env, cwd: box.cwd, runner: yt.runner };
  writeFileSync(join(box.cwd, 'items.json'), JSON.stringify(ITEMS));
  const r = await call(ctx, 'media', 'fetch', 'S1', '--media-json', 'items.json', '--dir', 'dl', '--ordinal', '2', '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).path, join(box.cwd, 'dl', 'dQw4w9WgXcQ.mp4'));
  const two = [ITEMS[1], { ...ITEMS[1], ordinal: 3, video_id: 'aaaaaaaaaaa', url: 'https://youtu.be/aaaaaaaaaaa' }];
  writeFileSync(join(box.cwd, 'two.json'), JSON.stringify({ items: two }));
  const ambiguous = await call(ctx, 'media', 'fetch', 'S1', '--media-json', 'two.json');
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /2 YouTube takes \(ordinals 2, 3\); pick one with --ordinal <n>/);
  const picked = await call(ctx, 'media', 'fetch', 'S1', '--media-json', 'two.json', '--ordinal', '3', '--json');
  assert.equal(JSON.parse(picked.stdout).video_id, 'aaaaaaaaaaa');
});

test('fetch refuses anything that is not a YouTube source autologger recorded for the session', async () => {
  const box = sandbox();
  const yt = fakeYtdlp();
  const ctx = { env: box.env, cwd: box.cwd, runner: yt.runner };
  const cases: [unknown, RegExp][] = [
    [[ITEMS[0]], /no YouTube media \(it has recorded\); map a local video file with media set instead/],
    [[{ ...ITEMS[1], video_id: 'x; rm -rf /' }], /no valid YouTube video id/],
    [[{ ...ITEMS[1], url: 'https://evil.example/watch?v=dQw4w9WgXcQ' }], /is not the YouTube video dQw4w9WgXcQ/],
    [[{ ...ITEMS[1], take_start_s: null }], /has no take_start_s/],
    [{ session_id: 'OTHER', items: ITEMS }, /the media JSON is for session OTHER, not S1/],
    [{ hello: 1 }, /not a list_session_media result/],
  ];
  for (const [data, message] of cases) {
    writeFileSync(join(box.cwd, 'm.json'), JSON.stringify(data));
    const r = await call(ctx, 'media', 'fetch', 'S1', '--media-json', 'm.json');
    assert.equal(r.code, 1, JSON.stringify(data));
    assert.match(r.stderr, message);
  }
  assert.equal(yt.calls.length, 0, 'yt-dlp was run');
  assert.equal((await call(ctx, 'media', 'fetch', 'S1')).code, 2);
  assert.equal((await call(ctx, 'media', 'fetch', 'S1', '--media-json', 'missing.json')).code, 2);
});

test('fetch without yt-dlp on PATH: a clear error with the install hint; a failed or escaping download is an error', async () => {
  const box = sandbox();
  writeFileSync(join(box.cwd, 'm.json'), JSON.stringify(ITEMS));
  const missing = await call({ env: box.env, cwd: box.cwd, runner: fakeYtdlp({ missing: true }).runner }, 'media', 'fetch', 'S1', '--media-json', 'm.json');
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^autologger-clips: yt-dlp is not on PATH; install it \(https:\/\/github\.com\/yt-dlp\/yt-dlp#installation/);
  const failed = await call({ env: box.env, cwd: box.cwd, runner: fakeYtdlp({ fail: true }).runner }, 'media', 'fetch', 'S1', '--media-json', 'm.json');
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /ERROR: Video unavailable[\s\S]*yt-dlp failed \(exit 1\)/);
  mkdirSync(join(box.home, 'elsewhere'), { recursive: true });
  writeFileSync(join(box.home, 'elsewhere', 'x.mp4'), 'x');
  const escaped = await call({ env: box.env, cwd: box.cwd, runner: fakeYtdlp({ print: () => join(box.home, 'elsewhere', 'x.mp4') }).runner }, 'media', 'fetch', 'S1', '--media-json', 'm.json');
  assert.equal(escaped.code, 1);
  assert.match(escaped.stderr, /outside/);
  assert.equal(JSON.parse((await call({ env: box.env, cwd: box.cwd }, 'media', 'list', '--json')).stdout).sessions.length, 0);
});

test('the yt-dlp flags are the documented ones', () => {
  assert.equal(YTDLP_FORMAT, 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes(`yt-dlp ${ytdlpArgs('<url>', '<dir>').map((a) => (/[*[\]%/+]/.test(a) && !a.startsWith('<') ? `"${a}"` : a)).join(' ')}`), 'README shows the exact yt-dlp command');
});
