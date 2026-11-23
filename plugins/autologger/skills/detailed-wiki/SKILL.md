---
name: detailed-wiki
description: Build or rebuild a detailed, cited wiki for a whole AutoLogger show (or a batch of sessions) — an in-depth recap per session where every segment, story and quote cites the session range it comes from, then the show-wide pages (host, recurring people, guests, bits, topics and a hub with an episode guide) updated from those recaps. Use when the user asks for "detailed wikis for each session", to document or fill out a whole show's wiki, to turn the wiki into a knowledge base, or to refresh it after importing many episodes.
argument-hint: "<show> [sessions]"
---

# Detailed show wiki

For one session at a time, `show-wiki` is enough. This skill handles a whole show: it reads every
transcript in full, writes detailed cited recaps in parallel, then merges what they found into the
shared pages in one careful pass. Every save is a wiki revision the user can restore; tell them so.

## 0. Scope and plan

1. `shows_list` → `showId`; `sessions_list` for the show (or the sessions the user named). Skip
   sessions whose transcript isn't done (`transcriptStatus`) and say which.
2. `wiki_list` with `include: "summary"` (page through `nextOffset`): note existing recap titles
   (kind `session`, tied to `sessionId`), people, topics, bits and question pages, with exact titles.
3. Decide the recap title pattern now (reuse the existing one, e.g. `Ep 4: <Guest>`), so recaps can
   link previous/next and the hub can list them.
4. Tell the user the plan and the cost before starting: N sessions, ~K agents, and roughly 60–70k
   agent tokens per hour of audio for recaps plus ~250k per shared-pages agent (19 one-hour
   episodes ≈ 1.3M + 0.5M). For a large show offer a lighter level: shorter recaps (rundown and best
   moments only) or only the sessions they name.
5. Create a notes folder for this run (e.g. `<scratchpad>/wiki-notes/`); recap agents write their
   notes there, one file per session.

## 1. Recaps — in parallel

Run the `session-recap` agent once per session, several per message (about 4–6 at a time; for big
shows give one agent 3–4 sessions). Pass each: showId, sessionId(s), the exact recap title(s),
previous/next recap titles, the list of existing page titles it may link, and the notes folder. Each
agent reads the whole transcript, rewrites only its recap, writes **notes for shared pages** (with
citations) to `<notes folder>/<sessionId>.md` and returns only a short summary. Don't edit shared
pages yet.

## 2. Plan the shared pages

From the notes, decide:
- updates to existing pages: the host(s), recurring people, guests, bits, topics, the hub;
- **new pages** only for people, topics and bits that come up in **two or more** sessions; fix their
  exact titles and kinds now (e.g. "Tom's weight" topic, "Joe Rogan" person, "Be funny!" bit).

## 3. Shared pages — disjoint agents

Writers of shared pages must never edit the same page. Split them, for example:
- **show-wide agent**: host and recurring people, bits, topics, the hub, and creating every new page;
- **guest agent**: one page per guest (who they are as said on the show, highlights from their
  episode, mentions in other episodes found with `search`, links to topic pages).

Give both the notes folder, the fixed list of new page titles (both may link them) and these rules:
read before writing; keep titles, aliases and voice; organise by theme with a short "By episode"
list where useful; convert bare timecodes to citations; never invent facts; `compact: true`;
`wiki_patch` for small edits; `baseRevision` (the revision you read) on every edit of an
existing page, and on `conflict` re-read and redo rather than overwrite; check every fact against the recap or `transcript_text` before saving
— drop what can't be confirmed rather than keep it.

The hub page: what the show is, an episode guide table (`[[recap]]` + one line each), and sections
linking recurring people, topics, bits and question pages.

## Citations (all pages)

On recaps the short form `[HH:MM:SS](@<startSec>-<endSec>)` (the recap's own session; bare
`[@<startSec>-<endSec>]` without a label); on shared pages `[label](@<sessionId>:<startSec>-<endSec>)`.
Seconds from the session start (the `@seconds` of `transcript_text`), `t` at the set-up line, `to`
where the moment ends (+~2 s), never past the session's audio end (up to 5 s over is clamped). A
timecode label must match `t`. They render as chips that play the range. Every specific claim gets
one. Every save returns the page's `citationCount`, `badCitations` (fix as you go) and
`clampedCitations` (ends trimmed to the audio; later `wiki_patch` finds must use the stored end).
For progress, `wiki_list` with `citesSession`, `countOnly: true` and `limit: 1` gives `total`
(citing pages) and `citationTotal` per session without pulling every range.

## Accuracy

Agents tend to fill gaps from memory. Require that every paragraph is checked against
`transcript_text` before saving, that speakers are attributed by content (diarization can merge or
swap speakers), and that names not in the transcript are left out. A `[[link]]` to a page that
doesn't exist is reported as a candidate page, not silently deleted.

## 4. Check and report

`wiki_lint` for the show: fix `unresolved` links, `badCitations` and `orphans` (link orphans from
the hub or a topic). Report: recaps rewritten (with citation counts), shared pages updated, new
pages created, anything skipped. Mention the user can now ask questions with the `autologger-ask`
plugin, whose answers cite these pages' sessions, and that every save can be restored from the
page's revisions or undone from the show's **Changes** page.

If an AutoLogger tool was missing, failed, or cost far too many calls, file it with the
`report-issue` skill when done.
