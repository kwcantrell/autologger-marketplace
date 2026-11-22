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

1. `sessions_get` — check `transcriptStatus`. If it is `none` or `pending`, stop and tell the user
   the transcript is not ready (they can record/import audio, or wait for transcription).
2. `transcript_text` — the whole transcript as `[HH:MM:SS @123.4s] Speaker: text` lines. For long
   sessions page with `fromSec` / `toSec` (e.g. 30-minute windows) rather than one huge call.
3. `topics_list` — what already exists. If the operator has hand-edited topics, say so and ask
   before replacing them.
4. `events_list` — operator markers (e.g. "Scene", "Ad read") often mark segment boundaries.

## Write topics

- Level 1: one topic per real segment of the conversation, usually 3–15 minutes. Titles are short
  and specific ("Dana's flight horror story", not "Discussion"). Summary: one or two sentences of
  what actually happens.
- Level 2 (optional): notable sub-moments inside a level-1 topic.
- `startSec` comes from the `@seconds` values in `transcript_text`. Set `durationSec` so level-1
  topics tile the session without overlapping.
- Save in ONE call: `topics_replace` with the full list. It replaces everything and each change is
  recorded, so the operator can undo it from the session's **Agents** tab.

## Report back

List the level-1 titles with their start times (`HH:MM:SS`), and mention that the changes can be
undone from the Agents tab.
