---
name: ask
description: Answer a question about an AutoLogger show from its sessions — "what has Tom said about pricing", "every time they talked about the dog", "how did the guest get started" — with timecode ranges in each session that relate to it, save the answer to the show wiki as a cited knowledge-base page, and offer a video compilation of the ranges when the sessions came from YouTube. Use for any question about what was said or happened across a show's episodes.
argument-hint: "<question> [in <show>]"
---

# Ask the show

Answer from the show's sessions, cite every claim with a time range, and keep the answer in the
show's knowledge base (its wiki) so the next question starts from it. Uses the AutoLogger MCP
tools from the `autologger` plugin; if they are missing, tell the user to install and sign in to
that plugin (`/mcp`).

## 1. Resolve the show

`shows_list` and match the show the user named (or the only show they can see). If several fit,
ask which one. Note `showId`.

## 2. Knowledge base first

- `wiki_list` with `showId`, `kind: "question"`, `include: "summary"`: a page whose title asks the
  same thing (or close) may already answer it. Also `search` the question's key words with
  `kinds: ["wiki"]`.
- If a question page answers it, reuse its citations, check whether sessions newer than the page's
  last update could add anything (step 3 on just those sessions), and update the page instead of
  starting over.
- Once you know the candidate sessions, `wiki_list` with `citesSession: <sessionId>` lists the
  pages already citing each one (with their ranges) — reuse them instead of re-reading.
- Person, topic and bit pages often summarise the answer and point at sessions — use them to
  narrow the search, but cite the session ranges, not the wiki page.

## 3. Find the ranges

1. `search` with `showId` and 3–5 phrasings (names, key nouns, synonyms, how a speaker would
   actually say it). Hits carry `sessionId`, `atSec` and `endSec`
   (transcript line end or topic end; null for events) — a first guess at the range.
2. `topics_list` for sessions with hits — a topic's `startSec`/`durationSec` often bounds the whole
   discussion; topic summaries also catch paraphrases text search misses.
3. For each promising hit read context with `transcript_text` (`fromSec = atSec - 90`,
   `toSec = atSec + 180`, `format: "compact"`), and set the range precisely:
   - start at the first line of the relevant exchange (the question or set-up), end where the
     conversation moves on; add ~2 s padding at both ends;
   - merge ranges in the same session less than ~30 s apart;
   - drop passing mentions unless the user asked for every mention.
4. Paraphrase-heavy question or many sessions (more than ~6 with no clear hits)? Run the
   `session-scan` agent on each candidate session **in parallel** (one Agent call per session in
   a single message) with the question, `sessionId` and any search hits; it returns ranges with
   quotes. Pick candidates from search hits, topic summaries and wiki pages — don't scan a
   100-session show blindly; say what you skipped.

Ranges are seconds from the session start, the same `@seconds` values `transcript_text` prints.

## 4. Answer

Group by session (most relevant first, or chronological if the user asks "how did X change"):

```
### <Session title> — <episode date>  (YouTube | recorded)
- 00:12:30–00:15:10 · Tom explains why he dropped the free tier — "we were paying people to leave"
- 00:41:02–00:42:20 · …
```

Then a 2–5 sentence synthesis that answers the question, citing sessions by title. Say plainly
what you searched and what you did not find. Never put a claim in the answer that no range
supports.

## 5. Save to the knowledge base

Unless the user said not to, `wiki_upsert` a `question` page (`compact: true`) in the show:
- `title`: the question, phrased generally ("What does Tom think about free tiers?"); reuse the
  exact title of an existing question page to update it (then pass `baseRevision` = the revision
  you read; on `conflict` re-read it and merge your answer into the current text).
- `bodyMd`: the synthesis, then `## Where it comes up` with one bullet per range as a citation link
  `[<session title> 00:12:30–00:15:10](@<sessionId>:750-910) — what happens` (short form; the long
  `/sessions/<sessionId>?t=750&to=910` link also works)
  (`t`/`to` in seconds), then `[[links]]` to the person/topic/bit pages involved.
- Link back: if a person or topic page is central, `wiki_patch` it to add
  `- [[<question title>]]` under a `## Questions` heading (append if missing).
- The save result lists `badCitations` (`unknown_session`, `bad_range`, `past_end`,
  `label_mismatch`); fix them with `wiki_patch`. `clampedCitations` lists ends that were clamped (stored `endSec` vs `sentEndSec`): a later `wiki_patch` `find` must use the stored end. Then run `wiki_lint` for any link it reports.

Mention that the page is in the show's wiki and every save is a revision the user can restore.

## 6. Offer a compilation

`sessions_get` each cited session: if any have `sourceKind: "youtube"`, offer — once, with the
numbers — "Make a video of these N clips (~M min) from the YouTube sessions?" If the user already
asked for a video, don't ask; go ahead. Then follow the `compile-clips` skill with the ranges
(non-YouTube sessions can't be included; say which were left out).

If an AutoLogger tool was missing, failed, or cost far too many calls along the way, file it with
the `autologger:report-issue` skill when done and list the issue links.
