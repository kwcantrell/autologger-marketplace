// media fetch: downloads a YouTube-imported session's video with yt-dlp and maps it, with the offset
// autologger recorded for the take. The session's media list comes from autologger's MCP tool
// `list_session_media` (the agent calls it with autologger-mcp and saves the result to a file); this
// CLI never talks to autologger and downloads only the YouTube video that list names.
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { CliError, UsageError } from './errors.ts';
import { checkSessionId, homeOf, setMedia, type Env, type MediaEntry } from './media.ts';
import { probeVideo } from './probe.ts';
import type { Runner } from './runner.ts';

/** yt-dlp's format choice: the best MP4 video with M4A audio (merged into one .mp4, which needs ffmpeg), else the best single MP4. */
export const YTDLP_FORMAT = 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b';

/** The exact yt-dlp arguments for one video into `dir` (documented in the README). */
export function ytdlpArgs(url: string, dir: string): string[] {
  return [
    '--no-playlist',
    '--no-progress',
    '--restrict-filenames',
    '-f',
    YTDLP_FORMAT,
    '--merge-output-format',
    'mp4',
    '-P',
    dir,
    '-o',
    '%(id)s.%(ext)s',
    '--print',
    'after_move:filepath',
    '--',
    url,
  ];
}

export const YTDLP_INSTALL_HINT =
  'yt-dlp is not on PATH; install it (https://github.com/yt-dlp/yt-dlp#installation, for example `pipx install yt-dlp`, `brew install yt-dlp` or your package manager), and ffmpeg so it can merge video and audio, then run media fetch again';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export interface MediaItem {
  ordinal?: number;
  recording_ordinal?: number;
  kind: string;
  url?: string | null;
  video_id?: string | null;
  file_name?: string | null;
  duration_s?: number | null;
  take_start_s?: number | null;
  take_stop_s?: number | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The items of a `list_session_media` answer, in any of the shapes the agent may have saved: the
 * item array, `{items: [...]}` (the tool's structured content), or the whole MCP tool result
 * (`structuredContent`, or JSON text in `content[0].text`) as `autologger-mcp call --json` prints it.
 */
export function mediaItems(data: unknown, sessionId: string, depth = 0): MediaItem[] {
  if (depth > 4) throw new CliError('the media JSON is nested too deeply');
  if (Array.isArray(data)) {
    return data.map((item, i) => {
      if (!isObject(item) || typeof item.kind !== 'string') throw new CliError(`media item ${i + 1} has no kind`);
      return item as unknown as MediaItem;
    });
  }
  if (!isObject(data)) throw new CliError('the media JSON is not a list_session_media result');
  if (typeof data.session_id === 'string' && data.session_id !== sessionId) {
    throw new CliError(`the media JSON is for session ${data.session_id}, not ${sessionId}`);
  }
  for (const key of ['items', 'media']) if (Array.isArray(data[key])) return mediaItems(data[key], sessionId, depth + 1);
  if (data.structuredContent !== undefined) return mediaItems(data.structuredContent, sessionId, depth + 1);
  if (Array.isArray(data.content)) {
    const text = data.content.find((c): c is { type: string; text: string } => isObject(c) && c.type === 'text' && typeof c.text === 'string');
    if (text) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text.text);
      } catch {
        throw new CliError('the media JSON is a tool result whose text is not JSON');
      }
      return mediaItems(parsed, sessionId, depth + 1);
    }
  }
  throw new CliError('the media JSON is not a list_session_media result (expected its items, or the tool result)');
}

/** Picks the YouTube item to download: the only one, or the one with --ordinal. */
export function pickYoutube(items: readonly MediaItem[], ordinal: number | undefined): MediaItem & { video_id: string; take_start_s: number } {
  const youtube = items.filter((i) => i.kind === 'youtube');
  let item: MediaItem | undefined;
  if (ordinal !== undefined) {
    item = items.find((i) => i.ordinal === ordinal);
    if (!item) throw new CliError(`the session has no media item with ordinal ${ordinal} (it has ${items.map((i) => i.ordinal).join(', ') || 'none'})`);
    if (item.kind !== 'youtube') throw new CliError(`media item ${ordinal} is ${item.kind}, not youtube; map a local file with media set instead`);
  } else if (youtube.length === 1) {
    item = youtube[0];
  } else if (youtube.length === 0) {
    const kinds = [...new Set(items.map((i) => i.kind))].join(', ') || 'no media';
    throw new CliError(`the session has no YouTube media (it has ${kinds}); map a local video file with media set instead`);
  } else {
    throw new CliError(`the session has ${youtube.length} YouTube takes (ordinals ${youtube.map((i) => i.ordinal).join(', ')}); pick one with --ordinal <n>`);
  }
  const id = item?.video_id ?? undefined;
  if (typeof id !== 'string' || !VIDEO_ID.test(id)) throw new CliError(`media item ${item?.ordinal ?? ''} has no valid YouTube video id`);
  if (item?.url !== undefined && item.url !== null) {
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      throw new CliError(`media item ${item.ordinal ?? ''} has a URL that is not one: ${item.url}`);
    }
    const host = url.hostname.replace(/^(www|m)\./, '');
    const urlId = host === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v');
    if (!['youtube.com', 'youtu.be'].includes(host) || urlId !== id) {
      throw new CliError(`media item ${item.ordinal ?? ''} URL ${item.url} is not the YouTube video ${id}`);
    }
  }
  const take = item?.take_start_s;
  if (typeof take !== 'number' || !Number.isFinite(take)) {
    throw new CliError(`media item ${item?.ordinal ?? ''} has no take_start_s, so the video's place in the session is unknown; download it yourself and map it with media set --offset <s>`);
  }
  return { ...(item as MediaItem), video_id: id, take_start_s: take };
}

export const defaultDownloadDir = (env: Env, sessionId: string): string => join(homeOf(env), 'Documents', 'autologger-clips', sessionId);

export interface FetchOptions {
  mediaJson: string;
  dir?: string;
  ordinal?: number;
  cwd: string;
  env: Env;
  runner: Runner;
  /** yt-dlp's progress and messages (stderr). */
  log: (text: string) => void;
}

export interface FetchResult {
  session_id: string;
  url: string;
  video_id: string;
  path: string;
  dir: string;
  offset_s: number;
  entry: MediaEntry;
  replaced: boolean;
  map_file: string;
  ytdlp_args: string[];
}

export async function fetchMedia(sessionId: string, options: FetchOptions): Promise<FetchResult> {
  checkSessionId(sessionId);
  const jsonPath = resolve(options.cwd, options.mediaJson);
  if (!existsSync(jsonPath)) throw new UsageError(`--media-json file ${jsonPath} does not exist`);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (error) {
    throw new CliError(`--media-json ${jsonPath} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const item = pickYoutube(mediaItems(data, sessionId), options.ordinal);
  const url = `https://www.youtube.com/watch?v=${item.video_id}`;
  const dir = options.dir !== undefined ? resolve(options.cwd, options.dir) : defaultDownloadDir(options.env, sessionId);

  const version = await options.runner('yt-dlp', ['--version'], { env: options.env, timeoutMs: 30_000 });
  if (version.error === 'ENOENT') throw new CliError(YTDLP_INSTALL_HINT);
  if (version.code !== 0) throw new CliError(`yt-dlp --version failed (${version.error ?? `exit ${version.code}`}): ${version.stderr.trim()}`);

  mkdirSync(dir, { recursive: true });
  const args = ytdlpArgs(url, dir);
  const result = await options.runner('yt-dlp', args, { env: options.env, onStderr: options.log });
  if (result.error === 'ENOENT') throw new CliError(YTDLP_INSTALL_HINT);
  if (result.code !== 0) throw new CliError(`yt-dlp failed (${result.error ?? `exit ${result.code}`}) downloading ${url}; its messages are above`);
  const printed = result.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '').pop();
  if (printed === undefined) throw new CliError('yt-dlp did not print the downloaded file path');
  const path = resolve(dir, printed);
  const rel = relative(dir, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new CliError(`yt-dlp wrote ${path}, outside ${dir}`);
  if (!existsSync(path) || !statSync(path).isFile()) throw new CliError(`yt-dlp reported ${path}, which does not exist`);

  const probe = probeVideo(path);
  const duration = probe === undefined && typeof item.duration_s === 'number' && item.duration_s > 0 ? item.duration_s : undefined;
  const set = setMedia(options.env, sessionId, path, {
    cwd: options.cwd,
    offset_s: item.take_start_s,
    ...(duration !== undefined ? { duration_s: duration } : {}),
    source: { kind: 'youtube', url, video_id: item.video_id, ...(typeof item.ordinal === 'number' ? { ordinal: item.ordinal } : {}) },
  });
  return { session_id: sessionId, url, video_id: item.video_id, path, dir, offset_s: item.take_start_s, entry: set.entry, replaced: set.replaced, map_file: set.map_file, ytdlp_args: args };
}
