// annotate apply and annotate undo: a plan file of Claude-written events, topics, wiki pages and
// dashboards per session, checked against the server (a dry run), created with the MCP write tools
// (create-only, resumable), and taken back out again.
//
// - The plan is data. Its content is only ever sent as tool arguments, cut down to the fields each
//   tool's inputSchema accepts; it never picks a tool, a server or a file.
// - Every item gets a key (its `id`, else a hash of its fields). Each created item's target id and
//   version is saved in `<plan>.apply-state.json` (mode 0600) right after its write, so a rerun
//   creates nothing twice. Creates also send a `client_request_id` derived from the key when the
//   target accepts one, so a write whose answer was lost is not repeated by the server either.
// - Nothing is updated, and nothing is deleted except by `undo`, which deletes only what the state
//   file says this plan created, each only while its version (revision) is still the one it was
//   created with.
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { AnnotationKind } from './annotate.ts';
import { type Caller, callWithRetry, inputShape, readJson, readTool, type Rec } from './copy.ts';
import { cleanTitle, dashboardProblems, DEFAULT_OVERVIEW_TITLE, OVERVIEW_TEMPLATE, overviewTsx, titleProblem } from './dashboard.ts';
import { CliError } from './errors.ts';
import { listPaged } from './export.ts';
import { clip, isObject } from './http.ts';
import { fit } from './importer.ts';
import { checkLinks } from './links.ts';
import { resultText, type Tool } from './mcp.ts';
import { countRate, formatTimecode, parseTimecode, validRate } from './timecode.ts';

export const PLAN_FORMAT = 'autologger-mcp-annotate-plan';
export const APPLY_STATE_FORMAT = 'autologger-mcp-annotate-state';
/** The marker every created event carries in its metadata (when create_event takes metadata). */
export const MARKER_TOOL = 'autologger-mcp annotate';

export const CREATE_TOOLS: Record<AnnotationKind, string> = { events: 'create_event', topics: 'create_topic', wiki_pages: 'create_wiki_page', dashboards: 'save_dashboard' };
export const DELETE_TOOLS: Record<AnnotationKind, string> = { events: 'delete_event', topics: 'delete_topic', wiki_pages: 'delete_wiki_page', dashboards: 'delete_dashboard' };
const LIST_TOOLS: Record<AnnotationKind, string> = { events: 'list_events', topics: 'list_topics', wiki_pages: 'list_wiki_pages', dashboards: 'list_dashboards' };
const KIND_ORDER: readonly AnnotationKind[] = ['events', 'topics', 'wiki_pages', 'dashboards'];

/** autologger's write window per user (mcp-session-data "The write window"): the estimate's basis. */
export const WRITES_PER_MINUTE = 30;
export const WRITES_PER_HOUR = 300;

const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const ITEM_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const WIKI_KINDS = ['person', 'topic', 'bit', 'session'];
const MAX_TEXT = 8000;
const MAX_WIKI_TITLE = 200;
const MAX_ALIASES = 50;
const MAX_WIKI_BODY = 100_000;
/** Seconds a time may lie outside the transcript's extent and still count as inside the session. */
const EDGE_S = 1;

const FIELDS: Record<AnnotationKind, readonly string[]> = {
  events: ['id', 'category', 'message', 'session_time', 'timecode'],
  topics: ['id', 'session_time', 'duration_sec', 'topic_level', 'summary'],
  wiki_pages: ['id', 'kind', 'title', 'aliases', 'body_md'],
  dashboards: ['id', 'title', 'template', 'tsx'],
};

// ── the plan file ───────────────────────────────────────────────────────────────────────────

export interface PlanEntry {
  key: string;
  kind: AnnotationKind;
  session_id: string;
  item: Rec;
  /** A problem found while reading the plan (a duplicate id, a non-object item). */
  problem?: string;
}

export interface AnnotatePlan {
  plan_id: string;
  path: string;
  /** The sessions in plan order. */
  session_ids: string[];
  entries: PlanEntry[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Reads and checks a plan file's structure; per-item field problems are found by `planApply`. */
export function readPlan(path: string): AnnotatePlan {
  const value = readJson(path, 'plan');
  const bad = (why: string): CliError => new CliError(`${path} is not an annotate plan (${why}); see the README's plan file schema`);
  if (!isObject(value) || value.format !== PLAN_FORMAT || value.version !== 1) throw bad(`"format": "${PLAN_FORMAT}" and "version": 1 are required`);
  let planId = basename(path).replace(/\.json$/i, '').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64) || 'plan';
  if (value.plan_id !== undefined) {
    if (typeof value.plan_id !== 'string' || !ITEM_ID_RE.test(value.plan_id)) throw bad('plan_id must be 1-64 letters, digits, ".", "_" or "-"');
    planId = value.plan_id;
  }
  if (!Array.isArray(value.sessions)) throw bad('sessions must be an array');
  const entries: PlanEntry[] = [];
  const sessionIds: string[] = [];
  for (const s of value.sessions) {
    if (!isObject(s) || typeof s.session_id !== 'string' || !ID_RE.test(s.session_id)) throw bad('every session needs a session_id');
    if (sessionIds.includes(s.session_id)) throw bad(`session ${s.session_id} is listed twice; put all its items in one entry`);
    sessionIds.push(s.session_id);
    for (const key of Object.keys(s)) {
      if (key !== 'session_id' && !(KIND_ORDER as readonly string[]).includes(key)) throw bad(`session ${s.session_id} has an unknown field '${key}' (use events, topics, wiki_pages, dashboards)`);
    }
    for (const kind of KIND_ORDER) {
      const list = s[kind];
      if (list === undefined) continue;
      if (!Array.isArray(list)) throw bad(`session ${s.session_id}: ${kind} must be an array`);
      const keys = new Set<string>();
      list.forEach((item, index) => {
        if (!isObject(item)) {
          entries.push({ key: `${s.session_id}/${kind}/#${index + 1}`, kind, session_id: s.session_id as string, item: {}, problem: 'the item is not a JSON object' });
          return;
        }
        let key: string;
        let problem: string | undefined;
        if (item.id !== undefined) {
          if (typeof item.id !== 'string' || !ITEM_ID_RE.test(item.id)) {
            key = `${s.session_id}/${kind}/#${index + 1}`;
            problem = 'id must be 1-64 letters, digits, ".", "_" or "-"';
          } else {
            key = `${s.session_id}/${kind}/${item.id}`;
            if (keys.has(key)) problem = `the id '${item.id}' is used twice in ${kind} of this session`;
          }
        } else {
          const base = `${s.session_id}/${kind}/h-${sha(canonical(item)).slice(0, 16)}`;
          key = base;
          for (let n = 2; keys.has(key); n++) key = `${base}-${n}`;
        }
        if (problem === undefined) keys.add(key);
        entries.push({ key, kind, session_id: s.session_id as string, item, ...(problem !== undefined ? { problem } : {}) });
      });
    }
  }
  return { plan_id: planId, path, session_ids: sessionIds, entries };
}

// ── the state file ──────────────────────────────────────────────────────────────────────────

export interface CreatedRecord {
  kind: AnnotationKind;
  session_id: string;
  target_id: string;
  /** An event's or topic's version, a wiki page's or dashboard's revision, as created. */
  version: number | null;
  /** Wiki pages: the show the page is in. */
  show_id?: string;
  label: string;
  created_at: string;
}

export interface ApplyState {
  format: typeof APPLY_STATE_FORMAT;
  version: 1;
  server: string;
  plan_id: string;
  /** By item key: what this plan created and has not undone. */
  created: Record<string, CreatedRecord>;
  /** Items the server refused for good (a wiki title the show has). */
  skipped: Record<string, { reason: string }>;
  /** Items undo deleted. */
  undone: Record<string, CreatedRecord & { undone_at: string }>;
}

/** The state file of a plan: next to it, `<plan>.apply-state.json`. */
export function applyStatePath(planPath: string): string {
  return `${planPath}.apply-state.json`;
}

export function readApplyState(path: string, server: string, planId: string, exists: boolean): ApplyState {
  if (!exists) return { format: APPLY_STATE_FORMAT, version: 1, server, plan_id: planId, created: {}, skipped: {}, undone: {} };
  const value = readJson(path, 'apply state');
  if (!isObject(value) || value.format !== APPLY_STATE_FORMAT || value.version !== 1 || !isObject(value.created) || !isObject(value.skipped) || !isObject(value.undone)) {
    throw new CliError(`${path} is not an annotate state file; move it away to start over`);
  }
  if (value.server !== server) {
    throw new CliError(`${path} records this plan applied to ${String(value.server)}, not ${server}; a plan's state is for one server (copy the plan to another file to apply it elsewhere)`);
  }
  return value as unknown as ApplyState;
}

// ── the dry run ─────────────────────────────────────────────────────────────────────────────

export type ItemAction = 'create' | 'skip' | 'invalid';

export interface ItemPlan {
  key: string;
  kind: AnnotationKind;
  session_id: string;
  label: string;
  action: ItemAction;
  reason?: string;
  /** skip of an item created earlier: its target id. */
  target_id?: string;
}

/** A create's tool and arguments (before the inputSchema cut). */
interface Write {
  tool: string;
  args: Rec;
  show_id?: string;
}

export interface SessionInfo {
  session_id: string;
  found: boolean;
  reason?: string;
  show_id?: string;
  title?: string;
  fps?: number;
  categories: { id: string; name: string }[];
  /** The transcript's extent in seconds, when it has one. */
  extent: { start: number; end: number } | null;
  /** Lower-cased titles of the show's wiki pages linked to the session. */
  wiki_titles: Set<string>;
  has_session_page: boolean;
}

export interface ApplyPlan {
  items: ItemPlan[];
  writes: Map<string, Write>;
  sessions: SessionInfo[];
  counts: { create: Record<AnnotationKind, number>; skip: number; invalid: number };
  estimate: Estimate;
}

export interface Estimate {
  writes: number;
  seconds: number;
  text: string;
  assumes: { writes_per_minute: number; writes_per_hour: number };
}

/** How long `writes` writes take under the write window (a full window to start with). */
export function estimate(writes: number): Estimate {
  const perMinute = Math.max(0, writes - WRITES_PER_MINUTE) * (60 / WRITES_PER_MINUTE);
  const perHour = Math.max(0, writes - WRITES_PER_HOUR) * (3600 / WRITES_PER_HOUR);
  // About half a second a call besides the waits.
  const seconds = Math.ceil(Math.max(perMinute, perHour) + writes * 0.5);
  return { writes, seconds, text: duration(seconds), assumes: { writes_per_minute: WRITES_PER_MINUTE, writes_per_hour: WRITES_PER_HOUR } };
}

export function duration(seconds: number): string {
  if (seconds < 90) return `about ${seconds} s`;
  if (seconds < 5400) return `about ${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `about ${h} h${m > 0 ? ` ${m} min` : ''}`;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** What the dry run needs to know of each session of the plan. Read tools only. */
export async function readSessions(caller: Caller, plan: AnnotatePlan, warn: (m: string) => void): Promise<SessionInfo[]> {
  const out: SessionInfo[] = [];
  for (const id of plan.session_ids) {
    const info: SessionInfo = { session_id: id, found: false, categories: [], extent: null, wiki_titles: new Set(), has_session_page: false };
    out.push(info);
    const answer = await callWithRetry(caller, 'get_session', { session_id: id });
    if (answer.isError === true || !isObject(answer.structuredContent)) {
      info.reason = `unknown session (get_session: ${clip(resultText(answer), 200)})`;
      continue;
    }
    const session = answer.structuredContent;
    info.found = true;
    info.title = str(session.title);
    if (typeof session.show_id === 'string' && session.show_id !== '') info.show_id = session.show_id;
    if (validRate(session.fps)) info.fps = session.fps;
    const entries = plan.entries.filter((e) => e.session_id === id);
    const has = (kind: AnnotationKind): boolean => entries.some((e) => e.kind === kind);
    if (has('events')) {
      const cats = isObject(session.categories) ? session.categories : await readTool(caller, 'list_categories', { session_id: id });
      info.categories = (Array.isArray(cats.items) ? cats.items : []).filter(isObject).flatMap((c) => (typeof c.id === 'string' && typeof c.name === 'string' ? [{ id: c.id, name: c.name }] : []));
    }
    if (has('events') || has('topics')) {
      const counts = isObject(session.counts) ? session.counts : {};
      // Paragraphs when there are any (fewer reads), else words.
      const tool = isNum(counts.paragraphs) && counts.paragraphs === 0 ? 'list_transcript_words' : 'list_transcript_paragraphs';
      let rows = await listPaged(caller, tool, { session_id: id }, `session ${id}`, warn);
      if (rows.length === 0 && tool === 'list_transcript_paragraphs') rows = await listPaged(caller, 'list_transcript_words', { session_id: id }, `session ${id}`, warn);
      for (const r of rows) {
        const start = isNum(r.start_sec) ? r.start_sec : undefined;
        const end = isNum(r.end_sec) ? r.end_sec : start;
        if (start === undefined || end === undefined) continue;
        info.extent = info.extent === null ? { start, end } : { start: Math.min(info.extent.start, start), end: Math.max(info.extent.end, end) };
      }
    }
    if (has('wiki_pages')) {
      for (const p of await listPaged(caller, 'list_wiki_pages', { session_id: id }, `session ${id}`, warn)) {
        if (typeof p.title === 'string') info.wiki_titles.add(p.title.trim().toLowerCase());
        if (p.association === 'session_page') info.has_session_page = true;
      }
    }
  }
  return out;
}

function labelOf(kind: AnnotationKind, item: Rec): string {
  const text = kind === 'events' ? item.message : kind === 'topics' ? item.summary : item.title;
  return clip(typeof text === 'string' ? text.replace(/\s+/g, ' ') : '', 80);
}

/** A session time (seconds, or a timecode string) as total frames at `fps`, or a problem. */
function frames(value: unknown, fps: number, field: string): number | string {
  if (isNum(value)) {
    if (value < 0) return `${field} is negative`;
    if (value >= 86_400) return `${field} ${value} s is past 24 h`;
    // The frame that holds the instant.
    return Math.floor(value * countRate(fps) + 1e-9);
  }
  if (typeof value === 'string') {
    const parsed = parseTimecode(value.trim(), fps);
    if (parsed === undefined) return `${field} '${clip(value, 40)}' is not seconds or an HH:MM:SS:FF timecode at the session's ${fps} fps`;
    return parsed;
  }
  return `${field} is missing (seconds, or an HH:MM:SS:FF timecode)`;
}

function outside(seconds: number, info: SessionInfo, field: string, slack = EDGE_S): string | undefined {
  const e = info.extent;
  if (e === null || (seconds >= e.start - slack && seconds <= e.end + slack)) return undefined;
  return `${field} ${Math.round(seconds * 1000) / 1000} s is outside the session (its transcript runs ${Math.round(e.start * 1000) / 1000}-${Math.round(e.end * 1000) / 1000} s)`;
}

export interface PlanContext {
  plan: AnnotatePlan;
  server: string;
  state: ApplyState;
  sessions: readonly SessionInfo[];
  tools: ReadonlyMap<string, Tool>;
}

/** The marker an event carries, naming this tool, the plan and the item. */
export function marker(planId: string, key: string): Rec {
  return { created_by: MARKER_TOOL, annotate_plan: planId, annotate_item: key };
}

/** The client_request_id of an item's create: the same for every run of the plan on the server. */
export function requestId(server: string, planId: string, key: string): string {
  return `annotate-${sha(`${server}\n${planId}\n${key}`).slice(0, 40)}`;
}

/** Checks every item and builds each valid one's create; writes nothing. */
export function planApply(ctx: PlanContext): ApplyPlan {
  const { plan, state } = ctx;
  const items: ItemPlan[] = [];
  const writes = new Map<string, Write>();
  // Wiki titles the plan creates, per show, to find a title used twice.
  const planTitles = new Map<string, string>();
  for (const kind of KIND_ORDER) {
    for (const entry of plan.entries.filter((e) => e.kind === kind)) {
      const base = { key: entry.key, kind, session_id: entry.session_id, label: labelOf(kind, entry.item) };
      const created = state.created[entry.key];
      if (created !== undefined) {
        items.push({ ...base, action: 'skip', reason: 'created by an earlier apply of this plan (state file)', target_id: created.target_id });
        continue;
      }
      const skipped = state.skipped[entry.key];
      if (skipped !== undefined) {
        items.push({ ...base, action: 'skip', reason: skipped.reason });
        continue;
      }
      const info = ctx.sessions.find((s) => s.session_id === entry.session_id);
      const built = entry.problem !== undefined ? entry.problem : info === undefined || !info.found ? (info?.reason ?? 'unknown session') : build(ctx, entry, info, planTitles);
      if (typeof built === 'string') {
        items.push({ ...base, action: 'invalid', reason: built });
        continue;
      }
      if ('skip' in built) {
        items.push({ ...base, action: 'skip', reason: built.skip });
        continue;
      }
      writes.set(entry.key, built);
      items.push({ ...base, action: 'create' });
    }
  }
  const create = { events: 0, topics: 0, wiki_pages: 0, dashboards: 0 };
  for (const i of items) if (i.action === 'create') create[i.kind]++;
  // Keep the plan's session order: sessions, then kinds.
  const order = new Map(plan.session_ids.map((id, n) => [id, n]));
  items.sort((a, b) => (order.get(a.session_id) ?? 0) - (order.get(b.session_id) ?? 0));
  return {
    items,
    writes,
    sessions: [...ctx.sessions],
    counts: { create, skip: items.filter((i) => i.action === 'skip').length, invalid: items.filter((i) => i.action === 'invalid').length },
    estimate: estimate(writes.size),
  };
}

/** An item's create, a skip, or why it is invalid. */
function build(ctx: PlanContext, entry: PlanEntry, info: SessionInfo, planTitles: Map<string, string>): Write | { skip: string } | string {
  const { item, kind } = entry;
  const unknown = Object.keys(item).filter((k) => !FIELDS[kind].includes(k));
  if (unknown.length > 0) return `unknown field${unknown.length === 1 ? '' : 's'} ${unknown.map((k) => `'${k}'`).join(', ')} (a ${kind.replace(/s$/, '').replace('_', ' ')} takes ${FIELDS[kind].join(', ')})`;
  const fps = info.fps ?? 25;
  const sessionId = entry.session_id;
  const extra = (tool: string): Rec => ({ client_request_id: requestId(ctx.server, ctx.plan.plan_id, entry.key), ...(tool === 'create_event' ? { metadata: marker(ctx.plan.plan_id, entry.key) } : {}) });

  if (kind === 'events') {
    const names = info.categories.map((c) => c.name);
    if (typeof item.category !== 'string' || item.category.trim() === '') return `category is missing (one of the show's categories: ${names.join(', ') || 'none'})`;
    const wanted = item.category.trim().toLowerCase();
    if (wanted === 'internal') return `internal is the category of recording-take rows, which annotate does not write; use one of the show's categories: ${names.join(', ') || 'none'}`;
    const category = info.categories.find((c) => c.name.trim().toLowerCase() === wanted) ?? info.categories.find((c) => c.id === item.category);
    if (category === undefined) return `the session's show has no category '${clip(item.category, 60)}'; its categories: ${names.join(', ') || 'none'}`;
    if (typeof item.message !== 'string' || item.message.trim() === '') return 'message is missing';
    if (item.message.length > MAX_TEXT) return `message is over ${MAX_TEXT} characters`;
    if ((item.session_time === undefined) === (item.timecode === undefined)) return 'give the event exactly one of session_time (seconds) or timecode (HH:MM:SS:FF)';
    const f = frames(item.session_time ?? item.timecode, fps, item.session_time !== undefined ? 'session_time' : 'timecode');
    if (typeof f === 'string') return f;
    const why = outside(f / countRate(fps), info, 'the event time');
    if (why !== undefined) return why;
    return { tool: 'create_event', args: { session_id: sessionId, category: category.id, message: item.message, timecode: formatTimecode(f, fps), ...extra('create_event') } };
  }

  if (kind === 'topics') {
    const f = frames(item.session_time, fps, 'session_time');
    if (typeof f === 'string') return f;
    if (!isNum(item.duration_sec)) return 'duration_sec is missing (seconds, 0 or more)';
    if (item.duration_sec < 0) return 'duration_sec is negative';
    const level = item.topic_level ?? 1;
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 10) return 'topic_level must be a whole number from 1 to 10';
    if (typeof item.summary !== 'string' || item.summary.trim() === '') return 'summary is missing';
    if (item.summary.length > MAX_TEXT) return `summary is over ${MAX_TEXT} characters`;
    const start = f / countRate(fps);
    const why = outside(start, info, 'the topic start') ?? outside(start + item.duration_sec, info, 'the topic end', 5);
    if (why !== undefined) return why;
    return { tool: 'create_topic', args: { session_id: sessionId, session_time: formatTimecode(f, fps), duration_sec: item.duration_sec, topic_level: level, summary: item.summary, ...extra('create_topic') } };
  }

  if (kind === 'wiki_pages') {
    if (info.show_id === undefined) return 'the session has no show_id';
    if (typeof item.kind !== 'string' || !WIKI_KINDS.includes(item.kind)) return `kind must be one of ${WIKI_KINDS.join(', ')}`;
    if (typeof item.title !== 'string' || item.title.trim() === '') return 'title is missing';
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
    if (item.title.length > MAX_WIKI_TITLE || /[\u0000-\u001f\u007f]/.test(item.title)) return `title must be at most ${MAX_WIKI_TITLE} characters with no control characters`;
    const aliases = item.aliases ?? [];
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
    if (!Array.isArray(aliases) || aliases.length > MAX_ALIASES || !aliases.every((a) => typeof a === 'string' && a.trim() !== '' && a.length <= MAX_WIKI_TITLE && !/[\u0000-\u001f\u007f]/.test(a))) {
      return `aliases must be a list of at most ${MAX_ALIASES} non-empty lines of at most ${MAX_WIKI_TITLE} characters`;
    }
    if (item.kind === 'session' && aliases.length > 0) return 'a session page takes no aliases';
    if (typeof item.body_md !== 'string') return 'body_md is missing';
    if (item.body_md.length > MAX_WIKI_BODY) return `body_md is over ${MAX_WIKI_BODY} characters`;
    const problems = checkLinks(item.body_md);
    if (problems.length > 0) return `body_md fails check-links: ${problems.map((p) => `${p.line}:${p.column} ${p.message}`).join('; ')}`;
    const title = item.title.trim().toLowerCase();
    const twice = planTitles.get(`${info.show_id}\n${title}`);
    if (twice !== undefined) return `the plan has the title '${clip(item.title, 60)}' twice in show ${info.show_id} (also ${twice})`;
    planTitles.set(`${info.show_id}\n${title}`, entry.key);
    if (info.wiki_titles.has(title)) return { skip: `the show already has a wiki page titled '${clip(item.title, 60)}'; not overwritten` };
    if (item.kind === 'session' && info.has_session_page) return { skip: 'the session already has a session page; not overwritten' };
    return {
      tool: 'create_wiki_page',
      show_id: info.show_id,
      args: { show_id: info.show_id, kind: item.kind, title: item.title, body_md: item.body_md, aliases, ...(item.kind === 'session' ? { session_id: sessionId } : {}), ...extra('create_wiki_page') },
    };
  }

  // dashboards
  if ((item.template === undefined) === (item.tsx === undefined)) return `give the dashboard exactly one of "template": "${OVERVIEW_TEMPLATE}" or "tsx"`;
  if (item.template !== undefined && item.template !== OVERVIEW_TEMPLATE) return `template must be "${OVERVIEW_TEMPLATE}" (the only built-in template)`;
  const title = item.title ?? (item.template !== undefined ? DEFAULT_OVERVIEW_TITLE : undefined);
  const bad = titleProblem(title);
  if (bad !== undefined) return bad;
  let tsx: string;
  if (item.template !== undefined) {
    tsx = overviewTsx(cleanTitle(String(title)));
  } else {
    if (typeof item.tsx !== 'string' || item.tsx.trim() === '') return 'tsx is empty';
    tsx = item.tsx;
  }
  const problems = dashboardProblems(tsx);
  if (problems.length > 0) return `the dashboard fails autologger's dashboard rules: ${problems.join('; ')}`;
  return { tool: 'save_dashboard', args: { title: String(title), tsx, scope: { kind: 'session', session_id: sessionId } } };
}

// ── apply ───────────────────────────────────────────────────────────────────────────────────

export interface ApplyFailure {
  key: string;
  kind: AnnotationKind;
  session_id: string;
  reason: string;
}

export interface ApplyResult {
  created: Record<AnnotationKind, number>;
  skipped: ItemPlan[];
  failed: ApplyFailure[];
  /** Fields a target tool does not accept, not sent (e.g. create_event without metadata). */
  dropped_fields: { tool: string; field: string }[];
}

const TAKEN_RE = /^(Title already used\.|Session already has a page\.)/;

function createdIds(kind: AnnotationKind, sc: unknown): { id: string | undefined; version: number | null } {
  if (!isObject(sc)) return { id: undefined, version: null };
  const keys = { events: ['event_id', 'id'], topics: ['topic_id', 'id'], wiki_pages: ['page_id', 'id'], dashboards: ['dashboard_id', 'id'] }[kind];
  const id = keys.map((k) => sc[k]).find((v): v is string => typeof v === 'string' && v !== '');
  const v = kind === 'events' || kind === 'topics' ? sc.version : sc.revision;
  return { id, version: isNum(v) ? v : null };
}

export interface ApplyInput {
  caller: Caller;
  tools: ReadonlyMap<string, Tool>;
  state: ApplyState;
  save: () => void;
  now: () => number;
}

/** Creates the plan's valid items, saving each one's target id right after its write. */
export async function applyPlan(input: ApplyInput, thePlan: ApplyPlan): Promise<ApplyResult> {
  const { caller, tools, state } = input;
  const result: ApplyResult = { created: { events: 0, topics: 0, wiki_pages: 0, dashboards: 0 }, skipped: [], failed: [], dropped_fields: [] };
  const dropped = new Map<string, { tool: string; field: string }>();
  for (const item of thePlan.items) {
    if (item.action === 'skip') {
      result.skipped.push(item);
      continue;
    }
    if (item.action === 'invalid') {
      result.failed.push({ key: item.key, kind: item.kind, session_id: item.session_id, reason: `invalid: ${item.reason ?? ''}` });
      continue;
    }
    const write = thePlan.writes.get(item.key);
    if (write === undefined) continue;
    const fitted = fit(write.args, inputShape(tools.get(write.tool)));
    for (const field of fitted.dropped) if (field !== 'client_request_id') dropped.set(`${write.tool}\u0000${field}`, { tool: write.tool, field });
    if (fitted.missing.length > 0) {
      result.failed.push({ key: item.key, kind: item.kind, session_id: item.session_id, reason: `${write.tool} on the server requires ${fitted.missing.join(', ')}, which annotate does not send` });
      continue;
    }
    const answer = await callWithRetry(caller, write.tool, fitted.args);
    if (answer.isError === true) {
      const message = resultText(answer);
      if (item.kind === 'wiki_pages' && TAKEN_RE.test(message)) {
        const reason = `${clip(message, 200)} on the server; not overwritten`;
        state.skipped[item.key] = { reason };
        input.save();
        result.skipped.push({ ...item, action: 'skip', reason });
      } else {
        result.failed.push({ key: item.key, kind: item.kind, session_id: item.session_id, reason: `${write.tool} refused it: ${clip(message, 500)}` });
      }
      continue;
    }
    const { id, version } = createdIds(item.kind, answer.structuredContent);
    if (id === undefined) throw new CliError(`${write.tool} answered no id for ${item.key}; it may have been created, check the session before running again`);
    state.created[item.key] = {
      kind: item.kind,
      session_id: item.session_id,
      target_id: id,
      version,
      ...(write.show_id !== undefined ? { show_id: write.show_id } : {}),
      label: item.label,
      created_at: new Date(input.now()).toISOString(),
    };
    input.save();
    result.created[item.kind]++;
  }
  result.dropped_fields = [...dropped.values()];
  return result;
}

// ── undo ────────────────────────────────────────────────────────────────────────────────────

export interface UndoItem {
  key: string;
  kind: AnnotationKind;
  session_id: string;
  target_id: string;
  version: number | null;
  label: string;
}

export interface UndoResult {
  deleted: UndoItem[];
  /** Changed since this plan created it (its version or revision moved on): left as it is. */
  changed: (UndoItem & { reason: string })[];
  /** No longer on the server: dropped from the state file. */
  gone: UndoItem[];
  failed: (UndoItem & { reason: string })[];
}

export function undoItems(state: ApplyState): UndoItem[] {
  return Object.entries(state.created).map(([key, c]) => ({ key, kind: c.kind, session_id: c.session_id, target_id: c.target_id, version: c.version, label: c.label }));
}

const CONFLICT_RE = /^Version conflict|^Page was merged/;
const GONE_RE = /not found/i;

/**
 * Deletes what the state file says this plan created, each with the version (revision) read just
 * before and only while it is still the one it was created with. A wiki page the session's
 * list_wiki_pages does not show is deleted with its recorded revision, which the server refuses if
 * the page changed.
 */
export async function undoPlan(input: ApplyInput): Promise<UndoResult> {
  const { caller, state } = input;
  const result: UndoResult = { deleted: [], changed: [], gone: [], failed: [] };
  const lists = new Map<string, Map<string, Rec>>();
  const current = async (item: UndoItem): Promise<Rec | undefined> => {
    const cacheKey = `${item.kind}\n${item.session_id}`;
    let rows = lists.get(cacheKey);
    if (rows === undefined) {
      const listed = await listPaged(caller, LIST_TOOLS[item.kind], { session_id: item.session_id }, `session ${item.session_id}`, () => {});
      rows = new Map();
      for (const r of listed) {
        const { id } = createdIds(item.kind, r);
        if (id !== undefined) rows.set(id, r);
      }
      lists.set(cacheKey, rows);
    }
    return rows.get(item.target_id);
  };
  const forget = (key: string, undone: boolean): void => {
    const record = state.created[key];
    if (record === undefined) return;
    delete state.created[key];
    if (undone) state.undone[key] = { ...record, undone_at: new Date(input.now()).toISOString() };
    input.save();
  };

  for (const item of undoItems(state)) {
    let version = item.version;
    const row = await current(item);
    if (row === undefined && item.kind !== 'wiki_pages') {
      result.gone.push(item);
      forget(item.key, false);
      continue;
    }
    if (row !== undefined) {
      const now = createdIds(item.kind, row).version;
      if (now !== null && item.version !== null && now !== item.version) {
        result.changed.push({ ...item, reason: `changed since it was created (${item.kind === 'events' || item.kind === 'topics' ? 'version' : 'revision'} ${item.version} -> ${now}); not deleted` });
        continue;
      }
      if (now !== null) version = now;
    }
    if (version === null) {
      result.failed.push({ ...item, reason: 'no version was recorded or read for it; not deleted' });
      continue;
    }
    const tool = DELETE_TOOLS[item.kind];
    const args: Rec =
      item.kind === 'events'
        ? { session_id: item.session_id, event_id: item.target_id, version }
        : item.kind === 'topics'
          ? { session_id: item.session_id, topic_id: item.target_id, version }
          : item.kind === 'wiki_pages'
            ? { page_id: item.target_id, expected_revision: version }
            : { dashboard_id: item.target_id, expected_revision: version };
    const answer = await callWithRetry(caller, tool, args);
    if (answer.isError === true) {
      const message = resultText(answer);
      if (CONFLICT_RE.test(message)) result.changed.push({ ...item, reason: `changed since it was created; ${tool} refused: ${clip(message, 200)}` });
      else if (GONE_RE.test(message) && item.kind === 'wiki_pages' && row === undefined) {
        result.gone.push(item);
        forget(item.key, false);
      } else result.failed.push({ ...item, reason: `${tool} refused it: ${clip(message, 300)}` });
      continue;
    }
    forget(item.key, true);
    result.deleted.push(item);
  }
  return result;
}
