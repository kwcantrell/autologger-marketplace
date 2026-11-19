import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { buildTimeline, summary } from './build.ts';
import { buildDashboard, dashboardSummary } from './dashboard.ts';
import { desktopDoctor } from './desktop.ts';
import { editorStatus, OPENREEL_COMMIT, startEditor, stopEditor } from './editor.ts';
import { CliError, messageOf, UsageError } from './errors.ts';
import { fetchMedia } from './fetch.ts';
import { listMedia, parseSeconds, removeMedia, setMedia, type Env } from './media.ts';
import { spawnRunner, type Runner } from './runner.ts';
import { parseRate } from './timecode.ts';

export const CLI_NAME = 'autologger-clips';

/** Exit codes shared by every plugin CLI in this marketplace. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Defaults: process.env, process.cwd(), the real runner. Tests pass their own. */
  env?: Env;
  cwd?: string;
  runner?: Runner;
  /** How long `editor start` waits for the dev server to answer (ms). */
  readyTimeoutMs?: number;
}

export const USAGE = `Usage: ${CLI_NAME} <command> [options]

Cuts autologger session moments into OpenReel timelines. Session times come from autologger
(autologger-mcp's moments, events, transcripts, topics); a video's time is session time minus the
offset mapped for its session (the session time at which the video's second 0 plays).

Commands:
  timeline --clips <file.json> --out <file.fcpxml|file.otio> [--fps <rate>] [--pad <s>] [--title <name>]
      Write a timeline: one clip per range in list order (overlapping or adjacent ranges of one
      session merged, after --pad), clamped to each video's length.
  compile --clips <file.json> --out <file.fcpxml|file.otio> [--order date|list] [--title-cards]
          [--title-seconds <s>] [--fps <rate>] [--pad <s>] [--title <name>]
      A compilation across sessions, ordered by session date then time (default) or list order,
      optionally with a title card naming each session before its clips.
  dashboard --clips <file.json> --media-json <file> --out <file.tsx> [--title <t>] [--pad <s>]
            [--compilation] [--order list|date] [--ordinal <n>] [--save-args <file.json> [--session <id>]]
      Write an autologger custom dashboard (TSX) that embeds the sessions' YouTube video with
      YouTubePlayer and lists the clips (label, session time, length); picking one plays its range
      (video time = session time - the take's take_start_s, padded and merged as timeline does).
      --media-json is the session's list_session_media result; for clips of several sessions give
      --media-json <session_id>=<file> for each. Clips of different videos need --compilation (one
      player per video, at most 8, in compile order: by session date unless --order list).
      --save-args also writes save_dashboard's arguments {title, tsx, scope} for autologger-mcp's
      call save_dashboard --args-file (scope: the clips' session, or --session). Writes local files
      only; it never calls autologger.
  media set <session_id> <video file> [--offset <s>] [--duration <s>]
      Map a session to a local video file (--offset: session time of the video's second 0).
  media list                      The media map, with whether each file exists.
  media remove <session_id>       Remove a session from the media map.
  media fetch <session_id> --media-json <file> [--dir <dir>] [--ordinal <n>]
      Download a YouTube-imported session's video with yt-dlp (from autologger's
      list_session_media result saved in <file>) into ~/Documents/autologger-clips/<session_id>/
      or --dir, and map it with the take's offset.
  editor start [--ref <commit|tag>] [--port <n>]
      Clone OpenReel (pinned ${OPENREEL_COMMIT.slice(0, 7)}) into ~/.autologger-clips/openreel/<sha>/
      once, pnpm install, and run pnpm dev in the background on 127.0.0.1:5173 (or the next free port).
  editor status                   Whether the editor this CLI started is running and answers.
  editor stop                     Stop the editor this CLI started (only that process).
  desktop doctor                  Whether OpenReel Desktop's MCP server is registered in Claude Code.

Rates for --fps: 23.976, 24, 25, 29.97 (drop-frame), 29.97ndf, 30, 50, 59.94 (drop-frame),
59.94ndf, 60. Default: the first clip's video rate when it can be read, else 30.

The media map lives in $AUTOLOGGER_CLIPS_CONFIG_DIR, else $XDG_CONFIG_HOME/autologger-clips, else
~/.config/autologger-clips (media.json, mode 0600).

Options:
  --json         Print machine-readable JSON on stdout
  -h, --help     Show this help
  --version      Print the CLI version

Exit codes: 0 success, 1 command failed, 2 usage error (message on stderr).
`;

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'unknown';
}

const OPTIONS = {
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', default: false },
  clips: { type: 'string' },
  out: { type: 'string' },
  fps: { type: 'string' },
  pad: { type: 'string' },
  title: { type: 'string' },
  order: { type: 'string' },
  'title-cards': { type: 'boolean', default: false },
  'title-seconds': { type: 'string' },
  offset: { type: 'string' },
  duration: { type: 'string' },
  'media-json': { type: 'string', multiple: true },
  compilation: { type: 'boolean', default: false },
  'save-args': { type: 'string' },
  session: { type: 'string' },
  dir: { type: 'string' },
  ordinal: { type: 'string' },
  ref: { type: 'string' },
  port: { type: 'string' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

/** Options each command accepts (besides --json/--help/--version). */
const ALLOWED: Record<string, readonly (keyof typeof OPTIONS)[]> = {
  timeline: ['clips', 'out', 'fps', 'pad', 'title'],
  compile: ['clips', 'out', 'fps', 'pad', 'title', 'order', 'title-cards', 'title-seconds'],
  dashboard: ['clips', 'media-json', 'out', 'title', 'pad', 'compilation', 'order', 'ordinal', 'save-args', 'session'],
  'media set': ['offset', 'duration'],
  'media list': [],
  'media remove': [],
  'media fetch': ['media-json', 'dir', 'ordinal'],
  'editor start': ['ref', 'port'],
  'editor status': [],
  'editor stop': [],
  'desktop doctor': [],
};

function checkOptions(command: string, values: Values): void {
  const allowed = new Set<string>(['json', 'help', 'version', ...(ALLOWED[command] ?? [])]);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === false) continue;
    if (!allowed.has(key)) throw new UsageError(`${command} does not take --${key}`);
  }
}

function positionals(command: string, rest: string[], count: number, names: string): string[] {
  if (rest.length !== count) throw new UsageError(`${command} takes ${count === 0 ? 'no arguments' : names}, got ${rest.length === 0 ? 'none' : rest.map((r) => `'${r}'`).join(' ')}`);
  return rest;
}

function intOption(value: string | undefined, flag: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`${flag} must be a whole number from ${min} to ${max}, got '${value}'`);
  return n;
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: OPTIONS });
  } catch (error) {
    return usageError(io, messageOf(error));
  }
  const { values, positionals: words } = parsed;
  if (values.help) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  if (values.version) {
    io.stdout(`${version()}\n`);
    return EXIT.ok;
  }
  const env: Env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const runner = io.runner ?? spawnRunner;
  const print = (json: unknown, text: string): number => {
    io.stdout(values.json ? `${JSON.stringify(json)}\n` : text.endsWith('\n') ? text : `${text}\n`);
    return EXIT.ok;
  };

  const [group, ...rest] = words;
  try {
    switch (group) {
      case 'timeline':
      case 'compile': {
        checkOptions(group, values);
        positionals(group, rest, 0, '');
        if (values.clips === undefined) throw new UsageError(`${group} needs --clips <file.json>`);
        if (values.out === undefined) throw new UsageError(`${group} needs --out <file.fcpxml|file.otio>`);
        const order = values.order ?? (group === 'compile' ? 'date' : 'list');
        if (order !== 'date' && order !== 'list') throw new UsageError(`--order must be date or list, got '${order}'`);
        const report = buildTimeline({
          clips: values.clips,
          out: values.out,
          ...(values.fps !== undefined ? { rate: parseRate(values.fps) } : {}),
          pad: values.pad !== undefined ? parseSeconds(values.pad, '--pad', { min: 0 }) : 0,
          order,
          titleCards: values['title-cards'] === true,
          titleSeconds: values['title-seconds'] !== undefined ? parseSeconds(values['title-seconds'], '--title-seconds', { min: 0.1 }) : 3,
          ...(values.title !== undefined ? { title: values.title } : {}),
          cwd,
          env,
        });
        return print(report, summary(report));
      }
      case 'dashboard': {
        checkOptions(group, values);
        positionals(group, rest, 0, '');
        if (values.clips === undefined) throw new UsageError('dashboard needs --clips <file.json>');
        if (values.out === undefined) throw new UsageError('dashboard needs --out <file.tsx>');
        if (values['media-json'] === undefined) throw new UsageError("dashboard needs --media-json <file> (the session's list_session_media result)");
        const order = values.order ?? (values.compilation === true ? 'date' : 'list');
        if (order !== 'date' && order !== 'list') throw new UsageError(`--order must be date or list, got '${order}'`);
        const report = buildDashboard({
          clips: values.clips,
          mediaJson: values['media-json'],
          out: values.out,
          ...(values.title !== undefined ? { title: values.title } : {}),
          pad: values.pad !== undefined ? parseSeconds(values.pad, '--pad', { min: 0 }) : 0,
          order,
          compilation: values.compilation === true,
          ...(values.ordinal !== undefined ? { ordinal: intOption(values.ordinal, '--ordinal', 0, 1_000_000) as number } : {}),
          ...(values['save-args'] !== undefined ? { saveArgs: values['save-args'] } : {}),
          ...(values.session !== undefined ? { session: values.session } : {}),
          cwd,
        });
        return print(report, dashboardSummary(report));
      }
      case 'media': {
        const [sub, ...args] = rest;
        const command = `media ${sub ?? ''}`.trim();
        if (sub === undefined) throw new UsageError('media needs a command: set, list, remove or fetch');
        if (!(command in ALLOWED)) throw new UsageError(`unknown command '${command}'`);
        checkOptions(command, values);
        if (sub === 'list') {
          positionals(command, args, 0, '');
          const listed = listMedia(env);
          const text =
            listed.sessions.length === 0
              ? `No session is mapped to a video yet (${listed.map_file}).`
              : listed.sessions.map((e) => `${e.session_id}  ${e.path}${e.exists ? '' : ' (missing)'}  offset ${e.offset_s} s`).join('\n');
          return print(listed, text);
        }
        if (sub === 'remove') {
          const [id] = positionals(command, args, 1, '<session_id>');
          const removed = removeMedia(env, id as string);
          return print(removed, removed.removed ? `Removed ${id}.` : `${id} was not mapped.`);
        }
        if (sub === 'set') {
          const [id, file] = positionals(command, args, 2, '<session_id> <video file>');
          const set = setMedia(env, id as string, file as string, {
            cwd,
            ...(values.offset !== undefined ? { offset_s: parseSeconds(values.offset, '--offset') } : {}),
            ...(values.duration !== undefined ? { duration_s: parseSeconds(values.duration, '--duration', { min: 0.001 }) } : {}),
          });
          const warn = set.probe === null && set.entry.duration_s === undefined ? ' (its length could not be read; pass --duration <s> so clips are clamped to it)' : '';
          return print(set, `Mapped ${id} to ${set.entry.path}, offset ${set.entry.offset_s} s${warn}.`);
        }
        // fetch
        const [id] = positionals(command, args, 1, '<session_id>');
        const mediaJson = values['media-json'] ?? [];
        if (mediaJson.length === 0) throw new UsageError('media fetch needs --media-json <file> (the list_session_media result for the session)');
        if (mediaJson.length > 1) throw new UsageError('media fetch takes one --media-json <file>');
        const fetched = await fetchMedia(id as string, {
          mediaJson: mediaJson[0] as string,
          ...(values.dir !== undefined ? { dir: values.dir } : {}),
          ...(values.ordinal !== undefined ? { ordinal: intOption(values.ordinal, '--ordinal', 0, 1_000_000) as number } : {}),
          cwd,
          env,
          runner,
          log: io.stderr,
        });
        return print(fetched, `Downloaded ${fetched.url} to ${fetched.path} and mapped ${id} (offset ${fetched.offset_s} s).`);
      }
      case 'editor': {
        const [sub, ...args] = rest;
        const command = `editor ${sub ?? ''}`.trim();
        if (sub === undefined) throw new UsageError('editor needs a command: start, status or stop');
        if (!(command in ALLOWED)) throw new UsageError(`unknown command '${command}'`);
        checkOptions(command, values);
        positionals(command, args, 0, '');
        if (sub === 'start') {
          const started = await startEditor(
            { ...(values.ref !== undefined ? { ref: values.ref } : {}), ...(values.port !== undefined ? { port: intOption(values.port, '--port', 1024, 65535) as number } : {}) },
            { env, runner, log: io.stderr, ...(io.readyTimeoutMs !== undefined ? { readyTimeoutMs: io.readyTimeoutMs } : {}) },
          );
          return print(started, `${started.already_running ? 'Already running' : 'Started'}: ${started.url} (pid ${started.pid}, OpenReel ${started.sha.slice(0, 7)}).`);
        }
        if (sub === 'status') {
          const status = await editorStatus(env);
          return print(status, status.running ? `Running: ${status.url} (pid ${status.pid})${status.answers ? '' : ', not answering'}.` : 'Not running.');
        }
        const stopped = await stopEditor(env);
        return print(stopped, stopped.stopped ? `Stopped pid ${stopped.pid}.` : `Nothing stopped: ${stopped.reason}.`);
      }
      case 'desktop': {
        const [sub, ...args] = rest;
        if (sub !== 'doctor') throw new UsageError(sub === undefined ? 'desktop needs a command: doctor' : `unknown command 'desktop ${sub}'`);
        checkOptions('desktop doctor', values);
        positionals('desktop doctor', args, 0, '');
        const report = await desktopDoctor(env, runner);
        return print(report, `${report.registered ? `Registered: ${report.entry}` : 'OpenReel Desktop MCP is not registered.'}\n${report.next}\nRegister with: ${report.registration_line}`);
      }
      case undefined:
        return usageError(io, 'missing command');
      default:
        return usageError(io, `unknown command '${group}'`);
    }
  } catch (error) {
    if (error instanceof UsageError) return usageError(io, error.message);
    if (error instanceof CliError) {
      io.stderr(`${CLI_NAME}: ${error.message}\n`);
      return EXIT.failure;
    }
    io.stderr(`${CLI_NAME}: ${messageOf(error)}\n`);
    return EXIT.failure;
  }
}

function usageError(io: Io, message: string): number {
  io.stderr(`${CLI_NAME}: ${message}\nRun '${CLI_NAME} --help' for usage.\n`);
  return EXIT.usage;
}
