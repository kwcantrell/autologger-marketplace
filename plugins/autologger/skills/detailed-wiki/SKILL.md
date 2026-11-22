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
4. Tell the user the plan and the size (N sessions, ~K agents) before starting a large show.

## 1. Recaps — in parallel

Run the `session-recap` agent once per session, several per message (about 4–6 at a time; for big
shows give one agent 3–4 sessions). Pass each: showId, sessionId(s), the exact recap title(s),
previous/next recap titles, and the list of existing page titles it may link. Each agent reads the
whole transcript, rewrites only its recap and returns **notes for shared pages** with citations.

Collect every agent's notes in one scratch file as they arrive (host facts, guest facts, other
people, bit appearances, recurring themes, candidate new pages). Don't edit shared pages yet.

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

Give both the notes file, the fixed list of new page titles (both may link them) and these rules:
read before writing; keep titles, aliases and voice; organise by theme with a short "By episode"
list where useful; convert bare timecodes to citations; never invent facts; `compact: true`;
`wiki_patch` for small edits.

The hub page: what the show is, an episode guide table (`[[recap]]` + one line each), and sections
linking recurring people, topics, bits and question pages.

## Citations (all pages)

`[HH:MM:SS](/sessions/<sessionId>?t=<startSec>&to=<endSec>)` — seconds from the session start (the
`@seconds` of `transcript_text`), `t` at the set-up line, `to` where the moment ends (+~2 s), never
past the session's audio end. They render as chips that play the range. Every specific claim gets
one.

## 4. Check and report

`wiki_lint` for the show: fix `unresolved` links, `badCitations` and `orphans` (link orphans from
the hub or a topic). Report: recaps rewritten (with citation counts), shared pages updated, new
pages created, anything skipped. Mention the user can now ask questions with the `autologger-ask`
plugin, whose answers cite these pages' sessions, and that every save can be restored from the
page's revisions.

If an AutoLogger tool was missing, failed, or cost far too many calls, file it with the
`report-issue` skill when done.
