// annotate: the gaps report, the compact transcript, the plan's dry run, apply (create-only,
// resumable, rate-limit aware) and undo, against the fake autologger in data mode.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { GAPS_TOOLS } from '../src/annotate.ts';
import { type FakeData, FakeAutologger, type FakeOptions } from './fakeServer.ts';
import { cli, tempConfigDir, transcript as printedOutput } from './helpers.ts';

const servers: FakeAutologger[] = [];
after(async () => {
  const printed = printedOutput.join('\n');
  for (const server of servers) {
    for (const t of server.issued) assert.ok(!printed.includes(t), 'a token was printed');
    await server.close();
  }
});

const WRITE_PREFIXES = ['create_', 'update_', 'delete_', 'save_', 'restore_'];

const take = (id: string, n: number, kind: 'Started' | 'Stopped', seconds: number): Record<string, unknown> => ({
  event_id: id,
  wall_time_utc: `2026-11-19T10:${kind === 'Started' ? '00' : '10'}:00.000Z`,
  timecode_total_frames: seconds * 25,
  frame_rate: 25,
  category: 'internal',
  category_label: 'Internal',
  message: `Recording ${n} ${kind}`,
  metadata: {},
  version: 1,
});

function data(): FakeData {
  return {
    studios: [
      {
        studio_id: 'st_1',
        name: 'Studio',
        shows: [
          { show_id: 'shw_1', name: 'Show one' },
          { show_id: 'shw_2', name: 'Show two' },
          { show_id: 'shw_x', name: 'Locked', can_access: false },
        ],
      },
    ],
    sessions: [
      {
        session_id: 'S1',
        show_id: 'shw_1',
        title: 'Episode 1',
        fps: 25,
        categories: [
          { id: 'cat_j', label: 'Joke' },
          { id: 'cat_g', label: 'Guest' },
        ],
        events: [
          take('e_start', 1, 'Started', 0),
          take('e_stop', 1, 'Stopped', 600),
          { event_id: 'e_joke', wall_time_utc: '2026-11-19T10:00:30.000Z', timecode_total_frames: 750, frame_rate: 25, category: 'cat_j', category_label: 'Joke', message: 'An old joke', metadata: {}, version: 1 },
        ],
        topics: [{ id: 't_1', session_time: '00:00:10:00', duration_sec: 20, topic_level: 1, summary: 'Intro', ordinal: 1, version: 1 }],
        words: Array.from({ length: 41 }, (_, i) => ({ ordinal: i + 1, session_time: '', speaker: i < 20 ? 'Ann' : 'Bob', word: `w${i}`, start_sec: i * 15, end_sec: i * 15 + 0.5 })),
        dashboards: [{ dashboard_id: 'db_old', title: 'Old', tsx: 'export default function D() { return null; }', revision: 1 }],
      },
      {
        session_id: 'S2',
        show_id: 'shw_1',
        title: 'Episode 2',
        events: [take('e2_start', 1, 'Started', 0), take('e2_stop', 1, 'Stopped', 400)],
        topics: [],
        paragraphs: [
          { ordinal: 1, speaker: 'Ann', session_time: null, start_sec: 5, end_sec: 9, text: 'Hello  there,\nfriends' },
          { ordinal: 2, speaker: 'Bob', session_time: null, start_sec: 300, end_sec: 310, text: 'Bye now' },
        ],
      },
      { session_id: 'S3', show_id: 'shw_2', title: 'Pilot', events: [], topics: [] },
      { session_id: 'S4', show_id: 'shw_2', title: 'Hidden one', hidden: true, events: [], topics: [] },
    ],
    pages: [{ page_id: 'pg_jane', show_id: 'shw_1', kind: 'person', title: 'Jane', aliases: [], body_md: 'Jane at [the joke](cite:S1@30).', revision: 1 }],
  };
}

interface Setup {
  server: FakeAutologger;
  dir: string;
  sleeps: number[];
  run: (...argv: string[]) => ReturnType<typeof cli>;
}

async function setup(options: FakeOptions = {}, scope = 'dashboards session-data:write'): Promise<Setup> {
  const server = await new FakeAutologger({ data: data(), ...options }).start();
  servers.push(server);
  const dir = tempConfigDir();
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };
  const signin = await cli({ configDir: dir, server: server.base, stdin: server.mintDevTokens(scope) }, 'import-tokens', '--json');
  assert.equal(signin.code, 0, signin.stderr);
  return { server, dir, sleeps, run: (...argv) => cli({ configDir: dir, server: server.base, sleep }, ...argv) };
}

const toolCalls = (server: FakeAutologger): string[] => server.calls.flatMap((c) => (c.tool === undefined ? [] : [c.tool]));
const wroteNothing = (server: FakeAutologger): void => {
  assert.equal(server.writeCounts.attempted, 0);
  for (const t of toolCalls(server)) assert.ok(!WRITE_PREFIXES.some((p) => t.startsWith(p)), `${t} was called`);
};

// ── gaps ────────────────────────────────────────────────────────────────────────────────────

test('annotate gaps reports every visible session, what it has and what it lacks, with read tools only', async () => {
  // Reads are rate limited twice on the way: both waits are waited out.
  const s = await setup({ rateLimitAfterReads: 3, rateLimitReadTimes: 2 });
  const out = join(s.dir, 'gaps.json');
  const r = await s.run('annotate', 'gaps', '--out', out, '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(s.sleeps, [8000, 8000]);
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.out, out);
  assert.deepEqual(summary.totals, { sessions: 3, with_transcript: 2, transcript_words: 41, missing: { events: 2, topics: 2, wiki_pages: 2, dashboards: 2 }, missing_all: 2 });
  assert.deepEqual(summary.skipped_shows, [{ show_id: 'shw_x', reason: 'this account cannot open its sessions' }]);

  const report = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(report.format, 'autologger-mcp-annotate-gaps');
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const [s1, s2, s3] = report.sessions;
  assert.deepEqual(s1, {
    session_id: 'S1',
    studio_id: 'st_1',
    show_id: 'shw_1',
    show_name: 'Show one',
    title: 'Episode 1',
    date: '2026-11-19',
    duration_s: 600.5,
    last_session_time_s: 600,
    transcript_words: 41,
    transcript_paragraphs: 0,
    events: 1,
    topics: 1,
    wiki_pages: 1,
    dashboards: 1,
    missing: [],
  });
  assert.equal(s2.events, 0, 'recording-take rows are not counted');
  assert.equal(s2.transcript_paragraphs, 2);
  assert.deepEqual(s2.missing, ['events', 'topics', 'wiki_pages', 'dashboards']);
  assert.deepEqual([s3.session_id, s3.show_name, s3.missing.length], ['S3', 'Show two', 4]);
  assert.equal(report.sessions.length, 3, 'the hidden session is not listed (write tools refuse hidden sessions)');

  // Every list was paged (page size 2: two pages of S1's events), and only the gaps read tools ran.
  assert.equal(toolCalls(s.server).filter((t) => t === 'list_events').length, 2 + 1 + 1);
  for (const t of toolCalls(s.server)) assert.ok((GAPS_TOOLS as readonly string[]).includes(t), t);
  wroteNothing(s.server);

  // --show limits it; a show that is not there is reported.
  const one = await s.run('annotate', 'gaps', '--show', 'shw_2', '--show', 'shw_nope', '--out', out, '--json');
  assert.equal(one.code, 0, one.stderr);
  assert.equal(JSON.parse(one.stdout).totals.sessions, 1);
  assert.deepEqual(JSON.parse(one.stdout).skipped_shows, [{ show_id: 'shw_nope', reason: 'no such show among the studios this account belongs to' }]);
  const text = await s.run('annotate', 'gaps', '--out', out);
  assert.match(text.stdout, /^Gaps on http:\/\/127\.0\.0\.1:\d+ \(.*gaps\.json\): 3 sessions \(2 with a transcript, 41 words\); without events 2, topics 2, wiki pages 2, dashboards 2; 2 have none of the four\.\n {2}skipped show shw_x/);
  wroteNothing(s.server);
});

test('annotate gaps refuses to overwrite a file that is not a gaps report, and a bad --out', async () => {
  const s = await setup();
  const other = join(s.dir, 'notes.json');
  writeFileSync(other, '{"mine": true}');
  const r = await s.run('annotate', 'gaps', '--out', other, '--json');
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /notes\.json exists and is not an earlier gaps report/);
  assert.equal(readFileSync(other, 'utf8'), '{"mine": true}');
  assert.equal((await s.run('annotate', 'gaps', '--out', join(s.dir, 'x.txt'))).code, 2);
  assert.equal((await s.run('annotate', 'gaps')).code, 2);
  assert.equal((await s.run('annotate', 'gaps', '--out', other, '--session', 'S1')).code, 2, 'gaps takes no --session');
  assert.equal((await s.run('annotate', 'nope')).code, 2);
});

// ── transcript ──────────────────────────────────────────────────────────────────────────────

const TEN_K = 10_000;
/** 10,000 words, speakers changing every 37 words, two words at each instant (start_sec). */
const bigWords = Array.from({ length: TEN_K }, (_, i) => ({
  ordinal: i + 1,
  session_time: '',
  speaker: `Speaker ${Math.floor(i / 37) % 3}`,
  word: `w${i}`,
  start_sec: Math.floor(i / 2) * 0.5,
  end_sec: Math.floor(i / 2) * 0.5 + 0.4,
}));

async function bigSetup(): Promise<Setup> {
  const s = await setup({ pageSize: 1000 });
  s.server.options.data?.sessions.push({ session_id: 'S9', show_id: 'shw_1', title: 'Long one', events: [], topics: [], words: bigWords });
  return s;
}

/** The words of transcript text lines, in order. */
const wordsOf = (text: string): string[] =>
  text === ''
    ? []
    : text.split('\n').flatMap((line) => {
        const m = /^\[\d{2}:\d{2}:\d{2}\] ([^:]+): (.*)$/.exec(line);
        assert.ok(m, line);
        return (m[2] ?? '').split(' ');
      });

test('annotate transcript of 10,000 words is under 40% of the raw list_transcript_words JSON', async () => {
  const s = await bigSetup();
  const r = await s.run('annotate', 'transcript', '--session', 'S9', '--max-chars', '1000000', '--json');
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.source, 'words');
  assert.equal(out.units, TEN_K);
  assert.equal(out.next_from, null);
  assert.deepEqual(wordsOf(out.text), bigWords.map((w) => w.word));
  assert.match(out.text.split('\n')[0], /^\[00:00:00\] Speaker 0: w0 w1 w2/);
  const raw = JSON.stringify(bigWords);
  assert.ok(r.stdout.length < 0.4 * raw.length, `${r.stdout.length} of ${raw.length}`);
  wroteNothing(s.server);
});

test('following next_from prints every word exactly once, never splitting an instant, at most --max-chars per call', async () => {
  const s = await bigSetup();
  const seen: string[] = [];
  let from: number | null = 0;
  let calls = 0;
  while (from !== null) {
    const r = await s.run('annotate', 'transcript', '--session', 'S9', '--from', String(from), '--max-chars', '3000', '--json');
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(out.text.length <= 3000, `call ${calls}: ${out.text.length} characters`);
    assert.equal(out.chars, out.text.length);
    seen.push(...wordsOf(out.text));
    assert.ok(out.next_from === null || out.next_from > from);
    from = out.next_from;
    calls++;
  }
  assert.ok(calls > 10, `${calls} calls`);
  assert.deepEqual(seen, bigWords.map((w) => w.word));

  // --to ends a range (exclusive): words starting before 10 s.
  const r = await s.run('annotate', 'transcript', '--session', 'S9', '--from', '5', '--to', '10', '--json');
  const ranged = JSON.parse(r.stdout);
  assert.deepEqual(wordsOf(ranged.text), bigWords.filter((w) => w.start_sec >= 5 && w.start_sec < 10).map((w) => w.word));
  assert.equal(ranged.next_from, null);
});

test('annotate transcript reads paragraphs when the session has them', async () => {
  const s = await setup();
  const r = await s.run('annotate', 'transcript', '--session', 'S2', '--json');
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.source, 'paragraphs');
  assert.equal(out.text, '[00:00:05] Ann: Hello there, friends\n[00:05:00] Bob: Bye now');
  assert.ok(!toolCalls(s.server).includes('list_transcript_words'));
  const text = await s.run('annotate', 'transcript', '--session', 'S2', '--from', '6');
  assert.equal(text.stdout, '[00:05:00] Bob: Bye now\n(end)\n');
  const none = await s.run('annotate', 'transcript', '--session', 'S3', '--json');
  assert.equal(JSON.parse(none.stdout).source, 'none');
  for (const bad of [['--from', '-1'], ['--max-chars', '10'], ['--from', '5', '--to', '5']]) {
    assert.equal((await s.run('annotate', 'transcript', '--session', 'S2', ...bad)).code, 2, bad.join(' '));
  }
  assert.equal((await s.run('annotate', 'transcript')).code, 2, 'needs --session');
  wroteNothing(s.server);
});

// ── apply: the dry run ──────────────────────────────────────────────────────────────────────

function goodPlan(): Record<string, unknown> {
  return {
    format: 'autologger-mcp-annotate-plan',
    version: 1,
    plan_id: 'batch-1',
    sessions: [
      {
        session_id: 'S1',
        events: [
          { category: 'joke', message: 'A good joke', session_time: 42.5 },
          { id: 'guest', category: 'Guest', message: 'The guest arrives', timecode: '00:01:00:00' },
        ],
        topics: [{ session_time: 10, duration_sec: 60, topic_level: 2, summary: 'Opening' }],
        wiki_pages: [{ kind: 'topic', title: 'Pasta', aliases: ['Noodles'], body_md: 'About [pasta](cite:S1@42.5).' }],
        dashboards: [{ template: 'session-overview', title: 'Overview' }],
      },
    ],
  };
}

function writePlan(s: Setup, plan: Record<string, unknown>, name = 'plan.json'): string {
  const path = join(s.dir, name);
  writeFileSync(path, JSON.stringify(plan));
  return path;
}

test('annotate apply without --confirm is a dry run: create, skip and each invalid reason, the write count and a time estimate', async () => {
  const s = await setup();
  const plan = goodPlan();
  const sessions = plan.sessions as Record<string, unknown>[];
  const s1 = sessions[0] as Record<string, unknown[]>;
  s1.events?.push(
    { id: 'music', category: 'Music', message: 'x', session_time: 1 },
    { id: 'late', category: 'Joke', message: 'Too late', session_time: 5000 },
    { id: 'both', category: 'Joke', message: 'Two times', session_time: 1, timecode: '00:00:01:00' },
    { id: 'take', category: 'internal', message: 'Recording 9 Started', session_time: 1 },
  );
  s1.topics?.push({ id: 'nosummary', session_time: 20, duration_sec: 5 });
  s1.wiki_pages?.push(
    { id: 'links', kind: 'person', title: 'Bob', body_md: 'See [[Jane]].' },
    { id: 'jane', kind: 'person', title: 'jane', body_md: 'Again.' },
  );
  s1.dashboards?.push({ id: 'evil', title: 'Evil', tsx: "export default function D() { window.alert(1); return null; }" });
  sessions.push({ session_id: 'S404', events: [{ category: 'Joke', message: 'nowhere', session_time: 1 }] });
  const path = writePlan(s, plan);

  const r = await s.run('annotate', 'apply', '--plan', path, '--json');
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.plan_id, 'batch-1');
  assert.deepEqual(report.counts, { create: { events: 2, topics: 1, wiki_pages: 1, dashboards: 1 }, skip: 1, invalid: 8 });
  assert.equal(report.writes, 5);
  assert.equal(report.estimate.writes, 5);
  assert.deepEqual(report.estimate.assumes, { writes_per_minute: 30, writes_per_hour: 300 });
  const reason = (key: string): string => report.items.find((i: { key: string }) => i.key === key)?.reason ?? '';
  const action = (key: string): string => report.items.find((i: { key: string }) => i.key === key)?.action ?? '';
  assert.equal(action('S1/events/guest'), 'create');
  assert.match(reason('S1/events/music'), /^the session's show has no category 'Music'; its categories: Joke, Guest$/);
  assert.match(reason('S1/events/late'), /^the event time 5000 s is outside the session \(its transcript runs 0-600\.5 s\)$/);
  assert.match(reason('S1/events/both'), /exactly one of session_time \(seconds\) or timecode/);
  assert.match(reason('S1/events/take'), /^internal is the category of recording-take rows/);
  assert.equal(reason('S1/topics/nosummary'), 'summary is missing');
  assert.match(reason('S1/wiki_pages/links'), /^body_md fails check-links: 1:5 '\[\[Jane\]\]' is not a link/);
  assert.equal(action('S1/wiki_pages/jane'), 'skip');
  assert.match(reason('S1/wiki_pages/jane'), /the show already has a wiki page titled 'jane'; not overwritten/);
  assert.match(reason('S1/dashboards/evil'), /^the dashboard fails autologger's dashboard rules: line 1: window is not allowed$/);
  const missing = report.items.find((i: { session_id: string }) => i.session_id === 'S404');
  assert.equal(missing.action, 'invalid');
  assert.match(missing.reason, /^unknown session \(get_session: Session not found\)$/);
  assert.deepEqual(report.sessions.map((x: { session_id: string; found: boolean }) => [x.session_id, x.found]), [['S1', true], ['S404', false]]);
  assert.equal(existsSync(`${path}.apply-state.json`), false);
  wroteNothing(s.server);

  const text = await s.run('annotate', 'apply', '--plan', path);
  assert.match(text.stdout, /^Dry run: nothing was written\. annotate apply --confirm would, on http:\/\/127\.0\.0\.1:\d+:\n {2}session S1 \(Episode 1\): 2 events, 1 topics, 1 wiki pages, 1 dashboards to create, 1 skip, 7 invalid\n/);
  assert.match(text.stdout, /\n {2}5 writes, about \d+ s at the write rate limit\n/);
  assert.match(text.stdout, /Run the same command as annotate apply --confirm \.\.\. to write\.\n$/);
});

test('a missing required field, a bad plan file and a bad --plan are reported', async () => {
  const s = await setup();
  const plan = goodPlan();
  const s1 = (plan.sessions as Record<string, unknown[]>[])[0] as Record<string, unknown[]>;
  s1.events = [{ category: 'Joke', session_time: 3 }, { category: 'Joke', message: 'm', session_time: 3, colour: 'red' }];
  s1.topics = [{ session_time: '00:00:10:99', duration_sec: 1, summary: 's' }, { session_time: 10, summary: 's' }];
  s1.wiki_pages = [{ kind: 'essay', title: 'T', body_md: '' }, { kind: 'session', title: 'S', aliases: ['x'], body_md: '' }];
  s1.dashboards = [{ title: 'No source' }, { template: 'other' }];
  const r = await s.run('annotate', 'apply', '--plan', writePlan(s, plan), '--json');
  assert.equal(r.code, 0, r.stderr);
  const reasons = JSON.parse(r.stdout).items.map((i: { reason: string }) => i.reason);
  assert.deepEqual(reasons, [
    'message is missing',
    "unknown field 'colour' (a event takes id, category, message, session_time, timecode)",
    "session_time '00:00:10:99' is not seconds or an HH:MM:SS:FF timecode at the session's 25 fps",
    'duration_sec is missing (seconds, 0 or more)',
    'kind must be one of person, topic, bit, session',
    'a session page takes no aliases',
    'give the dashboard exactly one of "template": "session-overview" or "tsx"',
    'template must be "session-overview" (the only built-in template)',
  ]);
  writeFileSync(join(s.dir, 'nope.json'), '{"sessions": []}');
  const bad = await s.run('annotate', 'apply', '--plan', join(s.dir, 'nope.json'));
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /is not an annotate plan \("format": "autologger-mcp-annotate-plan" and "version": 1 are required\)/);
  assert.equal((await s.run('annotate', 'apply', '--plan', join(s.dir, 'plan.txt'))).code, 2);
  assert.equal((await s.run('annotate', 'apply')).code, 2);
  wroteNothing(s.server);
});

// ── apply --confirm ─────────────────────────────────────────────────────────────────────────

test('apply --confirm needs --confirm right after apply, and a write sign-in', async () => {
  const s = await setup();
  const path = writePlan(s, goodPlan());
  const late = await s.run('annotate', 'apply', '--plan', path, '--confirm');
  assert.equal(late.code, 2);
  assert.match(late.stderr, /--confirm must come right after apply/);
  const ro = await setup({}, 'dashboards');
  const roPath = writePlan(ro, goodPlan());
  const r = await ro.run('annotate', 'apply', '--confirm', '--plan', roPath, '--json');
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /the sign-in to \S+ is read-only \(scope 'dashboards'\); annotate apply --confirm needs session-data:write\. Nothing was written\. To sign in with it, run in a terminal:\n {2}npx .* autologger-mcp login --write --server /);
  assert.equal(existsSync(`${roPath}.apply-state.json`), false);
  // The dry run works read-only, and says what --confirm will need.
  const dry = JSON.parse((await ro.run('annotate', 'apply', '--plan', roPath, '--json')).stdout);
  assert.equal(dry.can_write, false);
  assert.match(dry.login_write_command, / login --write --server /);
  wroteNothing(s.server);
  wroteNothing(ro.server);
});

test('apply --confirm creates each item with its tool, a provenance marker on events, and saves the state; a rerun creates nothing twice', async () => {
  const s = await setup();
  const path = writePlan(s, goodPlan());
  const r = await s.run('annotate', 'apply', '--confirm', '--plan', path, '--json');
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.created, { events: 2, topics: 1, wiki_pages: 1, dashboards: 1 });
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.dropped_fields, []);
  const data = s.server.options.data as FakeData;
  const s1 = data.sessions[0];
  const joke = s1?.events.find((e) => e.message === 'A good joke');
  assert.equal(joke?.category, 'cat_j');
  assert.equal(joke?.timecode, '00:00:42:12');
  assert.deepEqual(joke?.metadata, { created_by: 'autologger-mcp annotate', annotate_plan: 'batch-1', annotate_item: report.items[0].key });
  assert.equal(s1?.events.find((e) => e.message === 'The guest arrives')?.timecode, '00:01:00:00');
  assert.deepEqual(s1?.topics.at(-1), { id: s1?.topics.at(-1)?.id, session_time: '00:00:10:00', duration_sec: 60, topic_level: 2, summary: 'Opening', ordinal: 2, version: 1 });
  const page = data.pages.find((p) => p.title === 'Pasta');
  assert.deepEqual([page?.show_id, page?.kind, page?.aliases, page?.body_md], ['shw_1', 'topic', ['Noodles'], 'About [pasta](cite:S1@42.5).']);
  const board = s1?.dashboards?.at(-1);
  assert.equal(board?.title, 'Overview');
  assert.match(String(board?.tsx), /^const DATA = \{"title":"Overview"\};$/m);
  // Only the four create tools wrote, with only fields their schemas accept (the fake is strict).
  const writes = toolCalls(s.server).filter((t) => WRITE_PREFIXES.some((p) => t.startsWith(p)));
  assert.deepEqual(writes, ['create_event', 'create_event', 'create_topic', 'create_wiki_page', 'save_dashboard']);
  assert.equal(s.server.writeCounts.succeeded, 5);

  const stateFile = `${path}.apply-state.json`;
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(Object.keys(state.created).length, 5);
  assert.equal(state.created['S1/events/guest'].kind, 'events');
  assert.equal(state.created['S1/events/guest'].version, 1);

  const again = await s.run('annotate', 'apply', '--confirm', '--plan', path, '--json');
  assert.equal(again.code, 0, again.stderr);
  const second = JSON.parse(again.stdout);
  assert.deepEqual(second.created, { events: 0, topics: 0, wiki_pages: 0, dashboards: 0 });
  assert.equal(second.skipped.length, 5);
  assert.ok(second.skipped.every((i: { reason: string }) => i.reason === 'created by an earlier apply of this plan (state file)'));
  assert.equal(s.server.writeCounts.attempted, 5, 'nothing written again');
  assert.equal(s1?.events.length, 5);
});

test('without metadata in create_event\'s inputSchema, events are created without the marker (reported in dropped_fields)', async () => {
  const s = await setup({
    inputSchemas: {
      create_event: { type: 'object', properties: { session_id: { type: 'string' }, category: { type: 'string' }, message: { type: 'string' }, timecode: { type: 'string' } }, required: ['session_id', 'category', 'message'], additionalProperties: false },
    },
  });
  const plan = goodPlan();
  const s1 = (plan.sessions as Record<string, unknown>[])[0] as Record<string, unknown>;
  for (const k of ['topics', 'wiki_pages', 'dashboards']) delete s1[k];
  const r = await s.run('annotate', 'apply', '--confirm', '--plan', writePlan(s, plan), '--json');
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.created.events, 2);
  assert.deepEqual(report.dropped_fields, [{ tool: 'create_event', field: 'metadata' }]);
});

test('apply --confirm waits out a write rate limit; with --no-wait it stops, and the same command continues', async () => {
  const s = await setup({ rateLimitAfterWrites: 2, rateLimitTimes: 1, rateLimitRetryS: 30 });
  const path = writePlan(s, goodPlan());
  const r = await s.run('annotate', 'apply', '--confirm', '--plan', path, '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(s.sleeps, [31_000]);
  assert.match(r.stderr, /create_topic: rate limited; waiting 30 s before retrying/);
  assert.equal(s.server.writeCounts.succeeded, 5);

  const t = await setup({ rateLimitAfterWrites: 2, rateLimitTimes: 1, rateLimitRetryS: 30 });
  const tPath = writePlan(t, goodPlan());
  const stopped = await t.run('annotate', 'apply', '--confirm', '--plan', tPath, '--no-wait', '--json');
  assert.equal(stopped.code, 1);
  assert.equal(stopped.stdout, '');
  assert.match(stopped.stderr, /create_topic: rate limited \(retry in 30 s\); stopped\. Progress is saved in .*plan\.json\.apply-state\.json; run the same annotate apply --confirm command again to continue/);
  assert.deepEqual(t.sleeps, []);
  assert.equal(Object.keys(JSON.parse(readFileSync(`${tPath}.apply-state.json`, 'utf8')).created).length, 2);
  const rest = await t.run('annotate', 'apply', '--confirm', '--plan', tPath, '--no-wait', '--json');
  assert.equal(rest.code, 0, rest.stderr);
  assert.deepEqual(JSON.parse(rest.stdout).created, { events: 0, topics: 1, wiki_pages: 1, dashboards: 1 });
  assert.equal(t.server.writeCounts.succeeded, 5);
  assert.equal(t.server.options.data?.sessions[0]?.events.length, 5, 'no event twice');
});

test('an interrupted apply (HTTP 500) keeps what it created; the rerun finishes without duplicates', async () => {
  const s = await setup({ failWriteNumber: 3 });
  const path = writePlan(s, goodPlan());
  const r = await s.run('annotate', 'apply', '--confirm', '--plan', path, '--json');
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /answered 500.*Progress is saved in .*; run the same annotate apply --confirm command again to continue \(nothing is done twice\)/s);
  assert.equal(Object.keys(JSON.parse(readFileSync(`${path}.apply-state.json`, 'utf8')).created).length, 2);
  const again = await s.run('annotate', 'apply', '--confirm', '--plan', path, '--json');
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout).created, { events: 0, topics: 1, wiki_pages: 1, dashboards: 1 });
  const data = s.server.options.data as FakeData;
  assert.equal(data.sessions[0]?.events.length, 5);
  assert.equal(data.sessions[0]?.topics.length, 2);
  assert.equal(data.pages.filter((p) => p.title === 'Pasta').length, 1);
  assert.equal(data.sessions[0]?.dashboards?.length, 2);
});

test('a write the server refuses is reported in failed and the run goes on; a lost state file does not duplicate (client_request_id)', async () => {
  const s = await setup({ toolErrorWriteNumber: 1 });
  const plan = goodPlan();
  const s1 = (plan.sessions as Record<string, unknown>[])[0] as Record<string, unknown>;
  delete s1.dashboards;
  const path = writePlan(s, plan);
  const r = await s.run('annotate', 'apply', '--confirm', '--plan', path, '--json');
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.created, { events: 1, topics: 1, wiki_pages: 1, dashboards: 0 });
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].reason, /^create_event refused it: Internal error\.$/);
  const text = await s.run('annotate', 'apply', '--plan', path);
  assert.match(text.stdout, /1 events, 0 topics, 0 wiki pages, 0 dashboards to create, 3 skip, 0 invalid/);

  // The state file is lost after the writes: the server answers each repeat with its first result.
  unlinkSync(`${path}.apply-state.json`);
  const before = s.server.writeCounts.succeeded;
  const again = await s.run('annotate', 'apply', '--confirm', '--plan', path, '--json');
  assert.equal(again.code, 0, again.stderr);
  const data = s.server.options.data as FakeData;
  assert.equal(data.sessions[0]?.events.filter((e) => e.message === 'The guest arrives').length, 1);
  assert.equal(data.sessions[0]?.topics.filter((t) => t.summary === 'Opening').length, 1);
  assert.equal(s.server.writeCounts.succeeded, before + 1, 'only the refused event is written now');
});

test('a state file for another server is refused', async () => {
  const s = await setup();
  const path = writePlan(s, goodPlan());
  writeFileSync(`${path}.apply-state.json`, JSON.stringify({ format: 'autologger-mcp-annotate-state', version: 1, server: 'https://stage.example', plan_id: 'batch-1', created: {}, skipped: {}, undone: {} }));
  const r = await s.run('annotate', 'apply', '--plan', path);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /records this plan applied to https:\/\/stage\.example, not http:\/\/127\.0\.0\.1:\d+/);
});

// ── undo ────────────────────────────────────────────────────────────────────────────────────

test('annotate undo lists what the plan created; --confirm deletes exactly those, skipping any changed since', async () => {
  const s = await setup();
  const path = writePlan(s, goodPlan());
  assert.equal((await s.run('annotate', 'apply', '--confirm', '--plan', path)).code, 0);
  const data = s.server.options.data as FakeData;
  const s1 = data.sessions[0];
  // Someone edits the created topic, and logs an event of their own.
  const topic = s1?.topics.find((t) => t.summary === 'Opening') as Record<string, unknown>;
  topic.version = 2;
  s1?.events.push({ event_id: 'e_theirs', category: 'cat_j', category_label: 'Joke', message: 'Theirs', metadata: {}, version: 1 });

  const writesBefore = s.server.writeCounts.attempted;
  const dry = await s.run('annotate', 'undo', '--plan', path, '--json');
  assert.equal(dry.code, 0, dry.stderr);
  const listed = JSON.parse(dry.stdout);
  assert.equal(listed.mode, 'dry-run');
  assert.equal(listed.count, 5);
  assert.deepEqual(listed.items.map((i: { kind: string }) => i.kind).sort(), ['dashboards', 'events', 'events', 'topics', 'wiki_pages']);
  assert.equal(s.server.writeCounts.attempted, writesBefore, 'the dry run deletes nothing');
  assert.equal((await s.run('annotate', 'undo', '--plan', path, '--confirm')).code, 2, '--confirm must come right after undo');

  const r = await s.run('annotate', 'undo', '--confirm', '--plan', path, '--json');
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.deleted.map((i: { kind: string }) => i.kind).sort(), ['dashboards', 'events', 'events', 'wiki_pages']);
  assert.equal(report.changed.length, 1);
  assert.match(report.changed[0].reason, /^changed since it was created \(version 1 -> 2\); not deleted$/);
  assert.deepEqual(report.failed, []);
  // Everything else is untouched.
  assert.deepEqual(s1?.events.map((e) => e.event_id), ['e_start', 'e_stop', 'e_joke', 'e_theirs']);
  assert.deepEqual(s1?.topics.map((t) => t.summary), ['Intro', 'Opening']);
  assert.deepEqual(data.pages.map((p) => p.page_id), ['pg_jane']);
  assert.deepEqual(s1?.dashboards?.map((d) => d.dashboard_id), ['db_old']);
  const deletes = toolCalls(s.server).filter((t) => t.startsWith('delete_'));
  assert.deepEqual(deletes.sort(), ['delete_dashboard', 'delete_event', 'delete_event', 'delete_wiki_page']);
  const state = JSON.parse(readFileSync(`${path}.apply-state.json`, 'utf8'));
  assert.deepEqual(Object.keys(state.created), [report.changed[0].key]);
  assert.equal(Object.keys(state.undone).length, 4);

  // Run again: only the changed topic is left, and it is still left alone.
  const again = JSON.parse((await s.run('annotate', 'undo', '--confirm', '--plan', path, '--json')).stdout);
  assert.deepEqual([again.deleted.length, again.changed.length], [0, 1]);
  assert.deepEqual(s1?.topics.map((t) => t.summary), ['Intro', 'Opening']);
});

test('undo --confirm needs a write sign-in; a created item already gone is dropped from the state', async () => {
  const s = await setup();
  const plan = goodPlan();
  const s1 = (plan.sessions as Record<string, unknown>[])[0] as Record<string, unknown>;
  for (const k of ['topics', 'wiki_pages', 'dashboards']) delete s1[k];
  const path = writePlan(s, plan);
  assert.equal((await s.run('annotate', 'apply', '--confirm', '--plan', path)).code, 0);
  const events = s.server.options.data?.sessions[0]?.events ?? [];
  events.splice(events.findIndex((e) => e.message === 'A good joke'), 1);
  const r = JSON.parse((await s.run('annotate', 'undo', '--confirm', '--plan', path, '--json')).stdout);
  assert.deepEqual([r.deleted.length, r.gone.length, r.changed.length], [1, 1, 0]);
  assert.deepEqual(JSON.parse(readFileSync(`${path}.apply-state.json`, 'utf8')).created, {});
  const text = await s.run('annotate', 'undo', '--plan', path);
  assert.match(text.stdout, /would delete 0 items/);
});
