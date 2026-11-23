---
name: session-topics
description: Generate or rewrite the topics (chapters) of an AutoLogger session from its transcript. Use when the user asks to chapter, segment, outline or "add topics to" a session or episode.
argument-hint: "[session title or id]"
---

# Generate session topics

Turn a session transcript into chapters an editor can navigate: level-1 topics for major segments,
optional level-2 sub-topics inside them.

## Find the session

If the user gave an id (`ses_…`), use it. Otherwise call `sessions_list` (optionally filtered by
`showId` from `shows_list`) and match the title, episode or date. If several match, ask which one.

## Read before writing

1. `sessions_get` — check `transcriptStatus`. If it is not `done`: `none` → stop and tell the user
   there is no audio yet; `pending` → wait for `transcriptJob` (`jobs_list` with `waitSec`);
   `partial` (some recordings not transcribed yet) → wait, or say the topics will cover only part; `failed` → report it.
2. `transcript_text` with `{format: "compact", stampEverySec: 0}`, read once — paragraphs per
   speaker turn with a `[@seconds]` stamp at every segment start, so no second pass in lines
   format is needed. The result's `totalSegments` / `durationSec` tell you whether to page: for
   long sessions use ~25-minute `fromSec` / `toSec` windows (pages don't overlap). No segments? The text says why (the `transcript_text` description lists each case and what to do); an empty transcript with status `done` is final: skip the session.
3. `topics_list` — what already exists. If the operator has hand-edited topics
   (`changes_list` {sessionId, entity: "topic", via: "web"}), say so and ask
   before replacing them.
4. `events_list` — operator markers (e.g. "Scene", "Ad read") often mark segment boundaries.

If the transcript is machine-made and garbled (technical terms, numbers, math), clean it first
with the `transcript-cleanup` skill so topic titles and summaries quote it correctly.

## Write topics

- Level 1: one topic per real segment of the conversation, usually 3–15 minutes. Titles are short
  and specific ("Dana's flight horror story", not "Discussion"). Summary: one or two sentences of
  what actually happens.
- Level 2 (optional): notable sub-moments inside a level-1 topic.
- `startSec` comes from the `[@seconds]` stamps in `transcript_text`. Set `durationSec` so level-1
  topics tile the session without overlapping.
- Save in ONE call: `topics_replace` with the full list (`compact: true` returns only
  `{ id, startSec, level, title }` per topic). It replaces everything and each change is
  recorded, so the operator can undo it from the session's **Agents** tab.

## Report back

List the level-1 titles with their start times (`HH:MM:SS`), and mention that the changes can be
undone from the Agents tab.

If an AutoLogger tool was missing, failed, or cost far too many calls or tokens along the way — or
something was left for later — file it with the `report-issue` skill when the task is done and
list the issue links in your report.
