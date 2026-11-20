// What export and import share: the snapshot and state files (written atomically, mode 0600), tool
// calls that wait out autologger's `Rate limit exceeded; retry in N s.`, and the ids of copied items.
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CliError, messageOf } from './errors.ts';
import { clip, isObject } from './http.ts';
import { type CallToolResult, McpError, resultText, type Tool } from './mcp.ts';

export type Rec = Record<string, unknown>;

export const SNAPSHOT_FORMAT = 'autologger-mcp-snapshot';
export const STATE_FORMAT = 'autologger-mcp-import-state';

/** The kinds of session data a snapshot holds and import can create. */
export const KINDS = ['events', 'topics', 'wiki_pages'] as const;
export type Kind = (typeof KINDS)[number];

/** Where each kind's id is in a row autologger answers (list items, and the rows write tools answer). */
const ID_KEYS: Record<Kind, string[]> = {
  events: ['event_id', 'id'],
  topics: ['topic_id', 'id'],
  wiki_pages: ['page_id', 'id'],
};

/** An item's id, from the first id key it has, or undefined. */
export function itemId(kind: Kind, item: Rec): string | undefined {
  for (const key of ID_KEYS[kind]) {
    const value = item[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

export function idKeys(kind: Kind): readonly string[] {
  return ID_KEYS[kind];
}

export interface SnapshotSession {
  session_id: string;
  /** The `get_session` result. */
  session: Rec;
  events: Rec[];
  topics: Rec[];
  /** Each page's `list_wiki_pages` item and `get_wiki_page` fields, with the whole `body_md`. */
  wiki_pages: Rec[];
  /** `export --all` only: the studio and show the session was listed under. */
  studio_id?: string;
  show_id?: string;
  /** `export --all` only: the session's `list_sessions` item (hidden, archived). */
  listed?: Rec;
  /** `export --all` only: every `list_transcript_words` item. */
  transcript_words?: Rec[];
  /** `export --all` only: every `list_transcript_paragraphs` item. */
  transcript_paragraphs?: Rec[];
  /** `export --all` only: each session-scoped dashboard's `get_dashboard` result (with its tsx). */
  dashboards?: Rec[];
  /** `export --all` only: the `list_session_media` items (links and offsets; never media bytes). */
  media?: Rec[];
}

/** `export --all`: a show, its categories (`list_categories`) and the ids of its sessions. */
export interface SnapshotShow {
  show_id: string;
  /** The `list_shows` item. */
  show: Rec;
  /** The `list_categories` result for the show, when the source offers the tool. */
  categories?: Rec;
  session_ids: string[];
}

/** `export --all`: a studio (team) and its shows. */
export interface SnapshotStudio {
  studio_id: string;
  /** The `list_studios` item. */
  studio: Rec;
  shows: SnapshotShow[];
}

export interface Snapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: 1;
  source_server: string;
  exported_at: string;
  /** `export --all` only: every studio, show and session the source account could read. */
  studios?: SnapshotStudio[];
  sessions: SnapshotSession[];
}

/** The optional per-session parts `export --all` adds. */
export const EXTRA_PARTS = ['transcript_words', 'transcript_paragraphs', 'dashboards', 'media'] as const;

export interface CreatedItem {
  target_id: string;
  target_session_id: string;
  /** A wiki page's revision after the last write (update_wiki_page needs it). */
  revision?: number;
  /**
   * sha256 (hex) of the wiki body last sent. A later run updates the page when the body, rewritten
   * with what the target has by then, differs (a linked page created after it, even on a rerun).
   */
  body_sha256?: string;
  /** An event's timecode as last sent to the target (create_event or update_event). */
  timecode?: string;
}

export interface SkippedItem {
  target_session_id: string;
  reason: string;
}

export interface TargetState {
  /** `<kind>:<source id>` of every item created on the target. */
  created: Record<string, CreatedItem>;
  /** Items the target refused for good (a wiki title or session page it already has). */
  skipped: Record<string, SkippedItem>;
  /** `import --create`: the teams, shows, sessions, transcript words and dashboards it made. */
  structure?: Structure;
}

/** What `import --create` made on the target, by source id; saved after every write. */
export interface Structure {
  teams: Record<string, { target_id: string; reused: boolean }>;
  shows: Record<string, { target_id: string; target_team_id: string; categories_set?: boolean }>;
  sessions: Record<string, { target_id: string; target_show_id: string }>;
  /** Per source session: how many of its transcript words (in snapshot order) are on the target. */
  words: Record<string, { done: number; last_target_id?: string }>;
  dashboards: Record<string, { target_id: string; target_session_id: string }>;
}

export interface ImportState {
  format: typeof STATE_FORMAT;
  version: 1;
  source_server: string;
  targets: Record<string, TargetState>;
}

export function itemKey(kind: Kind, sourceId: string): string {
  return `${kind}:${sourceId}`;
}

/** The state file of a snapshot: next to it, `<snapshot>.import-state.json`. */
export function statePath(snapshotPath: string): string {
  return `${snapshotPath}.import-state.json`;
}

/**
 * Writes `value` as JSON, mode 0600, through a temporary file in the same directory: renamed over
 * `path` when `overwrite`, else hard-linked to it, which fails if `path` exists meanwhile.
 */
export function writeJsonFile(path: string, value: unknown, overwrite: boolean): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number;
  try {
    fd = openSync(tmp, 'wx', 0o600);
  } catch (error) {
    throw new CliError(`cannot write ${path}: ${messageOf(error)}`);
  }
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (overwrite) {
      renameSync(tmp, path);
      return;
    }
    linkSync(tmp, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new CliError(code === 'EEXIST' ? `${path} already exists; pass --force to overwrite it` : `cannot write ${path}: ${messageOf(error)}`);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // renamed
    }
  }
}

export function readJson(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new CliError(`cannot read ${what} ${path}: ${messageOf(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`${what} ${path} is not valid JSON`);
  }
}

const isRecArray = (value: unknown): value is Rec[] => Array.isArray(value) && value.every(isObject);

/** Reads and checks a snapshot file written by `export`. */
export function readSnapshot(path: string): Snapshot {
  const value = readJson(path, 'snapshot');
  const bad = (why: string): CliError => new CliError(`${path} is not an autologger-mcp snapshot (${why})`);
  if (!isObject(value) || value.format !== SNAPSHOT_FORMAT || value.version !== 1) throw bad('format');
  if (typeof value.source_server !== 'string' || !Array.isArray(value.sessions)) throw bad('source_server, sessions');
  for (const s of value.sessions) {
    if (!isObject(s) || typeof s.session_id !== 'string' || !isObject(s.session)) throw bad('session');
    for (const kind of KINDS) if (!isRecArray(s[kind])) throw bad(kind);
    for (const part of EXTRA_PARTS) if (s[part] !== undefined && !isRecArray(s[part])) throw bad(part);
  }
  if (value.studios !== undefined) {
    if (!Array.isArray(value.studios)) throw bad('studios');
    for (const st of value.studios) {
      if (!isObject(st) || typeof st.studio_id !== 'string' || !isObject(st.studio) || !Array.isArray(st.shows)) throw bad('studio');
      for (const sh of st.shows) {
        if (!isObject(sh) || typeof sh.show_id !== 'string' || !isObject(sh.show) || !Array.isArray(sh.session_ids)) throw bad('show');
        if (sh.categories !== undefined && !isObject(sh.categories)) throw bad('categories');
        if (!sh.session_ids.every((id) => typeof id === 'string')) throw bad('session_ids');
      }
    }
  }
  return value as unknown as Snapshot;
}

/** The state file, or a fresh state when there is none. */
export function readState(path: string, sourceServer: string): ImportState {
  if (!existsSync(path)) return { format: STATE_FORMAT, version: 1, source_server: sourceServer, targets: {} };
  const value = readJson(path, 'import state');
  if (!isObject(value) || value.format !== STATE_FORMAT || value.version !== 1 || !isObject(value.targets)) {
    throw new CliError(`${path} is not an autologger-mcp import state file; move it away to start over`);
  }
  if (value.source_server !== sourceServer) {
    throw new CliError(`${path} records an import from ${String(value.source_server)}, not from the snapshot's ${sourceServer}; move it away to start over`);
  }
  return value as unknown as ImportState;
}

/** Thrown when a rate limit stops the run (`--no-wait`, or the wait would be too long). */
export class RateLimitStop extends CliError {
  readonly retryS: number;
  constructor(message: string, retryS: number) {
    super(message);
    this.retryS = retryS;
  }
}

const RATE_LIMIT_RE = /Rate limit exceeded; retry in (\d+) s\./;
/** Waits on one call before giving up. */
export const MAX_RATE_LIMIT_WAITS = 5;
/** The longest wait (s): autologger's hour window. Longer answers stop the run instead. */
export const MAX_RATE_LIMIT_WAIT_S = 3600;

export function rateLimitSeconds(message: string): number | undefined {
  const m = RATE_LIMIT_RE.exec(message);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

export interface Caller {
  call: (name: string, args: Rec) => Promise<CallToolResult>;
  /** Waits `ms` (default: a timer). */
  sleep: (ms: number) => Promise<void>;
  /** Stop on a rate limit instead of waiting. */
  noWait: boolean;
  /** Reports a wait on stderr. */
  notice: (text: string) => void;
}

/**
 * Calls a tool, waiting out `Rate limit exceeded; retry in N s.` (at most MAX_RATE_LIMIT_WAITS
 * times, each at most MAX_RATE_LIMIT_WAIT_S) unless `noWait`. Answers the result, error or not; a
 * JSON-RPC error that is not a rate limit is thrown.
 */
export async function callWithRetry(caller: Caller, name: string, args: Rec): Promise<CallToolResult> {
  for (let waits = 0; ; waits++) {
    let result: CallToolResult;
    let message: string;
    try {
      result = await caller.call(name, args);
      if (result.isError !== true) return result;
      message = resultText(result);
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
      message = error.message;
      if (rateLimitSeconds(message) === undefined) throw error;
      result = { isError: true, content: [{ type: 'text', text: message }] };
    }
    const seconds = rateLimitSeconds(message);
    if (seconds === undefined) return result;
    if (caller.noWait) throw new RateLimitStop(`${name}: rate limited (retry in ${seconds} s)`, seconds);
    if (seconds > MAX_RATE_LIMIT_WAIT_S || waits >= MAX_RATE_LIMIT_WAITS) {
      throw new RateLimitStop(`${name}: still rate limited after ${waits} waits (retry in ${seconds} s)`, seconds);
    }
    caller.notice(`${name}: rate limited; waiting ${seconds} s before retrying\n`);
    await caller.sleep((seconds + 1) * 1000);
  }
}

/** A read tool's structured result, or a CliError with the tool's message. */
export async function readTool(caller: Caller, name: string, args: Rec): Promise<Rec> {
  const result = await callWithRetry(caller, name, args);
  if (result.isError === true) throw new CliError(`${name} failed: ${clip(resultText(result), 500)}`);
  if (!isObject(result.structuredContent)) throw new CliError(`${name} answered no structured content`);
  return result.structuredContent;
}

/** The property names a tool's `inputSchema` accepts, and whether it accepts any other key. */
export interface InputShape {
  properties: Set<string>;
  required: string[];
  open: boolean;
}

export function inputShape(tool: Tool | undefined): InputShape {
  const schema = isObject(tool?.inputSchema) ? tool.inputSchema : {};
  const properties = isObject(schema.properties) ? new Set(Object.keys(schema.properties)) : new Set<string>();
  const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [];
  return { properties, required, open: schema.additionalProperties === true };
}
