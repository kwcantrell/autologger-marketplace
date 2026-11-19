# autologger-clips

Cuts [autologger](https://github.com/kwcantrell/autologger-2) session moments into video
timelines for [OpenReel](https://github.com/Augani/openreel-video) (MIT), so you can ask Claude to
"clip every moment where they talk about X" in a session, or to make a compilation across the
sessions of an imported YouTube playlist, and watch it land in a video editor.

Claude finds the moments with the `autologger-mcp` plugin (its `moments` command, events,
transcripts, topics and wiki) and picks time ranges with you. This plugin's CLI does the
deterministic parts: it keeps a map from each session to its video file, maps session time to
video time, merges and clamps the ranges, writes an FCPXML 1.10 or OTIO timeline, downloads a
YouTube-imported session's video with `yt-dlp`, and runs the OpenReel web editor.

## Install

```
/plugin marketplace add kwcantrell/autologger-marketplace
/plugin install autologger-clips@autologger-marketplace
/plugin install autologger-mcp@autologger-marketplace
```

Needs Node.js 22.18 or newer to run the CLI, with no runtime dependencies and nothing to build.
Optional, per feature: `yt-dlp` (and `ffmpeg`, to merge video and audio) for `media fetch`;
`git`, `pnpm` and Node.js 18+ for `editor start`; `agent-browser` to drive the web editor;
OpenReel Desktop with its MCP server registered for unattended exports.

| Skill | Use |
| --- | --- |
| `clip-moments` | Finds the moments about a topic in a session, confirms the ranges with you, writes the clip list, checks or fetches the media, builds the timeline, then opens it in the web editor (agent-browser) or exports it through OpenReel Desktop's MCP tools. |
| `compile-playlist` | The same across a playlist's (or show's) sessions: a compilation ordered by session date, with a title card naming each session. |

## Commands

| Command | What it does |
| --- | --- |
| `timeline --clips <file.json> --out <file.fcpxml\|file.otio> [--fps <rate>] [--pad <s>] [--title <name>]` | Writes a timeline with one clip per range, in list order. Ranges of one session that overlap or touch (closer than half a frame) are merged, after `--pad` (default 0) is added to both ends; a merged clip takes the place of its first range and joins the labels with ` / `. Ranges are clamped to the video (start at 0, end at its length) and reported; a range wholly outside it is dropped and reported. |
| `compile --clips <file.json> --out <timeline> [--order date\|list] [--title-cards] [--title-seconds <s>] [--fps <rate>] [--pad <s>] [--title <name>]` | The same for clips from several sessions, ordered by session date then time (the default; every session needs a `session_date`) or in list order. `--title-cards` puts a card (default 3 s) naming the session, `session_title (date)`, before each run of its clips. |
| `media set <session_id> <video file> [--offset <s>] [--duration <s>]` | Maps a session to a local video file. `--offset` (default 0) is the session time at which the video's second 0 plays; write a negative one as `--offset=-5`. `--duration` gives the video's length when it is not an MP4/MOV (whose header the CLI reads). |
| `media list` | The map, with `exists` for each file. |
| `media remove <session_id>` | Removes a session from the map. |
| `media fetch <session_id> --media-json <file> [--dir <dir>] [--ordinal <n>]` | Reads autologger's `list_session_media` answer for the session (saved by the agent from `autologger-mcp call list_session_media`; the item list, `{items}` or the whole tool result), downloads its `youtube` item with `yt-dlp` into `~/Documents/autologger-clips/<session_id>/` (or `--dir`) and maps it with `offset = take_start_s`. Several YouTube takes: pick one with `--ordinal`. Anything else (a recorded or local session, a URL that is not that YouTube video, no take start) is refused. |
| `editor start [--ref <commit\|tag>] [--port <n>]` | Clones OpenReel at the pinned commit into `~/.autologger-clips/openreel/<sha>/` once, runs `pnpm install --frozen-lockfile` once, then `pnpm dev --host 127.0.0.1 --port <port> --strictPort` in the background (port 5173, or the next free one up to 5192), waits until it answers and prints the URL and pid. Output goes to `~/.autologger-clips/editor.log`. |
| `editor status` | Whether the editor `start` recorded (`~/.autologger-clips/editor.json`) is running and answers. |
| `editor stop` | Stops that process group (SIGTERM, then SIGKILL after 10 s), and only if the recorded pid is still `pnpm`; anything else is left alone. |
| `desktop doctor` | Runs `claude mcp list` and reports whether OpenReel Desktop's MCP server is registered and connected, with the registration line from OpenReel's `docs/MCP-SETUP.md`: `claude mcp add openreel -- node /path/to/mcp-shim/index.js`. It never registers anything. |

Every command takes `--json` (one JSON value on stdout) and exits 0 (success), 1 (failed) or 2
(usage error), with the message on stderr. The skills pre-approve only the read-only commands
(`timeline`, `compile`, `media list`, `editor status`, `desktop doctor`, `--help`); `media
set|remove|fetch` and `editor start|stop` ask first.

## The clip list

A JSON array (or `{"clips": [...]}`), schema in [`schema/clip-list.schema.json`](schema/clip-list.schema.json):

```json
[
  { "session_id": "ses_123", "start_s": 754.2, "end_s": 781.0, "label": "Pasta debate",
    "session_date": "2026-01-15", "session_title": "Episode 1" }
]
```

`session_id`, `start_s` and `end_s` (session time in seconds, `end_s > start_s`) are required;
`label` names the clip; `session_date` (ISO) and `session_title` are for `compile` (order and title
cards). Other fields are ignored. The file is data: labels are escaped into the timeline,
control characters removed and cut to 200 characters, and nothing in it is run.

## Session time and video time

autologger times everything in **session time**. A video's own time is

```
video time = session time - offset
```

where `offset` is the session time at which the video's second 0 plays, stored per session in the
media map. For a YouTube import, autologger anchors the take's `Recording N Started` event at the
session's transport position and `Stopped` after the video's length (`anchorImportedTake` in
autologger-2's `server/src/routers/sessions.ts`), so `offset = take_start_s` from
`list_session_media`, which `media fetch` sets. For a local file, `--offset` is whatever puts the
video in step with the session (0 when the recording started with the session).

Every time in the timeline is a whole number of frames of the sequence rate (`--fps`: `23.976`,
`24`, `25`, `29.97` (drop-frame timecode), `29.97ndf`, `30`, `50`, `59.94` (drop-frame),
`59.94ndf`, `60`; default the first clip's video rate, else 30): in and out points are rounded to
the nearest frame, and FCPXML times are exact rationals (`1001/30000s`).

## Timelines

- **FCPXML 1.10**: one `format` per rate and size, one `asset` per session video with a
  `media-rep` `file://` URL, and one `asset-clip` per clip on the primary storyline with exact
  `offset`, `start` and `duration`. A title card is a `gap` holding a connected Basic Title and a
  `marker` with the same text.
- **OTIO** (`.otio`): `Timeline.1` > `Stack.1` > a video and an audio `Track.1` of `Clip.2`
  (`ExternalReference.1` to the file, `source_range` in frames) and `Gap.1`; title cards are a gap
  plus a timeline `Marker.2`. OpenReel's `linkId`/`linkedAudioOf` metadata folds the audio back into
  each clip.

OpenReel imports either through File > Import timeline (web) or `import_timeline_xml` /
`import_timeline_from_path` (Desktop). It relinks media **by file name** to its media bin, so
import the videos first (the report's `media_files`). OpenReel's interchange has no text clips:
title cards arrive as a gap with a named marker (Final Cut Pro and Resolve show the title).

## YouTube downloads

`media fetch` downloads only the YouTube video autologger recorded for that session, and runs
exactly (yt-dlp must be on PATH; without it the command fails with the install hint):

```
yt-dlp --no-playlist --no-progress --restrict-filenames -f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b" --merge-output-format mp4 -P <dir> -o "%(id)s.%(ext)s" --print after_move:filepath -- <url>
```

that is: the best MP4 video with M4A audio merged into one `.mp4` (merging needs `ffmpeg`), else
the best single MP4, saved as `<video id>.mp4`. `~/Documents` is one of the folders OpenReel
Desktop's MCP tools may read. Downloading is the user's call: the skills ask first, and respect
YouTube's terms and the rights holder.

## Editor modes

- **Web** (`editor start`): OpenReel's `pnpm dev` on `http://127.0.0.1:5173`, driven with
  agent-browser so you can watch: import the media files, then File > Import timeline > Timeline
  XML... and pick the `.fcpxml` or `.otio`. No CA is needed (plain HTTP on loopback).
- **Desktop**: OpenReel Desktop's own MCP server (`create_project`, `import_media_from_path`,
  `import_timeline_xml` / `import_timeline_from_path`, `export_video`) for unattended exports.
  Register it yourself (`desktop doctor` prints the line); its path tools only read and write in
  Movies, Music, Pictures, Documents, Downloads, Desktop and the project folder.

## What is pinned

- OpenReel: `https://github.com/Augani/openreel-video.git` at commit
  `38c7e26c4d33a101f7fc5d5414a5ee0010623d74` (main on 2026-11-18, after `v1.0.0-alpha.17`), in
  `src/editor.ts`. `editor start --ref <commit|tag>` uses another one, in its own `<sha>` folder.
- The yt-dlp flags above, in `src/fetch.ts`.
- The FCPXML version, 1.10.

## Files

| Path | What |
| --- | --- |
| `$AUTOLOGGER_CLIPS_CONFIG_DIR`, else `$XDG_CONFIG_HOME/autologger-clips`, else `~/.config/autologger-clips` | `media.json`, the media map (mode 0600, directory 0700). |
| `~/.autologger-clips/openreel/<sha>/` | OpenReel checkouts. |
| `~/.autologger-clips/editor.json`, `editor.log` | The running web editor (pid, port, URL) and its output. |
| `~/Documents/autologger-clips/<session_id>/` | `media fetch` downloads (or `--dir`). |

## Development

```sh
node --test plugins/autologger-clips/test/*.test.ts
node plugins/plugin-builder/src/cli.ts verify autologger-clips
```

The tests fake `yt-dlp`, `git`, `pnpm` and `claude` (no network, no real install); timelines are
checked against the FCPXML 1.10 DTD's content models, xmllint (when installed) and OTIO's schema
fields, with exact times at 29.97 drop-frame and 24 fps.
