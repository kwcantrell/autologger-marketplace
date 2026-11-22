---
name: transcript-cleanup
description: Fix systematic mistakes in a machine transcript of an AutoLogger session — misheard terms, mangled numbers and math, generic speaker labels — and record what was changed. Use when the user asks to clean up, correct or proofread a transcript, when a transcript has repeated errors (e.g. "doctor" for "dr"), or before generating topics, events or recaps from a technical talk.
argument-hint: "[session] [known errors, e.g. \"doctor\" should be \"dr\"]"
---

# Clean up a session transcript

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
4. **Find the segment ids.** `transcript_text` has no ids. For each line to fix, call
   `transcript_get` with a narrow window around its `@seconds` (`fromSec` = @s − 0.05,
   `toSec` = @s + 0.05) and take the segment `id`. Its response includes word timings, so keep the
   window small.
5. **Fix each line** with `transcript_updateSegment` (the full corrected text):
   - Write math and numbers **as they were spoken** ("x squared", "dy dx", "one over x",
     "e to the three t"), not as symbols. Use the same convention across every session of a show.
   - Fix only clear transcription errors. Don't rephrase, tidy grammar or add words you can't
     infer with confidence from the sentence itself. If unsure, leave the line and list it.
   - Each edit replaces the segment's word timings with evenly spaced ones, so edit only lines
     that are actually wrong.
6. **Re-read** the affected ranges with `transcript_text` to confirm no instance of each pattern
   remains.
7. **Leave a trace.** Log one `Note` event per pattern (what, how many lines, time range,
   "corrected by hand") with `events_createMany`, so editors know captions were changed.

## Report back

A table of pattern → replacement → lines fixed → time range, the speaker renames, and any lines you
left alone because you weren't sure. Mention that each edit is in the change log and can be undone
from the session's **Agents** tab.
