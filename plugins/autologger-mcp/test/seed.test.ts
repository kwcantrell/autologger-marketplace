// Seeding a local dev stack with a whole account: export --all from a source, and import --create
// into a target (both played by the fake server in data mode; the target also plays the app's
// HTTP API, signed in with a `make dev-login` cookie through app-signin).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { teamSlug } from '../src/seed.ts';
import { type FakeData, FakeAutologger, type FakeOptions } from './fakeServer.ts';
import { cli, tempConfigDir, transcript } from './helpers.ts';

const EXPORT_ALL_TOOLS = [
  'list_studios',
  'list_shows',
  'list_sessions',
  'list_categories',
  'get_session',
  'list_events',
  'list_topics',
  'list_transcript_words',
  'list_transcript_paragraphs',
  'list_wiki_pages',
  'get_wiki_page',
  'list_dashboards',
  'get_dashboard',
  'list_session_media',
];

const servers: FakeAutologger[] = [];
const files: string[] = [];
after(async () => {
  // Non-disclosure: no output, snapshot, progress or state file carries a token or cookie any server issued.
  const printed = [...transcript, ...files.filter(existsSync).map((f) => readFileSync(f, 'utf8'))].join('\n');
  for (const server of servers) {
    for (const t of server.issued) assert.ok(!printed.includes(t), 'a token or cookie was printed or stored');
    await server.close();
  }
});

const words = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => ({ ordinal: i + 1, session_time: `00:00:0${i}:00`, speaker: i % 2 === 0 ? 'Ann' : 'Bo', word: `${prefix}${i}`, start_sec: i, end_sec: i + 0.5 }));

function sourceData(): FakeData {
  return {
    studios: [
      {
        studio_id: 'st_Main',
        name: 'Main Studio',
        shows: [
          { show_id: 'shw_a', name: 'Show A', show_code: 'SHA', categories: [{ id: 'cat_joke', label: 'Joke', kind: 'BUTTON', color: '#ff0000' }, { id: 'cat_music', label: 'Music', kind: 'TEXT' }] },
          { show_id: 'shw_locked', name: 'Locked', can_access: false },
        ],
      },
      { studio_id: 'Second_Team', name: 'Second', shows: [{ show_id: 'shw_b', name: 'Show B', categories: [{ id: 'cat_x', label: 'Note' }] }] },
    ],
    templates: [{ dashboard_id: 'tpl_1', title: 'Studio template', tsx: 'export default function T() { return null; }', show_ids: [] }],
    sessions: [
      {
        session_id: 'S1',
        show_id: 'shw_a',
        title: 'Episode one',
        fps: 29.97,
        categories: [{ id: 'cat_joke', label: 'Joke' }, { id: 'cat_music', label: 'Music' }],
        events: [
          { event_id: 'e1', wall_time_utc: '2026-01-01T10:00:00.000Z', timecode: '00:00:10;00', frame_rate: 29.97, timecode_total_frames: 300, category: 'cat_joke', category_label: 'Joke', message: 'a joke', metadata: {}, version: 1 },
          { event_id: 'e2', wall_time_utc: '2026-01-01T10:01:00.000Z', timecode: '00:01:10;00', frame_rate: 29.97, timecode_total_frames: 2100, category: 'cat_music', category_label: 'Music', message: 'a song', metadata: {}, version: 1 },
          { event_id: 'r1', wall_time_utc: '2026-01-01T09:59:00.000Z', timecode: '00:00:00;00', frame_rate: 29.97, timecode_total_frames: 0, category: 'internal', category_label: 'Internal', message: 'Recording 1 Started', metadata: {}, version: 1 },
          { event_id: 'r2', wall_time_utc: '2026-01-01T10:05:00.000Z', timecode: '00:06:00;00', frame_rate: 29.97, timecode_total_frames: 10800, category: 'internal', category_label: 'Internal', message: 'Recording 1 Stopped', metadata: {}, version: 1 },
        ],
        topics: [{ id: 't1', session_time: '00:01:00:00', duration_sec: 30, topic_level: 1, summary: 'Openers', ordinal: 1, version: 1 }],
        words: words(5, 'w'),
        paragraphs: [{ ordinal: 1, speaker: 'Ann', session_time: null, start_sec: 0, end_sec: 3, text: 'w0 w1 w2' }],
        dashboards: [
          { dashboard_id: 'db_ok', title: 'Jokes board', tsx: 'export default function D() { return null; }', revision: 3 },
          { dashboard_id: 'db_bad', title: 'Refused board', tsx: 'export default function D() { window.alert(1); return null; }', revision: 1 },
        ],
        media: [{ ordinal: 1, recording_ordinal: 1, kind: 'youtube', url: 'https://www.youtube.com/watch?v=abc', video_id: 'abc', file_name: null, duration_s: 360, take_start_timecode: '00:00:00;00', take_stop_timecode: null, take_start_s: 0, take_stop_s: null }],
      },
      { session_id: 'S2', show_id: 'shw_a', title: 'Hidden one', fps: 25, hidden: true, events: [], topics: [], words: words(3, 'h') },
      { session_id: 'S3', show_id: 'shw_b', title: 'Other studio', fps: 25, categories: [{ id: 'cat_x', label: 'Note' }], events: [{ event_id: 'e9', wall_time_utc: '2026-01-02T10:00:00.000Z', timecode: '00:00:04:00', frame_rate: 25, timecode_total_frames: 100, category: 'cat_x', category_label: 'Note', message: 'a note', metadata: {}, version: 1 }], topics: [] },
      { session_id: 'SL', show_id: 'shw_locked', events: [], topics: [] },
    ],
    pages: [
      { page_id: 'pg_a', show_id: 'shw_a', kind: 'session', title: 'Episode one page', aliases: [], body_md: `About [Jane](wiki:pg_j) and a [quote](cite:S1@2).\n${'Padding. '.repeat(8)}`, revision: 2, session_id: 'S1' },
      { page_id: 'pg_j', show_id: 'shw_a', kind: 'person', title: 'Jane', aliases: [], body_md: 'Jane in [one](cite:S1@1) and [two](cite:S2@1).', revision: 1 },
    ],
  };
}

function emptyTarget(): FakeData {
  return { studios: [], sessions: [], pages: [] };
}

async function fake(options: FakeOptions): Promise<FakeAutologger> {
  const server = await new FakeAutologger(options).start();
  servers.push(server);
  return server;
}

interface Setup {
  source: FakeAutologger;
  target: FakeAutologger;
  configDir: string;
  snapshot: string;
  sleeps: number[];
  cookie: string;
  run: (...argv: string[]) => ReturnType<typeof cli>;
}

/** A source signed in read-only with a whole-account snapshot of it; a target signed in with write and its app session stored. */
async function setup(targetOptions: FakeOptions = {}, data: FakeData = emptyTarget()): Promise<Setup> {
  const source = await fake({ data: sourceData() });
  const target = await fake({ data, ...targetOptions });
  const configDir = tempConfigDir();
  const sleeps: number[] = [];
  const run = (...argv: string[]) => cli({ configDir, sleep: async (ms) => void sleeps.push(ms) }, ...argv);
  assert.equal((await run('login', '--server', source.base)).code, 0);
  assert.equal((await run('login', '--write', '--server', target.base)).code, 0);
  const snapshot = join(configDir, 'all.json');
  files.push(snapshot, `${snapshot}.import-state.json`);
  const exported = await run('export', '--server', source.base, '--all', '--out', snapshot, '--json');
  assert.equal(exported.code, 0, exported.stderr);
  const cookie = target.mintDevLogin();
  const signin = await cli({ configDir, stdin: cookie }, 'app-signin', '--server', target.base, '--json');
  assert.equal(signin.code, 0, signin.stderr);
  target.calls.length = 0;
  target.appCalls.length = 0;
  return { source, target, configDir, snapshot, sleeps, cookie, run };
}

const toolCalls = (server: FakeAutologger) => server.calls.filter((c) => c.tool !== undefined).map((c) => c.tool as string);
const createArgs = (s: Setup, ...more: string[]) => ['import', ...more, '--snapshot', s.snapshot, '--server', s.target.base, '--create', '--json'];
const targetSessions = (s: Setup) => (s.target.options.data as FakeData).sessions;

test('teamSlug makes an id the app accepts', () => {
  assert.equal(teamSlug('st_Main'), 'st-main');
  assert.equal(teamSlug('Second_Team'), 'second-team');
  assert.equal(teamSlug('42'), 't-42');
  assert.equal(teamSlug('x'), 'x-team');
  assert.match(teamSlug('a'.repeat(100)), /^[a-z][a-z0-9-]{1,62}$/);
});

test('export --all: every studio, show (with categories) and session, all their data, with read tools only', async () => {
  const source = await fake({ data: sourceData() });
  const configDir = tempConfigDir();
  const run = (...argv: string[]) => cli({ configDir }, ...argv);
  assert.equal((await run('login', '--server', source.base)).code, 0);
  source.calls.length = 0;
  const out = join(configDir, 'all.json');
  files.push(out);
  const result = await run('export', '--server', source.base, '--all', '--out', out, '--json');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /show shw_locked \(Locked\): this account cannot open it; its categories and sessions are not exported/);
  // A show the account cannot open is not read at all: autologger refuses its categories ("Show not found").
  assert.ok(!source.calls.some((c) => (c.arguments as Record<string, unknown> | undefined)?.show_id === 'shw_locked' && c.tool !== 'list_shows'));
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.studios, 2);
  assert.equal(summary.shows, 3);
  assert.deepEqual(summary.totals, { sessions: 3, events: 5, topics: 1, wiki_pages: 3, transcript_words: 8, transcript_paragraphs: 1, dashboards: 2, media: 1 });

  // Only the read tools of the list were called, never a write tool.
  const tools = toolCalls(source);
  assert.ok(tools.every((t) => EXPORT_ALL_TOOLS.includes(t)), tools.join(','));
  assert.deepEqual([...new Set(tools)].sort(), [...EXPORT_ALL_TOOLS].sort());
  assert.equal(source.writeCounts.attempted, 0);
  // Hidden sessions were asked for, and every cursor followed.
  assert.ok(source.calls.filter((c) => c.tool === 'list_sessions').every((c) => (c.arguments as Record<string, unknown>).include_hidden === true));
  assert.equal(source.calls.filter((c) => c.tool === 'list_transcript_words' && (c.arguments as Record<string, unknown>).session_id === 'S1').length, 3, 'five words, two a page');
  // Jane's page is associated with S1 and S2: its body is read once.
  const janeSlices = source.calls.filter((c) => c.tool === 'get_wiki_page' && (c.arguments as Record<string, unknown>).page_id === 'pg_j');
  assert.equal(janeSlices.length, 2, 'two 40-character slices, read for one session only');

  const snap = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.equal(existsSync(`${out}.export-progress.json`), false, 'the progress file is removed when done');
  assert.deepEqual(snap.studios.map((s: { studio_id: string }) => s.studio_id), ['st_Main', 'Second_Team']);
  const showA = snap.studios[0].shows[0];
  assert.equal(showA.show.name, 'Show A');
  assert.deepEqual(showA.categories.items.map((c: { name: string; kind: string }) => [c.name, c.kind]), [['Joke', 'BUTTON'], ['Music', 'TEXT']]);
  assert.deepEqual(showA.session_ids, ['S1', 'S2']);
  assert.deepEqual(snap.studios[0].shows[1].session_ids, [], 'the locked show is listed, its sessions are not read');
  assert.equal(snap.studios[0].shows[1].categories, undefined, 'nor its categories');
  assert.deepEqual(snap.sessions.map((s: { session_id: string }) => s.session_id), ['S1', 'S2', 'S3']);
  const [s1, s2] = snap.sessions;
  assert.equal(s1.session.fps, 29.97);
  assert.equal(s1.studio_id, 'st_Main');
  assert.equal(s2.listed.hidden, true);
  assert.equal(s1.events.length, 4);
  assert.equal(s1.transcript_words.length, 5);
  assert.deepEqual(s1.transcript_words[4], { ordinal: 5, session_time: '00:00:04:00', speaker: 'Ann', word: 'w4', start_sec: 4, end_sec: 4.5 });
  assert.equal(s1.transcript_paragraphs.length, 1);
  assert.equal(s1.wiki_pages.find((p: { page_id: string }) => p.page_id === 'pg_a').body_md, (sourceData().pages[0] as { body_md: string }).body_md);
  assert.deepEqual(s1.dashboards.map((d: { dashboard_id: string; tsx: string }) => [d.dashboard_id, d.tsx.length > 0]), [['db_ok', true], ['db_bad', true]], 'session dashboards with their source; the template is not');
  assert.equal(s1.media[0].url, 'https://www.youtube.com/watch?v=abc');
  assert.ok(!JSON.stringify(snap).includes('tpl_1'));
});

test('export --all waits out a rate limit; --no-wait stops with a progress file and the rerun reads nothing twice', async () => {
  // A clean export, for the number of reads it takes.
  const clean = await fake({ data: sourceData() });
  const configDir = tempConfigDir();
  const sleeps: number[] = [];
  const run = (...argv: string[]) => cli({ configDir, sleep: async (ms) => void sleeps.push(ms) }, ...argv);
  assert.equal((await run('login', '--server', clean.base)).code, 0);
  const cleanOut = join(configDir, 'clean.json');
  files.push(cleanOut);
  assert.equal((await run('export', '--server', clean.base, '--all', '--out', cleanOut, '--json')).code, 0);
  const reads = clean.readCounts.answered;

  // Waiting: the same snapshot, after two waits.
  const waited = await fake({ data: sourceData(), rateLimitAfterReads: 6, rateLimitReadTimes: 2, rateLimitRetryS: 4 });
  assert.equal((await run('login', '--server', waited.base)).code, 0);
  const waitedOut = join(configDir, 'waited.json');
  files.push(waitedOut);
  const w = await run('export', '--server', waited.base, '--all', '--out', waitedOut, '--json');
  assert.equal(w.code, 0, w.stderr);
  assert.deepEqual(sleeps, [5000, 5000]);
  assert.match(w.stderr, /rate limited; waiting 4 s before retrying/);
  const strip = (file: string) => {
    const snap = JSON.parse(readFileSync(file, 'utf8'));
    return { studios: snap.studios, sessions: snap.sessions };
  };
  assert.deepEqual(JSON.stringify(strip(waitedOut)).replaceAll(waited.base, ''), JSON.stringify(strip(cleanOut)).replaceAll(clean.base, ''));

  // --no-wait: stops with exit 1, nothing at --out, progress kept; the rerun finishes it.
  const stopped = await fake({ data: sourceData(), rateLimitAfterReads: 20, rateLimitReadTimes: 1 });
  assert.equal((await run('login', '--server', stopped.base)).code, 0);
  const out = join(configDir, 'stopped.json');
  const progress = `${out}.export-progress.json`;
  files.push(out, progress);
  const first = await run('export', '--server', stopped.base, '--all', '--out', out, '--no-wait', '--json');
  assert.equal(first.code, 1);
  assert.equal(first.stdout, '');
  assert.match(first.stderr, /rate limited \(retry in 7 s\); stopped\. Progress is saved in .*stopped\.json\.export-progress\.json; run the same export command again to continue/);
  assert.equal(existsSync(out), false);
  assert.equal(statSync(progress).mode & 0o777, 0o600);
  assert.equal(stopped.readCounts.answered, 20);
  const second = await run('export', '--server', stopped.base, '--all', '--out', out, '--no-wait', '--json');
  assert.equal(second.code, 0, second.stderr);
  assert.equal(stopped.readCounts.answered, reads, 'the two runs together read exactly what one clean run reads');
  assert.equal(existsSync(progress), false);
  assert.deepEqual(JSON.stringify(strip(out)).replaceAll(stopped.base, ''), JSON.stringify(strip(cleanOut)).replaceAll(clean.base, ''));
});

test('export --all goes on past a show whose categories are refused, with a warning', async () => {
  const data = sourceData();
  const showB = data.studios?.[1]?.shows[0];
  assert.ok(showB !== undefined);
  showB.categories_refused = true;
  const source = await fake({ data });
  const configDir = tempConfigDir();
  const run = (...argv: string[]) => cli({ configDir }, ...argv);
  assert.equal((await run('login', '--server', source.base)).code, 0);
  const out = join(configDir, 'refused.json');
  files.push(out);
  const result = await run('export', '--server', source.base, '--all', '--out', out, '--json');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /show shw_b \(Show B\): list_categories refused: Categories unavailable; its categories are not exported/);
  const snap = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(snap.studios[1].shows[0].categories, { items: [], total: 0 });
  assert.deepEqual(snap.studios[1].shows[0].session_ids, ['S3'], 'its sessions are still exported');
  assert.deepEqual(snap.sessions.map((s: { session_id: string }) => s.session_id), ['S1', 'S2', 'S3']);
});

test('export --all and --session together, or neither, is a usage error', async () => {
  const configDir = tempConfigDir();
  const both = await cli({ configDir, server: 'http://127.0.0.1:9' }, 'export', '--all', '--session', 'S1', '--out', join(configDir, 'x.json'));
  assert.equal(both.code, 2);
  assert.match(both.stderr, /give --session <id> or --all, not both/);
  const neither = await cli({ configDir, server: 'http://127.0.0.1:9' }, 'export', '--out', join(configDir, 'x.json'));
  assert.equal(neither.code, 2);
  assert.match(neither.stderr, /export needs --session <id> \(one or more\), or --all/);
});

test('import --create dry run: plans the teams, shows, sessions, words and dashboards; writes nothing', async () => {
  const s = await setup();
  const dry = await s.run(...createArgs(s));
  assert.equal(dry.code, 0, dry.stderr);
  const report = JSON.parse(dry.stdout);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.app_signed_in, true);
  assert.deepEqual(report.create.teams.map((t: { target_team_id: string; action: string }) => [t.target_team_id, t.action]), [['st-main', 'create'], ['second-team', 'create']]);
  assert.deepEqual(report.create.shows.map((x: { source_show_id: string; categories: number }) => [x.source_show_id, x.categories]), [['shw_a', 2], ['shw_locked', 0], ['shw_b', 1]]);
  assert.deepEqual(
    report.create.sessions.map((x: { source_session_id: string; title: string; frame_rate: number; action: string }) => [x.source_session_id, x.title, x.frame_rate, x.action]),
    [['S1', 'Episode one', 29.97, 'create'], ['S2', 'Hidden one', 25, 'create'], ['S3', 'Other studio', 25, 'create']],
  );
  assert.deepEqual(report.create.transcript_words, [{ source_session_id: 'S1', total: 5, done: 0 }, { source_session_id: 'S2', total: 3, done: 0 }]);
  assert.deepEqual(report.create.transcript_paragraphs, [{ source_session_id: 'S1', total: 1 }]);
  assert.equal(report.create.dashboards.length, 2);
  assert.ok(report.create.not_copied.some((n: string) => n.startsWith('transcript paragraphs: ')));
  assert.ok(report.create.not_copied.some((n: string) => n.startsWith('audio and video: never')));
  assert.equal(report.plan.create.events, 5);
  assert.equal(report.plan.create.topics, 1);
  assert.equal(report.plan.create.wiki_pages, 2);
  assert.deepEqual(report.frame_rate_mismatch, []);
  // Nothing written: no app request, no write tool, no state file.
  assert.deepEqual(s.target.appCalls, []);
  assert.equal(s.target.writeCounts.attempted, 0);
  assert.equal(existsSync(`${s.snapshot}.import-state.json`), false);
  const text = await s.run(...createArgs(s).filter((a) => a !== '--json'));
  assert.match(text.stdout, /^Dry run: nothing was written\. On the target, import --create would make:\n {2}teams: 2 to create \(st_Main -> st-main, Second_Team -> second-team\)/);
  assert.match(text.stdout, /transcript paragraphs: autologger stores them only from its own transcript generation runs/);
});

test('import --confirm --create makes teams, shows, sessions, and copies events, topics, pages, words and dashboards', async () => {
  const s = await setup();
  const result = await s.run(...createArgs(s, '--confirm'));
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'confirm');
  assert.deepEqual(report.created_structure, { teams_created: 2, teams_reused: 0, shows_created: 3, categories_set: 2, sessions_created: 3, transcript_words_copied: 8, dashboards_saved: 1 });
  assert.deepEqual(report.created, { events: 5, topics: 1, wiki_pages: 2 });
  assert.deepEqual(report.failed.map((f: { kind: string; source_id: string }) => [f.kind, f.source_id]), [['dashboard', 'db_bad']]);
  assert.match(report.failed[0].reason, /save_dashboard refused it: Dashboard source refused/);

  // Teams and shows through the app's HTTP API; the show's categories by name and kind.
  const studios = (s.target.options.data as FakeData).studios ?? [];
  assert.deepEqual(studios.map((st) => [st.studio_id, st.name]), [['st-main', 'Main Studio'], ['second-team', 'Second']]);
  const showA = studios[0]?.shows[0];
  assert.equal(showA?.name, 'Show A');
  assert.equal(showA?.show_code, 'SHA');
  assert.deepEqual(showA?.categories?.map((c) => [c.label, c.kind, c.color]), [['Joke', 'BUTTON', '#ff0000'], ['Music', 'TEXT', '#7cb7ff']]);
  const posts = s.target.appCalls.filter((c) => c.method === 'POST').map((c) => c.path);
  assert.deepEqual(posts.filter((p) => !p.endsWith('/transcript-words')), ['/api/teams', '/api/shows', '/api/sessions', '/api/sessions', '/api/shows', '/api/teams', '/api/shows', '/api/sessions']);
  // Each session at the source frame rate, with its title, in the show made for it, its team active.
  const sessions = targetSessions(s);
  assert.deepEqual(sessions.map((x) => [x.title, x.fps, x.show_id === showA?.show_id]), [['Episode one', 29.97, true], ['Hidden one', 25, true], ['Other studio', 25, false]]);
  const sessionPosts = s.target.appCalls.filter((c) => c.path === '/api/sessions');
  assert.deepEqual(sessionPosts[0]?.body, { title: 'Episode one', frame_rate: 29.97, start_offset_frames: 0, show_id: showA?.show_id });
  // Events by category name, takes whole, timecodes kept.
  const t1 = sessions[0];
  assert.deepEqual(t1?.events.map((e) => [e.message, e.timecode]), [['Recording 1 Stopped', '00:06:00;00'], ['Recording 1 Started', '00:00:00;00'], ['a joke', '00:00:10;00'], ['a song', '00:01:10;00']]);
  assert.deepEqual(t1?.events.slice(2).map((e) => e.category_label), ['Joke', 'Music']);
  assert.equal(sessions[2]?.events[0]?.category_label, 'Note');
  // Transcript words: the target's list_transcript_words total equals the source's, word for word.
  for (const [i, source] of [[0, 'S1'], [1, 'S2']] as const) {
    const listed = await s.run('call', 'list_transcript_words', '--server', s.target.base, '--args', JSON.stringify({ session_id: sessions[i]?.session_id }), '--json');
    const sourceWords = sourceData().sessions.find((x) => x.session_id === source)?.words ?? [];
    assert.equal(JSON.parse(listed.stdout).structuredContent.total, sourceWords.length);
    assert.deepEqual(sessions[i]?.words?.map((w) => [w.session_time, w.speaker, w.word]), sourceWords.map((w) => [w.session_time, w.speaker, w.word]));
  }
  // Dashboards: the accepted one is listed on its target session.
  const boards = await s.run('call', 'list_dashboards', '--server', s.target.base, '--args', JSON.stringify({ session_id: t1?.session_id }), '--json');
  assert.deepEqual(JSON.parse(boards.stdout).structuredContent.items.map((d: { title: string }) => d.title), ['Jokes board']);
  // Wiki pages in the new show, cite links to the new session.
  const pages = (s.target.options.data as FakeData).pages;
  assert.equal(pages.find((p) => p.title === 'Episode one page')?.show_id, showA?.show_id);
  assert.match(pages.find((p) => p.title === 'Episode one page')?.body_md ?? '', new RegExp(`cite:${t1?.session_id}@2`));
  // The state file records the structure; it holds no cookie.
  const state = JSON.parse(readFileSync(`${s.snapshot}.import-state.json`, 'utf8'));
  const structure = state.targets[s.target.base].structure;
  assert.deepEqual(Object.keys(structure.teams), ['st_Main', 'Second_Team']);
  assert.equal(structure.sessions.S1.target_id, t1?.session_id);
  assert.deepEqual(structure.words.S1, { done: 5, last_target_id: t1?.words?.[4]?.id });
  assert.deepEqual(Object.keys(structure.dashboards), ['db_ok']);
  const cookieValue = s.cookie.trim().split('=')[1] ?? '';
  for (const text of [readFileSync(`${s.snapshot}.import-state.json`, 'utf8'), readFileSync(s.snapshot, 'utf8'), result.stdout, result.stderr]) assert.ok(!text.includes(cookieValue));
});

test('import --create refuses a target that is not loopback or is the source, with exit 1 and nothing written', async () => {
  const s = await setup();
  const before = readdirSync(s.configDir).sort();
  const noNetwork: typeof fetch = async () => {
    throw new Error('network used');
  };
  for (const server of ['https://stage.example.test', 'https://10.0.0.5:8787']) {
    const r = await cli({ configDir: s.configDir, fetch: noNetwork }, 'import', '--confirm', '--snapshot', s.snapshot, '--server', server, '--create', '--json');
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /import --create writes only to a local dev stack \(localhost, 127\.0\.0\.1 or \[::1\], any port\); .* is not one\. Nothing was written/);
  }
  for (const server of [s.source.base, s.source.base.replace('127.0.0.1', 'localhost')]) {
    const r = await cli({ configDir: s.configDir, fetch: noNetwork }, 'import', '--confirm', '--snapshot', s.snapshot, '--server', server, '--create', '--json');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is the snapshot's source server .*Nothing was written/);
  }
  assert.deepEqual(readdirSync(s.configDir).sort(), before);
  assert.equal(existsSync(`${s.snapshot}.import-state.json`), false);
  assert.equal(s.source.writeCounts.attempted, 0);
  assert.deepEqual(s.source.appCalls, []);
});

test('import --create refuses a per-session snapshot, --map, and --confirm without an app session', async () => {
  const s = await setup();
  const perSession = join(s.configDir, 'one.json');
  files.push(perSession);
  assert.equal((await s.run('export', '--server', s.source.base, '--session', 'S1', '--out', perSession, '--json')).code, 0);
  const r1 = await s.run('import', '--snapshot', perSession, '--server', s.target.base, '--create', '--json');
  assert.equal(r1.code, 1);
  assert.match(r1.stderr, /needs a whole-account snapshot from export --all/);
  const r2 = await s.run(...createArgs(s), '--map', 'S1=T1');
  assert.equal(r2.code, 2);
  assert.match(r2.stderr, /takes no --map/);
  assert.equal((await s.run('app-signout', '--server', s.target.base, '--json')).code, 0);
  const r3 = await s.run(...createArgs(s, '--confirm'));
  assert.equal(r3.code, 1);
  assert.match(r3.stderr, /no app session stored for .*make dev-login EMAIL=<address> \| npx .* app-signin --server .*Nothing was written/s);
  assert.deepEqual(s.target.appCalls, []);
  assert.equal(existsSync(`${s.snapshot}.import-state.json`), false);
  // The dry run still works, and says how to sign in.
  const dry = await s.run(...createArgs(s));
  assert.equal(dry.code, 0, dry.stderr);
  const report = JSON.parse(dry.stdout);
  assert.equal(report.app_signed_in, false);
  assert.match(report.app_signin_command, /^make dev-login EMAIL=<address> \| npx --yes --offline --loglevel=error --package=\S+ -- autologger-mcp app-signin --server http:\/\/127\.0\.0\.1:\d+$/);
});

test('app-signin stores the cookie from stdin only, mode 0600, never prints it; refuses a remote server or a bad line', async () => {
  const target = await fake({ data: emptyTarget() });
  const configDir = tempConfigDir();
  const cookie = target.mintDevLogin();
  const value = cookie.trim().split('=')[1] ?? '';
  const ok = await cli({ configDir, stdin: cookie }, 'app-signin', '--server', target.base, '--json');
  assert.equal(ok.code, 0, ok.stderr);
  const report = JSON.parse(ok.stdout);
  assert.equal(report.cookie_name, 'autologger_sid');
  assert.equal(report.active_team, null);
  assert.equal(statSync(report.stored).mode & 0o777, 0o600);
  assert.equal(statSync(join(configDir, 'app-cookies')).mode & 0o777, 0o700);
  assert.ok(!ok.stdout.includes(value) && !ok.stderr.includes(value));
  // It was checked against the app with the cookie header.
  assert.deepEqual(target.appCalls.map((c) => c.path), ['/api/studio']);

  const remote = await cli({ configDir: tempConfigDir(), stdin: cookie }, 'app-signin', '--server', 'https://stage.example.test', '--json');
  assert.equal(remote.code, 1);
  assert.match(remote.stderr, /app-signin is for a local dev stack/);
  const bad = tempConfigDir();
  const twoLines = await cli({ configDir: bad, stdin: `${cookie}${cookie}` }, 'app-signin', '--server', target.base);
  assert.equal(twoLines.code, 2);
  assert.ok(!twoLines.stderr.includes(value));
  const rejected = await cli({ configDir: bad, stdin: 'autologger_sid=not-a-session-token\n' }, 'app-signin', '--server', target.base);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /answered 401: the dev-login cookie is not a session there.*Nothing was stored/);
  assert.deepEqual(readdirSync(bad), []);
  const arg = await cli({ configDir: bad }, 'app-signin', value, '--server', target.base);
  assert.equal(arg.code, 2, 'the cookie is never taken from an argument');
});

test('an interrupted import --create resumes: nothing is created twice', async () => {
  // The third MCP write answers HTTP 500, and the 9th app write a rate limit (with --no-wait): each stops the run.
  const s = await setup({ appRateLimitWriteNumber: 9, failWriteNumber: 3 });
  const first = await s.run(...createArgs(s, '--confirm', '--no-wait'));
  assert.equal(first.code, 1);
  assert.equal(first.stdout, '');
  assert.match(first.stderr, /Progress is saved in .*all\.json\.import-state\.json; run the same import --confirm command again to resume/);
  let stops = 1;
  for (let i = 0; i < 4; i++) {
    const again = await s.run(...createArgs(s, '--confirm', '--no-wait'));
    if (again.code === 0) break;
    assert.match(again.stderr, /run the same import --confirm command again to resume/);
    stops++;
  }
  assert.equal(stops, 2, 'one stop for the HTTP 500, one for the rate limit');
  assert.equal(s.target.writeCounts.failed500, 1);
  const last = await s.run(...createArgs(s, '--confirm'));
  assert.equal(last.code, 0, last.stderr);
  const report = JSON.parse(last.stdout);
  assert.deepEqual(report.created_structure, { teams_created: 0, teams_reused: 0, shows_created: 0, categories_set: 0, sessions_created: 0, transcript_words_copied: 0, dashboards_saved: 0 });
  assert.deepEqual(report.created, { events: 0, topics: 0, wiki_pages: 0 });
  const data = s.target.options.data as FakeData;
  assert.equal(data.studios?.length, 2);
  assert.equal(data.studios?.reduce((n, st) => n + st.shows.length, 0), 3);
  assert.equal(data.sessions.length, 3);
  assert.deepEqual(data.sessions.map((x) => x.words?.length), [5, 3, 0]);
  assert.deepEqual(data.sessions.map((x) => x.events.length), [4, 0, 1]);
  assert.equal(data.pages.length, 2);
  assert.equal(data.sessions[0]?.dashboards?.length, 1);
});

test('a rate-limited app request is waited out', async () => {
  const s = await setup({ appRateLimitWriteNumber: 2 });
  const r = await s.run(...createArgs(s, '--confirm'));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /POST \/api\/shows: rate limited; waiting 3 s before retrying/);
  assert.ok(s.sleeps.includes(4000));
  assert.equal(JSON.parse(r.stdout).created_structure.shows_created, 3);
});

test('an existing team you belong to is reused; a taken id gets a suffix; the owned-team cap is a clear failure', async () => {
  const reuse = await setup({}, { studios: [{ studio_id: 'st-main', name: 'Mine already', shows: [] }, { studio_id: 'second-team', name: 'Not mine', shows: [], member: false }], sessions: [], pages: [] });
  const r = await reuse.run(...createArgs(reuse, '--confirm'));
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.created_structure.teams_reused, 1);
  assert.equal(report.created_structure.teams_created, 1);
  assert.match(r.stderr, /team st-main already exists on .* and you belong to it: reusing it for studio st_Main/);
  assert.deepEqual(reuse.target.appCalls.filter((c) => c.path === '/api/teams').map((c) => (c.body as { id: string }).id), ['second-team', 'second-team-2']);
  assert.deepEqual(report.create.teams.map((t: { target_team_id: string; reused: boolean }) => [t.target_team_id, t.reused]), [['st-main', true], ['second-team-2', false]]);
  assert.equal(report.created_structure.sessions_created, 3);

  const capped = await setup({ ownedTeams: 20 });
  const c = await capped.run(...createArgs(capped, '--confirm'));
  assert.equal(c.code, 0, c.stderr);
  const cr = JSON.parse(c.stdout);
  assert.deepEqual(cr.failed.map((f: { kind: string; source_id: string }) => [f.kind, f.source_id]), [['team', 'st_Main'], ['team', 'Second_Team']]);
  assert.match(cr.failed[0].reason, /you already own 20 teams on .*autologger's limit .*Delete a team you own there, then run the same import --confirm again; nothing of this studio was created/);
  assert.equal(cr.created_structure.sessions_created, 0);
  assert.deepEqual(cr.created, { events: 0, topics: 0, wiki_pages: 0 });
  assert.equal(capped.target.writeCounts.attempted, 0);
});

test('import --confirm --create gives the user back the active team and show they had', async () => {
  const s = await setup({}, { studios: [{ studio_id: 'home', name: 'Home', shows: [{ show_id: 'sh_one', name: 'One' }, { show_id: 'sh_two', name: 'Two' }] }], sessions: [], pages: [] });
  s.target.activeStudio = 'home';
  s.target.activeShow = 'sh_two';
  const r = await s.run(...createArgs(s, '--confirm'));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).created_structure.sessions_created, 3);
  assert.equal(s.target.activeStudio, 'home');
  assert.equal(s.target.activeShow, 'sh_two', 'not the team\'s first show');
  assert.deepEqual(s.target.appCalls.at(-1), { method: 'PUT', path: '/api/profile', body: { active_studio_id: 'home', active_show_id: 'sh_two' } });
});

test('a transcript word the app refuses is reported in failed; the rerun adds the rest of them', async () => {
  // App writes 1-12 make the structure; 13 is S1's first word, so 14 is its second.
  const s = await setup({ appFailWriteNumber: 14 });
  const first = await s.run(...createArgs(s, '--confirm'));
  assert.equal(first.code, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  const failed = report.failed.filter((f: { kind: string }) => f.kind === 'transcript_words');
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason, /^word 2 of 5: POST \/api\/sessions\/\S+\/transcript-words answered 500: Internal Server Error; the rest of this session's words are tried again on the next run$/);
  assert.deepEqual(targetSessions(s).map((x) => x.words?.length), [1, 3, 0]);
  const second = await s.run(...createArgs(s, '--confirm'));
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).created_structure.transcript_words_copied, 4);
  assert.deepEqual(targetSessions(s)[0]?.words?.map((w) => w.word), ['w0', 'w1', 'w2', 'w3', 'w4']);
});
