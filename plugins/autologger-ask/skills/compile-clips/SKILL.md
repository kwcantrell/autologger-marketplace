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
- a wiki `question` page: `wiki_get` it and take each citation link
  `/sessions/<sessionId>?t=<start>&to=<end>`;
- otherwise run the `ask` skill first to find them.

Each clip: `{ sessionId, startSec, endSec, label }` — seconds from the session start (the
`@seconds` values of `transcript_text`). `label` is a short caption of what happens.

## 2. Check them

- `sessions_get` each session: keep `sourceKind: "youtube"`; list the others as left out.
- Limits: 1–100 clips, each 1 s–20 min, ≤ 3 h total. Trim or split rather than fail.
- Order: as the user asked; otherwise chronologically (episode date, then start time) — or by
  relevance for a "best of".
- More than ~30 min total or 40 clips? Confirm with the user first, with the numbers.

## 3. Create and wait

1. `compilations_create` with `showId`, a `title` (e.g. the question) and `clips`. A
   `bad_request` names the clips that aren't covered by a YouTube source — drop or fix them and
   retry once.
2. Wait with `compilations_get` `waitSec: 55` (the maximum; MCP clients time out at ~60 s) in a loop until `status` is `ready` or `failed`
   (no sleeps needed; it long-polls). Report `progress` to the user every few minutes on long
   builds.
3. `ready`: give the `url` (a download link that expires after about an hour) and say the video is
   also in AutoLogger under **Compilations** for the show, where a fresh link is always available.
   `failed`: report `error`; one retry is reasonable if it looks transient (network, YouTube
   throttling).

## Report back

Title, number of clips, total length, the link, and any clips left out and why. If a tool was
missing or misbehaved, file it with the `autologger:report-issue` skill.
