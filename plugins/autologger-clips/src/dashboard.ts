// dashboard: clip list + the sessions' list_session_media results -> an autologger custom dashboard
// (TSX) with the YouTube video embedded through `YouTubePlayer` and a list of the clips, each of which
// sets the player's range when picked. The ranges are planned exactly as `timeline` plans them
// (padding, merging, session time -> video time with the take's offset, clamping to the video).
//
// The CLI never talks to autologger: it writes the .tsx file (and, with --save-args, the
// save_dashboard arguments as JSON); publishing goes through autologger-mcp's `call save_dashboard`.
//
// Safety: everything that comes from session data (labels, titles, ids) is put in ONE constant as
// JSON (JSON.stringify, with <, >, &, U+2028 and U+2029 escaped), never into JSX or code. The rest of
// the file is a fixed template, so the code a dashboard runs does not depend on the data.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { buildPlan, cleanText, parseClipList, type ClipInput, type Plan, type PlanClip } from './clips.ts';
import { CliError, UsageError } from './errors.ts';
import { mediaItems, pickYoutube, VIDEO_ID } from './fetch.ts';
import { SESSION_ID, type MediaEntry } from './media.ts';
import { DEFAULT_RATE } from './timecode.ts';

/** autologger's save-time limit on a dashboard's source (custom-dashboards "Save-time validation"). */
export const MAX_TSX_CHARS = 100_000;
/** The parent draws at most this many YouTube players at once per mount ("YouTube player"). */
export const MAX_PLAYERS = 8;
/** `start` and `end` of a YouTubePlayer are at most this many seconds ("YouTube player"). */
export const MAX_PLAYER_S = 86_400;
/** A dashboard title: 1-200 characters, no control characters ("Dashboard tools"). */
export const MAX_TITLE = 200;

/** The imports of the generated dashboard; every one is in autologger's DASHBOARD_IMPORT_ALLOWLIST. */
export const DASHBOARD_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  react: ['useState'],
  '@autologger/dashboard': ['YouTubePlayer', 'formatDuration', 'formatTimecode'],
  '@/components/ui/button': ['Button'],
  '@/components/ui/card': ['Card', 'CardContent', 'CardDescription', 'CardHeader', 'CardTitle'],
};

export interface DashboardOptions {
  clips: string;
  /** --media-json values: `<file>` (one session) or `<session_id>=<file>`. */
  mediaJson: readonly string[];
  out: string;
  title?: string;
  pad: number;
  order: 'list' | 'date';
  compilation: boolean;
  ordinal?: number;
  /** Where to write the save_dashboard arguments (title, tsx, session scope). */
  saveArgs?: string;
  /** The session the dashboard is saved on (scope). */
  session?: string;
  cwd: string;
}

export interface DashboardClip {
  position: number;
  /** 1-based clip list entries merged into this clip. */
  from: number[];
  session_id: string;
  label: string;
  session_start_s: number;
  session_end_s: number;
  /** The player's range: video time = session time - take_start_s. */
  video_start_s: number;
  video_end_s: number;
  length_s: number;
}

export interface DashboardPlayer {
  video_id: string;
  url: string;
  title: string;
  session_ids: string[];
  clips: DashboardClip[];
}

export interface DashboardReport {
  out: string;
  title: string;
  tsx_chars: number;
  players: DashboardPlayer[];
  merged: Plan['merged'];
  clamped: Plan['clamped'];
  dropped: Plan['dropped'];
  warnings: string[];
  /** The session scope of save_dashboard, when known (one session, or --session). */
  session_id: string | null;
  save_args: string | null;
}

interface SessionVideo {
  video_id: string;
  take_start_s: number;
  duration_s: number | null;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function readJson(path: string, flag: string): unknown {
  if (!existsSync(path)) throw new UsageError(`${flag} file ${path} does not exist`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CliError(`${flag} ${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** Pairs each --media-json value with a session of the clip list. */
export function mediaFiles(values: readonly string[], sessions: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const value of values) {
    const eq = value.indexOf('=');
    const prefix = eq > 0 ? value.slice(0, eq) : '';
    let session: string;
    let file: string;
    if (prefix !== '' && SESSION_ID.test(prefix)) {
      session = prefix;
      file = value.slice(eq + 1);
      if (file === '') throw new UsageError(`--media-json ${value} names no file`);
      if (!sessions.includes(session)) throw new UsageError(`--media-json ${value}: session ${session} is not in the clip list`);
    } else {
      if (sessions.length !== 1) throw new UsageError(`the clips come from ${sessions.length} sessions; give --media-json <session_id>=<file> for each (${sessions.join(', ')})`);
      session = sessions[0] as string;
      file = value;
    }
    if (files.has(session)) throw new UsageError(`--media-json is given twice for session ${session}`);
    files.set(session, file);
  }
  const missing = sessions.filter((s) => !files.has(s));
  if (missing.length > 0) {
    throw new UsageError(`no --media-json for session${missing.length > 1 ? 's' : ''} ${missing.join(', ')} (save autologger-mcp's list_session_media result for each and pass --media-json <session_id>=<file>)`);
  }
  return files;
}

/** The session's YouTube video and take offset, from its list_session_media result. */
export function sessionVideo(data: unknown, sessionId: string, ordinal: number | undefined): SessionVideo {
  const items = mediaItems(data, sessionId);
  if (ordinal === undefined) {
    const youtube = items.filter((i) => i.kind === 'youtube');
    if (youtube.length === 0) {
      const kinds = [...new Set(items.map((i) => i.kind))].join(', ') || 'no media';
      throw new CliError(`session ${sessionId} has no YouTube media (it has ${kinds}); a dashboard can only embed a YouTube video`);
    }
  }
  let item;
  try {
    item = pickYoutube(items, ordinal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`session ${sessionId}: ${message.replace(/; map a local file with media set instead$/, '; a dashboard can only embed a YouTube video')}`);
  }
  if (!VIDEO_ID.test(item.video_id)) throw new CliError(`session ${sessionId}: '${item.video_id}' is not a YouTube video id`);
  const duration = typeof item.duration_s === 'number' && Number.isFinite(item.duration_s) && item.duration_s > 0 ? item.duration_s : null;
  return { video_id: item.video_id, take_start_s: item.take_start_s, duration_s: duration };
}

/** JSON as a JS expression, with the characters that could end or confuse a surrounding context escaped. */
export function jsonLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** The data the dashboard renders, all of it from the plan; this goes into the file only as JSON. */
export interface DashboardData {
  title: string;
  players: { key: string; video_id: string; title: string; clips: { label: string; session_start: number; start: number; end: number; length: number }[] }[];
}

const IMPORT_LINES = Object.entries(DASHBOARD_IMPORTS)
  .map(([from, names]) => `import { ${names.join(', ')} } from '${from}';`)
  .join('\n');

/** The fixed code of the dashboard; `__DATA__` is replaced with the JSON literal. */
export const TEMPLATE = `// Made by autologger-clips: YouTube clips of autologger moments. Picking a clip plays its range.
// Everything that comes from session data is in DATA below, as JSON; the code does not depend on it.
${IMPORT_LINES}

const DATA = __DATA__;

export default function ClipsDashboard() {
  const [picked, setPicked] = useState(() => DATA.players.map(() => ({ index: 0, play: false })));
  const pick = (p, index) => setPicked((prev) => prev.map((s, i) => (i === p ? { index, play: true } : s)));
  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">{DATA.title}</h1>
      {DATA.players.map((player, p) => {
        const state = picked[p] ?? { index: 0, play: false };
        const current = player.clips[state.index] ?? player.clips[0];
        return (
          <Card key={player.key}>
            <CardHeader>
              <CardTitle>{player.title}</CardTitle>
              <CardDescription>
                {player.clips.length === 1 ? '1 clip' : player.clips.length + ' clips'}: {current.label}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <YouTubePlayer videoId={player.video_id} start={current.start} end={current.end} title={current.label} autoplay={state.play} />
              <ul aria-label={'Clips of ' + player.title} className="flex flex-col gap-1">
                {player.clips.map((clip, c) => (
                  <li key={c}>
                    <Button
                      variant={c === state.index ? 'default' : 'outline'}
                      aria-pressed={c === state.index}
                      className="h-auto w-full justify-between gap-3 text-left"
                      onClick={() => pick(p, c)}
                    >
                      <span className="truncate">{clip.label}</span>
                      <span className="shrink-0 tabular-nums">
                        {formatTimecode(clip.session_start)} ({formatDuration(clip.length)})
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
`;

export function renderTsx(data: DashboardData): string {
  // A function replacement, so `$&`, `$'` and the like in the data are not replacement patterns.
  return TEMPLATE.replace('__DATA__', () => jsonLiteral(data));
}

const formatClock = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h > 0 ? `${h}:${String(m).padStart(2, '0')}` : String(m)}:${String(s % 60).padStart(2, '0')}`;
};

/** Players, in plan order: one per YouTube video. */
function playersOf(plan: Plan, clips: readonly ClipInput[], videos: ReadonlyMap<string, SessionVideo>): DashboardPlayer[] {
  const players = new Map<string, DashboardPlayer>();
  let position = 0;
  for (const item of plan.items) {
    if (item.kind !== 'clip') continue;
    const clip = item as PlanClip;
    position += 1;
    const video = videos.get(clip.session_id) as SessionVideo;
    if (clip.video_out_s > MAX_PLAYER_S) {
      throw new CliError(`clip ${clip.from.join(', ')} (session ${clip.session_id}) ends at video time ${clip.video_out_s} s, past the ${MAX_PLAYER_S} s the YouTube player accepts`);
    }
    let player = players.get(video.video_id);
    if (player === undefined) {
      const sessionTitle = clips.find((c) => c.session_id === clip.session_id && c.session_title !== undefined)?.session_title;
      player = { video_id: video.video_id, url: `https://www.youtube.com/watch?v=${video.video_id}`, title: sessionTitle ?? `YouTube video ${video.video_id}`, session_ids: [], clips: [] };
      players.set(video.video_id, player);
    }
    if (!player.session_ids.includes(clip.session_id)) player.session_ids.push(clip.session_id);
    const label = clip.name.startsWith(`${clip.session_id} `) ? `Clip at ${formatClock(clip.session_start_s)}` : clip.name;
    player.clips.push({
      position,
      from: clip.from,
      session_id: clip.session_id,
      label: cleanText(label),
      session_start_s: clip.session_start_s,
      session_end_s: clip.session_end_s,
      video_start_s: round3(clip.video_in_s),
      video_end_s: round3(clip.video_out_s),
      length_s: round3(clip.video_out_s - clip.video_in_s),
    });
  }
  return [...players.values()];
}

/** buildPlan, with its media-map advice replaced by what applies to a dashboard. */
function planOrExplain(plan: () => Plan): Plan {
  try {
    return plan();
  } catch (error) {
    if (error instanceof CliError && error.message.startsWith('no clip is left')) {
      throw new CliError("no clip is left: every range falls outside its session's YouTube video (video time = session time - take_start_s); check the clip list's session times");
    }
    throw error;
  }
}

/**
 * A file this command may write: refused (usage error, before anything is written) when it is a
 * symlink or exists as something other than a regular file. The command is pre-approved, so it
 * must not be able to write through a link or onto a device, directory or FIFO.
 */
function writableTarget(cwd: string, path: string, option: string): string {
  const full = resolve(cwd, path);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return full;
  }
  if (stat.isSymbolicLink()) throw new UsageError(`${option} ${full} is a symbolic link; give a plain file path`);
  if (!stat.isFile()) throw new UsageError(`${option} ${full} exists and is not a regular file`);
  return full;
}

export function buildDashboard(options: DashboardOptions): DashboardReport {
  // Every check on the output paths comes before any write: a usage error writes nothing.
  if (extname(options.out).toLowerCase() !== '.tsx') throw new UsageError(`--out must end in .tsx, got '${options.out}'`);
  if (options.saveArgs !== undefined && extname(options.saveArgs).toLowerCase() !== '.json') {
    throw new UsageError(`--save-args must end in .json, got '${options.saveArgs}'`);
  }
  const out = writableTarget(options.cwd, options.out, '--out');
  const saveArgs = options.saveArgs !== undefined ? writableTarget(options.cwd, options.saveArgs, '--save-args') : null;
  const clipsPath = resolve(options.cwd, options.clips);
  if (!existsSync(clipsPath)) throw new UsageError(`--clips file ${clipsPath} does not exist`);
  const clips = parseClipList(readFileSync(clipsPath, 'utf8'), basename(clipsPath));
  const sessions = [...new Set(clips.map((c) => c.session_id))];
  if (options.ordinal !== undefined && sessions.length !== 1) throw new UsageError('--ordinal picks a take of one session; the clips come from several');
  if (options.session !== undefined && !sessions.includes(options.session)) throw new UsageError(`--session ${options.session} is not a session of the clip list`);
  if (options.session !== undefined && options.saveArgs === undefined) throw new UsageError('--session is the save_dashboard scope; it needs --save-args <file.json>');
  const files = mediaFiles(options.mediaJson, sessions);

  const videos = new Map<string, SessionVideo>();
  for (const s of sessions) videos.set(s, sessionVideo(readJson(resolve(options.cwd, files.get(s) as string), '--media-json'), s, options.ordinal));
  const distinct = [...new Set([...videos.values()].map((v) => v.video_id))];
  if (distinct.length > 1 && !options.compilation) {
    throw new CliError(`the clips come from ${distinct.length} different YouTube videos (sessions ${sessions.join(', ')}); pass --compilation for one player per video, or split the clip list`);
  }

  // Plan as timeline does: the take's offset, the media's duration for clamping, no title cards.
  const entries: Record<string, MediaEntry> = {};
  for (const [s, v] of videos) {
    entries[s] = { session_id: s, path: `youtube-${v.video_id}`, offset_s: v.take_start_s, ...(v.duration_s !== null ? { duration_s: v.duration_s } : {}), updated_at: '' };
  }
  const plan = planOrExplain(() => buildPlan(clips, entries, { rate: DEFAULT_RATE, pad: options.pad, order: options.order, titleCards: false, titleSeconds: 1, probe: () => undefined }));
  const warnings = [...videos].filter(([, v]) => v.duration_s === null).map(([s, v]) => `the length of session ${s}'s video ${v.video_id} is unknown (list_session_media gave no duration_s); ranges are not clamped at its end`);
  const players = playersOf(plan, clips, videos);
  if (players.length > MAX_PLAYERS) {
    throw new CliError(`the clips come from ${players.length} YouTube videos; autologger shows at most ${MAX_PLAYERS} players in one dashboard, so split the clip list into dashboards of at most ${MAX_PLAYERS} videos`);
  }

  const singleTitle = players.length === 1 && players[0]?.session_ids.length === 1 ? clips.find((c) => c.session_title !== undefined)?.session_title : undefined;
  const fallback = options.compilation ? 'Clip compilation' : singleTitle !== undefined ? `Clips: ${singleTitle}` : 'Clips';
  const title = cleanText(options.title ?? fallback, MAX_TITLE) || cleanText(fallback, MAX_TITLE);

  const data: DashboardData = {
    title,
    players: players.map((p, i) => ({
      key: `${p.video_id}-${i}`,
      video_id: p.video_id,
      title: p.title,
      clips: p.clips.map((c) => ({ label: c.label, session_start: c.session_start_s, start: c.video_start_s, end: c.video_end_s, length: c.length_s })),
    })),
  };
  const tsx = renderTsx(data);
  if (tsx.length > MAX_TSX_CHARS) {
    throw new CliError(`the dashboard is ${tsx.length} characters, over autologger's ${MAX_TSX_CHARS}; split the clip list or shorten the labels`);
  }

  const scope = options.session ?? (sessions.length === 1 ? (sessions[0] as string) : null);
  if (options.saveArgs !== undefined && scope === null) {
    throw new UsageError(`the clips come from ${sessions.length} sessions; name the one to save the dashboard on with --session <session_id>`);
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, tsx);
  if (saveArgs !== null) {
    mkdirSync(dirname(saveArgs), { recursive: true });
    writeFileSync(saveArgs, `${JSON.stringify({ title, tsx, scope: { kind: 'session', session_id: scope } }, null, 2)}\n`);
  }
  return { out, title, tsx_chars: tsx.length, players, merged: plan.merged, clamped: plan.clamped, dropped: plan.dropped, warnings, session_id: scope, save_args: saveArgs };
}

export function dashboardSummary(report: DashboardReport): string {
  const count = report.players.reduce((n, p) => n + p.clips.length, 0);
  const lines = [`Wrote ${report.out} ("${report.title}", ${report.players.length} player${report.players.length === 1 ? '' : 's'}, ${count} clip${count === 1 ? '' : 's'}, ${report.tsx_chars} characters).`];
  for (const p of report.players) {
    lines.push(`  ${p.url}  ${p.title}`);
    for (const c of p.clips) lines.push(`    ${c.video_start_s}-${c.video_end_s} s  ${c.label}`);
  }
  for (const m of report.merged) lines.push(`merged clips ${m.from.join(', ')} (session ${m.session_id})`);
  for (const c of report.clamped) lines.push(`clamped clip ${c.from.join(', ')} (session ${c.session_id}) to video ${c.kept_video_s[0]}-${c.kept_video_s[1]} s`);
  for (const d of report.dropped) lines.push(`dropped clip ${d.from.join(', ')} (session ${d.session_id}): ${d.reason}`);
  for (const w of report.warnings) lines.push(`warning: ${w}`);
  if (report.save_args !== null) lines.push(`save_dashboard arguments (session ${report.session_id}): ${report.save_args}`);
  return `${lines.join('\n')}\n`;
}
