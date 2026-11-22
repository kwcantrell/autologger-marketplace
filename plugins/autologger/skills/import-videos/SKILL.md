---
name: import-videos
description: Import one YouTube video or a whole playlist into an AutoLogger show — one session per video, audio download and transcription — and optionally annotate each session afterwards (transcript cleanup, topics, events, dashboard, wiki). Use when the user gives YouTube links or a playlist (public or private) and asks to create sessions, import, transcribe or log them.
argument-hint: "[YouTube URL or playlist] [team/show]"
---

# Import YouTube videos into sessions

## 1. Pick the show

`teams_list` and `shows_list` (filter by `teamId`). Sessions need a show: create one with
`shows_create` (owner/admin of the team) and set its buttons with `categories_save` (it replaces
the whole list — keep existing ones by `id`). If the user names a team that doesn't exist yet,
`teams_create` makes it (the user becomes owner). Set transcription options with `shows_update`
**before** importing:
- `titleSuffix: "episode"` if episodes are numbered.
- `smartFormat: false` for technical or math talk. Leave it on for conversation, but expect it to
  turn spoken numbers into clock times ("four fifty" pounds → "04:50") and glue sponsor URLs
  together; fix those with `transcriptRules` (see `transcript-cleanup`).
- `keyTerms` on the show only for names said in **every** session (host, show name, co-hosts).
  Deepgram pushes key terms into the audio, so a guest's name set show-wide turns up in other
  episodes ("Rotten Tomatoes" → "Rotten Tom Segura", D'Angelo → "Deion Sanders"). Put guest names
  and episode-specific jargon on the **session** instead (`sessions_create` / `sessions_update`
  `keyTerms`).

## 2. Import

- **Playlist:** one `media_importPlaylist` call (`showId`, `url` with `list=`, `order:
  "playlist"` or `"reverse"` for newest-first channel playlists, optional `titleTemplate` with
  `{title}` / `{episode}`). It creates one session per video with episode numbers from the show
  counter, queues every download and returns `created` (session ids, titles, durations) and
  `skipped` (already imported, private or deleted). Running it again imports only new videos.
  Agents can't delete sessions (that's web-only), so for an unfamiliar playlist call it first with
  `dryRun: true` to see what would be created.
  Session dates are set from the YouTube upload date when the audio arrives.
- **Single video:** `sessions_create` (clear `title`; omit `episode` to use the show counter),
  then `media_importYoutube`.
- **Per-episode key terms:** after the playlist call, `sessions_update` each session with
  `keyTerms` for its guest/subject **before** its transcription starts — or set them later and
  `media_retranscribe` (which replaces manual transcript edits).

### Private playlists, or the server hits YouTube's bot check

The server can't download private or account-only videos, and from a datacenter IP YouTube may
block it ("YouTube is blocking this server's downloads (bot check)" or "requires a signed-in
account" from `media_importPlaylist` / `media_importYoutube` or a failed `youtube_import` job).
Don't retry server imports then: use the **local import helper**, which downloads on the user's
own computer with their browser's YouTube login and uploads only the audio. Their cookies never
leave their machine.

1. Get it from the user's AutoLogger server:
   `curl -fLO <AUTOLOGGER_URL>/api/importer/autologger-import.mjs` (Node 20+; needs `yt-dlp` on
   `PATH`). It needs `AUTOLOGGER_URL` (the server origin) and `AUTOLOGGER_TOKEN` — a personal
   access token the user creates in **Settings › Agents**. Ask the user to set the token in their
   environment; never ask them to paste it into the chat.
2. Ask which browser they're signed in to YouTube with (`chrome`, `firefox`, `safari`, `edge`, …).
3. Preview, then import:
   `node autologger-import.mjs playlist '<url>' --show <showId> --cookies-from-browser <browser> --dry-run`,
   then the same without `--dry-run`. One video: `video '<url>' --session <sessionId>` (or
   `--show <showId>`). Options: `--order reverse`, `--title-template`.
   - **Running in Claude Code on the user's own computer:** you can run these commands yourself
     with Bash after the user agrees; reading their browser cookies may show a keychain prompt.
   - **Running anywhere else** (cloud, remote agent): you can't — give the user the commands.
4. Re-running resumes (stored audio is skipped). Sessions look like server imports
   (`sourceKind: "youtube"`, `sourceUrl`); `media_list` shows `sourcePrivate: true` for audio
   from private videos. Then wait for transcription as below (`kinds: ["transcribe"]`).

## 3. Wait

The worker downloads, then transcribes each session as soon as its own download finishes (two jobs
at a time; an hour of audio takes well under a minute to transcribe). Wait with
`jobs_list({ showId, status: ["queued","running"], waitSec: 50 })` in a loop: each call returns as
soon as a job changes, or after `waitSec`. Queued jobs show `queuePosition`, and queued or running
jobs a rough `etaSec` — use it to pick `waitSec`, not as a deadline; `sessions_get` carries
`transcriptJob` for one session (its `etaSec` covers download and transcription, for single
imports as well as playlists). Don't sleep in
between. Start annotating a session as soon as its `transcriptStatus` is `done` rather than
waiting for the whole playlist. Then `jobs_list({ showId, status: ["failed"] })`: "yt-dlp not
found" or a Deepgram key error means the server is misconfigured (tell the user; don't retry
blindly). A failed `youtube_import` job carries the video's `sourceUrl`: to retry a transient
failure (network, throttling), call `media_importYoutube` with that `sourceUrl` and the job's
`sessionId`. Without a Deepgram key the audio imports but is never transcribed. The transcribe job's
`progress` ends with key-term hit counts ("key terms: Tom Segura ×41, …") — a term showing up
where it shouldn't is a sign of key-term bleed.

## 4. Annotate (if asked)

Per session, in this order: `transcript-cleanup` → `session-topics` → `log-moments` →
`session-dashboard` → `show-wiki` (recap only). For many sessions:
- Fix the conventions once, up front, and give the same brief to everyone working on them:
  which buttons to use for what, the recap title pattern ("Ep N: <Guest>"), the dashboard layout
  (same widget ids everywhere), and how to write spoken numbers/math in transcripts.
- Sessions are independent, so they can be split between parallel agents (about 3–4 hours of
  audio per agent). Shared wiki pages (people, the series hub, recurring bits) are written once
  at the end by one writer, from facts the session agents collected with episode + timecode.
- Finish with a consistency pass: same speaker names, same dashboard layout, and `wiki_lint` for
  the show returns no unresolved links.
- Ask every agent to report friction (tool, what it needed, what happened). Merge the reports,
  drop duplicates and file one issue per distinct problem with `report-issue`.

## Report back

One line per video: session title, session id, audio length, transcript status, and what was
annotated. Point to the show's sessions list and wiki.

If an AutoLogger tool was missing, failed, or cost far too many calls or tokens along the way — or
something was left for later — file it with the `report-issue` skill when the task is done and
list the issue links in your report.
