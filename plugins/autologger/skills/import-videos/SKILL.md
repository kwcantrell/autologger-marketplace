---
name: import-videos
description: Import one YouTube video or a whole playlist into an AutoLogger show — one session per video, audio download and transcription — and optionally annotate each session afterwards (transcript cleanup, topics, events, dashboard, wiki). Use when the user gives YouTube links or a playlist and asks to create sessions, import, transcribe or log them.
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

## 3. Wait

The worker downloads, then transcribes each session as soon as its own download finishes (two jobs
at a time; an hour of audio takes well under a minute to transcribe). Wait with
`jobs_list({ showId, status: ["queued","running"], waitSec: 50 })` in a loop: each call returns as
soon as a job changes, or after `waitSec`, and queued jobs show `queuePosition`. Don't sleep in
between. Start annotating a session as soon as its `transcriptStatus` is `done` rather than
waiting for the whole playlist. Then `jobs_list({ showId, status: ["failed"] })`: "yt-dlp not
found" or a Deepgram key error means the server is misconfigured (tell the user; don't retry
blindly). Without a Deepgram key the audio imports but is never transcribed. The transcribe job's
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
