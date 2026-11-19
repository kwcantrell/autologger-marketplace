// export: reads sessions from a source server through its MCP read tools into a snapshot. Only the
// read tools named here are ever called; what the server answers is stored as data.
import { type Caller, type Kind, readTool, type Rec, SNAPSHOT_FORMAT, type Snapshot, type SnapshotSession } from './copy.ts';
import { CliError } from './errors.ts';
import { isObject } from './http.ts';

/** The read tools export calls, and nothing else. */
export const EXPORT_TOOLS = ['get_session', 'list_events', 'list_topics', 'list_wiki_pages', 'get_wiki_page'] as const;

/** Guards against a server whose cursor or offset never ends. */
const MAX_PAGES = 10_000;

const LIST_TOOL: Record<Kind, string> = { events: 'list_events', topics: 'list_topics', wiki_pages: 'list_wiki_pages' };

/** Every item of a list tool, following `next_cursor` to the end. */
async function listAll(caller: Caller, tool: string, sessionId: string, warn: (m: string) => void): Promise<Rec[]> {
  const items: Rec[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const out = await readTool(caller, tool, cursor === undefined ? { session_id: sessionId } : { session_id: sessionId, cursor });
    if (!Array.isArray(out.items)) throw new CliError(`${tool} answered no items`);
    for (const item of out.items) if (isObject(item)) items.push(item);
    if (typeof out.note === 'string') warn(`${tool} for session ${sessionId}: ${out.note}`);
    const next = out.next_cursor;
    if (typeof next !== 'string' || next === '') return items;
    if (seen.has(next)) throw new CliError(`${tool} for session ${sessionId} repeated a cursor`);
    seen.add(next);
    cursor = next;
  }
  throw new CliError(`${tool} for session ${sessionId} did not end after ${MAX_PAGES} pages`);
}

/** A wiki page's metadata and whole body, from every slice of `get_wiki_page` through `next_offset`. */
async function wholePage(caller: Caller, sessionId: string, listed: Rec): Promise<Rec> {
  const pageId = listed.page_id;
  if (typeof pageId !== 'string') throw new CliError(`list_wiki_pages for session ${sessionId} answered a page without page_id`);
  let body = '';
  let offset = 0;
  let meta: Rec = {};
  for (let slice = 0; slice < MAX_PAGES; slice++) {
    const args: Rec = { session_id: sessionId, page_id: pageId };
    if (offset > 0) args.offset = offset;
    const out = await readTool(caller, 'get_wiki_page', args);
    if (typeof out.body_md !== 'string') throw new CliError(`get_wiki_page ${pageId} answered no body_md`);
    body += out.body_md;
    const { body_md: _b, offset: _o, next_offset: next, ...rest } = out;
    meta = rest;
    if (typeof next !== 'number') return { ...listed, ...meta, body_md: body };
    if (next <= offset) throw new CliError(`get_wiki_page ${pageId} answered a next_offset that does not advance`);
    offset = next;
  }
  throw new CliError(`get_wiki_page ${pageId} did not end after ${MAX_PAGES} slices`);
}

export interface ExportSummary {
  source_server: string;
  out: string;
  sessions: { session_id: string; events: number; topics: number; wiki_pages: number }[];
  totals: { sessions: number; events: number; topics: number; wiki_pages: number };
}

export async function exportSessions(caller: Caller, server: string, sessionIds: readonly string[], now: number, warn: (m: string) => void): Promise<Snapshot> {
  const sessions: SnapshotSession[] = [];
  for (const sessionId of sessionIds) {
    const session = await readTool(caller, 'get_session', { session_id: sessionId });
    const events = await listAll(caller, LIST_TOOL.events, sessionId, warn);
    const topics = await listAll(caller, LIST_TOOL.topics, sessionId, warn);
    const listed = await listAll(caller, LIST_TOOL.wiki_pages, sessionId, warn);
    const pages: Rec[] = [];
    for (const page of listed) pages.push(await wholePage(caller, sessionId, page));
    sessions.push({ session_id: sessionId, session, events, topics, wiki_pages: pages });
  }
  return { format: SNAPSHOT_FORMAT, version: 1, source_server: server, exported_at: new Date(now).toISOString(), sessions };
}

export function summarize(snapshot: Snapshot, out: string): ExportSummary {
  const sessions = snapshot.sessions.map((s) => ({ session_id: s.session_id, events: s.events.length, topics: s.topics.length, wiki_pages: s.wiki_pages.length }));
  const sum = (k: 'events' | 'topics' | 'wiki_pages'): number => sessions.reduce((n, s) => n + s[k], 0);
  return {
    source_server: snapshot.source_server,
    out,
    sessions,
    totals: { sessions: sessions.length, events: sum('events'), topics: sum('topics'), wiki_pages: sum('wiki_pages') },
  };
}
