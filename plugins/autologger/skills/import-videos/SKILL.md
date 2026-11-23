---
name: import-videos
description: Import one YouTube video or a whole playlist into an AutoLogger show — one session per video, audio download (the server downloads it, signed in to YouTube with the team's sign-in) and transcription — and optionally annotate each session afterwards (transcript cleanup, topics, events, dashboard, wiki). Use when the user gives YouTube links or a playlist (public or private) and asks to create sessions, import, transcribe or log them, or asks to set up or refresh the YouTube sign-in for their team.
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

## 2. Make sure the team is signed in to YouTube

The AutoLogger server downloads the videos itself. YouTube usually blocks downloads from servers
("Sign in to confirm you're not a bot") unless they are signed in, so each team has one YouTube
sign-in — the cookies of a browser signed in to YouTube — that every show of the team uses.
yt-dlp has no password login; cookies are the only way.

Before the first import, call `media_youtubeAccess({ showId })`:
- `configured: true` and `lastOkAt` newer than `lastFailedAt` (or neither set yet): go on to
  step 3.
- `configured: false`, or `lastFailedAt` newer than `lastOkAt` (signed out or expired): set it
  up as below. Also do this when an import fails with "YouTube is blocking this server's
  downloads (bot check)", "…the cookies have probably expired" or "YouTube requires a signed-in
  account" — don't retry the import until the sign-in is fixed.

Setting the sign-in (needs owner or admin of the team; `teams_list` shows the role):

1. **Ask the user to sign in.** Tell them the server needs a YouTube sign-in for the team and ask
   them to open YouTube in a browser on this computer and sign in — preferably with a spare
   Google account in a browser profile they use only for this, because the cookies give full
   access to that account and YouTube invalidates the server's copy when the same profile keeps
   using YouTube. Ask which browser and profile (`firefox`, `chrome`, `chrome:Profile 2`, …).
   Wait for them to say they are signed in.
2. **Ask for consent, explicitly, before reading or sending any cookies.** Say what will happen:
   "I'll read the YouTube cookies of <browser> on this computer and upload the youtube.com /
   google.com ones to <AutoLogger URL> as the YouTube sign-in of team <team name>. Anyone who
   can read the server's database can use them to act as that Google account. OK?" Only go on
   after a clear yes; if they decline, offer the local import helper (below) instead.
3. **Export and upload.**
   - **Claude Code on the user's computer** (needs `yt-dlp`): export to a private temp file,
     keeping only the YouTube lines, then send them:
     ```sh
     d=$(mktemp -d) && yt-dlp --cookies-from-browser <browser> --cookies "$d/c.txt" \
       --skip-download --quiet --no-warnings 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
     grep -E '^(#HttpOnly_)?\.youtube\.com' "$d/c.txt"; rm -rf "$d"
     ```
     (yt-dlp may print a format error; the cookie file is still written. Chrome may need to be
     closed, and macOS may show a keychain prompt.) Pass that text as `cookies` to
     `media_setYoutubeCookies({ showId, cookies })` — or `teamId` — and don't repeat the cookie
     values in your messages. If the user has `AUTOLOGGER_URL` and `AUTOLOGGER_TOKEN` set, the
     import helper does the same without the cookies passing through the conversation:
     `node autologger-import.mjs youtube-login --team <teamId> --cookies-from-browser <browser>`.
   - **Anywhere else** (cloud, remote agent): you can't read their browser. Ask them to run the
     `youtube-login` command above themselves, or to paste a cookies.txt export into
     **Settings › Team details › YouTube access** in AutoLogger.
4. **Check the result.** `check.ok: true` → go on. `check.ok: false` means YouTube refused them
   already (signed out, or the browser rotated them since the export): ask the user to reload
   YouTube signed in, and export again.

Afterwards tell the user the sign-in works for every show of the team, and that signing out of
YouTube in that browser profile (or using YouTube a lot in it) ends it; you can refresh it the
same way.

## 3. Import

- **Playlist:** `media_importPlaylist` (`showId`, `url` with `list=`, `order: "playlist"` or
  `"reverse"` for newest-first channel playlists, optional `titleTemplate` with `{title}` /
  `{episode}`). It creates one session per video with episode numbers from the show counter and
  queues every download; videos already imported, private or deleted are `skipped`, so running it
  again imports only new videos. Agents can't delete sessions (web-only), so always:
  1. `media_youtubeAccess` (step 2).
  2. Call it with `dryRun: true` and read `downloadCheck`: `"blocked"` → don't import; fix the
     sign-in (step 2) or offer the import helper (below). `"ok"` or `"skipped"` (not checked) → go on.
  3. From the dryRun's `created[].videoId` and titles, build per-episode
     `keyTerms: { "<videoId>": ["Guest Name", "jargon"] }` (guests, subjects; skip if none).
  4. Call again with the same arguments plus `keyTerms` (no `dryRun`). Each session gets its terms
     before its job is queued, so the first transcription uses them.
  Session dates are set from the YouTube upload date when the audio arrives.
- **Single video:** `sessions_create` (clear `title`, session `keyTerms`; omit `episode` to use the
  show counter), then `media_importYoutube`.
- **Already-imported videos only:** to change key terms, `sessions_update` `keyTerms`, then
  `media_retranscribe` (replaces manual transcript edits). Don't `sessions_update` right after a
  playlist import: it races the transcription.
- **Audio only, no transcript:** `transcribe: false` on `media_importYoutube`,
  `media_importPlaylist` or `media_completeUpload` (helper: `--no-transcribe`): the audio is
  stored and its waveform drawn, nothing is transcribed (later: `media_retranscribe` per session).
- **Video that already has captions or a transcript:** import with `transcribe: false`, then
  `transcript_import` (`format` `"srt"`, `"vtt"` or `"json"`, `mode: "replace"`). With
  `audioSegmentId` (from `media_list`) times are relative to that recording, as in a subtitle file
  made from the video; omit it for times from the session start. It is refused while a
  transcription of that session/recording is pending.

### Fallback: the local import helper

Only when the user doesn't want to give the server a YouTube sign-in (step 2), or for videos the
signed-in account can't watch: the **local import helper** downloads on the user's own computer
with their browser's YouTube login and uploads only the audio; their cookies never leave their
machine.

1. Get it from the user's AutoLogger server:
   `curl -fLO <AUTOLOGGER_URL>/api/importer/autologger-import.mjs` (Node 22+; needs `yt-dlp` on
   `PATH`). It needs `AUTOLOGGER_URL` (the server origin) and `AUTOLOGGER_TOKEN` — a personal
   access token the user creates in **Settings › Agents**. Ask the user to set the token in their
   environment; never ask them to paste it into the chat.
2. Preview, then import:
   `node autologger-import.mjs playlist '<url>' --show <showId> --cookies-from-browser <browser> --dry-run`,
   then the same without `--dry-run`. One video: `video '<url>' --session <sessionId>` (or
   `--show <showId>`). Options: `--order reverse`, `--title-template`, `--no-transcribe` (helper
   1.1.0+; re-download an older copy from the URL above).
3. Re-running resumes (stored audio is skipped). Sessions look like server imports
   (`sourceKind: "youtube"`, `sourceUrl`); `media_list` shows `sourcePrivate: true` for audio
   from private videos.

## 4. Wait

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
`sessionId`. A sign-in error here means the team's YouTube sign-in stopped working: redo step 2, then retry. Without a Deepgram key (or with `transcribe: false`) the audio imports but is never transcribed. The transcribe job's
`progress` ends with key-term hit counts ("key terms: Tom Segura ×41, …") — a term showing up
where it shouldn't is a sign of key-term bleed.

## 5. Annotate (if asked)

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
