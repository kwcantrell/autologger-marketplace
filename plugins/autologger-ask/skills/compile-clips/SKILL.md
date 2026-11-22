---
name: compile-clips
description: Build one video from timecode ranges of AutoLogger sessions that were imported from YouTube — a supercut of every time a topic came up, a highlights reel, the clips cited on a wiki question page. The AutoLogger server downloads just those sections and joins them into an MP4 you can play or download. Use when the user asks for a compilation, supercut, montage, highlight reel or "a video of those clips".
argument-hint: "<ranges | wiki question page | what to compile>"
---

# Compile clips into a video

The server builds compilations (`compilations_create`): it downloads only the needed sections of
each session's YouTube video and joins them. Only sessions imported from YouTube can be used.

## 1. Collect the clips

From, in order of preference:
- ranges you just produced (the `ask` skill), or ranges the user gave;
- a wiki `question` page: `wiki_get` it and take each citation — `/sessions/<sessionId>?t=<start>&to=<end>`,
  `(@<sessionId>:<start>-<end>)`, or on a recap `(@<start>-<end>)` / `[@<start>-<end>]` for the
  recap's own session (or use the page's **Make video** button in the web app);
- otherwise run the `ask` skill first to find them.

Each clip: `{ sessionId, startSec, endSec, label }` — seconds from the session start (the
`@seconds` values of `transcript_text`). `label` is a short caption of what happens.

## 2. Check them

- `sessions_get` each session: keep `sourceKind: "youtube"`; list the others as left out.
- Limits: 1–100 clips, each 1 s–20 min, ≤ 3 h total. Trim or split rather than fail.
- Order: as the user asked; otherwise chronologically (episode date, then start time) — or by
  relevance for a "best of".
- More than ~30 min total or 40 clips? Confirm with the user first, with the numbers.
- Already clipped? Every compilation logs a `Compilation` event at each clip's start in its
  session — `events_list` and look for category `Compilation` to see which moments are already in
  a video, and mention overlaps to the user.

## 3. Create and wait

1. `compilations_create` with `showId`, a `title` (e.g. the question) and `clips`. A
   `bad_request` names the clips that aren't covered by a YouTube source — drop or fix them and
   retry once. Creating it also logs a grey `Compilation` event at each clip's start in that
   clip's session (each returned clip has its `eventId`); pass `logEvents: false` for drafts and
   tests. To remove just those events and keep the video, `changes_revertGroup` the create's group;
   `compilations_delete` removes the video and its events together.
2. Wait with `compilations_get` `waitSec: 55` (the maximum; MCP clients time out at ~60 s) in a loop until `status` is `ready` or `failed`
   (no sleeps needed; it long-polls). While queued or running it has `queuePosition` and a rough
   `etaSec` — tell the user about how long it will take (an estimate, not a deadline) and report
   `progress` every few minutes on long builds.
3. `ready`: give the `url` (a download link that expires after about an hour) and say the video is
   also in AutoLogger under **Compilations** for the show, where a fresh link is always available.
   `failed`: report `error`. If it looks transient (network, YouTube throttling, a worker
   restart), call `compilations_retry {compilationId}` once — same id, title and clips — and wait
   again — retry logs no new events, so prefer it over deleting and re-creating. A `bad_request` from the retry means a clip's session lost its YouTube source: create a
   new compilation without those clips. Users can also press Retry on the Compilations page.

## Private videos and the bot check: build locally

The server can't download audio imported from **private** videos (`media_list` → `sourcePrivate:
true`), so `compilations_create` rejects those clips ("the video is private (imported with the
local import helper)…"), and a server build can fail on YouTube's bot check. Then:

1. `compilations_create` again with the same clips and `buildLocally: true`. It stays `queued`
   with progress "Waiting for a local build".
2. Build it on the user's computer with the local import helper (see the autologger
   `import-videos` skill for getting `autologger-import.mjs` and its `AUTOLOGGER_URL` /
   `AUTOLOGGER_TOKEN`): `node autologger-import.mjs compile <compilationId>
   --cookies-from-browser <browser>` (needs `yt-dlp` and `ffmpeg`). In Claude Code on the user's
   own machine you may run it with Bash once they agree; elsewhere give them the command.
3. Wait with `compilations_get` `waitSec: 55` as usual — it turns `ready` with a `url` once the
   helper has uploaded the MP4.

## Report back

Title, number of clips, total length, the link, and any clips left out and why. If a tool was
missing or misbehaved, file it with the `autologger:report-issue` skill.
