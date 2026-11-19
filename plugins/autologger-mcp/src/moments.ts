// moments: finds, in the local index only, the places a topic comes up across a scope's sessions:
// topic titles and summaries, event messages, transcript paragraphs and wiki pages. Matching is
// lexical (case- and accent-insensitive, whole words or phrases); Claude judges which matches are
// really about the topic.
import type { Rec } from './copy.ts';
import { citeUrl, linkTargets } from './links.ts';
import type { PageRecord, ScopeView, SessionRecord } from './wikiIndex.ts';

/** Moments of one session closer than this (seconds) are merged into one. */
export const MERGE_WINDOW_S = 5;
const SNIPPET_CONTEXT = 60;

export type Source = 'topic' | 'event' | 'transcript' | 'wiki';

export interface Moment {
  session_id: string;
  session_title: string;
  session_date: string;
  show_id: string;
  /** Seconds into the session, when the source has a time. */
  seconds: number | null;
  source: Source;
  snippet: string;
  /** The term that matched, as given (the query, a --term, or a matching page's title or alias). */
  term: string;
  /** `cite:<session_id>@<seconds>`, ready for a wiki body, or null without a time. */
  cite: string | null;
  /** The matched item: event_id, topic id, paragraph ordinal or page_id. */
  ref: string;
  speaker?: string;
  /** Near-duplicates merged into this moment (same session, within MERGE_WINDOW_S). */
  also?: { source: Source; seconds: number | null; snippet: string; term: string; ref: string }[];
}

export interface PageHit {
  page_id: string;
  kind: string;
  title: string;
  /** Where the term matched: the title, an alias, or the body. */
  matched_in: 'title' | 'alias' | 'body';
  term: string;
  snippet: string;
}

export interface MomentsResult {
  terms: string[];
  moments: Moment[];
  /** Wiki pages that matched, including those with no session moment of their own. */
  wiki_pages: PageHit[];
}

/** Folds text for matching (NFKD, combining marks removed, lower case), with each folded UTF-16 unit's offset in `text`. */
export function fold(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const f = ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
    i += ch.length;
  }
  map.push(text.length);
  return { folded, map };
}

export interface Matcher {
  term: string;
  re: RegExp;
}

/** A matcher for a term as a whole word or phrase, or undefined when it has no letters or digits. */
export function matcher(term: string): Matcher | undefined {
  const words = fold(term).folded.split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
  if (words.length === 0) return undefined;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return { term, re: new RegExp(`(?<![\\p{L}\\p{N}])${escaped.join('[^\\p{L}\\p{N}]+')}(?![\\p{L}\\p{N}])`, 'u') };
}

/** Where `m` first matches `text`, as offsets in `text`. */
export function findIn(m: Matcher, text: string): { start: number; end: number } | undefined {
  const { folded, map } = fold(text);
  const hit = m.re.exec(folded);
  if (hit === null) return undefined;
  return { start: map[hit.index] ?? 0, end: map[hit.index + hit[0].length] ?? text.length };
}

/** A short one-line excerpt of `text` around `start`..`end`. */
export function snippet(text: string, start: number, end: number): string {
  const from = Math.max(0, start - SNIPPET_CONTEXT);
  const to = Math.min(text.length, end + SNIPPET_CONTEXT);
  const body = text.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Seconds of a session time (`HH:MM:SS`, `HH:MM:SS:FF` with `fps`, `MM:SS`, or plain seconds), else undefined. */
export function sessionSeconds(time: unknown, fps?: number): number | undefined {
  if (typeof time === 'number') return Number.isFinite(time) && time >= 0 ? time : undefined;
  if (typeof time !== 'string' || time.trim() === '') return undefined;
  const parts = time.trim().split(':');
  if (parts.length > 4 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return undefined;
  const n = parts.map(Number);
  if (n.length === 4) return (n[0] ?? 0) * 3600 + (n[1] ?? 0) * 60 + (n[2] ?? 0) + (fps !== undefined && fps > 0 ? (n[3] ?? 0) / fps : 0);
  if (n.length === 3) return (n[0] ?? 0) * 3600 + (n[1] ?? 0) * 60 + (n[2] ?? 0);
  if (n.length === 2) return (n[0] ?? 0) * 60 + (n[1] ?? 0);
  return n[0];
}

/** An event's second on the session timeline: `timecode_total_frames / frame_rate`, else its timecode. */
export function eventSeconds(event: Rec, fps?: number): number | undefined {
  const frames = num(event.timecode_total_frames);
  const rate = num(event.frame_rate) ?? fps;
  if (frames !== undefined && rate !== undefined && rate > 0 && frames >= 0) return frames / rate;
  return sessionSeconds(event.timecode, rate);
}

/** A topic's span on the session timeline: from its session_time for duration_sec (open-ended without one). */
export function topicSpan(topic: Rec, fps?: number): { start: number; end: number } | undefined {
  const start = sessionSeconds(topic.session_time, fps);
  if (start === undefined) return undefined;
  const duration = num(topic.duration_sec);
  return { start, end: duration !== undefined && duration > 0 ? start + duration : Number.POSITIVE_INFINITY };
}

interface SessionInfo {
  session_id: string;
  session_title: string;
  session_date: string;
  show_id: string;
  fps: number | undefined;
}

export function sessionInfo(record: SessionRecord): SessionInfo {
  const s = record.session;
  return { session_id: record.session_id, session_title: str(s.title), session_date: str(s.date), show_id: str(s.show_id), fps: num(s.fps) };
}

/** The paragraph (blank-line separated block) of `body` around offset `at`. */
function blockAround(body: string, at: number): { start: number; end: number } {
  const before = body.lastIndexOf('\n\n', at);
  const after = body.indexOf('\n\n', at);
  return { start: before === -1 ? 0 : before, end: after === -1 ? body.length : after };
}

/**
 * The moments of `view` about the terms (the query first, then each --term). A wiki page whose title
 * or an alias matches adds its title and aliases as terms and its `cite:` links as moments.
 */
export function findMoments(view: ScopeView, terms: readonly string[]): MomentsResult {
  const matchers: Matcher[] = [];
  const seenTerms = new Set<string>();
  const addTerm = (term: string): void => {
    const m = matcher(term);
    if (m === undefined) return;
    const key = m.re.source;
    if (seenTerms.has(key)) return;
    seenTerms.add(key);
    matchers.push(m);
  };
  for (const t of terms) addTerm(t);

  const infos = new Map(view.sessions.map((s) => [s.session_id, sessionInfo(s)]));
  const moments: Moment[] = [];
  const pageHits: PageHit[] = [];
  const firstMatch = (text: string): { m: Matcher; at: { start: number; end: number } } | undefined => {
    for (const m of matchers) {
      const at = findIn(m, text);
      if (at !== undefined) return { m, at };
    }
    return undefined;
  };
  const push = (info: SessionInfo, seconds: number | undefined, source: Source, text: string, hit: { m: Matcher; at: { start: number; end: number } }, ref: string, speaker?: string): void => {
    const s = seconds ?? null;
    moments.push({
      session_id: info.session_id,
      session_title: info.session_title,
      session_date: info.session_date,
      show_id: info.show_id,
      seconds: s === null ? null : Math.round(s * 1000) / 1000,
      source,
      snippet: snippet(text, hit.at.start, hit.at.end),
      term: hit.m.term,
      cite: citeUrl(info.session_id, s),
      ref,
      ...(speaker !== undefined && speaker !== '' ? { speaker } : {}),
    });
  };

  // Pages first: a page matched by title or alias widens the terms for everything else.
  const pages = [...view.pages.values()].sort((a, b) => a.page_id.localeCompare(b.page_id));
  const named = new Map<string, { page: PageRecord; hit: PageHit }>();
  for (const page of pages) {
    const base = [...matchers];
    for (const [where, text] of [['title', page.title], ...page.aliases.map((a) => ['alias', a] as const)] as const) {
      const m = base.find((x) => findIn(x, text) !== undefined);
      if (m === undefined) continue;
      named.set(page.page_id, { page, hit: { page_id: page.page_id, kind: page.kind, title: page.title, matched_in: where, term: m.term, snippet: text } });
      break;
    }
  }
  for (const { page } of named.values()) {
    addTerm(page.title);
    for (const a of page.aliases) addTerm(a);
  }

  // The sessions a page is the session page of, in scope.
  const sessionPageOf = new Map<string, string[]>();
  for (const s of view.sessions) {
    for (const row of s.wiki) {
      if (row.association !== 'session_page') continue;
      sessionPageOf.set(row.page_id, [...(sessionPageOf.get(row.page_id) ?? []), s.session_id]);
    }
  }

  for (const page of pages) {
    const cites = linkTargets(page.body_md).filter((l) => l.kind === 'cite');
    const titled = named.get(page.page_id);
    if (titled !== undefined) {
      pageHits.push(titled.hit);
      const m = matchers.find((x) => x.term === titled.hit.term) ?? matchers[0];
      for (const c of cites) {
        if (c.kind !== 'cite' || m === undefined) continue;
        const info = infos.get(c.session_id);
        if (info === undefined) continue;
        moments.push({
          session_id: info.session_id,
          session_title: info.session_title,
          session_date: info.session_date,
          show_id: info.show_id,
          seconds: c.seconds,
          source: 'wiki',
          snippet: snippet(page.body_md, c.index, c.index + c.label.length + 2),
          term: m.term,
          cite: citeUrl(info.session_id, c.seconds),
          ref: page.page_id,
        });
      }
      continue;
    }
    const hit = firstMatch(page.body_md);
    if (hit === undefined) continue;
    pageHits.push({ page_id: page.page_id, kind: page.kind, title: page.title, matched_in: 'body', term: hit.m.term, snippet: snippet(page.body_md, hit.at.start, hit.at.end) });
    // A body match is a moment at the citations of the paragraph it is in, else of the page's own session.
    const block = blockAround(page.body_md, hit.at.start);
    const near = cites.filter((c) => c.index >= block.start && c.index <= block.end);
    for (const c of near) {
      if (c.kind !== 'cite') continue;
      const info = infos.get(c.session_id);
      if (info !== undefined) push(info, c.seconds, 'wiki', page.body_md, hit, page.page_id);
    }
    if (near.length === 0) {
      for (const sessionId of sessionPageOf.get(page.page_id) ?? []) {
        const info = infos.get(sessionId);
        if (info !== undefined) push(info, undefined, 'wiki', page.body_md, hit, page.page_id);
      }
    }
  }

  for (const record of view.sessions) {
    const info = infos.get(record.session_id);
    if (info === undefined) continue;
    for (const topic of record.topics) {
      const text = [str(topic.title), str(topic.summary)].filter((t) => t !== '').join(' — ');
      const hit = firstMatch(text);
      if (hit !== undefined) push(info, topicSpan(topic, info.fps)?.start, 'topic', text, hit, str(topic.id ?? topic.topic_id));
    }
    for (const event of record.events) {
      const text = str(event.message);
      const hit = firstMatch(text);
      if (hit !== undefined) push(info, eventSeconds(event, info.fps), 'event', text, hit, str(event.event_id ?? event.id));
    }
    for (const paragraph of record.paragraphs) {
      const text = str(paragraph.text);
      const hit = firstMatch(text);
      if (hit !== undefined) push(info, num(paragraph.start_sec), 'transcript', text, hit, str(paragraph.ordinal), str(paragraph.speaker));
    }
  }

  return { terms: matchers.map((m) => m.term), moments: mergeMoments(moments), wiki_pages: pageHits };
}

const SOURCE_ORDER: Record<Source, number> = { transcript: 0, event: 1, topic: 2, wiki: 3 };

/** Orders moments by session date, session, then time (untimed last), and merges near-duplicates. */
export function mergeMoments(all: Moment[]): Moment[] {
  const sorted = [...all].sort(
    (a, b) =>
      (a.session_date === '' ? 1 : 0) - (b.session_date === '' ? 1 : 0) ||
      a.session_date.localeCompare(b.session_date) ||
      a.session_id.localeCompare(b.session_id) ||
      (a.seconds ?? Number.POSITIVE_INFINITY) - (b.seconds ?? Number.POSITIVE_INFINITY) ||
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source],
  );
  const out: Moment[] = [];
  const seen = new Set<string>();
  for (const m of sorted) {
    // The same item matched twice (one wiki citation reached two ways) is one moment.
    const key = `${m.session_id}\n${m.source}\n${m.ref}\n${m.seconds ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const last = out[out.length - 1];
    if (last !== undefined && last.session_id === m.session_id && last.seconds !== null && m.seconds !== null && m.seconds - last.seconds <= MERGE_WINDOW_S) {
      last.also = [...(last.also ?? []), { source: m.source, seconds: m.seconds, snippet: m.snippet, term: m.term, ref: m.ref }];
      continue;
    }
    out.push({ ...m });
  }
  return out;
}
