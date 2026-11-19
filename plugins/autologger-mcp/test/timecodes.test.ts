// import keeps session times and recording takes: the fake target plays autologger's shipped rules
// for MCP event writes (create_event/update_event `timecode`, take rows, the malformed-value and
// rolling refusals; autologger-2 4d2b1a37).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { convertFrames, formatTimecode, pairTakes, parseTimecode } from '../src/timecode.ts';
import { type FakeData, FakeAutologger, type FakeOptions, type FakeSession, openTakes, TAKE_ROW_ROLLING_TEXT } from './fakeServer.ts';
import { cli, tempConfigDir, transcript } from './helpers.ts';

const servers: FakeAutologger[] = [];
after(async () => {
  const printed = transcript.join('\n');
  for (const server of servers) {
    for (const t of server.issued) assert.ok(!printed.includes(t), 'a token was printed');
    await server.close();
  }
});

type Ev = Record<string, unknown>;

/**
 * A source session at `fps` in list_events (wall) order: an event before every take, two closed
 * takes with an event inside each and one between, an event after them, a Started with no Stopped
 * and a Stopped with no Started.
 */
function sourceEvents(fps: number): Ev[] {
  const sep = Math.abs(fps - 29.97) < 0.03 ? ';' : ':';
  const tc = (h: number, m: number, s: number, f: number) => `${[h, m, s].map((n) => String(n).padStart(2, '0')).join(':')}${sep}${String(f).padStart(2, '0')}`;
  const rows: [string, string, string, string][] = [
    ['before', 'cat_a', 'Before the first take', tc(0, 0, 5, 3)],
    ['t1s', 'internal', 'Recording 1 Started', tc(0, 0, 0, 0)],
    ['in1', 'cat_a', 'Inside take 1', tc(0, 1, 10, 12)],
    ['t1e', 'internal', 'Recording 1 Stopped', tc(0, 4, 10, 0)],
    ['between', 'cat_a', 'Between the takes', tc(0, 4, 10, 1)],
    ['t2s', 'internal', 'Recording 2 Started', tc(1, 4, 10, 0)],
    ['in2', 'cat_a', 'Inside take 2', tc(1, 5, 10, 17)],
    ['t2e', 'internal', 'Recording 2 Stopped', tc(1, 11, 20, 17)],
    ['after', 'cat_a', 'After every take', tc(1, 11, 20, 18)],
    ['t3s', 'internal', 'Recording 3 Started', tc(1, 11, 21, 0)],
    ['t4e', 'internal', 'Recording 4 Stopped', tc(1, 11, 22, 0)],
  ];
  return rows.map(([id, category, message, timecode], i) => ({
    event_id: id,
    wall_time_utc: new Date(Date.UTC(2026, 9, 29, 21, i * 5)).toISOString(),
    timecode,
    frame_rate: fps,
    timecode_total_frames: parseTimecode(timecode, fps),
    category,
    category_label: category === 'internal' ? 'Internal' : 'Joke',
    message,
    metadata: {},
    version: 1,
  }));
}

const COPIED = ['before', 't1s', 'in1', 't1e', 'between', 't2s', 'in2', 't2e', 'after'];

async function fake(options: FakeOptions): Promise<FakeAutologger> {
  const server = await new FakeAutologger(options).start();
  servers.push(server);
  return server;
}

interface Setup {
  source: FakeAutologger;
  target: FakeAutologger;
  t1: FakeSession;
  snapshot: string;
  run: (...argv: string[]) => ReturnType<typeof cli>;
  args: (...more: string[]) => string[];
  /** Open takes seen on the target after any write. */
  openSeen: number[][];
}

async function setup(sourceFps: number, targetFps: number, targetOptions: FakeOptions = {}): Promise<Setup> {
  const source = await fake({ data: { sessions: [{ session_id: 'S1', show_id: 'shw_s', fps: sourceFps, categories: [{ id: 'cat_a', label: 'Joke' }], events: sourceEvents(sourceFps), topics: [] }], pages: [] }, pageSize: 50 });
  const openSeen: number[][] = [];
  const data: FakeData = { sessions: [{ session_id: 'T1', show_id: 'shw_t', fps: targetFps, categories: [{ id: 'cat_t', label: 'joke' }], events: [], topics: [] }], pages: [] };
  const target = await fake({
    data,
    pageSize: 3,
    afterWrite: (d) => {
      const open = openTakes(d.sessions[0]?.events ?? []);
      if (open.length > 0) openSeen.push(open);
    },
    ...targetOptions,
  });
  const configDir = tempConfigDir();
  const run = (...argv: string[]) => cli({ configDir, sleep: async () => {} }, ...argv);
  assert.equal((await run('login', '--server', source.base)).code, 0);
  assert.equal((await run('login', '--server', target.base, '--write')).code, 0);
  const snapshot = join(configDir, 'snap.json');
  const exported = await run('export', '--server', source.base, '--session', 'S1', '--out', snapshot, '--json');
  assert.equal(exported.code, 0, exported.stderr);
  target.calls.length = 0;
  const args = (...more: string[]) => ['import', ...more, '--server', target.base, '--snapshot', snapshot, '--map', 'S1=T1', '--json'];
  return { source, target, t1: data.sessions[0] as FakeSession, snapshot, run, args, openSeen };
}

const calls = (s: Setup, tool: string) => s.target.calls.filter((c) => c.tool === tool).map((c) => c.arguments as Ev);
const byMessage = (events: Ev[], message: string): Ev | undefined => events.find((e) => e.message === message);

for (const fps of [24, 29.97]) {
  test(`takes first, Stopped then Started, never open; every copied event keeps its timecode (${fps} fps)`, async () => {
    const s = await setup(fps, fps);
    const dry = JSON.parse((await s.run(...s.args())).stdout);
    assert.deepEqual(dry.frame_rate_mismatch, []);
    assert.equal(dry.plan.create.events, COPIED.length);
    assert.deepEqual(
      dry.items.filter((i: { action: string }) => i.action === 'skip').map((i: { source_id: string }) => i.source_id).sort(),
      ['t3s', 't4e'],
    );
    const result = await s.run(...s.args('--confirm'));
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.failed, []);
    assert.equal(report.created.events, COPIED.length);
    const skipped = Object.fromEntries(report.skipped.map((i: { source_id: string; reason: string }) => [i.source_id, i.reason]));
    assert.match(skipped.t3s, /Recording 3 Started has no Recording 3 Stopped/);
    assert.match(skipped.t4e, /Recording 4 Stopped has no Recording 4 Started/);

    const created = calls(s, 'create_event');
    assert.deepEqual(
      created.slice(0, 4).map((a) => a.message),
      ['Recording 1 Stopped', 'Recording 1 Started', 'Recording 2 Stopped', 'Recording 2 Started'],
      'the takes before any other event, one whole take at a time',
    );
    for (const a of created.slice(0, 4)) assert.equal(a.category, 'internal');
    const src = sourceEvents(fps);
    for (const a of created) {
      const from = byMessage(src, String(a.message)) as Ev;
      assert.equal(a.marked_at_utc, from.wall_time_utc);
      assert.equal(a.timecode, from.timecode);
    }
    assert.deepEqual(s.openSeen, [], 'no write ever left a Started without its Stopped');
    for (const id of COPIED) {
      const from = src.find((e) => e.event_id === id) as Ev;
      const there = byMessage(s.t1.events, String(from.message));
      assert.equal(there?.timecode, from.timecode, `${id} at its source timecode`);
      assert.equal(there?.wall_time_utc, from.wall_time_utc);
    }
    assert.equal(s.t1.events.length, COPIED.length);

    s.target.calls.length = 0;
    const again = JSON.parse((await s.run(...s.args('--confirm'))).stdout);
    assert.equal(again.plan.fix_timecode, 0);
    assert.equal(again.plan.already_done, COPIED.length);
    assert.deepEqual(calls(s, 'create_event').concat(calls(s, 'update_event')), []);
  });
}

test('interrupted between the two rows of a take (server error): no open take; the rerun finishes it', async () => {
  const s = await setup(24, 24, { failWriteNumber: 2 });
  const stopped = await s.run(...s.args('--confirm'));
  assert.equal(stopped.code, 1);
  assert.match(stopped.stderr, /Progress is saved/);
  assert.deepEqual(s.t1.events.map((e) => e.message), ['Recording 1 Stopped']);
  assert.deepEqual(openTakes(s.t1.events), []);
  const resumed = await s.run(...s.args('--confirm'));
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.deepEqual(s.openSeen, []);
  assert.equal(s.t1.events.length, COPIED.length, 'nothing created twice');
  assert.equal(byMessage(s.t1.events, 'Recording 1 Started')?.timecode, '00:00:00:00');
});

test('a refused Stopped row keeps its Started back, so the take is never opened', async () => {
  const s = await setup(24, 24, { toolErrorWriteNumber: 1 });
  const result = await s.run(...s.args('--confirm'));
  assert.equal(result.code, 0, result.stderr);
  const failed = JSON.parse(result.stdout).failed as { source_id: string; reason: string }[];
  assert.deepEqual(failed.map((f) => f.source_id), ['t1e', 't1s']);
  assert.match(failed[1]?.reason ?? '', /Stopped row of its take \(t1e\) is not on the target/);
  assert.deepEqual(s.openSeen, []);
  assert.equal(byMessage(s.t1.events, 'Recording 1 Started'), undefined);
  assert.equal(s.t1.events.length, COPIED.length - 2);
});

test('a rolling target refuses take rows: reported per item, the other events are copied at their timecodes', async () => {
  const s = await setup(24, 24);
  s.t1.rolling = true;
  const result = await s.run(...s.args('--confirm'));
  assert.equal(result.code, 0, result.stderr);
  const failed = JSON.parse(result.stdout).failed as { source_id: string; reason: string }[];
  assert.deepEqual(failed.map((f) => f.source_id), ['t1e', 't1s', 't2e', 't2s']);
  assert.ok(failed[0]?.reason.includes(TAKE_ROW_ROLLING_TEXT));
  assert.deepEqual(s.t1.events.filter((e) => e.category === 'internal'), []);
  assert.equal(byMessage(s.t1.events, 'After every take')?.timecode, '01:11:20:18');
});

test('the fake target refuses a malformed or out-of-range timecode, writing nothing', async () => {
  const s = await setup(24, 24);
  for (const timecode of ['00:00:00', '00:60:00:00', '00:00:00:24']) {
    const r = await s.run('call', 'create_event', '--server', s.target.base, '--args', JSON.stringify({ session_id: 'T1', category: 'joke', message: 'x', timecode }), '--json');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Invalid timecode: .*frames below 24 at this session's 24 fps\. Nothing was written\./);
  }
  assert.deepEqual(s.t1.events, []);
});

test('a target at another frame rate: frame_rate_mismatch in the plan and result, timecodes converted (29.97 DF -> 24)', async () => {
  const s = await setup(29.97, 24);
  const dry = JSON.parse((await s.run(...s.args())).stdout);
  const mismatch = [{ source_session_id: 'S1', target_session_id: 'T1', source_fps: 29.97, target_fps: 24 }];
  assert.deepEqual(dry.frame_rate_mismatch, mismatch);
  const text = await s.run(...s.args().filter((a) => a !== '--json'));
  assert.match(text.stdout, /frame rate: session S1 is 29\.97 fps, target T1 is 24 fps; timecodes are converted to 24 fps/);
  const result = await s.run(...s.args('--confirm'));
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.frame_rate_mismatch, mismatch);
  assert.deepEqual(report.failed, []);
  const expected: Record<string, string> = {
    'Before the first take': '00:00:05:02', // 3/30 s -> frame 2 of 24
    'Recording 1 Started': '00:00:00:00',
    'Inside take 1': '00:01:10:09', // 12/30 s = 0.4 s -> 9.6 -> 9
    'Recording 2 Stopped': '01:11:20:13', // 17/30 s -> 13.6 -> 13
    'After every take': '01:11:20:14', // 18/30 s = 0.6 s -> 14.4 -> 14
  };
  for (const [message, timecode] of Object.entries(expected)) assert.equal(byMessage(s.t1.events, message)?.timecode, timecode, message);
  assert.deepEqual(s.openSeen, []);
});

test('repair: an import from before this fix (timecodes wrong, take rows at 00:00:00:00) is fixed with update_event, nothing created twice', async () => {
  const s = await setup(29.97, 29.97);
  assert.equal((await s.run(...s.args('--confirm'))).code, 0);
  // Play the earlier import: every copied row at the transport position, a later version, and a
  // state file whose records carry no timecode.
  for (const e of s.t1.events) Object.assign(e, { timecode: '00:00:00;00', timecode_total_frames: 0, version: 3 });
  const stateFile = `${s.snapshot}.import-state.json`;
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  for (const record of Object.values(state.targets[s.target.base].created) as Ev[]) delete record.timecode;
  writeFileSync(stateFile, JSON.stringify(state));

  s.target.calls.length = 0;
  const dry = JSON.parse((await s.run(...s.args())).stdout);
  assert.equal(dry.plan.fix_timecode, COPIED.length - 1, 'Recording 1 Started was already at 00:00:00;00');
  assert.equal(dry.plan.already_done, 1);
  assert.deepEqual(dry.plan.create, { events: 0, topics: 0, wiki_pages: 0 });
  const fix = dry.items.find((i: { source_id: string }) => i.source_id === 't2e');
  assert.equal(fix.action, 'fix-timecode');
  assert.equal(fix.timecode, '01:11:20;17');
  assert.deepEqual(calls(s, 'update_event'), [], 'the dry run writes nothing');
  assert.ok(calls(s, 'list_events').length > 0, 'versions are read from the target');

  const result = await s.run(...s.args('--confirm'));
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.timecodes_fixed, COPIED.length - 1);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(calls(s, 'create_event'), []);
  const updates = calls(s, 'update_event');
  assert.equal(updates.length, COPIED.length - 1);
  for (const u of updates) assert.equal(u.version, 3);
  const stop = updates.find((u) => u.message === 'Recording 2 Stopped');
  assert.deepEqual(stop && { category: stop.category, timecode: stop.timecode }, { category: 'internal', timecode: '01:11:20;17' });
  const src = sourceEvents(29.97);
  for (const id of COPIED) {
    const from = src.find((e) => e.event_id === id) as Ev;
    assert.equal(byMessage(s.t1.events, String(from.message))?.timecode, from.timecode, id);
  }
  assert.equal(s.t1.events.length, COPIED.length);
  assert.deepEqual(s.openSeen, []);

  s.target.calls.length = 0;
  const again = JSON.parse((await s.run(...s.args('--confirm'))).stdout);
  assert.equal(again.plan.fix_timecode, 0);
  assert.deepEqual(calls(s, 'update_event').concat(calls(s, 'create_event')), []);
});

test('repair: a version conflict or a rolling refusal is reported per item and not retried', async () => {
  let bumped = false;
  const s = await setup(24, 24, {
    beforeWrite: (d, tool, args) => {
      // Someone edits "Inside take 1" between the read and the write.
      if (tool !== 'update_event' || bumped) return;
      const e = d.sessions[0]?.events.find((x) => x.event_id === args.event_id && x.message === 'Inside take 1');
      if (e !== undefined) {
        e.version = Number(e.version) + 1;
        bumped = true;
      }
    },
  });
  assert.equal((await s.run(...s.args('--confirm'))).code, 0);
  for (const e of s.t1.events) Object.assign(e, { timecode: '00:00:00:01', timecode_total_frames: 1 });
  s.t1.rolling = true;
  s.target.calls.length = 0;
  const result = await s.run(...s.args('--confirm'));
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const failed = Object.fromEntries(report.failed.map((f: { source_id: string; reason: string }) => [f.source_id, f.reason]));
  assert.deepEqual(Object.keys(failed).sort(), ['in1', 't1e', 't1s', 't2e', 't2s']);
  assert.match(failed.in1, /update_event refused to set its timecode: Version conflict/);
  assert.match(failed.t1s, /take row's timecode: Writing a take row .* refused while this session is actively recording/);
  assert.equal(report.timecodes_fixed, COPIED.length - 5);
  assert.equal(calls(s, 'update_event').length, COPIED.length, 'one attempt per item');

  // Once the session stops recording, a rerun reads the versions again and fixes the rest.
  s.t1.rolling = false;
  const rerun = JSON.parse((await s.run(...s.args('--confirm'))).stdout);
  assert.equal(rerun.timecodes_fixed, 5);
  assert.deepEqual(rerun.failed, []);
});

test('timecode math: autologger frames, conversion through seconds, takes paired as recordedTakes pairs them', () => {
  assert.equal(parseTimecode('01:11:20;17', 29.97), 128417);
  assert.equal(formatTimecode(128417, 29.97), '01:11:20;17');
  assert.equal(formatTimecode(247597, 24), '02:51:56:13');
  assert.equal(parseTimecode('00:00:00:24', 24), undefined);
  assert.equal(parseTimecode('00:00:00', 24), undefined);
  assert.equal(formatTimecode(convertFrames(128417, 29.97, 24), 24), '01:11:20:13');
  assert.equal(convertFrames(123, 29.97, 30), 123, 'same counting rate: unchanged');
  const ev = (id: string, message: string, minute: number): Ev => ({ event_id: id, category: 'internal', message, wall_time_utc: `2026-01-01T00:${String(minute).padStart(2, '0')}:00Z`, timecode: '00:00:00:00' });
  const { pairs, unpaired } = pairTakes([ev('a', 'Recording 1 Started', 1), ev('b', 'Recording 1 Started', 2), ev('c', 'Recording 1 Stopped', 3), ev('d', 'Recording 2 Stopped', 4)], 24);
  assert.deepEqual(pairs, [{ started: 0, stopped: 2 }], 'first in, first out per N');
  assert.deepEqual([...unpaired.keys()].sort(), [1, 3]);
});

test('--help describes the take handling, frame_rate_mismatch and fix-timecode', async () => {
  const help = await cli({ configDir: tempConfigDir() }, '--help');
  assert.equal(help.code, 0);
  for (const text of ['recording takes are created', 'frame_rate_mismatch', 'fix-timecode']) assert.ok(help.stdout.includes(text), text);
});

test('a target too old to take a timecode: take rows and timecode fixes are skipped with the reason, nothing written', async () => {
  const s = await setup(24, 24);
  assert.equal((await s.run(...s.args('--confirm'))).code, 0);
  for (const e of s.t1.events) Object.assign(e, { timecode: '00:00:00:01', timecode_total_frames: 1 });
  const old = await fake({
    data: s.target.options.data as FakeData,
    inputSchemas: {
      update_event: {
        type: 'object',
        properties: Object.fromEntries(['session_id', 'event_id', 'category', 'message', 'wall_time_utc', 'timecode_hms', 'version'].map((k) => [k, {}])),
        required: ['session_id', 'event_id', 'category', 'message', 'wall_time_utc', 'version'],
        additionalProperties: false,
      },
    },
  });
  const configDir = tempConfigDir();
  const run = (...argv: string[]) => cli({ configDir }, ...argv);
  assert.equal((await run('login', '--server', old.base, '--write')).code, 0);
  // The same state file, now recorded against the old target's URL.
  const stateFile = `${s.snapshot}.import-state.json`;
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.targets[old.base] = state.targets[s.target.base];
  writeFileSync(stateFile, JSON.stringify(state));
  const dry = JSON.parse((await run('import', '--server', old.base, '--snapshot', s.snapshot, '--map', 'S1=T1', '--json')).stdout);
  assert.equal(dry.plan.fix_timecode, 0);
  assert.equal(dry.plan.skip, COPIED.length + 2);
  const item = dry.items.find((i: { source_id: string }) => i.source_id === 'in1');
  assert.match(item.reason, /update_event takes no timecode .*cannot be set/);
  assert.deepEqual(old.calls.filter((c) => c.tool === 'update_event' || c.tool === 'create_event'), []);
});
