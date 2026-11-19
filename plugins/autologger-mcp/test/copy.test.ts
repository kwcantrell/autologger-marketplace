// export and import: seeding a target (a local dev stack) from a source server, both played by
// the fake server in data mode.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { checkLinks, rewriteLinks } from '../src/links.ts';
import { type FakeData, FakeAutologger, type FakeOptions } from './fakeServer.ts';
import { cli, tempConfigDir, transcript } from './helpers.ts';

const WRITE_TOOLS = ['create_event', 'update_event', 'delete_event', 'create_topic', 'update_topic', 'delete_topic', 'create_wiki_page', 'update_wiki_page', 'delete_wiki_page'];
const READ_TOOLS = ['get_session', 'list_events', 'list_topics', 'list_wiki_pages', 'get_wiki_page'];

const servers: FakeAutologger[] = [];
const files: string[] = [];
after(async () => {
  // Token non-disclosure: no output, snapshot or state file carries a token any server issued.
  const printed = [...transcript, ...files.filter(existsSync).map((f) => readFileSync(f, 'utf8'))].join('\n');
  for (const server of servers) {
    for (const t of server.issued) assert.ok(!printed.includes(t), 'a token was printed or stored');
    await server.close();
  }
});

const LONG_A = `# Session one\n\nWith [Jane](wiki:pg_b), a [quote](cite:S1@12.5), [gone](wiki:pg_zzz) and [elsewhere](cite:S9@3).\n${'Padding text. '.repeat(10)}\n`;

function sourceData(): FakeData {
  return {
    sessions: [
      {
        session_id: 'S1',
        show_id: 'shw_src',
        categories: [{ id: 'cat_a', label: 'Joke' }],
        events: [1, 2, 3, 4, 5].map((n) => ({
          event_id: `e${n}`,
          wall_time_utc: `2026-01-0${n}T10:00:00.000Z`,
          timecode: '00:00:01:00',
          frame_rate: 25,
          timecode_total_frames: 25,
          category: n === 5 ? 'internal' : 'cat_a',
          category_label: n === 5 ? 'Internal' : 'Joke',
          category_color: '#f00',
          message: `event ${n}`,
          metadata: { n },
          version: 2,
        })),
        topics: [1, 2, 3].map((n) => ({
          id: `t${n}`,
          session_time: `00:0${n}:00:00`,
          duration_sec: 30,
          topic_level: 2,
          summary: `topic ${n}`,
          ordinal: n,
          created_at_utc: '2026-01-01T00:00:00Z',
          version: 1,
        })),
      },
      { session_id: 'S2', show_id: 'shw_src', events: [], topics: [] },
    ],
    pages: [
      { page_id: 'pg_a', show_id: 'shw_src', kind: 'session', title: 'Session one', aliases: [], body_md: LONG_A, revision: 3, session_id: 'S1' },
      { page_id: 'pg_b', show_id: 'shw_src', kind: 'person', title: 'Jane', aliases: ['J'], body_md: 'Jane said [this](cite:S1@1) about [the session](wiki:pg_a).\n', revision: 1 },
    ],
  };
}

function targetData(extraPages: FakeData['pages'] = []): FakeData {
  return {
    sessions: [
      { session_id: 'T1', show_id: 'shw_t', categories: [{ id: 'cat_t', label: 'joke' }], events: [], topics: [] },
      { session_id: 'T2', show_id: 'shw_t', categories: [], events: [], topics: [] },
    ],
    pages: extraPages,
  };
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
  run: (...argv: string[]) => ReturnType<typeof cli>;
}

/** A source signed in read-only, a target signed in with write (unless `targetWrite` is false), and a snapshot of S1. */
async function setup(targetOptions: FakeOptions = {}, targetWrite = true): Promise<Setup> {
  const source = await fake({ data: sourceData() });
  const target = await fake({ data: targetData(), ...targetOptions });
  const configDir = tempConfigDir();
  const sleeps: number[] = [];
  const run = (...argv: string[]) => cli({ configDir, sleep: async (ms) => void sleeps.push(ms) }, ...argv);
  assert.equal((await run('login', '--server', source.base)).code, 0);
  const login = await run('login', '--server', target.base, ...(targetWrite ? ['--write'] : []));
  assert.equal(login.code, 0, login.stderr);
  const snapshot = join(configDir, 'snapshot.json');
  files.push(snapshot, `${snapshot}.import-state.json`);
  const exported = await run('export', '--server', source.base, '--session', 'S1', '--out', snapshot, '--json');
  assert.equal(exported.code, 0, exported.stderr);
  target.calls.length = 0;
  return { source, target, configDir, snapshot, sleeps, run };
}

const writeCalls = (server: FakeAutologger) => server.calls.filter((c) => c.tool !== undefined && WRITE_TOOLS.includes(c.tool));
const importArgs = (s: Setup, ...more: string[]) => ['import', ...more, '--server', s.target.base, '--snapshot', s.snapshot, '--map', 'S1=T1', '--json'];

test('export: every page of each list and every slice of each wiki body, with read tools only', async () => {
  const source = await fake({ data: sourceData() });
  const configDir = tempConfigDir();
  const run = (...argv: string[]) => cli({ configDir }, ...argv);
  assert.equal((await run('login', '--server', source.base)).code, 0);
  source.calls.length = 0;
  const out = join(configDir, 'snap.json');
  files.push(out);
  const result = await run('export', '--server', source.base, '--session', 'S1', '--session', 'S2', '--out', out, '--json');
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary.sessions, [
    { session_id: 'S1', events: 5, topics: 3, wiki_pages: 2 },
    { session_id: 'S2', events: 0, topics: 0, wiki_pages: 0 },
  ]);
  assert.deepEqual(summary.totals, { sessions: 2, events: 5, topics: 3, wiki_pages: 2 });

  const tools = source.calls.filter((c) => c.tool !== undefined).map((c) => c.tool as string);
  assert.ok(tools.every((t) => READ_TOOLS.includes(t)), tools.join(','));
  assert.equal(tools.filter((t) => t === 'list_events').length, 3 + 1, 'three pages for S1 (page size 2), one for S2');
  assert.ok(tools.filter((t) => t === 'get_wiki_page').length >= 6, 'the long body comes in several slices');

  const snap = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(snap.format, 'autologger-mcp-snapshot');
  assert.equal(snap.source_server, source.base);
  const s1 = snap.sessions[0];
  assert.equal(s1.session.show_id, 'shw_src');
  assert.deepEqual(s1.events.map((e: { event_id: string }) => e.event_id), ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.equal(s1.topics.length, 3);
  const a = s1.wiki_pages.find((p: { page_id: string }) => p.page_id === 'pg_a');
  assert.equal(a.body_md, LONG_A);
  assert.equal(a.association, 'session_page');
  assert.equal('next_offset' in a, false);
  assert.equal(statSync(out).mode & 0o777, 0o600);
});

test('export refuses an existing --out unless export --force (right after export, so the pre-approved form cannot overwrite)', async () => {
  const s = await setup();
  writeFileSync(s.snapshot, 'keep me');
  const refused = await s.run('export', '--server', s.source.base, '--session', 'S1', '--out', s.snapshot, '--json');
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /already exists; run 'export --force \.\.\.' to overwrite it/);
  assert.equal(readFileSync(s.snapshot, 'utf8'), 'keep me');
  // The skill pre-approves `export --server ...`: --force anywhere after that is a usage error.
  s.source.calls.length = 0;
  for (const at of [3, 7, 9]) {
    const argv = ['export', '--server', s.source.base, '--session', 'S1', '--out', s.snapshot, '--json'];
    argv.splice(at, 0, '--force');
    const late = await s.run(...argv);
    assert.equal(late.code, 2, argv.join(' '));
    assert.equal(late.stdout, '');
    assert.match(late.stderr, /--force must come right after export/);
  }
  assert.equal(readFileSync(s.snapshot, 'utf8'), 'keep me');
  assert.deepEqual(s.source.calls.filter((c) => c.tool !== undefined), [], 'refused before any request');
  const forced = await s.run('export', '--force', '--server', s.source.base, '--session', 'S1', '--out', s.snapshot, '--json');
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(JSON.parse(readFileSync(s.snapshot, 'utf8')).sessions.length, 1);
  assert.equal(statSync(s.snapshot).mode & 0o777, 0o600);
});

test('export writes only a .json --out (never a file a shell reads, such as ~/.bash_aliases)', async () => {
  const s = await setup();
  for (const name of ['.bash_aliases', '.bashrc', 'snap', 'snap.json.sh', 'snap.JSON']) {
    const out = join(s.configDir, name);
    for (const force of [[], ['--force']]) {
      const result = await s.run('export', ...force, '--server', s.source.base, '--session', 'S1', '--out', out, '--json');
      assert.equal(result.code, 2, `${force.join(' ')} ${name}`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /must be a \.json file/);
      assert.equal(existsSync(out), false);
    }
  }
});

test('export of a session the source does not have exits 1', async () => {
  const s = await setup();
  const out = join(s.configDir, 'none.json');
  const result = await s.run('export', '--server', s.source.base, '--session', 'NOPE', '--out', out);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /get_session failed: Session not found/);
  assert.equal(existsSync(out), false);
});

test('import is a dry run by default: the plan, and no write tool is called', async () => {
  const s = await setup();
  const result = await s.run(...importArgs(s));
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'dry-run');
  assert.deepEqual(report.plan, { create: { events: 5, topics: 3, wiki_pages: 2 }, already_done: 0, fix_links: 0, fix_timecode: 0, skip: 0 });
  assert.deepEqual(report.frame_rate_mismatch, []);
  assert.deepEqual(report.sessions, [{ source_session_id: 'S1', target_session_id: 'T1', target_show_id: 'shw_t' }]);
  assert.deepEqual(
    report.unresolved_links.map((u: { link: string }) => u.link).sort(),
    ['cite:S9@3', 'wiki:pg_zzz'],
  );
  const dropped = report.dropped_fields.map((d: { tool: string; field: string }) => `${d.tool}.${d.field}`);
  for (const field of ['create_event.version', 'create_event.category_color', 'create_topic.ordinal', 'create_wiki_page.revision']) assert.ok(dropped.includes(field), field);
  // The target's create_event takes timecode (autologger 4d2b1a37 and later): it is sent, not dropped.
  assert.ok(!dropped.includes('create_event.timecode'));
  assert.equal(new Set(dropped).size, dropped.length, 'each dropped field once');
  assert.deepEqual(writeCalls(s.target), []);
  assert.equal(existsSync(`${s.snapshot}.import-state.json`), false);
  const text = await s.run(...importArgs(s).filter((a) => a !== '--json'));
  assert.match(text.stdout, /^Dry run: nothing was written/);
  assert.deepEqual(writeCalls(s.target), []);
});

test('import --confirm writes, rewrites wiki links (also to a page created later), and a rerun creates nothing', async () => {
  const s = await setup();
  const result = await s.run(...importArgs(s, '--confirm'));
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.created, { events: 5, topics: 3, wiki_pages: 2 });
  assert.equal(report.links_fixed, 1, 'pg_a linked to pg_b before pg_b existed');
  assert.deepEqual(report.failed, []);
  assert.ok(writeCalls(s.target).length > 0);

  const data = s.target.options.data as FakeData;
  const t1 = data.sessions[0];
  assert.equal(t1?.events.length, 5);
  assert.deepEqual(t1?.events.map((e) => e.category), ['cat_t', 'cat_t', 'cat_t', 'cat_t', 'internal'], 'categories by name on the target');
  assert.equal(t1?.events[0]?.wall_time_utc, '2026-01-01T10:00:00.000Z');
  assert.equal(t1?.topics.length, 3);
  const a = data.pages.find((p) => p.title === 'Session one');
  const b = data.pages.find((p) => p.title === 'Jane');
  assert.ok(a !== undefined && b !== undefined);
  assert.equal(a.session_id, 'T1');
  assert.equal(a.show_id, 'shw_t');
  assert.ok(a.body_md.includes(`[Jane](wiki:${b.page_id})`), a.body_md);
  assert.ok(a.body_md.includes('[quote](cite:T1@12.5)'));
  assert.ok(a.body_md.includes('[gone](wiki:pg_zzz)') && a.body_md.includes('[elsewhere](cite:S9@3)'), 'unresolved links unchanged');
  assert.ok(b.body_md.includes(`[the session](wiki:${a.page_id})`) && b.body_md.includes('cite:T1@1'));
  for (const page of [a, b]) assert.deepEqual(checkLinks(page.body_md), []);
  assert.deepEqual(report.unresolved_links.map((u: { link: string }) => u.link).sort(), ['cite:S9@3', 'wiki:pg_zzz']);

  const state = `${s.snapshot}.import-state.json`;
  assert.equal(statSync(state).mode & 0o777, 0o600);

  s.target.calls.length = 0;
  const again = await s.run(...importArgs(s, '--confirm'));
  assert.equal(again.code, 0, again.stderr);
  const second = JSON.parse(again.stdout);
  assert.deepEqual(second.created, { events: 0, topics: 0, wiki_pages: 0 });
  assert.equal(second.plan.already_done, 10);
  assert.deepEqual(writeCalls(s.target), []);
  assert.equal(t1?.events.length, 5);
  assert.equal(data.pages.length, 2);
});

test('--confirm must come right after import (so a pre-approved dry-run line cannot write)', async () => {
  const s = await setup();
  const result = await s.run('import', '--server', s.target.base, '--snapshot', s.snapshot, '--map', 'S1=T1', '--confirm', '--json');
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--confirm must come right after import/);
  assert.deepEqual(writeCalls(s.target), []);
});

test('import refuses, writing nothing: the source server as target, a missing target session, a --map not in the snapshot, a read-only sign-in', async () => {
  const s = await setup();
  const state = `${s.snapshot}.import-state.json`;
  const sameServer = await s.run('import', '--confirm', '--server', s.source.base, '--snapshot', s.snapshot, '--map', 'S1=S2', '--json');
  assert.equal(sameServer.code, 1);
  assert.match(sameServer.stderr, /is the snapshot's source server/);
  assert.deepEqual(writeCalls(s.source), []);

  const missingTarget = await s.run('import', '--confirm', '--server', s.target.base, '--snapshot', s.snapshot, '--map', 'S1=NOPE', '--json');
  assert.equal(missingTarget.code, 1);
  assert.match(missingTarget.stderr, /target session NOPE cannot be read .*Session not found/);

  const notInSnapshot = await s.run('import', '--confirm', '--server', s.target.base, '--snapshot', s.snapshot, '--map', 'S2=T1', '--json');
  assert.equal(notInSnapshot.code, 1);
  assert.match(notInSnapshot.stderr, /session S2 is not in the snapshot/);

  for (const r of [sameServer, missingTarget, notInSnapshot]) assert.equal(r.stdout, '');
  assert.deepEqual(writeCalls(s.target), []);
  assert.equal(existsSync(state), false);

  const readOnly = await setup({}, false);
  const refused = await readOnly.run(...importArgs(readOnly, '--confirm'));
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /read-only .*import needs session-data:write/);
  assert.match(refused.stderr, /login --write --server/);
  assert.deepEqual(writeCalls(readOnly.target), []);
  assert.equal(existsSync(`${readOnly.snapshot}.import-state.json`), false);
});

test('only fields the target schema accepts are sent; each dropped field is listed once', async () => {
  const s = await setup({
    inputSchemas: {
      create_event: {
        type: 'object',
        properties: { session_id: { type: 'string' }, category: { type: 'string' }, message: { type: 'string' }, metadata: { type: 'object' } },
        required: ['session_id', 'category', 'message'],
        additionalProperties: false,
      },
    },
  });
  const dry = JSON.parse((await s.run(...importArgs(s))).stdout);
  const dropped = dry.dropped_fields.filter((d: { field: string }) => d.field === 'marked_at_utc');
  assert.deepEqual(dropped, [{ tool: 'create_event', field: 'marked_at_utc' }]);
  const result = await s.run(...importArgs(s, '--confirm'));
  assert.equal(result.code, 0, result.stderr);
  const sent = writeCalls(s.target).filter((c) => c.tool === 'create_event');
  assert.equal(sent.length, 5);
  for (const c of sent) assert.deepEqual(Object.keys(c.arguments as object).sort(), ['category', 'message', 'metadata', 'session_id']);
});

test('a write tool missing on the target is an error naming it', async () => {
  const s = await setup({ omitTools: ['create_topic'] });
  for (const extra of [[], ['--confirm']]) {
    const result = await s.run(...importArgs(s, ...extra));
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /has no create_topic tool/);
  }
  assert.deepEqual(writeCalls(s.target), []);
});

test('a rate limit is waited out, and the import continues', async () => {
  const s = await setup({ rateLimitAfterWrites: 3, rateLimitTimes: 2, rateLimitRetryS: 7 });
  const result = await s.run(...importArgs(s, '--confirm'));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).created, { events: 5, topics: 3, wiki_pages: 2 });
  assert.deepEqual(s.sleeps, [8000, 8000]);
  assert.match(result.stderr, /rate limited; waiting 7 s/);
  assert.equal(s.target.writeCounts.rateLimited, 2);
});

test('with --no-wait a rate limit stops the import; the rerun resumes without duplicates', async () => {
  const s = await setup({ rateLimitAfterWrites: 4 });
  const stopped = await s.run(...importArgs(s, '--confirm', '--no-wait'));
  assert.equal(stopped.code, 1);
  assert.equal(stopped.stdout, '');
  assert.match(stopped.stderr, /rate limited \(retry in 7 s\); stopped\. Progress is saved in .*import-state\.json; run the same import --confirm command again to resume/);
  assert.deepEqual(s.sleeps, []);
  const data = s.target.options.data as FakeData;
  assert.equal(data.sessions[0]?.events.length, 4);

  const resumed = await s.run(...importArgs(s, '--confirm', '--no-wait'));
  assert.equal(resumed.code, 0, resumed.stderr);
  const report = JSON.parse(resumed.stdout);
  assert.equal(report.plan.already_done, 4);
  assert.deepEqual(report.created, { events: 1, topics: 3, wiki_pages: 2 });
  assert.equal(data.sessions[0]?.events.length, 5);
  assert.equal(data.sessions[0]?.topics.length, 3);
  assert.equal(data.pages.length, 2);
});

test('an interrupted import (the server fails mid-way) resumes on the rerun without duplicates', async () => {
  const s = await setup({ failWriteNumber: 9 });
  const failed = await s.run(...importArgs(s, '--confirm'));
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /answered 500.*Progress is saved in/s);
  const data = s.target.options.data as FakeData;
  assert.equal(data.pages.length, 0, 'events and topics were written, the first page was not');
  const resumed = await s.run(...importArgs(s, '--confirm'));
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.deepEqual(JSON.parse(resumed.stdout).created, { events: 0, topics: 0, wiki_pages: 2 });
  assert.equal(data.sessions[0]?.events.length, 5);
  assert.equal(data.sessions[0]?.topics.length, 3);
  const a = data.pages.find((p) => p.title === 'Session one');
  const b = data.pages.find((p) => p.title === 'Jane');
  assert.ok(a?.body_md.includes(`wiki:${b?.page_id})`));
});

test('a page linking to a page the target refused is fixed on the rerun that creates that page', async () => {
  // Writes 1-8 are events and topics, 9 is pg_a (which links to pg_b), 10 is pg_b: refused once.
  const s = await setup({ toolErrorWriteNumber: 10 });
  const first = await s.run(...importArgs(s, '--confirm'));
  assert.equal(first.code, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.deepEqual(report.created, { events: 5, topics: 3, wiki_pages: 1 });
  assert.deepEqual(report.failed.map((f: { source_id: string; reason: string }) => [f.source_id, /Internal error\./.test(f.reason)]), [['pg_b', true]]);
  assert.equal(report.links_fixed, 0);
  assert.ok(report.unresolved_links.some((u: { link: string }) => u.link === 'wiki:pg_b'));
  const data = s.target.options.data as FakeData;
  assert.ok(data.pages.find((p) => p.title === 'Session one')?.body_md.includes('[Jane](wiki:pg_b)'));

  const dry = JSON.parse((await s.run(...importArgs(s))).stdout);
  assert.equal(dry.plan.fix_links, 1, 'the dry run says pg_a will be fixed');
  const rerun = await s.run(...importArgs(s, '--confirm'));
  assert.equal(rerun.code, 0, rerun.stderr);
  const second = JSON.parse(rerun.stdout);
  assert.deepEqual(second.created, { events: 0, topics: 0, wiki_pages: 1 });
  assert.equal(second.links_fixed, 1);
  assert.deepEqual(second.failed, []);
  const a = data.pages.find((p) => p.title === 'Session one');
  const b = data.pages.find((p) => p.title === 'Jane');
  assert.ok(a !== undefined && b !== undefined);
  assert.ok(a.body_md.includes(`[Jane](wiki:${b.page_id})`), a.body_md);
  assert.ok(!a.body_md.includes('wiki:pg_b)'));
  assert.deepEqual(second.unresolved_links.map((u: { link: string }) => u.link).sort(), ['cite:S9@3', 'wiki:pg_zzz']);

  s.target.calls.length = 0;
  const third = JSON.parse((await s.run(...importArgs(s, '--confirm'))).stdout);
  assert.equal(third.links_fixed, 0);
  assert.deepEqual(writeCalls(s.target), [], 'nothing left to write');
});

test('a page linking to a page of a session mapped only on a later run is fixed on that run', async () => {
  // pg_p belongs with S1 (it cites S1) and links to S2's session page, which only S2's export holds.
  const data: FakeData = {
    sessions: [
      { session_id: 'S1', show_id: 'shw_src', events: [], topics: [] },
      { session_id: 'S2', show_id: 'shw_src', events: [], topics: [] },
    ],
    pages: [
      { page_id: 'pg_p', show_id: 'shw_src', kind: 'person', title: 'Pat', aliases: [], body_md: 'Pat [said](cite:S1@1), see [two](wiki:pg_s2).\n', revision: 1 },
      { page_id: 'pg_s2', show_id: 'shw_src', kind: 'session', title: 'Session two', aliases: [], body_md: 'Two.\n', revision: 1, session_id: 'S2' },
    ],
  };
  const source = await fake({ data });
  const target = await fake({ data: targetData() });
  const configDir = tempConfigDir();
  const run = (...argv: string[]) => cli({ configDir }, ...argv);
  assert.equal((await run('login', '--server', source.base)).code, 0);
  assert.equal((await run('login', '--server', target.base, '--write')).code, 0);
  const snapshot = join(configDir, 'two.json');
  files.push(snapshot, `${snapshot}.import-state.json`);
  const exported = await run('export', '--server', source.base, '--session', 'S1', '--session', 'S2', '--out', snapshot, '--json');
  assert.equal(exported.code, 0, exported.stderr);
  assert.deepEqual(JSON.parse(exported.stdout).sessions.map((x: { wiki_pages: number }) => x.wiki_pages), [1, 1]);

  const base = ['import', '--confirm', '--server', target.base, '--snapshot', snapshot, '--json'];
  const first = JSON.parse((await run(...base, '--map', 'S1=T1')).stdout);
  assert.deepEqual(first.created, { events: 0, topics: 0, wiki_pages: 1 });
  assert.deepEqual(first.unresolved_links.map((u: { link: string }) => u.link), ['wiki:pg_s2']);
  const second = JSON.parse((await run(...base, '--map', 'S1=T1', '--map', 'S2=T2')).stdout);
  assert.deepEqual(second.created, { events: 0, topics: 0, wiki_pages: 1 });
  assert.equal(second.links_fixed, 1);
  assert.deepEqual(second.unresolved_links, []);
  const pages = (target.options.data as FakeData).pages;
  const p = pages.find((x) => x.title === 'Pat');
  const two = pages.find((x) => x.title === 'Session two');
  assert.ok(p !== undefined && two !== undefined);
  assert.equal(two.session_id, 'T2');
  assert.equal(p.body_md, `Pat [said](cite:T1@1), see [two](wiki:${two.page_id}).\n`);
  assert.deepEqual(checkLinks(p.body_md), []);
});

test('a wiki title the target already has is skipped, not overwritten, and stays skipped on a rerun', async () => {
  const existing = { page_id: 'pg_old', show_id: 'shw_t', kind: 'person', title: 'Jane', aliases: [], body_md: 'Original.', revision: 4 };
  const s = await setup({ data: targetData([existing]) });
  const result = await s.run(...importArgs(s, '--confirm'));
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.created, { events: 5, topics: 3, wiki_pages: 1 });
  assert.equal(report.skipped.length, 1);
  assert.match(report.skipped[0].reason, /Title already used\. on the target \(page_id pg_old\); not overwritten/);
  assert.deepEqual(existing, { page_id: 'pg_old', show_id: 'shw_t', kind: 'person', title: 'Jane', aliases: [], body_md: 'Original.', revision: 4 });
  assert.ok(report.unresolved_links.some((u: { link: string }) => u.link === 'wiki:pg_b'), 'a link to the skipped page is left as it is');
  const again = JSON.parse((await s.run(...importArgs(s))).stdout);
  assert.equal(again.plan.skip, 1);
  assert.equal(again.plan.create.wiki_pages, 0);
});

test('bad import and export arguments are usage errors', async () => {
  const configDir = tempConfigDir();
  for (const argv of [
    ['import'],
    ['import', '--snapshot', 'x.json'],
    ['import', '--snapshot', 'x.json', '--map', 'S1'],
    ['import', '--snapshot', 'x.json', '--map', 'S1=T1', '--map', 'S1=T2'],
    ['import', '--snapshot', 'x.json', '--map', 'S1=T1', '--force'],
    ['export', '--out', 'x.json'],
    ['export', '--session', 'S1'],
    ['export', '--session', 'a b', '--out', 'x.json'],
    ['export', '--session', 'S1', '--out', 'x.txt'],
    ['export', '--session', 'S1', '--out', 'x.json', '--force'],
  ]) {
    const result = await cli({ configDir }, ...argv);
    assert.equal(result.code, 2, argv.join(' '));
    assert.equal(result.stdout, '');
  }
});

test('rewriteLinks changes only link destinations it has a target for', () => {
  const body = 'A [x](wiki:p1) and [y](<wiki:p2>), [q](cite:S1@5.25), <wiki:p1>, plain wiki:p1 text, [z](wiki:p3).\n\n[ref]: cite:S2@1\n';
  const out = rewriteLinks(body, { page: (id) => (id === 'p1' ? 'N1' : id === 'p2' ? 'N2' : undefined), session: (id) => (id === 'S1' ? 'T1' : undefined) });
  assert.equal(out.body, 'A [x](wiki:N1) and [y](<wiki:N2>), [q](cite:T1@5.25), <wiki:N1>, plain wiki:p1 text, [z](wiki:p3).\n\n[ref]: cite:S2@1\n');
  assert.deepEqual(out.unresolved, ['wiki:p3', 'cite:S2@1']);
});
