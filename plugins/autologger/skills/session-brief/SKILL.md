---
name: session-brief
description: Write an editor's or producer's brief for an AutoLogger session — rundown, highlights with timecodes, clip candidates, problems logged (audio issues, retakes) and follow-ups. Read-only; the brief is returned in chat. Use for post-show notes, edit notes, show notes drafts or "summarize this session".
argument-hint: "[session] [audience: editor|producer|social]"
---

# Session brief

A read-only summary for people who will not re-listen to the recording.

## Gather

`sessions_get`, `events_list`, `topics_list`, `transcript_text` (paged for long sessions), and
`dashboards_list` if there are dashboards with useful numbers.

## Write

Adapt to the audience the user names (default: editor).

- **Rundown** — topics in order with start times and one line each.
- **Highlights / clip candidates** — 3–8 moments with `HH:MM:SS`–`HH:MM:SS` ranges and why they
  work (quote the best line).
- **Problems** — events in problem categories (audio issues, retakes, bleeps) with times and the
  operator's notes, so the editor can jump straight to them.
- **Follow-ups** — things promised or left open in the conversation.
- **Social** audience: 3 short post drafts with timecodes for the clips.

Timecodes: use the session clock (`sessions_get` → `startOffsetFrames`, `frameRate`) when the
user works in NLE timecode; otherwise session time from `@seconds`.

Do not write anything back unless the user asks — then offer `show-wiki` for a recap page.
