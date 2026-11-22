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
`teams_create` makes it (the user becomes owner). For technical talks, set `shows_update`
`smartFormat: false`, `keyTerms` and `transcriptRules` (see `transcript-cleanup`) **before**
importing, and `titleSuffix: "episode"` if episodes are numbered.

## 2. List the videos

For a single video, use its URL. For a playlist, get the ordered list of video ids, titles and
durations. If `yt-dlp` is available locally:
`yt-dlp --flat-playlist --print "%(playlist_index)s	%(id)s	%(duration)s	%(title)s" "<playlist URL>"`.
Otherwise ask the user for the list. Check `sessions_list` for the show first so you don't
import a video twice.

## 3. Create and import

- One `sessions_create` per video in playlist order, with a clear `title` and no `episode`: the
  show's counter numbers them 1, 2, 3 … and stays correct for the next session.
- One `media_importYoutube` per session. It queues a background job: the worker downloads the
  audio, stores it and queues transcription automatically.
- Wait with one `jobs_list({ showId, status: ["queued", "running"] })` call every 15–30 seconds
  until it returns nothing; then `jobs_list({ showId, status: ["failed"] })` for errors (each job
  carries `sessionId` and `sessionTitle`). A `failed` job carries its error: "yt-dlp not found" or a Deepgram key error means the
  server is misconfigured (tell the user; don't retry blindly). Without a Deepgram key the audio
  imports but is never transcribed.

## 4. Annotate (if asked)

Per session, in this order: `transcript-cleanup` → `session-topics` → `log-moments` →
`session-dashboard` → `show-wiki` (recap only). For many sessions:
- Fix the conventions once, up front, and give the same brief to everyone working on them:
  which buttons to use for what, the recap title pattern ("Chapter N: <title>"), the
  dashboard layout, and how to write spoken math in transcripts.
- Sessions are independent, so they can be split between parallel agents. Shared wiki pages
  (people, the series hub, recurring bits) are written once at the end, by one writer.
- Finish with a consistency pass across sessions: same speaker names, same dashboard layout,
  every `[[link]]` resolves.

## Report back

One line per video: session title, session id, audio length, transcript status, and what was
annotated. Point to the show's sessions list and wiki.
