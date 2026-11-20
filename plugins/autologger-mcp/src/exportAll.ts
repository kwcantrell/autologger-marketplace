// export --all: reads everything the signed-in source account can see through the MCP read tools
// (studios, shows with their categories, sessions incl. hidden ones, and per session its events,
// topics, transcript words and paragraphs, wiki pages with whole bodies, session dashboards with
// their source, and media metadata) into one snapshot. Only the read tools in EXPORT_ALL_TOOLS are
// ever called; no media bytes are fetched (list_session_media answers links and offsets only).
//
// Progress is kept in `<out>.export-progress.json` after every listing and every session part, and
// the answers of the step in progress (each page, each wiki slice) after every read, so a run
// stopped by a rate limit (`--no-wait`, or a wait too long) or an error continues on the next run
// of the same command without reading again what it already has.
import { existsSync } from 'node:fs';
import { type Caller, callWithRetry, inputShape, readJson, readTool, type Rec, SNAPSHOT_FORMAT, type Snapshot, type SnapshotSession, type SnapshotStudio } from './copy.ts';
import { CliError } from './errors.ts';
import { listPaged, wholePage } from './export.ts';
import { clip, isObject } from './http.ts';
import { resultText, type Tool } from './mcp.ts';

export const PROGRESS_FORMAT = 'autologger-mcp-export-progress';

/** The read tools export --all calls, and nothing else. */
export const EXPORT_ALL_TOOLS = [
  'list_studios',
  'list_shows',
  'list_sessions',
  'list_categories',
  'get_session',
  'list_events',
  'list_topics',
  'list_transcript_words',
  'list_transcript_paragraphs',
  'list_wiki_pages',
  'get_wiki_page',
  'list_dashboards',
  'get_dashboard',
  'list_session_media',
] as const;

/** Tools without which a whole-account export cannot be made. The others are skipped with a warning. */
const REQUIRED = ['list_studios', 'list_shows', 'list_sessions', 'get_session', 'list_events', 'list_topics', 'list_wiki_pages', 'get_wiki_page'];

interface ProgressShow {
  show_id: string;
  show: Rec;
  categories?: Rec;
  /** Present once list_sessions was read to the end. */
  session_ids?: string[];
}

interface ProgressStudio {
  studio_id: string;
  studio: Rec;
  /** Present once list_shows was read to the end. */
  shows?: ProgressShow[];
}

/** A session being read: each part is present once it was read whole. */
type ProgressSession = Partial<SnapshotSession> & { session_id: string; studio_id: string; show_id: string; listed: Rec };

export interface ExportProgress {
  format: typeof PROGRESS_FORMAT;
  version: 1;
  source_server: string;
  started_at: string;
  /** Present once list_studios was read. */
  studios?: ProgressStudio[];
  sessions: ProgressSession[];
  /** The answers read so far for the step in progress, by `<tool> <arguments JSON>`. */
  pending?: Record<string, Rec>;
}

/** The progress file of an export --all: next to the snapshot, `<out>.export-progress.json`. */
export function progressPath(out: string): string {
  return `${out}.export-progress.json`;
}

/** The progress file, or a fresh progress when there is none. */
export function readProgress(path: string, server: string, now: number): ExportProgress {
  if (!existsSync(path)) return { format: PROGRESS_FORMAT, version: 1, source_server: server, started_at: new Date(now).toISOString(), sessions: [] };
  const value = readJson(path, 'export progress');
  if (!isObject(value) || value.format !== PROGRESS_FORMAT || value.version !== 1 || !Array.isArray(value.sessions)) {
    throw new CliError(`${path} is not an autologger-mcp export progress file; move it away to start over`);
  }
  if (value.source_server !== server) {
    throw new CliError(`${path} records an export from ${String(value.source_server)}, not from ${server}; move it away to start over`);
  }
  return value as unknown as ExportProgress;
}

export interface ExportAllInput {
  caller: Caller;
  /** The source's tools/list, by name. */
  tools: ReadonlyMap<string, Tool>;
  progress: ExportProgress;
  /** Saves the progress file. */
  save: () => void;
  warn: (message: string) => void;
  now: number;
}

const PARTS = ['session', 'events', 'topics', 'transcript_words', 'transcript_paragraphs', 'wiki_pages', 'dashboards', 'media'] as const;

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** Reads the whole account into a snapshot, continuing `progress`; saves it after every step. */
export async function exportAll(input: ExportAllInput): Promise<Snapshot> {
  const { tools, progress, warn } = input;
  // Every answer of the step in progress is kept until the step is done, so a rerun reads none twice.
  const caller: Caller = {
    ...input.caller,
    call: async (name, args) => {
      const key = `${name} ${JSON.stringify(args)}`;
      const hit = progress.pending?.[key];
      if (hit !== undefined) return { content: [], structuredContent: hit };
      const result = await input.caller.call(name, args);
      if (result.isError !== true && isObject(result.structuredContent)) {
        (progress.pending ??= {})[key] = result.structuredContent;
        input.save();
      }
      return result;
    },
  };
  const save = (): void => {
    delete progress.pending;
    input.save();
  };
  const missing = REQUIRED.filter((t) => !tools.has(t));
  if (missing.length > 0) throw new CliError(`the source server has no ${missing.join(', ')} tool${missing.length === 1 ? '' : 's'}, which export --all needs`);
  const warned = new Set<string>();
  const has = (tool: string, what: string): boolean => {
    if (tools.has(tool)) return true;
    if (!warned.has(tool)) {
      warned.add(tool);
      warn(`the source server has no ${tool} tool; ${what} are not exported`);
    }
    return false;
  };

  if (progress.studios === undefined) {
    const out = await readTool(caller, 'list_studios', {});
    if (!Array.isArray(out.items)) throw new CliError('list_studios answered no items');
    progress.studios = out.items.filter(isObject).flatMap((item) => {
      const id = str(item.studio_id);
      return id === undefined ? [] : [{ studio_id: id, studio: item }];
    });
    save();
  }

  const includeHidden = inputShape(tools.get('list_sessions')).properties.has('include_hidden');
  for (const studio of progress.studios) {
    if (studio.shows === undefined) {
      const items = await listPaged(caller, 'list_shows', { studio_id: studio.studio_id }, `studio ${studio.studio_id}`, warn);
      studio.shows = items.flatMap((item) => {
        const id = str(item.show_id);
        return id === undefined ? [] : [{ show_id: id, show: item }];
      });
      save();
    }
    for (const show of studio.shows) {
      if (show.session_ids !== undefined) continue;
      // list_shows lists shows the account cannot open (can_access: false); their categories and
      // sessions are refused ("Show not found"), so neither is read.
      if (show.show.can_access === false) {
        warn(`show ${show.show_id} (${String(show.show.name ?? '')}): this account cannot open it; its categories and sessions are not exported`);
        show.session_ids = [];
        save();
        continue;
      }
      if (show.categories === undefined && has('list_categories', 'show categories')) {
        const answer = await callWithRetry(caller, 'list_categories', { show_id: show.show_id });
        if (answer.isError === true) {
          // A refusal is about this show only: note it and go on, so a rerun does not stop here again.
          warn(`show ${show.show_id} (${String(show.show.name ?? '')}): list_categories refused: ${clip(resultText(answer), 300)}; its categories are not exported`);
          show.categories = { items: [], total: 0 };
        } else {
          if (!isObject(answer.structuredContent)) throw new CliError('list_categories answered no structured content');
          show.categories = answer.structuredContent;
        }
        save();
      }
      const args: Rec = { show_id: show.show_id };
      if (includeHidden) args.include_hidden = true;
      const items = await listPaged(caller, 'list_sessions', args, `show ${show.show_id}`, warn);
      const ids: string[] = [];
      for (const item of items) {
        const id = str(item.session_id);
        if (id === undefined || ids.includes(id)) continue;
        ids.push(id);
        if (!progress.sessions.some((s) => s.session_id === id)) {
          progress.sessions.push({ session_id: id, studio_id: studio.studio_id, show_id: show.show_id, listed: item });
        }
      }
      show.session_ids = ids;
      save();
    }
  }

  // Wiki pages are show pages, listed by every session they are associated with: a body already
  // read at the same revision is not read again.
  const pages = new Map<string, Rec>();
  const remember = (list: readonly Rec[] | undefined): void => {
    for (const p of list ?? []) if (typeof p.page_id === 'string') pages.set(p.page_id, p);
  };
  for (const s of progress.sessions) remember(s.wiki_pages);

  for (const s of progress.sessions) {
    const id = s.session_id;
    const scope = { session_id: id };
    for (const part of PARTS) {
      if (s[part] !== undefined) continue;
      switch (part) {
        case 'session':
          s.session = await readTool(caller, 'get_session', scope);
          break;
        case 'events':
          s.events = await listPaged(caller, 'list_events', scope, `session ${id}`, warn);
          break;
        case 'topics':
          s.topics = await listPaged(caller, 'list_topics', scope, `session ${id}`, warn);
          break;
        case 'transcript_words':
          s.transcript_words = has('list_transcript_words', 'transcript words') ? await listPaged(caller, 'list_transcript_words', scope, `session ${id}`, warn) : [];
          break;
        case 'transcript_paragraphs':
          s.transcript_paragraphs = has('list_transcript_paragraphs', 'transcript paragraphs') ? await listPaged(caller, 'list_transcript_paragraphs', scope, `session ${id}`, warn) : [];
          break;
        case 'wiki_pages': {
          const listed = await listPaged(caller, 'list_wiki_pages', scope, `session ${id}`, warn);
          const whole: Rec[] = [];
          for (const item of listed) {
            const known = typeof item.page_id === 'string' ? pages.get(item.page_id) : undefined;
            whole.push(known !== undefined && known.revision === item.revision ? { ...known, ...item, body_md: known.body_md } : await wholePage(caller, id, item));
          }
          s.wiki_pages = whole;
          remember(whole);
          break;
        }
        case 'dashboards': {
          if (!has('list_dashboards', 'dashboards') || !has('get_dashboard', 'dashboards')) {
            s.dashboards = [];
            break;
          }
          // Studio templates are listed with a session too; only the session's own are copied.
          const listed = (await listPaged(caller, 'list_dashboards', scope, `session ${id}`, warn)).filter((d) => d.scope === 'session');
          const full: Rec[] = [];
          for (const d of listed) {
            const dashboardId = str(d.dashboard_id);
            if (dashboardId !== undefined) full.push(await readTool(caller, 'get_dashboard', { dashboard_id: dashboardId }));
          }
          s.dashboards = full;
          break;
        }
        case 'media': {
          if (!has('list_session_media', 'session media links')) {
            s.media = [];
            break;
          }
          const out = await readTool(caller, 'list_session_media', scope);
          s.media = Array.isArray(out.items) ? out.items.filter(isObject) : [];
          break;
        }
      }
      save();
    }
  }

  const studios: SnapshotStudio[] = progress.studios.map((st) => ({
    studio_id: st.studio_id,
    studio: st.studio,
    shows: (st.shows ?? []).map((sh) => ({ show_id: sh.show_id, show: sh.show, ...(sh.categories !== undefined ? { categories: sh.categories } : {}), session_ids: sh.session_ids ?? [] })),
  }));
  const sessions = progress.sessions.map((s): SnapshotSession => ({
    session_id: s.session_id,
    session: s.session ?? {},
    events: s.events ?? [],
    topics: s.topics ?? [],
    wiki_pages: s.wiki_pages ?? [],
    studio_id: s.studio_id,
    show_id: s.show_id,
    listed: s.listed,
    transcript_words: s.transcript_words ?? [],
    transcript_paragraphs: s.transcript_paragraphs ?? [],
    dashboards: s.dashboards ?? [],
    media: s.media ?? [],
  }));
  return { format: SNAPSHOT_FORMAT, version: 1, source_server: progress.source_server, exported_at: new Date(input.now).toISOString(), studios, sessions };
}
