---
name: transcript-cleanup
description: Fix systematic mistakes in a machine transcript of an AutoLogger session — misheard terms and names, mangled numbers and math, generic or wrong speaker labels — and record what was changed. Use when the user asks to clean up, correct or proofread a transcript, when a transcript has repeated errors (e.g. "doctor" for "dr"), or before generating topics, events or recaps from a technical talk or interview.
argument-hint: "[session] [known errors, e.g. \"doctor\" should be \"dr\"]"
---

# Clean up a session transcript

Prevention first (`shows_update`, before importing): `smartFormat: false` for technical talk,
`keyTerms` only for names said in every session (guest names go on the session's own `keyTerms`
— show-wide guest names bleed into other episodes), and `transcriptRules` for fixes that recur.
Rules (`{ find, replace, regex?, wholeWord?, caseSensitive?, preserveCase? }`, run in order)
apply to every transcription and re-transcription; the job result counts their replacements.
Literal case-insensitive rules keep the match's capitalisation by default ("Doctor" → "Dr" at a
sentence start); set `preserveCase: false` to insert `replace` exactly as written.

Errors are usually **systematic**: fix patterns, not single words.

## Steps

1. `sessions_get` — `transcriptStatus` must be `done`. Read the transcript with
   `transcript_text` and `format: "compact"` (same-speaker lines merged, ~40% smaller). The
   result's `totalSegments` and `durationSec` tell you how to page: about 25-minute windows
   (`fromSec`/`toSec`) for hour-long sessions; pages don't overlap.
2. **Speakers.** Rename `Speaker 1`, `Speaker 2`, … with `transcript_renameSpeaker` once the
   transcript says who they are; never guess a name it doesn't support. Promos, intro stings and
   music get their own label for just that stretch: `transcript_renameSpeaker` with
   `fromSec`/`toSec` (and no `from` to relabel everyone in the range, e.g. "Promo" for 0–47 s).
   A line holding two voices: `transcript_splitSegment` with `atText` (the phrase where the second
   speaker starts) or `atSec`, then rename the new piece. Sessions transcribed since the speaker
   fix split most of these automatically; for older ones with many mixed lines,
   `media_retranscribe` is cheaper than splitting by hand (it replaces manual edits — do it first).
3. **List the error patterns** before editing, each with an example and a count
   (`transcript_find` with `countOnly: true` gives per-pattern counts in one call). Typical:
   - names and brands misheard as common words or as **other key terms** ("Rotten Tom Segura",
     D'Angelo → "Deion Sanders"): search the key terms themselves to spot bleed;
   - smart formatting: spoken numbers turned into clock times ("four fifty" lb → "04:50",
     regex `\m[0-9]{2}:[0-9]{2}\M`), sponsor URLs glued together;
   - technical talk: "dr" → "doctor", "dsdt", "x2" for "x squared", "onex", "ms" for meters.
4. **Find the lines.** One `transcript_find` call with all patterns (`patterns: [...]`,
   `regex: true` uses PostgreSQL syntax, e.g. `\mdoctor\M`). The result is `{ total, lines }`;
   each line lists `matches` and `patternIndexes`; `context: 1` adds neighbours; `idsOnly: true`
   returns just `{ id, startSec, speaker }`. `\m`/`\M` treat apostrophes as word boundaries, so
   check `matches`.
5. **Fix systematic patterns with rules.** `transcript_replace` with `rules`, `dryRun: true` and
   `compact: true` returns counts per rule plus 5 trimmed samples; review, then run it again
   without `dryRun` (still `compact: true` — the full before/after of every line can be tens of KB
   on a long session). Add rules that will recur to the show with `shows_update`
   (`transcriptRules`, the full ordered list). Guest-specific fixes stay on the session.
6. **Fix one-off lines** with one `transcript_updateSegments` call (`{ segmentId, text }`,
   `compact: true`). Get ids from `transcript_find` (`idsOnly`) or `transcript_text` with
   `ids: true`.
   - Write numbers and math **as spoken** ("x squared", "dy dx"), consistently across a show.
   - Fix only clear errors; don't rephrase. If unsure, leave the line and list it.
   - Unchanged words keep their timings, so prefer small edits over rewriting lines.
   - Out-of-order or wrongly split lines: `transcript_mergeSegments` / `transcript_splitSegment`.
7. **Re-check** with the same `transcript_find` patterns (`countOnly: true`).
8. **Leave a trace.** One `Note` event per pattern family (what, how many lines, time range,
   "corrected by hand") with `events_createMany`. Fix a wrong note later with `events_updateMany`.

## Report back

A table of pattern → replacement → lines fixed → time range, the rules saved on the show, the
speaker renames and splits, and lines you left alone because you weren't sure. Each edit is in the
change log and can be undone from the session's **Agents** tab.

If an AutoLogger tool was missing, failed, or cost far too many calls or tokens along the way — or
something was left for later — file it with the `report-issue` skill when the task is done and
list the issue links in your report.
