// import: writes a snapshot's events, topics and wiki pages into existing sessions of a target
// server, through its MCP write tools. The write tools cannot create studios, shows, sessions or
// transcripts, so each source session is mapped by the user onto a target session.
//
// - Arguments are built from fixed rules per kind, then cut down to the fields the target tool's
//   inputSchema accepts (inputs are strict); every source field not sent is reported once.
// - Wiki bodies get their wiki:/cite: links rewritten to the target's ids. A page that links to a
//   page created after it is created first and its links fixed with update_wiki_page afterwards.
//   The state keeps a hash of the body last sent, so a page whose linked page is only created on a
//   later run (it failed, or its session was mapped later) is fixed then too.
// - Progress is kept in a state file next to the snapshot after every write, so a rerun creates no
//   duplicates. Content from the snapshot is only ever sent as tool arguments: it never picks a
//   tool, a server or a file.
// - Events keep their session time: each is created with the source's wall time and `timecode`
//   (converted through seconds when the target session's frame rate differs). A session's
//   recording takes (internal `Recording N Started` / `Stopped` rows) are created before its other
//   events, one closed take at a time, the Stopped row first: the target then never holds a
//   Started with no Stopped (an open take, which the web app asks to resolve), even when an import
//   stops between the two rows. A take row with no partner in the snapshot is not copied.
// - Events created by an earlier run whose timecode on the target is not the source's (an import
//   from before timecodes could be sent) are set with `update_event` (`fix-timecode`), using the
//   versions `list_events` answers.
import { createHash } from 'node:crypto';
import {
  type Caller,
  callWithRetry,
  type CreatedItem,
  idKeys,
  type ImportState,
  inputShape,
  type InputShape,
  itemId,
  itemKey,
  type Kind,
  KINDS,
  readTool,
  type Rec,
  type Snapshot,
  type TargetState,
} from './copy.ts';
import { CliError } from './errors.ts';
import { clip, isObject } from './http.ts';
import { checkLinks, rewriteLinks } from './links.ts';
import { resultText, type Tool } from './mcp.ts';
import { convertFrames, eventRate, formatTimecode, pairTakes, rowFrames, takeRow, validRate } from './timecode.ts';

export const CREATE_TOOL: Record<Kind, string> = { events: 'create_event', topics: 'create_topic', wiki_pages: 'create_wiki_page' };
export const LINK_FIX_TOOL = 'update_wiki_page';
export const TIMECODE_FIX_TOOL = 'update_event';

export type Action = 'create' | 'done' | 'skip' | 'fix-links' | 'fix-timecode';

export interface PlanItem {
  kind: Kind;
  source_id: string;
  source_session_id: string;
  target_session_id: string;
  label: string;
  action: Action;
  reason?: string;
  target_id?: string;
  /** An event's timecode on the target after this item (fix-timecode: the value set). */
  timecode?: string;
}

/** A mapped session whose target frame rate is not the source's: timecodes are converted. */
export interface FrameRateMismatch {
  source_session_id: string;
  target_session_id: string;
  source_fps: number;
  target_fps: number;
}

export interface DroppedField {
  tool: string;
  field: string;
}

export interface UnresolvedLink {
  source_page_id: string;
  link: string;
}

export interface Plan {
  items: PlanItem[];
  dropped_fields: DroppedField[];
  unresolved_links: UnresolvedLink[];
  /** The write tools the plan needs. */
  tools: string[];
  frame_rate_mismatch: FrameRateMismatch[];
}

export interface TargetSession {
  source_session_id: string;
  target_session_id: string;
  target_show_id: string | undefined;
  /** The target session's frame rate (get_session `fps`), when it answers one. */
  target_fps?: number;
}

interface Entry {
  kind: Kind;
  sourceId: string;
  sourceSessionId: string;
  target: TargetSession;
  item: Rec;
  /** An event's frame rate on the source. */
  sourceFps?: number;
  /** A take row in a closed take: which row, and the source id of the other row of its take. */
  take?: { kind: 'started' | 'stopped'; partner: string };
  /** A take row in no closed take: why it is not copied. */
  unpaired?: string;
}

/** A session's frame rate on the source (get_session `fps`), when the snapshot has one. */
function sessionFps(session: Rec | undefined): number | undefined {
  return validRate(session?.fps) ? session.fps : undefined;
}

/**
 * A session's events in the order import writes them: each closed take's Stopped then Started row,
 * the takes in the order they started, then every other event in snapshot order.
 */
function eventEntries(events: readonly Rec[], fps: number | undefined, target: TargetSession, sourceSessionId: string): Entry[] {
  const { pairs, unpaired } = pairTakes(events, fps);
  const make = (index: number): Entry | undefined => {
    const item = events[index] as Rec;
    const sourceId = itemId('events', item);
    if (sourceId === undefined) return undefined;
    const entry: Entry = { kind: 'events', sourceId, sourceSessionId, target, item };
    const rate = eventRate(item, fps);
    if (rate !== undefined) entry.sourceFps = rate;
    const reason = unpaired.get(index);
    if (reason !== undefined) entry.unpaired = reason;
    return entry;
  };
  const out: Entry[] = [];
  const inTake = new Set<number>();
  for (const pair of pairs) {
    const stopped = make(pair.stopped);
    const started = make(pair.started);
    inTake.add(pair.stopped).add(pair.started);
    if (stopped === undefined || started === undefined) continue;
    stopped.take = { kind: 'stopped', partner: started.sourceId };
    started.take = { kind: 'started', partner: stopped.sourceId };
    out.push(stopped, started);
  }
  events.forEach((_, index) => {
    if (inTake.has(index)) return;
    const entry = make(index);
    if (entry !== undefined) out.push(entry);
  });
  return out;
}

/** The snapshot items of the mapped sessions, each once (a show's page can be listed by several sessions). */
function entries(snapshot: Snapshot, targets: readonly TargetSession[]): Entry[] {
  const byKey = new Map<string, Entry>();
  for (const kind of KINDS) {
    for (const target of targets) {
      const session = snapshot.sessions.find((s) => s.session_id === target.source_session_id);
      if (kind === 'events') {
        for (const entry of eventEntries(session?.events ?? [], sessionFps(session?.session), target, target.source_session_id)) {
          const key = itemKey(kind, entry.sourceId);
          if (!byKey.has(key)) byKey.set(key, entry);
        }
        continue;
      }
      for (const item of session?.[kind] ?? []) {
        const sourceId = itemId(kind, item);
        if (sourceId === undefined) continue;
        const key = itemKey(kind, sourceId);
        const seen = byKey.get(key);
        // A session page belongs with the session whose own page it is.
        if (seen === undefined || (kind === 'wiki_pages' && item.association === 'session_page' && seen.item.association !== 'session_page')) {
          byKey.set(key, { kind, sourceId, sourceSessionId: target.source_session_id, target, item });
        }
      }
    }
  }
  return [...byKey.values()];
}

/**
 * An event's timecode for the target as total frames and text: the source's, converted through
 * seconds to the target session's rate and format when it differs. Undefined when the snapshot
 * has no usable timecode for it.
 */
function targetTimecode(entry: Entry): { frames: number; text: string } | undefined {
  const from = entry.sourceFps;
  if (from === undefined) return undefined;
  const frames = rowFrames(entry.item, from);
  if (frames === undefined) return undefined;
  const to = entry.target.target_fps ?? from;
  const converted = convertFrames(frames, from, to);
  return { frames: converted, text: formatTimecode(converted, to) };
}

/** Whether a tool's inputSchema accepts `field`. */
function accepts(tool: Tool | undefined, field: string): boolean {
  const shape = inputShape(tool);
  return shape.open || shape.properties.has(field);
}

function label(kind: Kind, item: Rec): string {
  const text = kind === 'events' ? item.message : kind === 'topics' ? item.summary : item.title;
  return clip(typeof text === 'string' ? text : '', 80);
}

/**
 * The arguments of an item's create tool before the schema cut, the target ids filled in, or a
 * reason it cannot be created.
 */
function candidate(entry: Entry): { args: Rec } | { skip: string } {
  const { kind, item, target } = entry;
  const args: Rec = { ...item };
  for (const key of idKeys(kind)) delete args[key];
  delete args.session_id;
  delete args.show_id;
  if (kind === 'events') {
    if (entry.unpaired !== undefined) return { skip: entry.unpaired };
    delete args.timecode;
    delete args.timecode_total_frames;
    delete args.frame_rate;
    const timecode = targetTimecode(entry);
    if (timecode !== undefined) args.timecode = timecode.text;
    // The target show's categories have other ids; a category's name resolves on the target.
    const internal = typeof item.category === 'string' && item.category.toLowerCase() === 'internal';
    if (!internal && typeof item.category_label === 'string' && item.category_label !== '') args.category = item.category_label;
    delete args.category_label;
    if ('wall_time_utc' in item) {
      args.marked_at_utc = item.wall_time_utc;
      delete args.wall_time_utc;
    }
    args.session_id = target.target_session_id;
  } else if (kind === 'topics') {
    args.session_id = target.target_session_id;
  } else {
    if (target.target_show_id === undefined) return { skip: `target session ${target.target_session_id} has no show_id` };
    args.show_id = target.target_show_id;
    if (item.kind === 'session') {
      if (item.association !== 'session_page') return { skip: 'the session page of a session that is not mapped' };
      args.session_id = target.target_session_id;
    }
  }
  return { args };
}

/** Cuts `args` down to what `shape` accepts; the fields cut, and missing required ones. */
function fit(args: Rec, shape: InputShape): { args: Rec; dropped: string[]; missing: string[] } {
  const out: Rec = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (shape.open || shape.properties.has(key)) out[key] = value;
    else dropped.push(key);
  }
  return { args: out, dropped, missing: shape.required.filter((r) => !(r in out)) };
}

function bodyOf(item: Rec): string {
  return typeof item.body_md === 'string' ? item.body_md : '';
}

export function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export interface PlanInput {
  snapshot: Snapshot;
  targets: readonly TargetSession[];
  state: TargetState;
  tools: ReadonlyMap<string, Tool>;
  /**
   * The target's events (`list_events`) by target session and event id, read for the sessions
   * with events an earlier run created; their timecodes and versions decide `fix-timecode`.
   */
  targetEvents?: ReadonlyMap<string, ReadonlyMap<string, Rec>>;
}

/** The mapped sessions whose target frame rate differs from the source's. */
export function frameRateMismatches(snapshot: Snapshot, targets: readonly TargetSession[]): FrameRateMismatch[] {
  const out: FrameRateMismatch[] = [];
  for (const target of targets) {
    const session = snapshot.sessions.find((s) => s.session_id === target.source_session_id);
    const source = sessionFps(session?.session) ?? session?.events.map((e) => e.frame_rate).find(validRate);
    if (source === undefined || target.target_fps === undefined || source === target.target_fps) continue;
    out.push({ source_session_id: target.source_session_id, target_session_id: target.target_session_id, source_fps: source, target_fps: target.target_fps });
  }
  return out;
}

/**
 * What an event an earlier run created needs: nothing, or its timecode set (with the row
 * `update_event` needs), or a reason it is left as it is.
 */
function timecodeCheck(entry: Entry, created: CreatedItem, input: PlanInput): { fix: { row: Rec; timecode: string } } | { done: string } | { skip: string } {
  const want = targetTimecode(entry);
  if (want === undefined) return { done: 'created by an earlier run (state file); the snapshot has no timecode for it' };
  const rows = input.targetEvents?.get(created.target_session_id);
  if (rows === undefined) return { done: 'created by an earlier run (state file)' };
  const row = rows.get(created.target_id);
  if (row === undefined) return { skip: `created by an earlier run as ${created.target_id}, which the target session no longer has; not created again` };
  const fps = validRate(row.frame_rate) ? row.frame_rate : (entry.target.target_fps ?? entry.sourceFps);
  if (fps !== undefined && rowFrames(row, fps) === want.frames) return { done: 'created by an earlier run (state file), at the source timecode' };
  if (!accepts(input.tools.get(TIMECODE_FIX_TOOL), 'timecode')) {
    return { skip: `created by an earlier run; its timecode on the target differs from the source's, and the target's ${TIMECODE_FIX_TOOL} takes no timecode (autologger-2 before 4d2b1a37), so it cannot be set` };
  }
  return { fix: { row, timecode: want.text } };
}

/** What import would do, without writing anything. */
export function plan(input: PlanInput): Plan {
  const { state, tools } = input;
  const all = entries(input.snapshot, input.targets);
  const sourceToTarget = new Map(input.targets.map((t) => [t.source_session_id, t.target_session_id]));
  const items: PlanItem[] = [];
  const dropped = new Map<string, DroppedField>();
  const needed = new Set<string>();
  const toCreate = new Set<string>();

  for (const entry of all) {
    const key = itemKey(entry.kind, entry.sourceId);
    const base = {
      kind: entry.kind,
      source_id: entry.sourceId,
      source_session_id: entry.sourceSessionId,
      target_session_id: entry.target.target_session_id,
      label: label(entry.kind, entry.item),
    };
    const created = state.created[key];
    if (created !== undefined && entry.kind === 'events') {
      const check = timecodeCheck(entry, created, input);
      const done = { ...base, target_session_id: created.target_session_id, target_id: created.target_id };
      if ('fix' in check) {
        needed.add(TIMECODE_FIX_TOOL);
        items.push({ ...done, action: 'fix-timecode', reason: `created by an earlier run; its timecode on the target is ${String(check.fix.row.timecode)}, not the source's`, timecode: check.fix.timecode });
      } else if ('skip' in check) {
        items.push({ ...done, action: 'skip', reason: check.skip });
      } else {
        items.push({ ...done, action: 'done', reason: check.done });
      }
      continue;
    }
    if (created !== undefined) {
      // Whether its links still need a rewrite is known once every page to create is (below).
      items.push({
        ...base,
        target_session_id: created.target_session_id,
        action: 'done',
        reason: 'created by an earlier run (state file)',
        target_id: created.target_id,
      });
      continue;
    }
    const skipped = state.skipped[key];
    if (skipped !== undefined) {
      items.push({ ...base, action: 'skip', reason: skipped.reason });
      continue;
    }
    const tool = CREATE_TOOL[entry.kind];
    const c = candidate(entry);
    if ('skip' in c) {
      items.push({ ...base, action: 'skip', reason: c.skip });
      continue;
    }
    const shape = inputShape(tools.get(tool));
    if (entry.take !== undefined && tools.has(tool) && !accepts(tools.get(tool), 'timecode')) {
      items.push({ ...base, action: 'skip', reason: `a take row; the target's ${tool} takes no timecode, so the take cannot be copied with its times` });
      continue;
    }
    const fitted = fit(c.args, shape);
    for (const field of fitted.dropped) dropped.set(`${tool}\u0000${field}`, { tool, field });
    if (tools.has(tool) && fitted.missing.length > 0) {
      items.push({ ...base, action: 'skip', reason: `the snapshot has no ${fitted.missing.join(', ')}, which ${tool} on the target requires` });
      continue;
    }
    needed.add(tool);
    toCreate.add(entry.sourceId);
    items.push({ ...base, action: 'create' });
  }

  // Pages created by an earlier run whose body, rewritten with what the target will have, changes:
  // a page they link to is created only now, or was created after their last write.
  const createdTarget = (id: string): string | undefined => state.created[itemKey('wiki_pages', id)]?.target_id;
  for (const item of items) {
    if (item.kind !== 'wiki_pages' || item.action !== 'done') continue;
    const entry = all.find((e) => e.kind === 'wiki_pages' && e.sourceId === item.source_id);
    const record = state.created[itemKey('wiki_pages', item.source_id)];
    if (entry === undefined || record === undefined) continue;
    let comesNow = false;
    const rewritten = rewriteLinks(bodyOf(entry.item), {
      page: (id) => {
        if (toCreate.has(id) && createdTarget(id) === undefined) comesNow = true;
        return createdTarget(id);
      },
      session: (id) => sourceToTarget.get(id),
    });
    if (comesNow || record.body_sha256 !== bodyHash(rewritten.body)) {
      needed.add(LINK_FIX_TOOL);
      item.action = 'fix-links';
      item.reason = 'created earlier; its links to pages created after it are still to be rewritten';
    }
  }

  // Links: which resolve, and which pages will need a second write for links to later pages.
  const pageIds = new Set([...toCreate].filter((id) => all.some((e) => e.kind === 'wiki_pages' && e.sourceId === id)));
  for (const id of Object.keys(state.created)) if (id.startsWith('wiki_pages:')) pageIds.add(id.slice('wiki_pages:'.length));
  const unresolved: UnresolvedLink[] = [];
  const createdBefore = new Set(Object.keys(state.created).filter((k) => k.startsWith('wiki_pages:')).map((k) => k.slice('wiki_pages:'.length)));
  for (const item of items) {
    if (item.kind !== 'wiki_pages' || item.action !== 'create') continue;
    const entry = all.find((e) => e.kind === 'wiki_pages' && e.sourceId === item.source_id);
    let forward = false;
    const result = rewriteLinks(bodyOf(entry?.item ?? {}), {
      page: (id) => {
        if (!pageIds.has(id)) return undefined;
        if (!createdBefore.has(id) && id !== item.source_id) forward = true;
        return id;
      },
      session: (id) => sourceToTarget.get(id),
    });
    for (const link of result.unresolved) unresolved.push({ source_page_id: item.source_id, link });
    if (forward) {
      needed.add(LINK_FIX_TOOL);
      item.reason = 'links to pages created after it are rewritten with update_wiki_page afterwards';
    }
    createdBefore.add(item.source_id);
  }

  return {
    items,
    dropped_fields: [...dropped.values()],
    unresolved_links: unresolved,
    tools: [...needed].sort(),
    frame_rate_mismatch: frameRateMismatches(input.snapshot, input.targets),
  };
}

export interface RunInput extends PlanInput {
  caller: Caller;
  /** Saves the state after each write. */
  save: () => void;
}

export interface Failure {
  kind: Kind;
  source_id: string;
  reason: string;
}

export interface RunResult {
  created: Record<Kind, number>;
  links_fixed: number;
  /** Events created by an earlier run whose timecode was set (fix-timecode). */
  timecodes_fixed: number;
  skipped: PlanItem[];
  failed: Failure[];
  unresolved_links: UnresolvedLink[];
}

const TAKEN_RE = /^(Title already used\.|Session already has a page\.) page_id: ([A-Za-z0-9_-]{1,200})/;

function createdId(kind: Kind, sc: unknown): { id: string | undefined; revision: number | undefined } {
  if (!isObject(sc)) return { id: undefined, revision: undefined };
  const revision = typeof sc.revision === 'number' ? sc.revision : undefined;
  return { id: itemId(kind, sc), revision };
}

/** Runs the plan's creates, then the link fixes; the state is saved after every write. */
export async function execute(input: RunInput, thePlan: Plan): Promise<RunResult> {
  const { state, tools, caller } = input;
  const all = entries(input.snapshot, input.targets);
  const sourceToTarget = new Map(input.targets.map((t) => [t.source_session_id, t.target_session_id]));
  const result: RunResult = { created: { events: 0, topics: 0, wiki_pages: 0 }, links_fixed: 0, timecodes_fixed: 0, skipped: [], failed: [], unresolved_links: [] };

  const pageTarget = (id: string): string | undefined => state.created[itemKey('wiki_pages', id)]?.target_id;

  for (const item of thePlan.items) {
    if (item.action === 'skip') result.skipped.push(item);
    if (item.action === 'fix-timecode') {
      await fixTimecode(input, item, result);
      continue;
    }
    if (item.action !== 'create') continue;
    const entry = all.find((e) => e.kind === item.kind && e.sourceId === item.source_id);
    if (entry === undefined) continue;
    // A Started row only once its Stopped row is on the target, so no take is ever left open.
    if (entry.take?.kind === 'started' && state.created[itemKey('events', entry.take.partner)] === undefined) {
      result.failed.push({ kind: 'events', source_id: item.source_id, reason: `not created: the Stopped row of its take (${entry.take.partner}) is not on the target, and a take is never left open` });
      continue;
    }
    const tool = CREATE_TOOL[item.kind];
    const c = candidate(entry);
    if ('skip' in c) continue;
    let sentHash: string | undefined;
    if (item.kind === 'wiki_pages') {
      const rewritten = rewriteLinks(bodyOf(entry.item), { page: pageTarget, session: (id) => sourceToTarget.get(id) });
      const problems = checkLinks(rewritten.body);
      if (problems.length > 0) {
        result.failed.push({ kind: item.kind, source_id: item.source_id, reason: `its body fails check-links (${problems.map((p) => `${p.line}:${p.column} ${p.text}`).join('; ')})` });
        continue;
      }
      c.args.body_md = rewritten.body;
      sentHash = bodyHash(rewritten.body);
    }
    const { args } = fit(c.args, inputShape(tools.get(tool)));
    const answer = await callWithRetry(caller, tool, args);
    const key = itemKey(item.kind, item.source_id);
    if (answer.isError === true) {
      const message = resultText(answer);
      const taken = TAKEN_RE.exec(message);
      if (item.kind === 'wiki_pages' && taken !== null) {
        const reason = `${taken[1]} on the target (page_id ${taken[2]}); not overwritten`;
        state.skipped[key] = { target_session_id: item.target_session_id, reason };
        input.save();
        result.skipped.push({ ...item, action: 'skip', reason });
      } else {
        result.failed.push({ kind: item.kind, source_id: item.source_id, reason: `${tool} refused it: ${clip(message, 500)}` });
      }
      continue;
    }
    const { id, revision } = createdId(item.kind, answer.structuredContent);
    if (id === undefined) throw new CliError(`${tool} answered no id for ${item.kind} ${item.source_id}; the item may have been created, check the target before running again`);
    const record: CreatedItem = { target_id: id, target_session_id: item.target_session_id };
    if (item.kind === 'events' && typeof args.timecode === 'string') record.timecode = args.timecode;
    if (item.kind === 'wiki_pages') {
      if (revision !== undefined) record.revision = revision;
      if (sentHash !== undefined) record.body_sha256 = sentHash;
    }
    state.created[key] = record;
    input.save();
    result.created[item.kind]++;
  }

  // Pages whose links named pages that did not exist when they were last written (in this run or
  // an earlier one): rewrite them now. Only pages of the mapped sessions, whose cite: links resolve.
  for (const entry of all) {
    if (entry.kind !== 'wiki_pages') continue;
    const sourceId = entry.sourceId;
    const record = state.created[itemKey('wiki_pages', sourceId)];
    if (record === undefined) continue;
    const rewritten = rewriteLinks(bodyOf(entry.item), { page: pageTarget, session: (id) => sourceToTarget.get(id) });
    const hash = bodyHash(rewritten.body);
    if (record.body_sha256 === hash) continue;
    if (!tools.has(LINK_FIX_TOOL)) throw new CliError(`the target server has no ${LINK_FIX_TOOL} tool, needed to fix the links of copied wiki pages`);
    const { args } = fit({ page_id: record.target_id, expected_revision: record.revision, body_md: rewritten.body }, inputShape(tools.get(LINK_FIX_TOOL)));
    const answer = await callWithRetry(caller, LINK_FIX_TOOL, args);
    if (answer.isError === true) {
      result.failed.push({ kind: 'wiki_pages', source_id: sourceId, reason: `${LINK_FIX_TOOL} refused the link rewrite: ${clip(resultText(answer), 500)}` });
      continue;
    }
    const { revision } = createdId('wiki_pages', answer.structuredContent);
    record.revision = revision ?? (record.revision === undefined ? undefined : record.revision + 1);
    record.body_sha256 = hash;
    input.save();
    result.links_fixed++;
  }

  // The links left as they were, now that everything that could be created is.
  for (const entry of all) {
    if (entry.kind !== 'wiki_pages' || state.created[itemKey('wiki_pages', entry.sourceId)] === undefined) continue;
    const { unresolved } = rewriteLinks(bodyOf(entry.item), { page: pageTarget, session: (id) => sourceToTarget.get(id) });
    for (const link of unresolved) result.unresolved_links.push({ source_page_id: entry.sourceId, link });
  }
  return result;
}

/**
 * Sets the timecode of an event an earlier run created, with `update_event` and the row
 * `list_events` answered (its version; its category, message and wall time unchanged, a take
 * row's category `internal`). A refusal (a stale version, a take row while the session is
 * recording) is reported for the item and not retried.
 */
async function fixTimecode(input: RunInput, item: PlanItem, result: RunResult): Promise<void> {
  const record = input.state.created[itemKey('events', item.source_id)];
  const row = record === undefined ? undefined : input.targetEvents?.get(record.target_session_id)?.get(record.target_id);
  if (record === undefined || row === undefined || item.timecode === undefined) return;
  const internal = typeof row.category === 'string' && row.category.toLowerCase() === 'internal';
  const args: Rec = {
    session_id: record.target_session_id,
    event_id: record.target_id,
    category: internal ? 'internal' : row.category,
    message: row.message,
    wall_time_utc: row.wall_time_utc,
    timecode: item.timecode,
    version: row.version,
  };
  const { args: sent } = fit(args, inputShape(input.tools.get(TIMECODE_FIX_TOOL)));
  const answer = await callWithRetry(input.caller, TIMECODE_FIX_TOOL, sent);
  if (answer.isError === true) {
    const what = takeRow(row) === undefined ? 'its timecode' : 'the take row\'s timecode';
    result.failed.push({ kind: 'events', source_id: item.source_id, reason: `${TIMECODE_FIX_TOOL} refused to set ${what}: ${clip(resultText(answer), 500)}` });
    return;
  }
  record.timecode = item.timecode;
  input.save();
  result.timecodes_fixed++;
}

/** The target's session, or a CliError when it does not exist or the user cannot see it. */
export async function targetSession(caller: Caller, server: string, source: string, target: string): Promise<TargetSession> {
  let session: Rec;
  try {
    session = await readTool(caller, 'get_session', { session_id: target });
  } catch (error) {
    throw new CliError(`target session ${target} cannot be read on ${server} (it does not exist or you cannot see it): ${(error as Error).message}`);
  }
  const show = session.show_id;
  const out: TargetSession = { source_session_id: source, target_session_id: target, target_show_id: typeof show === 'string' && show !== '' ? show : undefined };
  if (validRate(session.fps)) out.target_fps = session.fps;
  return out;
}

export function emptyTargetState(): TargetState {
  return { created: {}, skipped: {} };
}

export function targetState(state: ImportState, server: string): TargetState {
  let target = state.targets[server];
  if (target === undefined) {
    target = emptyTargetState();
    state.targets[server] = target;
  }
  return target;
}
