---
name: log-moments
description: Find moments in an AutoLogger session transcript (laughs, ad reads, guest intros, quotable lines, mistakes, anything the user names) and log them as timecoded events using the show's event buttons. Use when the user asks to "log", "mark", "tag" or "find and log" moments in a session.
argument-hint: "[what to log] [session]"
---

# Log moments as events

Operators normally log events live with hotkeys. This skill fills in what they missed, after the
fact, from the transcript.

## Steps

1. Resolve the session (`sessions_list` / `sessions_get`). Note `showId`, `frameRate` and
   `transcriptStatus`; without a transcript, stop and say why.
2. `categories_list` for the show — these are the event buttons. Prefer an existing button whose
   name fits what the user wants to log. Pass it as `categoryId`. Only use a free `category` name
   when nothing fits, and tell the user you did (free labels show in grey).
   - `dropdown` buttons take a `value` from their `options`.
   - `toggle` buttons take `value` = the button's `onLabel` or `offLabel`.
3. `events_list` with `compact: true` (`{ id, atSec, category, message }` per event) — skip
   moments the operator already logged (same category within ~10 s). `atSec` is seconds on the
   transcript's scale. `events_createMany` with `compact: true` returns `{ id, atSec, category }`
   per created event, so no separate check is needed.
4. Read `transcript_text` once with `{format: "compact", stampEverySec: 0}` (page long sessions
   with ~25-minute `fromSec`/`toSec` windows) — every segment start has a `[@seconds]` stamp, so
   no second pass in lines format. If the text is "(transcript is empty: no speech detected)" with `transcriptStatus` `done`, that is final: skip the session (don't wait or `media_retranscribe`); "(no transcript yet: …)" → wait with `jobs_list`; "(no transcript: transcription failed …)" → report it. Pick the moments.
   Be selective: an editor wants the moments that matter, not every chuckle.
5. Log them in one call with `events_createMany`, each with `atSec` taken from the segment's
   `[@seconds]` stamp and a short `message` quoting or describing the moment. To correct events
   afterwards (message, time, button), use one `events_updateMany` call instead of many
   `events_update` calls.

## Report back

A table of time (HH:MM:SS), button, message. Mention that every event is tagged as created by the
agent and can be undone from the session's **Agents** tab.

If an AutoLogger tool was missing, failed, or cost far too many calls or tokens along the way — or
something was left for later — file it with the `report-issue` skill when the task is done and
list the issue links in your report.
