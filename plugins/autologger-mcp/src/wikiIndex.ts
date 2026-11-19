// The local index: what `index build` read from a server through its read tools, kept per server so
// `moments` and `person-graph` answer without calling the server. autologger's MCP server has no
// search tool and limits reads (120 a minute, 2,000 an hour per user), so a build re-reads a
// session's content only when the server reports a change, stops cleanly at a read budget, and a
// rerun continues where it stopped.
//
// Layout: `<config dir>/index/<server key>/` (0700) holding `meta.json` (listings, finished builds,
// the build in progress), `sessions/<hash>.json` (a session's get_session, events, topics,
// transcript paragraphs and its list_wiki_pages rows) and `pages/<hash>.json` (a wiki page with its
// whole body). Files are 0600, written atomically. File names are hashes of the ids, so no id the
// server answers ever names a path. Only tool results are stored: never a token.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Caller, RateLimitStop, rateLimitSeconds, readTool, type Rec, writeJsonFile } from './copy.ts';
import { CliError, messageOf } from './errors.ts';
import { listAll, listPaged, wholePage } from './export.ts';
import { isObject } from './http.ts';
import { type CallToolResult, McpError, resultText } from './mcp.ts';
import { configDir, type Env, makeDirs, serverKey } from './store.ts';

export const INDEX_FORMAT = 'autologger-mcp-index';

/** What a build or a query covers: one show, one studio, or every studio of the user. */
export type Scope = { kind: 'show'; id: string } | { kind: 'studio'; id: string } | { kind: 'all' };

export function scopeKey(scope: Scope): string {
  return scope.kind === 'all' ? 'all' : `${scope.kind}:${scope.id}`;
}

/** The scope as command-line options. */
export function scopeArgs(scope: Scope): string[] {
  return scope.kind === 'all' ? ['--all'] : [`--${scope.kind}`, scope.id];
}

export function scopeText(scope: Scope): string {
  return scope.kind === 'all' ? 'all studios' : `${scope.kind} ${scope.id}`;
}

/** The read tools a build calls, and nothing else. */
export const INDEX_TOOLS = [
  'list_studios',
  'list_shows',
  'list_sessions',
  'get_session',
  'list_events',
  'list_topics',
  'list_transcript_paragraphs',
  'list_wiki_pages',
  'get_wiki_page',
] as const;

/** Reads one build makes at most by default: at autologger's 120 a minute that is about 4 minutes of
 * calls and rate-limit waits, well under the Bash tool's 10-minute limit. */
export const DEFAULT_MAX_READS = 400;
/** The longest single rate-limit wait a build sits out; a longer one stops it. */
export const MAX_WAIT_S = 90;
/** The most a build waits on rate limits in total; past it, the build stops. */
export const MAX_TOTAL_WAIT_S = 300;
/** A build in progress older than this is started over rather than continued. */
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface StudioListing {
  studio_id: string;
  name: string;
  show_ids: string[];
  listed_at: string;
}

export interface ShowListing {
  show_id: string;
  name: string;
  session_ids: string[];
  listed_at: string;
}

export interface FinishedBuild {
  scope: string;
  completed_at: string;
  sessions: number;
  reads: number;
}

export interface PendingBuild {
  scope: string;
  started_at: string;
  session_ids: string[];
  done: string[];
}

export interface IndexMeta {
  format: typeof INDEX_FORMAT;
  version: 1;
  server: string;
  /** `list_studios`, when an `--all` build listed it. */
  studios_listed?: { studio_ids: string[]; listed_at: string };
  studios: StudioListing[];
  shows: ShowListing[];
  builds: FinishedBuild[];
  pending?: PendingBuild;
}

/** A wiki page as one session's list_wiki_pages answers it. */
export interface SessionWikiRow {
  page_id: string;
  kind: string;
  title: string;
  aliases: string[];
  revision: number;
  association: string;
}

export interface SessionRecord {
  format: typeof INDEX_FORMAT;
  session_id: string;
  /** The get_session result. */
  session: Rec;
  events: Rec[];
  topics: Rec[];
  paragraphs: Rec[];
  wiki: SessionWikiRow[];
  /** When events, topics and paragraphs were last read. */
  content_read_at: string;
  /** When get_session and list_wiki_pages were last read. */
  checked_at: string;
}

export interface PageRecord {
  format: typeof INDEX_FORMAT;
  page_id: string;
  kind: string;
  title: string;
  aliases: string[];
  revision: number;
  body_md: string;
  read_at: string;
}

const hashName = (id: string): string => `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json`;

function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CliError(`cannot read ${path}: ${messageOf(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`${path} is not valid JSON; run index clear for this server and build again`);
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** One server's index on disk. */
export class WikiIndex {
  readonly server: string;
  readonly root: string;
  readonly dir: string;

  constructor(env: Env, server: string) {
    this.server = server;
    this.root = join(configDir(env), 'index');
    this.dir = join(this.root, serverKey(server));
  }

  exists(): boolean {
    return existsSync(join(this.dir, 'meta.json'));
  }

  meta(): IndexMeta {
    const value = readJsonFile(join(this.dir, 'meta.json'));
    if (value === undefined) return { format: INDEX_FORMAT, version: 1, server: this.server, studios: [], shows: [], builds: [] };
    if (!isObject(value) || value.format !== INDEX_FORMAT || value.version !== 1 || value.server !== this.server) {
      throw new CliError(`${join(this.dir, 'meta.json')} is not this server's autologger-mcp index; run index clear for this server and build again`);
    }
    const meta = value as unknown as IndexMeta;
    return { ...meta, studios: meta.studios ?? [], shows: meta.shows ?? [], builds: meta.builds ?? [] };
  }

  saveMeta(meta: IndexMeta): void {
    this.ensureDirs();
    writeJsonFile(join(this.dir, 'meta.json'), meta, true);
  }

  session(id: string): SessionRecord | undefined {
    const value = readJsonFile(join(this.dir, 'sessions', hashName(id)));
    if (!isObject(value) || value.format !== INDEX_FORMAT || value.session_id !== id) return undefined;
    return value as unknown as SessionRecord;
  }

  saveSession(record: SessionRecord): void {
    this.ensureDirs();
    writeJsonFile(join(this.dir, 'sessions', hashName(record.session_id)), record, true);
  }

  /** Every session record on disk. */
  allSessions(): SessionRecord[] {
    const dir = join(this.dir, 'sessions');
    if (!existsSync(dir)) return [];
    const out: SessionRecord[] = [];
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const value = readJsonFile(join(dir, name));
      if (isObject(value) && value.format === INDEX_FORMAT && typeof value.session_id === 'string') out.push(value as unknown as SessionRecord);
    }
    return out;
  }

  page(id: string): PageRecord | undefined {
    const value = readJsonFile(join(this.dir, 'pages', hashName(id)));
    if (!isObject(value) || value.format !== INDEX_FORMAT || value.page_id !== id) return undefined;
    return value as unknown as PageRecord;
  }

  savePage(record: PageRecord): void {
    this.ensureDirs();
    writeJsonFile(join(this.dir, 'pages', hashName(record.page_id)), record, true);
  }

  count(sub: 'sessions' | 'pages'): number {
    const dir = join(this.dir, sub);
    return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')).length : 0;
  }

  /** Deletes this server's index; true when there was one. */
  clear(): boolean {
    if (!existsSync(this.dir)) return false;
    rmSync(this.dir, { recursive: true, force: true });
    return true;
  }

  private ensureDirs(): void {
    for (const dir of [join(this.root, '..'), this.root, this.dir, join(this.dir, 'sessions'), join(this.dir, 'pages')]) {
      try {
        makeDirs(dir, 0o700);
      } catch (error) {
        throw new CliError(`cannot create ${dir}: ${messageOf(error)}`);
      }
      if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    }
  }
}

/** Thrown by a budgeted caller when the build has made its `--max-reads` reads. */
export class BudgetStop extends CliError {}

export interface BudgetCaller extends Caller {
  readonly reads: number;
  readonly waitedS: number;
}

/**
 * A Caller that counts every tool call against `maxReads` (BudgetStop when it is spent) and waits
 * out `Rate limit exceeded; retry in N s.` itself while each wait is at most MAX_WAIT_S and all
 * waits stay within MAX_TOTAL_WAIT_S. Past that it hands the rate-limited answer back, and
 * callWithRetry (with `noWait`) turns it into a RateLimitStop.
 */
export function budgetCaller(opts: {
  call: (name: string, args: Rec) => Promise<CallToolResult>;
  sleep: (ms: number) => Promise<void>;
  notice: (text: string) => void;
  maxReads: number;
}): BudgetCaller {
  let reads = 0;
  let waitedS = 0;
  const caller: BudgetCaller = {
    get reads() {
      return reads;
    },
    get waitedS() {
      return waitedS;
    },
    noWait: true,
    sleep: opts.sleep,
    notice: opts.notice,
    call: async (name, args) => {
      for (;;) {
        if (reads >= opts.maxReads) throw new BudgetStop(`read budget of ${opts.maxReads} calls spent`);
        reads++;
        let result: CallToolResult;
        let seconds: number | undefined;
        try {
          result = await opts.call(name, args);
          seconds = result.isError === true ? rateLimitSeconds(resultText(result)) : undefined;
        } catch (error) {
          if (!(error instanceof McpError) || rateLimitSeconds(error.message) === undefined) throw error;
          seconds = rateLimitSeconds(error.message);
          result = { isError: true, content: [{ type: 'text', text: error.message }] };
        }
        if (seconds === undefined) return result;
        if (seconds > MAX_WAIT_S || waitedS + seconds + 1 > MAX_TOTAL_WAIT_S) return result;
        opts.notice(`${name}: rate limited; waiting ${seconds} s before retrying\n`);
        await opts.sleep((seconds + 1) * 1000);
        waitedS += seconds + 1;
      }
    },
  };
  return caller;
}

export interface BuildResult {
  server: string;
  scope: string;
  complete: boolean;
  /** Why the build stopped early (the read budget, a rate limit), when it did. */
  stopped?: string;
  /** Continued a build an earlier run stopped. */
  resumed: boolean;
  reads: number;
  waited_s: number;
  sessions: {
    in_scope: number;
    /** Content (events, topics, paragraphs) read in this run. */
    content_read: number;
    /** Unchanged since the last build: only get_session and list_wiki_pages were called. */
    unchanged: number;
    /** Finished by the stopped run this one continues. */
    done_before: number;
    remaining: number;
  };
  pages: { read: number; unchanged: number };
  failed: { session_id: string; reason: string }[];
  index_dir: string;
}

const isoOf = (ms: number): string => new Date(ms).toISOString();

/** The session ids of `scope`, listed from the server (list_studios, list_shows, list_sessions), saved into `meta`. */
async function listScope(caller: Caller, meta: IndexMeta, scope: Scope, now: string, warn: (m: string) => void): Promise<string[]> {
  const shows = new Map(meta.shows.map((s) => [s.show_id, s]));
  const studios = new Map(meta.studios.map((s) => [s.studio_id, s]));
  const listShow = async (showId: string, name?: string): Promise<string[]> => {
    const items = await listPaged(caller, 'list_sessions', { show_id: showId }, `show ${showId}`, warn);
    const ids = items.map((i) => i.session_id).filter((id): id is string => typeof id === 'string' && id !== '');
    shows.set(showId, { show_id: showId, name: name ?? shows.get(showId)?.name ?? '', session_ids: ids, listed_at: now });
    return ids;
  };
  const listStudio = async (studioId: string, name?: string): Promise<string[]> => {
    const items = await listPaged(caller, 'list_shows', { studio_id: studioId }, `studio ${studioId}`, warn);
    const showIds: string[] = [];
    const ids: string[] = [];
    for (const item of items) {
      if (typeof item.show_id !== 'string' || item.show_id === '' || item.can_access === false) continue;
      showIds.push(item.show_id);
      ids.push(...(await listShow(item.show_id, str(item.name))));
    }
    studios.set(studioId, { studio_id: studioId, name: name ?? studios.get(studioId)?.name ?? '', show_ids: showIds, listed_at: now });
    return ids;
  };
  let ids: string[];
  if (scope.kind === 'show') {
    ids = await listShow(scope.id);
  } else if (scope.kind === 'studio') {
    ids = await listStudio(scope.id);
  } else {
    const out = await readTool(caller, 'list_studios', {});
    const items = Array.isArray(out.items) ? out.items.filter(isObject) : [];
    const studioIds: string[] = [];
    ids = [];
    for (const item of items) {
      if (typeof item.studio_id !== 'string' || item.studio_id === '') continue;
      studioIds.push(item.studio_id);
      ids.push(...(await listStudio(item.studio_id, str(item.name))));
    }
    meta.studios_listed = { studio_ids: studioIds, listed_at: now };
  }
  meta.shows = [...shows.values()];
  meta.studios = [...studios.values()];
  return [...new Set(ids)];
}

const COUNT_KEYS = ['events', 'words', 'paragraphs', 'topics'] as const;

/**
 * Whether a session's content is unchanged since `prev` was read: get_session's `revision` (which
 * autologger advances on every write to the session's events, transcript and topics) and its
 * counts of those rows are the same.
 */
export function contentUnchanged(prev: SessionRecord | undefined, session: Rec): boolean {
  if (prev === undefined) return false;
  const before = prev.session;
  if (num(before.revision) === undefined || num(before.revision) !== num(session.revision)) return false;
  const a = isObject(before.counts) ? before.counts : {};
  const b = isObject(session.counts) ? session.counts : {};
  return COUNT_KEYS.every((k) => num(a[k]) === num(b[k]));
}

function wikiRow(item: Rec): SessionWikiRow | undefined {
  if (typeof item.page_id !== 'string' || item.page_id === '') return undefined;
  return {
    page_id: item.page_id,
    kind: str(item.kind),
    title: str(item.title),
    aliases: strings(item.aliases),
    revision: num(item.revision) ?? -1,
    association: str(item.association),
  };
}

/**
 * Builds or refreshes the index of `scope`. Every session is checked with get_session and
 * list_wiki_pages; its events, topics and paragraphs are read again only when contentUnchanged says
 * they changed, and a wiki page's body only when its revision changed. Stops cleanly (complete:
 * false) when the read budget is spent or a rate limit lasts too long; progress is saved after every
 * session, so the next run continues with the sessions not yet done.
 */
export async function buildIndex(opts: {
  caller: BudgetCaller;
  index: WikiIndex;
  scope: Scope;
  now: () => number;
  warn: (m: string) => void;
}): Promise<BuildResult> {
  const { caller, index, scope, warn } = opts;
  const key = scopeKey(scope);
  const meta = index.meta();
  const started = isoOf(opts.now());
  const result: BuildResult = {
    server: index.server,
    scope: key,
    complete: false,
    resumed: false,
    reads: 0,
    waited_s: 0,
    sessions: { in_scope: 0, content_read: 0, unchanged: 0, done_before: 0, remaining: 0 },
    pages: { read: 0, unchanged: 0 },
    failed: [],
    index_dir: index.dir,
  };
  const finish = (): BuildResult => {
    result.reads = caller.reads;
    result.waited_s = caller.waitedS;
    const pending = meta.pending;
    result.sessions.remaining = pending === undefined ? 0 : pending.session_ids.filter((id) => !pending.done.includes(id)).length;
    return result;
  };
  const stop = (error: unknown): BuildResult => {
    result.stopped = error instanceof RateLimitStop ? `${error.message}; waited ${caller.waitedS} s in this run` : messageOf(error);
    index.saveMeta(meta);
    return finish();
  };

  let pending = meta.pending;
  if (pending !== undefined && pending.scope === key && opts.now() - Date.parse(pending.started_at) < PENDING_MAX_AGE_MS) {
    result.resumed = true;
  } else {
    let ids: string[];
    try {
      ids = await listScope(caller, meta, scope, started, warn);
    } catch (error) {
      if (error instanceof BudgetStop || error instanceof RateLimitStop) return stop(error);
      throw error;
    }
    pending = { scope: key, started_at: started, session_ids: ids, done: [] };
    meta.pending = pending;
    index.saveMeta(meta);
  }
  result.sessions.in_scope = pending.session_ids.length;
  result.sessions.done_before = pending.done.length;
  const done = new Set(pending.done);
  const pagesThisRun = new Set<string>();

  for (const sessionId of pending.session_ids) {
    if (done.has(sessionId)) continue;
    try {
      const outcome = await indexSession(caller, index, sessionId, pagesThisRun, isoOf(opts.now()), warn);
      if (outcome.contentRead) result.sessions.content_read++;
      else result.sessions.unchanged++;
      result.pages.read += outcome.pagesRead;
      result.pages.unchanged += outcome.pagesUnchanged;
    } catch (error) {
      if (error instanceof BudgetStop || error instanceof RateLimitStop) return stop(error);
      // A transport or server failure stops the build; a tool's refusal (the session is gone or no
      // longer visible) is reported and the build goes on.
      if (error instanceof McpError || !(error instanceof CliError)) {
        index.saveMeta(meta);
        throw error;
      }
      result.failed.push({ session_id: sessionId, reason: messageOf(error) });
      continue;
    }
    done.add(sessionId);
    pending.done.push(sessionId);
    index.saveMeta(meta);
  }

  if (result.failed.length === 0) {
    delete meta.pending;
    meta.builds = [
      ...meta.builds.filter((b) => b.scope !== key),
      { scope: key, completed_at: isoOf(opts.now()), sessions: pending.session_ids.length, reads: caller.reads },
    ];
    result.complete = true;
  } else {
    result.stopped = `${result.failed.length} session${result.failed.length === 1 ? '' : 's'} could not be read`;
  }
  index.saveMeta(meta);
  return finish();
}

async function indexSession(
  caller: Caller,
  index: WikiIndex,
  sessionId: string,
  pagesThisRun: Set<string>,
  now: string,
  warn: (m: string) => void,
): Promise<{ contentRead: boolean; pagesRead: number; pagesUnchanged: number }> {
  const session = await readTool(caller, 'get_session', { session_id: sessionId });
  const prev = index.session(sessionId);
  const unchanged = contentUnchanged(prev, session);
  let events: Rec[];
  let topics: Rec[];
  let paragraphs: Rec[];
  if (unchanged && prev !== undefined) {
    ({ events, topics, paragraphs } = prev);
  } else {
    events = await listAll(caller, 'list_events', sessionId, warn);
    topics = await listAll(caller, 'list_topics', sessionId, warn);
    paragraphs = await listAll(caller, 'list_transcript_paragraphs', sessionId, warn);
  }
  // The session revision does not cover wiki pages (they are the show's), so the session's wiki
  // listing is read on every build; a page body only when its revision moved.
  const listed = await listAll(caller, 'list_wiki_pages', sessionId, warn);
  const wiki: SessionWikiRow[] = [];
  let pagesRead = 0;
  let pagesUnchanged = 0;
  for (const item of listed) {
    const row = wikiRow(item);
    if (row === undefined) {
      warn(`list_wiki_pages for session ${sessionId} answered a page without page_id; skipped`);
      continue;
    }
    wiki.push(row);
    if (pagesThisRun.has(row.page_id)) continue;
    const stored = index.page(row.page_id);
    if (stored !== undefined && stored.revision === row.revision && row.revision >= 0) {
      pagesUnchanged++;
      pagesThisRun.add(row.page_id);
      continue;
    }
    const whole = await wholePage(caller, sessionId, item);
    index.savePage({
      format: INDEX_FORMAT,
      page_id: row.page_id,
      kind: str(whole.kind) || row.kind,
      title: str(whole.title) || row.title,
      aliases: Array.isArray(whole.aliases) ? strings(whole.aliases) : row.aliases,
      revision: num(whole.revision) ?? row.revision,
      body_md: str(whole.body_md),
      read_at: now,
    });
    pagesRead++;
    pagesThisRun.add(row.page_id);
  }
  index.saveSession({
    format: INDEX_FORMAT,
    session_id: sessionId,
    session,
    events,
    topics,
    paragraphs,
    wiki,
    content_read_at: unchanged && prev !== undefined ? prev.content_read_at : now,
    checked_at: now,
  });
  return { contentRead: !unchanged, pagesRead, pagesUnchanged };
}

/** The indexed sessions and wiki pages a query covers, and whether the scope is fully indexed. */
export interface ScopeView {
  scope: string;
  sessions: SessionRecord[];
  /** Wiki pages associated with any of `sessions`, by page id. */
  pages: Map<string, PageRecord>;
  /** Every listed session of the scope is in the index. */
  complete: boolean;
  /** Sessions the listing names that are not indexed (unknown without a listing). */
  missing: number | null;
  /** The last finished build of exactly this scope. */
  built_at: string | null;
  /** The oldest `checked_at` of the sessions. */
  oldest_check: string | null;
}

/** The session ids the stored listings give for `scope`, or undefined when a listing is missing. */
function listedIds(meta: IndexMeta, scope: Scope): string[] | undefined {
  const shows = new Map(meta.shows.map((s) => [s.show_id, s]));
  const studios = new Map(meta.studios.map((s) => [s.studio_id, s]));
  const ofShow = (id: string): string[] | undefined => shows.get(id)?.session_ids;
  const ofStudio = (id: string): string[] | undefined => {
    const studio = studios.get(id);
    if (studio === undefined) return undefined;
    const ids: string[] = [];
    for (const showId of studio.show_ids) {
      const s = ofShow(showId);
      if (s === undefined) return undefined;
      ids.push(...s);
    }
    return ids;
  };
  if (scope.kind === 'show') return ofShow(scope.id);
  if (scope.kind === 'studio') return ofStudio(scope.id);
  if (meta.studios_listed === undefined) return undefined;
  const ids: string[] = [];
  for (const id of meta.studios_listed.studio_ids) {
    const s = ofStudio(id);
    if (s === undefined) return undefined;
    ids.push(...s);
  }
  return ids;
}

/**
 * What the index holds for `scope`. With the scope's listing, the listed sessions (complete when all
 * are indexed and no build of it is pending); without one, every indexed session whose get_session
 * names the show or studio (all of them for `all`), and complete is false.
 */
export function scopeView(index: WikiIndex, scope: Scope): ScopeView {
  const meta = index.exists() ? index.meta() : undefined;
  const key = scopeKey(scope);
  const listed = meta === undefined ? undefined : listedIds(meta, scope);
  let sessions: SessionRecord[];
  let missing: number | null = null;
  if (listed !== undefined) {
    sessions = [];
    missing = 0;
    for (const id of new Set(listed)) {
      const record = index.session(id);
      if (record === undefined) missing++;
      else sessions.push(record);
    }
  } else {
    sessions = index.allSessions().filter((r) => {
      if (scope.kind === 'all') return true;
      return str(scope.kind === 'show' ? r.session.show_id : r.session.studio_id) === scope.id;
    });
  }
  const pages = new Map<string, PageRecord>();
  for (const s of sessions) {
    for (const row of s.wiki) {
      if (pages.has(row.page_id)) continue;
      const page = index.page(row.page_id);
      if (page !== undefined) pages.set(row.page_id, page);
    }
  }
  const checks = sessions.map((s) => s.checked_at).sort();
  return {
    scope: key,
    sessions,
    pages,
    complete: listed !== undefined && missing === 0 && meta?.pending?.scope !== key,
    missing,
    built_at: meta?.builds.find((b) => b.scope === key)?.completed_at ?? null,
    oldest_check: checks[0] ?? null,
  };
}
