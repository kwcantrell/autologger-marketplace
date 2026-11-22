---
name: transcript-cleanup
description: Fix systematic mistakes in a machine transcript of an AutoLogger session — misheard terms, mangled numbers and math, generic speaker labels — and record what was changed. Use when the user asks to clean up, correct or proofread a transcript, when a transcript has repeated errors (e.g. "doctor" for "dr"), or before generating topics, events or recaps from a technical talk.
argument-hint: "[session] [known errors, e.g. \"doctor\" should be \"dr\"]"
---

# Clean up a session transcript

Prevention first: for technical shows set `smartFormat: false`, `keyTerms` and
`transcriptRules` with `shows_update` **before** importing. Rules (`{ find, replace, regex?,
wholeWord?, caseSensitive? }`, run in order) are applied automatically to every transcription and
re-transcription of the show — the job result says how many replacements each made. Deepgram still
mangles notation ("doctor", "dsdt", "sin"), so put each systematic fix you discover into the show's
rules, not just into one session.

Deepgram transcripts are good on plain speech and weak on jargon, names, numbers and spoken math.
The errors are usually **systematic**: the same pattern repeats through the whole session, so fix
patterns, not single words.

## Steps

1. `sessions_get` — `transcriptStatus` must be `done`. Read the whole `transcript_text`
   (page long sessions with `fromSec`/`toSec`).
2. **Speakers.** If turns are labelled `Speaker 1`, `Speaker 2`, … and the transcript says who
   they are ("Hey everyone, Grant here"), rename each with `transcript_renameSpeaker`. Never guess
   a name the transcript does not support.
3. **List the error patterns** before editing, each with an example and a count. Typical Deepgram
   patterns in technical talks:
   - a short term heard as a word: "dr" → "doctor", "minus" → "minuteus";
   - digits glued to letters or each other: "x2", "dx2", "t3", "52" (for "5 squared"), "c2x2";
   - fractions and operators collapsed: "onex", "onetwo", "dydx", "dsdt", "x=zero", "-threefour";
   - units abbreviated wrongly: "ms"/"mss" for meters / meters per second;
   - function names cut short or arguments dropped: "sin", "ln", "cos(1.52)".
4. **Find the lines.** One `transcript_find` call with all patterns: `patterns: [...]`,
   `regex: true` (PostgreSQL syntax, e.g. `\mdoctor\M`, `\m[a-zA-Z]+[0-9]+\M`, `\md[a-z]d[a-z]\M`).
   Each hit lists `matches` (the matched text) and `patternIndexes`; `context: 1` adds the
   neighbouring lines (marked `context: true`) when an error spans two lines. `\m`/`\M` treat
   apostrophes as word boundaries (`\mm\M` matches "I'm"), so check each hit's `matches`.
5. **Fix systematic patterns with rules.** `transcript_replace` with `rules` and `dryRun: true`
   shows every would-be change (`before`/`after` per line); review it, then run it again without
   `dryRun`. Regex rules use PostgreSQL syntax: groups are `\1`…`\9` in `replace`; `wholeWord`
   avoids hitting "doctorate". Add the same rules to the show with `shows_update`
   (`transcriptRules`, the full ordered list) so future imports come out clean. A rule that takes
   too long is rejected (bad_request) — simplify it.
6. **Fix one-off lines** that need judgement with one `transcript_updateSegments` call (up to 500
   `{ segmentId, text }`, full corrected text, `compact: true` to get back only ids):
   - Write math and numbers **as they were spoken** ("x squared", "dy dx", "one over x",
     "e to the three t"), not as symbols. Use the same convention across every session of a show.
   - Fix only clear transcription errors. Don't rephrase, tidy grammar or add words you can't
     infer with confidence from the sentence itself. If unsure, leave the line and list it.
   - Unchanged words keep their recorded timings; only replaced or inserted words get
     interpolated ones, so prefer small targeted edits over rewriting whole lines.
   - Lines out of order or wrongly split: `transcript_mergeSegments` (adjacent or overlapping ids;
     don't merge overlaps from different speakers) or `transcript_splitSegment` (at a word index).
     Their undo is one change-log entry per row — revert all of them together.
7. **Re-check** with the same `transcript_find` patterns that nothing is left.
8. **Leave a trace.** Log one `Note` event per pattern (what, how many lines, time range,
   "corrected by hand") with `events_createMany`, so editors know captions were changed.

## Report back

A table of pattern → replacement → lines fixed → time range, the rules saved on the show, the
speaker renames, and any lines you left alone because you weren't sure. Mention that each edit is in the change log and can be undone
from the session's **Agents** tab.
