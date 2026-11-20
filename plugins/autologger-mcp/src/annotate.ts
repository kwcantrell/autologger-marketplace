// annotate gaps and annotate transcript: the read-only half of annotating sessions in bulk.
//
// - gaps lists every session the account can see (or only some shows'), with what it already has
//   (events without take rows, topics, wiki pages linked to it, session dashboards, transcript size)
//   and which of the four kinds are missing. Only the read tools in GAPS_TOOLS are called.
// - transcript prints a session's transcript compactly, as time-stamped, speaker-labelled lines
//   (from its paragraphs when it has them, else grouped from its words), a bounded number of
//   characters per call, with the second to continue from.
//
// Session content is only ever data here: it is printed, never acted on.
import { type Caller, readTool, type Rec } from './copy.ts';
import { CliError } from './errors.ts';
import { listPaged } from './export.ts';
import { isObject } from './http.ts';
import type { Tool } from './mcp.ts';
import { countRate, rowFrames, takeRow, validRate } from './timecode.ts';

export const GAPS_FORMAT = 'autologger-mcp-annotate-gaps';

/** The read tools annotate gaps may call, and nothing else. */
export const GAPS_TOOLS = ['list_studios', 'list_shows', 'list_sessions', 'get_session', 'list_events', 'get_session_aggregates', 'list_dashboards'] as const;

/** The four kinds annotate writes. */
export const ANNOTATION_KINDS = ['events', 'topics', 'wiki_pages', 'dashboards'] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

/** Guards against a server whose cursor never ends. */
const MAX_PAGES = 10_000;

export interface GapSession {
  session_id: string;
  studio_id: string;
  show_id: string;
  show_name: string;
  title: string;
  date: string;
  /** get_session_aggregates' session_duration (the transcript's extent), when it is available. */
  duration_s: number | null;
  /** The latest event timecode in seconds (take rows included), when the session has one. */
  last_session_time_s: number | null;
  transcript_words: number | null;
  transcript_paragraphs: number | null;
  /** Events other than recording-take rows. */
  events: number;
  topics: number | null;
  /** Wiki pages linked to the session (its own page, pages citing it, pages its page links to). */
  wiki_pages: number | null;
  /** Session dashboards (studio templates not counted); null when the server has no dashboard tools. */
  dashboards: number | null;
  /** The kinds the session has none of. */
  missing: AnnotationKind[];
}

export interface GapsReport {
  format: typeof GAPS_FORMAT;
  version: 1;
  server: string;
  generated_at: string;
  /** The --show filter, or null for every show. */
  shows_filter: string[] | null;
  /** Shows listed but not read: the account cannot open them, or a --show not found. */
  skipped_shows: { show_id: string; reason: string }[];
  sessions: GapSession[];
  totals: {
    sessions: number;
    with_transcript: number;
    transcript_words: number;
    missing: Record<AnnotationKind, number>;
    missing_all: number;
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Seconds of an event row's timecode, or null. */
function eventSeconds(row: Rec, sessionFps: number | undefined): number | null {
  const fps = validRate(row.frame_rate) ? row.frame_rate : sessionFps;
  if (fps === undefined) return null;
  const frames = rowFrames(row, fps);
  return frames === undefined ? null : frames / countRate(fps);
}

export interface GapsInput {
  caller: Caller;
  tools: ReadonlyMap<string, Tool>;
  server: string;
  /** Only these shows (by id), or every show the account can open. */
  shows?: readonly string[];
  warn: (message: string) => void;
  now: number;
}

/** Reads what every visible session already has. Read tools only. */
export async function gaps(input: GapsInput): Promise<GapsReport> {
  const { caller, tools, warn } = input;
  for (const t of ['list_studios', 'list_shows', 'list_sessions', 'list_events'] as const) {
    if (!tools.has(t)) throw new CliError(`the server has no ${t} tool, which annotate gaps needs`);
  }
  const filter = input.shows !== undefined && input.shows.length > 0 ? new Set(input.shows) : undefined;
  const found = new Set<string>();
  const skipped: GapsReport['skipped_shows'] = [];
  const sessions: GapSession[] = [];
  const seen = new Set<string>();

  const studios = await readTool(caller, 'list_studios', {});
  if (!Array.isArray(studios.items)) throw new CliError('list_studios answered no items');
  for (const studio of studios.items.filter(isObject)) {
    const studioId = str(studio.studio_id);
    if (studioId === '') continue;
    const shows = await listPaged(caller, 'list_shows', { studio_id: studioId }, `studio ${studioId}`, warn);
    for (const show of shows) {
      const showId = str(show.show_id);
      if (showId === '' || (filter !== undefined && !filter.has(showId))) continue;
      found.add(showId);
      if (show.can_access === false) {
        skipped.push({ show_id: showId, reason: 'this account cannot open its sessions' });
        continue;
      }
      const listed = await listPaged(caller, 'list_sessions', { show_id: showId }, `show ${showId}`, warn);
      for (const item of listed) {
        const sessionId = str(item.session_id);
        if (sessionId === '' || seen.has(sessionId)) continue;
        seen.add(sessionId);
        sessions.push(await sessionGaps(input, item, studioId, showId, str(show.name)));
      }
    }
  }
  for (const id of filter ?? []) if (!found.has(id)) skipped.push({ show_id: id, reason: 'no such show among the studios this account belongs to' });

  const missing = { events: 0, topics: 0, wiki_pages: 0, dashboards: 0 };
  for (const s of sessions) for (const k of s.missing) missing[k]++;
  return {
    format: GAPS_FORMAT,
    version: 1,
    server: input.server,
    generated_at: new Date(input.now).toISOString(),
    shows_filter: filter === undefined ? null : [...filter],
    skipped_shows: skipped,
    sessions,
    totals: {
      sessions: sessions.length,
      with_transcript: sessions.filter((s) => (s.transcript_words ?? 0) > 0 || (s.transcript_paragraphs ?? 0) > 0).length,
      transcript_words: sessions.reduce((n, s) => n + (s.transcript_words ?? 0), 0),
      missing,
      missing_all: sessions.filter((s) => s.missing.length === ANNOTATION_KINDS.length).length,
    },
  };
}

async function sessionGaps(input: GapsInput, item: Rec, studioId: string, showId: string, showName: string): Promise<GapSession> {
  const { caller, tools, warn } = input;
  const sessionId = str(item.session_id);
  // list_sessions answers each session's counts; get_session only when it does not.
  let counts = isObject(item.counts) ? item.counts : undefined;
  let fps: number | undefined;
  if (counts === undefined && tools.has('get_session')) {
    const session = await readTool(caller, 'get_session', { session_id: sessionId });
    counts = isObject(session.counts) ? session.counts : undefined;
    if (validRate(session.fps)) fps = session.fps;
  }
  const events = await listPaged(caller, 'list_events', { session_id: sessionId }, `session ${sessionId}`, warn);
  let last: number | null = null;
  for (const row of events) {
    const s = eventSeconds(row, fps);
    if (s !== null && (last === null || s > last)) last = s;
  }
  let duration: number | null = null;
  if (tools.has('get_session_aggregates')) {
    const aggregates = await readTool(caller, 'get_session_aggregates', { session_id: sessionId });
    const d = isObject(aggregates.session_duration) ? aggregates.session_duration : {};
    duration = d.available === true ? num(d.durationSec) : null;
  }
  let dashboards: number | null = null;
  if (tools.has('list_dashboards')) {
    dashboards = (await listPaged(caller, 'list_dashboards', { session_id: sessionId }, `session ${sessionId}`, warn)).filter((d) => d.scope === 'session').length;
  }
  const out: GapSession = {
    session_id: sessionId,
    studio_id: studioId,
    show_id: showId,
    show_name: showName,
    title: str(item.title),
    date: str(item.date),
    duration_s: duration === null ? null : Math.round(duration * 1000) / 1000,
    last_session_time_s: last === null ? null : Math.round(last * 1000) / 1000,
    transcript_words: num(counts?.words),
    transcript_paragraphs: num(counts?.paragraphs),
    events: events.filter((e) => takeRow(e) === undefined).length,
    topics: num(counts?.topics),
    wiki_pages: num(counts?.wiki_pages),
    dashboards,
    missing: [],
  };
  if (out.events === 0) out.missing.push('events');
  if (out.topics === 0) out.missing.push('topics');
  if (out.wiki_pages === 0) out.missing.push('wiki_pages');
  if (out.dashboards === 0) out.missing.push('dashboards');
  return out;
}

// ── transcript ──────────────────────────────────────────────────────────────────────────────

export const DEFAULT_MAX_CHARS = 20_000;
export const MIN_MAX_CHARS = 200;
export const MAX_MAX_CHARS = 1_000_000;
/** A line grouped from words ends at a change of speaker or at about this many characters. */
const LINE_CHARS = 400;

/** One item of a list tool at a time, following next_cursor. */
async function* items(caller: Caller, tool: string, args: Rec, what: string): AsyncGenerator<Rec> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const out = await readTool(caller, tool, cursor === undefined ? args : { ...args, cursor });
    if (!Array.isArray(out.items)) throw new CliError(`${tool} answered no items`);
    for (const item of out.items) if (isObject(item)) yield item;
    const next = out.next_cursor;
    if (typeof next !== 'string' || next === '') return;
    if (seen.has(next)) throw new CliError(`${tool} for ${what} repeated a cursor`);
    seen.add(next);
    cursor = next;
  }
  throw new CliError(`${tool} for ${what} did not end after ${MAX_PAGES} pages`);
}

interface Unit {
  start: number;
  speaker: string;
  text: string;
}

/** `[HH:MM:SS]` of a second. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

export interface TranscriptInput {
  caller: Caller;
  sessionId: string;
  from: number;
  /** Exclusive end (seconds), or undefined for the end of the transcript. */
  to: number | undefined;
  maxChars: number;
}

export interface TranscriptResult {
  session_id: string;
  title: string;
  /** Where the lines come from. */
  source: 'paragraphs' | 'words' | 'none';
  from: number;
  to: number | null;
  max_chars: number;
  /** The lines, joined with newlines: `[HH:MM:SS] <speaker>: <text>`. */
  text: string;
  chars: number;
  lines: number;
  /** Paragraphs or words in this answer. */
  units: number;
  /** The second to pass as --from for the rest, or null when this answer reaches the end (or --to). */
  next_from: number | null;
  /** A single paragraph or group of words at one instant was longer than max_chars and is printed whole. */
  over_max_chars: boolean;
}

/**
 * The session's transcript from `from` (inclusive) to `to` (exclusive), by each paragraph's or word's
 * start second, at most `maxChars` characters of text (except one first paragraph longer than it).
 * Units that start at the same instant are never split across answers, so following next_from
 * prints every unit exactly once (the server answers them in time order).
 */
export async function transcript(input: TranscriptInput): Promise<TranscriptResult> {
  const { caller, sessionId, from, to, maxChars } = input;
  const session = await readTool(caller, 'get_session', { session_id: sessionId });
  const scope = { session_id: sessionId };

  // Paragraphs when the session has timed ones, else words.
  let source: TranscriptResult['source'] = 'none';
  let units: AsyncGenerator<Unit> | undefined;
  const paragraphs = items(caller, 'list_transcript_paragraphs', scope, `session ${sessionId}`);
  const first = await paragraphs.next();
  if (first.done !== true && num(first.value.start_sec) !== null) {
    source = 'paragraphs';
    units = (async function* () {
      for (let p: IteratorResult<Rec> = first; p.done !== true; p = await paragraphs.next()) {
        const start = num(p.value.start_sec);
        if (start === null) continue;
        yield { start, speaker: str(p.value.speaker), text: oneLine(str(p.value.text)) };
      }
    })();
  } else {
    await paragraphs.return(undefined);
    source = 'words';
    units = (async function* () {
      for await (const w of items(caller, 'list_transcript_words', scope, `session ${sessionId}`)) {
        const start = num(w.start_sec);
        if (start === null) continue;
        yield { start, speaker: str(w.speaker), text: oneLine(str(w.word)) };
      }
    })();
  }

  const lines: string[] = [];
  let chars = 0;
  let count = 0;
  let next: number | null = null;
  let over = false;
  let lineSpeaker: string | undefined;
  // The units of one instant, added together or not at all.
  let atom: Unit[] = [];
  let seenAny = false;

  /** The characters adding `group` would add, and the lines after it. */
  const render = (group: readonly Unit[]): { lines: string[]; speaker: string | undefined; added: number } => {
    const out = [...lines];
    let speaker = lineSpeaker;
    for (const u of group) {
      if (u.text === '') continue;
      const last = out.length - 1;
      if (source === 'words' && speaker === u.speaker && last >= 0 && (out[last] ?? '').length < LINE_CHARS) {
        out[last] = `${out[last] ?? ''} ${u.text}`;
      } else {
        out.push(`[${clock(u.start)}] ${u.speaker === '' ? '?' : u.speaker}: ${u.text}`);
        speaker = u.speaker;
      }
    }
    const total = out.reduce((n, l) => n + l.length, 0) + Math.max(0, out.length - 1);
    return { lines: out, speaker, added: total - chars };
  };
  /** Adds the pending atom when it fits; false when the answer is full. */
  const flush = (): boolean => {
    if (atom.length === 0) return true;
    const r = render(atom);
    if (seenAny && chars + r.added > maxChars) {
      next = atom[0]?.start ?? null;
      return false;
    }
    if (!seenAny && r.added > maxChars) over = true;
    lines.splice(0, lines.length, ...r.lines);
    lineSpeaker = r.speaker;
    chars += r.added;
    count += atom.length;
    seenAny = true;
    atom = [];
    return true;
  };

  let anyUnit = false;
  for await (const u of units) {
    anyUnit = true;
    if (u.start < from) continue;
    if (to !== undefined && u.start >= to) break;
    if (atom.length > 0 && u.start !== atom[0]?.start) {
      if (!flush()) break;
    }
    atom.push(u);
  }
  if (next === null) flush();
  await units.return(undefined);

  return {
    session_id: sessionId,
    title: str(session.title),
    source: anyUnit ? source : 'none',
    from,
    to: to ?? null,
    max_chars: maxChars,
    text: lines.join('\n'),
    chars,
    lines: lines.length,
    units: count,
    next_from: next,
    over_max_chars: over,
  };
}
