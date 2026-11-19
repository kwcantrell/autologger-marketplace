// index build / status / clear, moments and person-graph, against the fake server in data mode.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { linkTargets } from '../src/links.ts';
import { findIn, fold, matcher, mergeMoments, type Moment } from '../src/moments.ts';
import { mermaidLabel, toMermaid } from '../src/personGraph.ts';
import { MAX_WAIT_S } from '../src/wikiIndex.ts';
import { type FakeData, FakeAutologger, type FakeOptions } from './fakeServer.ts';
import { cli, tempConfigDir, transcript } from './helpers.ts';

const servers: FakeAutologger[] = [];
const configDirs: string[] = [];

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

after(async () => {
  // No output and no index file carries a token any server issued.
  const stored = configDirs.flatMap((d) => filesUnder(join(d, 'index')).map((f) => readFileSync(f, 'utf8')));
  const all = [...transcript, ...stored].join('\n');
  for (const server of servers) {
    for (const t of server.issued) assert.ok(!all.includes(t), 'a token was printed or stored in the index');
    await server.close();
  }
});

const ODD_TITLE = 'Odd "Q" [x] **y** `z`\nline #2 <b>|pipe|</b> --> end';

function data(): FakeData {
  return {
    sessions: [
      {
        session_id: 'S1',
        show_id: 'shw_1',
        title: 'Pilot',
        date: '2026-01-05',
        events: [
          { event_id: 'e1', wall_time_utc: '2026-01-05T10:00:10Z', timecode: '00:00:10:00', frame_rate: 25, timecode_total_frames: 250, category: 'c', message: 'We talk about Crème Brûlée here', version: 1 },
          { event_id: 'e2', wall_time_utc: '2026-01-05T10:02:00Z', timecode: '00:02:00:00', frame_rate: 25, timecode_total_frames: 3000, category: 'c', message: 'A brule is not the topic', version: 1 },
        ],
        topics: [
          { id: 't1', session_time: '00:00:00', duration_sec: 60, topic_level: 1, summary: 'Desserts and creme brulee', ordinal: 1, version: 1 },
          { id: 't2', session_time: '00:01:00', duration_sec: 60, topic_level: 1, summary: 'Weather', ordinal: 2, version: 1 },
        ],
        paragraphs: [
          { ordinal: 1, speaker: 'Ann', session_time: null, start_sec: 12, end_sec: 15, text: 'I love creme BRULEE so much' },
          { ordinal: 2, speaker: 'Ben', session_time: null, start_sec: 90, end_sec: 95, text: 'Something about the Pastry Chef' },
          { ordinal: 3, speaker: 'Ann', session_time: null, start_sec: 100, end_sec: 105, text: 'brûléed onions' },
        ],
      },
      {
        session_id: 'S2',
        show_id: 'shw_1',
        title: 'Second',
        date: '2026-01-03',
        events: [],
        topics: [{ id: 't9', session_time: '00:00:20', duration_sec: 30, topic_level: 1, summary: 'Guests', ordinal: 1, version: 1 }],
        paragraphs: [{ ordinal: 1, speaker: 'Cy', session_time: null, start_sec: 30, end_sec: 33, text: 'Jean-Luc joined, the pâtissier' }],
      },
      { session_id: 'S3', show_id: 'shw_1', title: 'Hidden', hidden: true, events: [{ event_id: 'h', message: 'creme brulee hidden' }], topics: [] },
      { session_id: 'X1', show_id: 'shw_2', title: 'Other show', events: [{ event_id: 'x', message: 'creme brulee elsewhere' }], topics: [] },
    ],
    pages: [
      { page_id: 'pg_s1', show_id: 'shw_1', kind: 'session', title: 'Pilot', aliases: [], body_md: 'Recap with [Jane](wiki:pg_jane).\n', revision: 1, session_id: 'S1' },
      {
        page_id: 'pg_jane',
        show_id: 'shw_1',
        kind: 'person',
        title: 'Jane Doe',
        aliases: ['Pastry Chef'],
        body_md: 'Jane said [the crème brûlée line](cite:S1@12) and [later](cite:S2@31.5).\n\nFriend of [Bob](wiki:pg_bob).\n',
        revision: 1,
      },
      { page_id: 'pg_desserts', show_id: 'shw_1', kind: 'topic', title: 'Desserts', aliases: [], body_md: 'Covered in [ep](cite:S2@5); see [Jane](wiki:pg_jane).\n', revision: 1 },
      { page_id: 'pg_odd', show_id: 'shw_1', kind: 'person', title: ODD_TITLE, aliases: ['JD'], body_md: 'Said [a "quote" \\[x\\] here](cite:S2@25).\n', revision: 1 },
      { page_id: 'pg_jd2', show_id: 'shw_1', kind: 'person', title: 'Jo Dee', aliases: ['JD'], body_md: 'Also [here](cite:S2@26).\n', revision: 1 },
      { page_id: 'pg_bob', show_id: 'shw_1', kind: 'person', title: 'Bob', aliases: [], body_md: 'Works with [Jane](wiki:pg_jane).\n', revision: 1 },
    ],
  };
}

interface Setup {
  server: FakeAutologger;
  configDir: string;
  sleeps: number[];
  run: (...argv: string[]) => ReturnType<typeof cli>;
  tools: () => string[];
}

async function setup(options: FakeOptions = {}): Promise<Setup> {
  const server = await new FakeAutologger({ data: data(), ...options }).start();
  servers.push(server);
  const configDir = tempConfigDir();
  configDirs.push(configDir);
  const sleeps: number[] = [];
  const run = (...argv: string[]) => cli({ configDir, server: server.base, sleep: async (ms) => void sleeps.push(ms) }, ...argv);
  assert.equal((await run('login')).code, 0);
  server.calls.length = 0;
  const tools = () => server.calls.filter((c) => c.tool !== undefined).map((c) => c.tool as string);
  return { server, configDir, sleeps, run, tools };
}

const json = (stdout: string): Record<string, any> => JSON.parse(stdout) as Record<string, any>;

test('index build reads every visible session of the show with read tools only, into 0600 files in 0700 dirs', async () => {
  const s = await setup({ pageSize: 1, sliceChars: 10 });
  const r = await s.run('index', 'build', '--show', 'shw_1', '--json');
  assert.equal(r.code, 0, r.stderr);
  const report = json(r.stdout);
  assert.equal(report.complete, true);
  assert.equal(report.sessions.in_scope, 2, 'the hidden session is not listed');
  assert.equal(report.sessions.content_read, 2);
  assert.equal(report.continue_command, undefined);
  const used = new Set(s.tools());
  assert.deepEqual([...used].sort(), ['get_session', 'get_wiki_page', 'list_events', 'list_sessions', 'list_topics', 'list_transcript_paragraphs', 'list_wiki_pages']);
  // Every page of every list (page size 1) and every slice of each body (10 chars).
  const paragraphCalls = s.server.calls.filter((c) => c.tool === 'list_transcript_paragraphs' && (c.arguments as { session_id: string }).session_id === 'S1');
  assert.equal(paragraphCalls.length, 3);
  assert.ok(s.server.calls.some((c) => c.tool === 'get_wiki_page' && (c.arguments as { offset?: number }).offset === 90));
  const dir = report.index_dir as string;
  assert.ok(dir.startsWith(join(s.configDir, 'index')));
  for (const d of [join(s.configDir, 'index'), dir, join(dir, 'sessions'), join(dir, 'pages')]) assert.equal(statSync(d).mode & 0o777, 0o700, d);
  const files = filesUnder(dir);
  for (const f of files) assert.equal(statSync(f).mode & 0o777, 0o600, f);
  assert.deepEqual(readdirSync(dir).sort(), ['meta.json', 'pages', 'sessions']);
  // A whole body was reassembled from its slices.
  const stored = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  assert.ok(stored.includes(JSON.stringify(data().pages[1]?.body_md)));
});

test('an unchanged second build makes only the listing and get_session calls; a changed revision re-reads that session', async () => {
  const s = await setup();
  assert.equal((await s.run('index', 'build', '--show', 'shw_1', '--json')).code, 0);
  s.server.calls.length = 0;
  const second = await s.run('index', 'build', '--show', 'shw_1', '--json');
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual([...new Set(s.tools())].sort(), ['get_session', 'list_sessions', 'list_wiki_pages']);
  assert.equal(json(second.stdout).sessions.unchanged, 2);
  assert.equal(json(second.stdout).pages.unchanged, 5);

  // A write to S1 advances its revision: only S1's content is read again.
  const s1 = s.server.options.data?.sessions.find((x) => x.session_id === 'S1');
  assert.ok(s1 !== undefined);
  s1.revision = 2;
  s.server.calls.length = 0;
  const third = await s.run('index', 'build', '--show', 'shw_1', '--json');
  assert.equal(json(third.stdout).sessions.content_read, 1);
  const contentCalls = s.server.calls.filter((c) => c.tool === 'list_events' || c.tool === 'list_topics' || c.tool === 'list_transcript_paragraphs');
  assert.ok(contentCalls.length > 0 && contentCalls.every((c) => (c.arguments as { session_id: string }).session_id === 'S1'));
  assert.ok(!s.tools().includes('get_wiki_page'));

  // A count that changed with the same revision also re-reads; so does a wiki page's new revision (its body only).
  s1.events.push({ event_id: 'e3', message: 'new', timecode_total_frames: 0, frame_rate: 25 });
  const jane = s.server.options.data?.pages.find((p) => p.page_id === 'pg_jane');
  assert.ok(jane !== undefined);
  jane.revision = 2;
  jane.body_md += '\nShe also loves [tarts](cite:S1@200).\n';
  s.server.calls.length = 0;
  const fourth = json((await s.run('index', 'build', '--show', 'shw_1', '--json')).stdout);
  assert.equal(fourth.sessions.content_read, 1);
  assert.equal(fourth.pages.read, 1);
  assert.deepEqual(new Set(s.server.calls.filter((c) => c.tool === 'get_wiki_page').map((c) => (c.arguments as { page_id: string }).page_id)), new Set(['pg_jane']));
  const tarts = json((await s.run('moments', 'tarts', '--show', 'shw_1', '--json')).stdout);
  assert.equal(tarts.moments[0]?.cite, 'cite:S1@200');
});

test('--max-reads stops cleanly between calls with the command to continue; the rerun does not re-read finished sessions', async () => {
  const s = await setup();
  const first = await s.run('index', 'build', '--show', 'shw_1', '--max-reads', '13', '--json');
  assert.equal(first.code, 0, first.stderr);
  const report = json(first.stdout);
  assert.equal(report.complete, false);
  assert.equal(report.reads, 13);
  assert.match(report.stopped, /read budget of 13/);
  assert.match(report.continue_command, /^npx --yes --offline --loglevel=error --package=\S+ -- autologger-mcp index build --server http:\/\/127\.0\.0\.1:\d+ --show shw_1 --max-reads 13 --json$/);
  assert.equal(s.tools().length, 13);
  const doneFirst = report.sessions.content_read as number;
  assert.equal(doneFirst, 1, 'S1 finished within the budget, S2 did not');
  // moments says the scope is not fully indexed, with the build command.
  const partial = json((await s.run('moments', 'brulee', '--show', 'shw_1', '--json')).stdout);
  assert.equal(partial.complete, false);
  assert.match(partial.build_command, / index build --server \S+ --show shw_1 --json$/);

  s.server.calls.length = 0;
  const second = await s.run('index', 'build', '--show', 'shw_1', '--json');
  const done = json(second.stdout);
  assert.equal(done.complete, true);
  assert.equal(done.resumed, true);
  assert.equal(done.sessions.done_before, 1);
  assert.ok(!s.server.calls.some((c) => c.tool === 'list_sessions'), 'the listing is kept from the stopped run');
  assert.ok(!s.server.calls.some((c) => (c.arguments as { session_id?: string } | undefined)?.session_id === 'S1'), 'S1 is not read again');
  assert.equal(json((await s.run('moments', 'brulee', '--show', 'shw_1', '--json')).stdout).complete, true);
});

test('a rate limit is waited out within the bound; a longer one stops the build like the budget, and the rerun continues', async () => {
  const s = await setup({ rateLimitAfterReads: 3, rateLimitReadTimes: 2, rateLimitRetryS: 7 });
  const r = await s.run('index', 'build', '--show', 'shw_1', '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r.stdout).complete, true);
  assert.deepEqual(s.sleeps, [8000, 8000]);
  assert.match(r.stderr, /rate limited; waiting 7 s/);

  const t = await setup({ rateLimitAfterReads: 4, rateLimitReadTimes: 1, rateLimitRetryS: MAX_WAIT_S + 1 });
  const stopped = await t.run('index', 'build', '--show', 'shw_1', '--json');
  assert.equal(stopped.code, 0, stopped.stderr);
  const report = json(stopped.stdout);
  assert.equal(report.complete, false);
  assert.match(report.stopped, /rate limited \(retry in 91 s\)/);
  assert.match(report.continue_command, / index build --server \S+ --show shw_1 --json$/);
  assert.deepEqual(t.sleeps, []);
  const rerun = json((await t.run('index', 'build', '--show', 'shw_1', '--json')).stdout);
  assert.equal(rerun.complete, true);
  assert.equal(rerun.resumed, true);
});

test('index build --studio and --all list shows and studios; index status and index clear', async () => {
  const s = await setup();
  const studio = json((await s.run('index', 'build', '--studio', 'st_1', '--json')).stdout);
  assert.equal(studio.complete, true);
  assert.equal(studio.sessions.in_scope, 3, 'both shows, without the hidden session');
  const all = json((await s.run('index', 'build', '--all', '--json')).stdout);
  assert.equal(all.complete, true);
  assert.ok(s.tools().includes('list_studios') && s.tools().includes('list_shows'));
  // A show inside an indexed studio counts as indexed.
  assert.equal(json((await s.run('moments', 'brulee', '--show', 'shw_2', '--json')).stdout).complete, true);
  const status = json((await s.run('index', 'status', '--json')).stdout);
  assert.equal(status.exists, true);
  assert.equal(status.sessions, 3);
  assert.deepEqual(status.builds.map((b: { scope: string }) => b.scope).sort(), ['all', 'studio:st_1']);
  assert.ok(status.builds.every((b: { age_s: number }) => b.age_s >= 0));
  assert.match((await s.run('index', 'status')).stdout, /studio:st_1: built .* ago/);
  const cleared = json((await s.run('index', 'clear', '--json')).stdout);
  assert.equal(cleared.cleared, true);
  assert.equal(json((await s.run('index', 'status', '--json')).stdout).exists, false);
  assert.equal(json((await s.run('index', 'clear', '--json')).stdout).cleared, false);
});

test('moments answers from the index only: accents, case, whole words, aliases, a wiki-cited moment, merged near-duplicates', async () => {
  const s = await setup();
  assert.equal((await s.run('index', 'build', '--show', 'shw_1', '--json')).code, 0);
  s.server.calls.length = 0;
  const fail = async (): Promise<Response> => {
    throw new Error('moments must not call the server');
  };
  const run = (...argv: string[]) => cli({ configDir: s.configDir, server: s.server.base, fetch: fail }, ...argv);
  const r = await run('moments', 'Crème Brûlée', '--show', 'shw_1', '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(s.server.calls.length, 0);
  const out = json(r.stdout);
  assert.equal(out.complete, true);
  const m = out.moments as Moment[];
  // S2 (2026-01-03) before S1 (2026-01-05); in S1 by time.
  assert.deepEqual(
    m.map((x) => [x.session_id, x.seconds, x.source]),
    [
      ['S2', 31.5, 'wiki'],
      ['S1', 0, 'topic'],
      ['S1', 10, 'event'],
    ],
  );
  const event = m[2];
  assert.ok(event !== undefined);
  // The transcript paragraph at 12 s and the wiki citation at 12 s are merged into the event at 10 s.
  assert.deepEqual(event.also?.map((a) => [a.source, a.seconds]), [['transcript', 12], ['wiki', 12]]);
  assert.equal(event.cite, 'cite:S1@10');
  assert.equal(event.session_title, 'Pilot');
  assert.equal(event.session_date, '2026-01-05');
  assert.equal(event.show_id, 'shw_1');
  assert.equal(event.term, 'Crème Brûlée');
  assert.match(event.snippet, /Crème Brûlée/);
  assert.equal(m[0]?.cite, 'cite:S2@31.5');
  // 'A brule is not the topic' and 'brûléed onions' are not whole-word matches; other shows and hidden sessions are out of scope.
  assert.ok(!m.some((x) => x.ref === 'e2' || x.ref === '3' || x.session_id === 'X1' || x.session_id === 'S3'));
  // Every cite passes check-links.
  for (const x of m) assert.match(x.cite ?? '', /^cite:[A-Za-z0-9_-]{1,64}@\d+(\.\d{1,3})?$/);
  const body = m.map((x) => `[q](${x.cite})`).join('\n');
  const checked = await cli({ configDir: s.configDir, stdin: body }, 'check-links', '-', '--json');
  assert.equal(checked.code, 0, checked.stderr);

  // An alias names Jane's page: her title and aliases become terms and her citations moments.
  const alias = json((await run('moments', 'pastry chef', '--show', 'shw_1', '--json')).stdout);
  assert.deepEqual(alias.terms, ['pastry chef', 'Jane Doe']);
  assert.deepEqual(
    (alias.moments as Moment[]).map((x) => [x.session_id, x.seconds, x.source]),
    [
      ['S2', 31.5, 'wiki'],
      ['S1', 12, 'wiki'],
      ['S1', 90, 'transcript'],
    ],
  );
  assert.ok((alias.wiki_pages as { page_id: string; matched_in: string }[]).some((p) => p.page_id === 'pg_jane' && p.matched_in === 'alias'));

  // --term adds a term; matching is accent-insensitive both ways.
  const extra = json((await run('moments', 'nothing-here', '--term', 'patissier', '--show', 'shw_1', '--json')).stdout);
  assert.deepEqual((extra.moments as Moment[]).map((x) => [x.session_id, x.seconds, x.source, x.term, x.speaker]), [['S2', 30, 'transcript', 'patissier', 'Cy']]);

  // A scope never built: not fully indexed, with the build command, and no moments.
  const other = json((await run('moments', 'brulee', '--studio', 'st_9', '--json')).stdout);
  assert.equal(other.complete, false);
  assert.deepEqual(other.moments, []);
  assert.match(other.build_command, / index build --server \S+ --studio st_9 --json$/);
  assert.match((await run('moments', 'brulee', '--studio', 'st_9')).stdout, /not fully indexed; to index it, run:\n {2}npx /);
});

test('person-graph: nodes, edges and a Mermaid diagram, from the index only', async () => {
  const s = await setup();
  assert.equal((await s.run('index', 'build', '--show', 'shw_1', '--json')).code, 0);
  s.server.calls.length = 0;
  const r = await s.run('person-graph', 'jane doe', '--show', 'shw_1', '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(s.server.calls.length, 0);
  const g = json(r.stdout);
  assert.equal(g.person.page_id, 'pg_jane');
  const node = (id: string) => (g.nodes as { id: string; [k: string]: unknown }[]).find((n) => n.id === id);
  const has = (from: string, to: string, type: string) => (g.edges as { from: string; to: string; type: string }[]).some((e) => e.from === from && e.to === to && e.type === type);
  assert.equal(node('page:pg_jane')?.type, 'person');
  // Out-link to Bob (not reachable through MCP, so not indexed); in-links from the session page and the topic page.
  assert.equal(node('page:pg_bob')?.in_index, false);
  assert.ok(has('page:pg_jane', 'page:pg_bob', 'links_to'));
  assert.ok(has('page:pg_s1', 'page:pg_jane', 'links_to'));
  assert.ok(has('page:pg_desserts', 'page:pg_jane', 'links_to'));
  assert.equal(node('page:pg_desserts')?.kind, 'topic');
  assert.equal(node('page:pg_s1')?.kind, 'session');
  // Cited moments, their sessions and the topics whose span holds them.
  assert.equal(node('moment:S1@12')?.cite, 'cite:S1@12');
  assert.ok(has('page:pg_jane', 'moment:S1@12', 'cites'));
  assert.ok(has('moment:S1@12', 'session:S1', 'in_session'));
  assert.ok(has('moment:S1@12', 'topic:S1:t1', 'during'));
  assert.ok(!has('moment:S1@12', 'topic:S1:t2', 'during'));
  assert.ok(has('moment:S2@31.5', 'topic:S2:t9', 'during'));
  assert.equal(node('session:S2')?.title, 'Second');
  assert.match(g.mermaid, /^graph LR\n/);
  // By page id, and in text form the diagram itself.
  const text = await s.run('person-graph', 'pg_jane', '--show', 'shw_1');
  assert.equal(text.code, 0);
  assert.match(text.stdout, /^graph LR\n/);
});

test('person-graph: labels with quotes, brackets, newlines and Markdown cannot break out of their node', async () => {
  const s = await setup();
  assert.equal((await s.run('index', 'build', '--show', 'shw_1', '--json')).code, 0);
  const r = await s.run('person-graph', 'pg_odd', '--show', 'shw_1', '--json');
  assert.equal(r.code, 0, r.stderr);
  const g = json(r.stdout);
  const lines = (g.mermaid as string).trimEnd().split('\n');
  assert.equal(lines[0], 'graph LR');
  for (const line of lines.slice(1)) {
    assert.match(line, /^ {2}n\d+\["[^"[\]`<>|\n*#]*(?:#\d+;[^"[\]`<>|\n*#]*)*"\]$|^ {2}n\d+ -->\|[a-z ]+\| n\d+$/, line);
  }
  // Exactly one node line per node, so nothing a label holds made a node or an edge of its own.
  assert.equal(lines.filter((l) => /^ {2}n\d+\[/.test(l)).length, (g.nodes as unknown[]).length);
  assert.equal(lines.filter((l) => / -->\|/.test(l)).length, (g.edges as unknown[]).length);
  assert.ok(lines.some((l) => l.includes('#34;Q#34;') && l.includes('#91;x#93;')));
  assert.equal(mermaidLabel('a\nb "c" [d] `e` *f* #g'), 'a b #34;c#34; #91;d#93; #96;e#96; #42;f#42; #35;g');
  assert.ok([...mermaidLabel('x'.repeat(200))].length < 80);
  const custom = toMermaid([{ id: 'a"]-->b', type: 'page', label: '"]\nclick n0 call evil()' }], []);
  assert.equal(custom, 'graph LR\n  n0["#34;#93; click n0 call evil()"]\n');
});

test('person-graph errors: a missing person names index build; several matches are listed', async () => {
  const s = await setup();
  const none = await s.run('person-graph', 'Jane Doe', '--show', 'shw_1', '--json');
  assert.equal(none.code, 1);
  assert.equal(none.stdout, '');
  assert.match(none.stderr, /no person page 'Jane Doe' in the index .*run index build first:\n {2}npx .* index build --server \S+ --show shw_1 --json/s);
  assert.equal((await s.run('index', 'build', '--show', 'shw_1', '--json')).code, 0);
  const many = await s.run('person-graph', 'jd', '--show', 'shw_1', '--json');
  assert.equal(many.code, 1);
  assert.match(many.stderr, /'jd' names 2 person pages; pass one page_id:\n {2}pg_jd2 {2}Jo Dee \(aliases: JD\)\n {2}pg_odd/);
  // A topic page is not a person.
  assert.equal((await s.run('person-graph', 'Desserts', '--show', 'shw_1', '--json')).code, 1);
});

test('session data is data: odd ids never name a path, a cite is only written on the grammar', async () => {
  const d = data();
  d.sessions.push({ session_id: '../../evil', show_id: 'shw_1', title: 'x', events: [{ event_id: 'ev', message: 'creme brulee', timecode_total_frames: 25, frame_rate: 25 }], topics: [] });
  const s = await setup({ data: d });
  const r = await s.run('index', 'build', '--show', 'shw_1', '--json');
  assert.equal(r.code, 0, r.stderr);
  const dir = json(r.stdout).index_dir as string;
  for (const f of filesUnder(join(s.configDir))) assert.ok(f.startsWith(join(s.configDir, 'index')) || f.startsWith(join(s.configDir, 'credentials')), f);
  for (const f of filesUnder(join(dir, 'sessions'))) assert.match(f, /\/sessions\/[0-9a-f]{32}\.json$/);
  const m = json((await s.run('moments', 'brulee', '--show', 'shw_1', '--json')).stdout).moments as Moment[];
  const evil = m.find((x) => x.session_id === '../../evil');
  assert.equal(evil?.cite, null);
  assert.equal(evil?.seconds, 1);
});

test('bad index, moments and person-graph arguments are usage errors', async () => {
  const configDir = tempConfigDir();
  const run = (...argv: string[]) => cli({ configDir, server: 'http://127.0.0.1:9' }, ...argv);
  for (const argv of [
    ['index'],
    ['index', 'rebuild'],
    ['index', 'build'],
    ['index', 'build', '--show', 'a', '--all'],
    ['index', 'build', '--show', 'a b'],
    ['index', 'build', '--show', 'a', '--max-reads', '0'],
    ['index', 'build', '--show', 'a', '--term', 'x'],
    ['index', 'clear', '--show', 'a'],
    ['index', 'status', '--all'],
    ['moments', '--show', 'a'],
    ['moments', 'x', 'y', '--show', 'a'],
    ['moments', 'x'],
    ['moments', '!!!', '--show', 'a'],
    ['person-graph', 'x', '--studio', 's', '--show', 'a'],
    ['person-graph', 'x', '--show', 'a', '--term', 'y'],
  ]) {
    const r = await run(...argv);
    assert.equal(r.code, 2, `${argv.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '');
  }
});

test('matching helpers: folding, whole words and phrases, link targets, merging', () => {
  assert.equal(fold('Crème BRÛLÉE').folded, 'creme brulee');
  const m = matcher('Jean-Luc');
  assert.ok(m !== undefined);
  assert.deepEqual(findIn(m, 'Hi jean luc!'), { start: 3, end: 11 });
  assert.equal(findIn(m, 'jeanluc'), undefined);
  assert.equal(matcher('  !! '), undefined);
  const at = findIn(matcher('ete') as NonNullable<ReturnType<typeof matcher>>, 'Un été chaud');
  assert.deepEqual(at, { start: 3, end: 6 });
  assert.deepEqual(
    linkTargets('A [q](cite:S1@2.5) `[no](wiki:p0)` [p](wiki:p1)\n```\n[x](cite:S9@1)\n```\n[bad](cite:S1@x)'),
    [
      { kind: 'cite', session_id: 'S1', seconds: 2.5, label: 'q', index: 2 },
      { kind: 'wiki', page_id: 'p1', label: 'p', index: 35 },
    ],
  );
  const base = { session_title: '', session_date: '2026-01-01', show_id: 'h', snippet: '', term: 't', cite: null, ref: 'r' };
  const merged = mergeMoments([
    { ...base, session_id: 'A', seconds: 20, source: 'event' },
    { ...base, session_id: 'A', seconds: 1, source: 'topic' },
    { ...base, session_id: 'A', seconds: 4, source: 'transcript' },
    { ...base, session_id: 'A', seconds: null, source: 'wiki' },
    { ...base, session_id: 'A', seconds: null, source: 'wiki' },
  ]);
  assert.deepEqual(merged.map((x) => [x.seconds, x.source, x.also?.length ?? 0]), [[1, 'topic', 1], [20, 'event', 0], [null, 'wiki', 0]]);
});
