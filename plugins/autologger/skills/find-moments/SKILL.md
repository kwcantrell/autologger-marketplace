---
name: find-moments
description: Answer questions across AutoLogger sessions — "when did we talk about X", "every time Dana mentioned the dog", "which episodes had an audio issue" — with session titles and timecodes. Read-only. Use for any search or lookup over logged sessions, transcripts, topics or the wiki.
argument-hint: "<question>"
---

# Find moments across sessions

Read-only: never create or change anything with this skill.

## Steps

1. Start with `search` — full-text over events, transcript lines, topics, wiki pages and sessions
   the user can access. Try 2–3 phrasings (names, key nouns, synonyms); narrow with `showId`,
   `sessionId` or `kinds` when the question is specific.
2. Hits carry `sessionId`, `atSec` and `endSec` (where a transcript line ends, or a topic's start
   plus its length; null for events and wiki pages). For promising hits, read context with `transcript_text`
   using `fromSec = atSec - 60`, `toSec = atSec + 120`.
3. For structural questions ("which sessions had an audio issue") use `sessions_list` +
   `events_list` with category filters instead of text search.
4. Check the show wiki (`wiki_get` by title) for people and recurring bits — it often answers
   "who is…" and "what is…" directly.

## Answer

Group results by session: session title, date, then each moment as `HH:MM:SS — what happens` with
a short quote. Say plainly when something was not found, and what you searched for.

If an AutoLogger tool was missing, failed, or cost far too many calls or tokens along the way — or
something was left for later — file it with the `report-issue` skill when the task is done and
list the issue links in your report.
