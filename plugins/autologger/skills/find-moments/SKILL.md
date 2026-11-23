---
name: find-moments
description: Quick read-only lookup across AutoLogger sessions — "when did we talk about X", "which episode had the airport story", "which episodes had an audio issue" — answered in chat with session titles and timecodes; nothing is saved. Use for finding a moment, a logged event or a fact fast. For a cited answer kept in the show wiki (or a video of the clips), use the autologger-ask plugin's `ask` skill instead.
argument-hint: "<question>"
---

# Find moments across sessions

Read-only: never create or change anything with this skill. If the user wants the answer kept
(a knowledge-base page), every relevant range across a show, or a video of the moments, hand off
to `autologger-ask:ask` (needs the `autologger-ask` plugin) instead.

## Steps

0. **About a person, recurring bit or topic of a show with a wiki?** If the server has the
   knowledge-graph tools, start there (resolve `showId` with `shows_list` when the question names
   no show): `graph_entity {showId, entity}` (aliases, the sessions it appears in, related pages),
   then `moments_search {showId, entities: [...]}` — two entities find where they come up together
   — optionally with `query`. Moments come with `startSec`/`endSec` ranges and a description; add
   `mergeGapSec` for clip ranges. When the tools aren't there, the show has no wiki or the entity
   has no page, go to step 1.
1. Start with `search` — full-text over events, transcript lines, topics, wiki pages and sessions
   the user can access. Try 2–3 phrasings (names, key nouns, synonyms); narrow with `showId`,
   `sessionId` or `kinds` when the question is specific. A call that returns exactly `limit` hits
   (30 by default) may have more: page with `offset`.
2. Hits carry `sessionId`, `atSec` and `endSec` (where a transcript line ends, or a topic's start
   plus its length; null for events and wiki pages). For promising hits, read context with `transcript_text`
   using `fromSec = atSec - 60`, `toSec = atSec + 120`.
3. For logged-event questions ("which sessions had an audio issue") `search` with
   `kinds: ["event"]` and the button name (events are indexed by category; hits carry the session
   title and date). Use `events_list` with `categoryIds` only for one session's detail.
4. Also check the show wiki for answers already written: `wiki_list` with `kind: "question"`,
   `include: "summary"`; and `wiki_get` by title for people and recurring bits — it often answers
   "who is…" and "what is…" directly.

## Answer

Group results by session: session title, date, then each moment as `HH:MM:SS — what happens` with
a short quote. Say plainly when something was not found, and what you searched for.

If an AutoLogger tool was missing, failed, or cost far too many calls or tokens along the way — or
something was left for later — file it with the `report-issue` skill when the task is done and
list the issue links in your report.
