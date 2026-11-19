// The media map: which video file plays each autologger session, and the session time at which the
// video's second 0 plays (the offset). One JSON file per user, mode 0600, in the config dir.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { CliError, UsageError } from './errors.ts';
import { probeVideo } from './probe.ts';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
export const MAP_FILE = 'media.json';

export interface MediaSource {
  kind: 'youtube';
  url: string;
  video_id: string;
  /** The `list_session_media` item's ordinal (one audio segment of the session). */
  ordinal?: number;
}

export interface MediaEntry {
  session_id: string;
  /** Absolute path of the video file. */
  path: string;
  /** Session time (seconds) at which the video's second 0 plays: video time = session time - offset_s. */
  offset_s: number;
  /** Length of the video in seconds, when given with --duration (else read from the file). */
  duration_s?: number;
  source?: MediaSource;
  updated_at: string;
}

export interface MediaMap {
  version: 1;
  sessions: Record<string, MediaEntry>;
}

export type Env = Readonly<Record<string, string | undefined>>;

export const homeOf = (env: Env): string => (env.HOME !== undefined && env.HOME !== '' ? env.HOME : homedir());

/** `$AUTOLOGGER_CLIPS_CONFIG_DIR`, else `$XDG_CONFIG_HOME/autologger-clips`, else `~/.config/autologger-clips`. */
export function configDir(env: Env): string {
  const override = env.AUTOLOGGER_CLIPS_CONFIG_DIR;
  if (override !== undefined && override !== '') return override;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== '' && isAbsolute(xdg)) return join(xdg, 'autologger-clips');
  return join(homeOf(env), '.config', 'autologger-clips');
}

/** Session ids are used in folder names, so only plain id characters are accepted. */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function checkSessionId(id: string, what = 'session id'): string {
  if (!SESSION_ID.test(id)) throw new UsageError(`${what} '${id}' is not a session id (letters, digits, '_' and '-', at most 128)`);
  return id;
}

export function loadMap(env: Env): MediaMap {
  const file = join(configDir(env), MAP_FILE);
  if (!existsSync(file)) return { version: 1, sessions: {} };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CliError(`the media map ${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix or remove it`);
  }
  if (typeof data !== 'object' || data === null || typeof (data as MediaMap).sessions !== 'object' || (data as MediaMap).sessions === null) {
    throw new CliError(`the media map ${file} is not a media map; fix or remove it`);
  }
  return data as MediaMap;
}

export function saveMap(env: Env, map: MediaMap): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const file = join(dir, MAP_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: FILE_MODE });
  chmodSync(tmp, FILE_MODE);
  renameSync(tmp, file);
  return file;
}

export function parseSeconds(value: string, flag: string, { min }: { min?: number } = {}): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) throw new UsageError(`${flag} must be a number of seconds, got '${value}'`);
  if (min !== undefined && n < min) throw new UsageError(`${flag} must be at least ${min}, got '${value}'`);
  return n;
}

export interface SetOptions {
  offset_s?: number;
  duration_s?: number;
  source?: MediaSource;
  cwd: string;
  now?: Date;
}

/** Maps a session to a video file (which must exist), replacing any earlier entry. */
export function setMedia(env: Env, sessionId: string, file: string, options: SetOptions): { entry: MediaEntry; replaced: boolean; map_file: string; probe: ReturnType<typeof probeVideo> | null } {
  checkSessionId(sessionId);
  const path = resolve(options.cwd, file);
  if (!existsSync(path) || !statSync(path).isFile()) throw new CliError(`video file ${path} does not exist`);
  const map = loadMap(env);
  const replaced = map.sessions[sessionId] !== undefined;
  const entry: MediaEntry = {
    session_id: sessionId,
    path,
    offset_s: options.offset_s ?? 0,
    ...(options.duration_s !== undefined ? { duration_s: options.duration_s } : {}),
    ...(options.source !== undefined ? { source: options.source } : {}),
    updated_at: (options.now ?? new Date()).toISOString(),
  };
  map.sessions[sessionId] = entry;
  const mapFile = saveMap(env, map);
  return { entry, replaced, map_file: mapFile, probe: probeVideo(path) ?? null };
}

export function removeMedia(env: Env, sessionId: string): { removed: boolean; entry: MediaEntry | null; map_file: string } {
  checkSessionId(sessionId);
  const map = loadMap(env);
  const entry = map.sessions[sessionId] ?? null;
  if (entry) delete map.sessions[sessionId];
  const mapFile = entry ? saveMap(env, map) : join(configDir(env), MAP_FILE);
  return { removed: entry !== null, entry, map_file: mapFile };
}

export interface ListedEntry extends MediaEntry {
  exists: boolean;
}

export function listMedia(env: Env): { map_file: string; sessions: ListedEntry[] } {
  const map = loadMap(env);
  const sessions = Object.values(map.sessions)
    .sort((a, b) => a.session_id.localeCompare(b.session_id))
    .map((e) => ({ ...e, exists: existsSync(e.path) }));
  return { map_file: join(configDir(env), MAP_FILE), sessions };
}
