---
name: knowledge-graph
description: The full pipeline that makes a whole AutoLogger show searchable as a knowledge graph — show-wide conventions first, then one read per session for transcript cleanup, topics, events and a recap written as findable moments, then shared entity pages, then a check with graph_entity and moments_search — so agents can find moments and clips by person, recurring bit or theme. Use when the user wants a knowledge graph, a RAG source, "make this show searchable for clips", or a show processed end to end including cleanup, topics and events. For recaps and shared wiki pages only (transcripts already clean), use detailed-wiki.
argument-hint: "<show name or id>"
---

# Build a show knowledge graph

The wiki *is* the graph: pages are entities, `[[links]]` relations, aliases alternate names, and
every citation a **moment** — a session range described by the sentence that cites it and tagged
with the page plus the pages linked in that sentence. `moments_search` and `graph_entity` serve it
live; `graph_export` and `/api/shows/<id>/export/*.jsonl|.jsonld` download it. Reference:
`/docs/agents/knowledge-graph` on the user's server.

**Needs the knowledge-graph tools** (`moments_search`, `graph_entity`). If the server's tool list
doesn't have them, say so and offer `detailed-wiki` instead.

For one session use `show-wiki`; for recaps and shared pages of an already-clean show,
`detailed-wiki`. This skill is the whole pipeline.

## 0. Plan and cost

`shows_list` → `sessions_list {showId}`. Skip sessions whose `transcriptStatus` isn't `done`
(transcribe them first, or leave them out) and say which. Note total audio hours and what exists:
`wiki_list {include: "summary"}` (existing recap titles and their aliases), `categories_list`.

Tell the user the plan and the cost before starting: about **120k agent tokens per hour of
audio** for stage 2 (cleanup + topics + events + recap from one read) plus ~250k per shared-pages
writer — e.g. 17 one-hour episodes ≈ 2M + 0.5M. Offer a lighter level for big shows (recaps and
topics only, or only named sessions). Make a notes folder in the scratchpad (`<scratchpad>/kg-notes/`).

## 1. Conventions — you, once, before any parallel work

Read one representative transcript (compact, `stampEverySec: 0`) and write
`<notes>/conventions.md`, which every later agent receives:

- **Speaker roster**: names for host(s) and recurring voices, only as the transcript supports
  them; fixed labels for the rest ("Producer", "Crew", "Clip", "Music", "Guest: <name>").
- **Canonical names** of recurring segments/bits, people and running jokes, each with the
  misspellings heard — these become shared page titles and aliases in stage 3; fix them now.
  Aliases also tag topics, events and transcript lines that mention them, so only specific names:
  no bare first names ("Tom"), no generic words ("the show", "Producer", "the special").
- **Show rules**: misheard show/host/site/sponsor names → `shows_update {transcriptRules}`;
  names said every episode → `keyTerms`. Apply the rules to already-transcribed sessions with
  `transcript_replace` without `rules`.
- **Event buttons** (`categories_save`, keeping existing ones): for talk shows Segment, Story,
  Funny moment, Quote, Clip played, Ad read, Plug, Callback, Note.
- **Episode order**: when titles carry the on-air number but `episode`/`episodeDate` disagree,
  say which to trust; recaps use the trusted order.

## 2. Per session — one read (parallel)

Run the `session-document` agent, 2–4 sessions per agent, 4–6 agents at a time. Pass: showId; per
session its id, exact recap title, the existing recap's aliases (if any) and previous/next titles;
the conventions file; the fixed list of shared page titles it may link (stage 3 creates them all);
the notes folder. Don't edit shared pages yet.

## 3. Shared pages

Follow `detailed-wiki` sections 2–3 (planning, disjoint writers, reading before writing,
`baseRevision`, fact checks), with these additions:

- create pages only for people, bits and topics in **two or more** sessions, titled per the
  conventions file; a topic page holds what its segment pages don't (e.g. *Air Travel* gathers
  airline talk outside *Flight Log* and links there for the segment's stories) — never two pages
  with the same items;
- **aliases: specific names only** — nicknames and real alternate spellings, including ones the
  transcript itself uses ("Skank Fest"). No generic words ("the show", "Producer"), no bare first
  names, no URLs or handles, no mishearings (those belong in show rules);
- **cross-episode synthesis first** — every shared page opens with what a reader can't get from
  any single episode, each statement cited to the episodes it rests on:
  - segment pages: **Format** (what happens, who reads, how it ends, how it changed),
    **Running threads** (stories, predictions and callbacks that span episodes — e.g. "Frontier
    is next", proved right later), **Episodes without** it (listed), **Notable lines**;
  - person pages: themes as synthesis ("Joe DeRosa says he is 48 (VAH_0005, VAH_0009, VAH_0012)"
    — one item with several citations, not one item per mention), how the person's role
    changes over the run, relationships to other entities;
  - topic pages: the recurring positions and how they develop, then the items;
  - the hub: format, schedule, sponsors and contact details said on air, how the show evolves,
    segment debuts, dating clues, then the episode guide **once** (a table with summaries and
    segments);
- **then the detail**: one list item per **story, letter, headline, quote or fact** with its
  **own tight citation** (the stretch where it is said, usually under ~2 minutes; often a setup
  and a punchline range), `[[linking]]` every other person, bit and topic page it mentions, every
  time, and **naming its subject** ("Joe DeRosa says…", never "He…"). Each fact **once**: segment
  pages by episode; person and topic pages by theme with a short "Appearances" list of episode
  links. A fact said in several episodes is one item with several citations; no citation twice in
  one item;
- framing only as the transcript supports it (a crew member who chimes in is not a "co-host");
- writers work from the recaps and notes but **open `transcript_text` around every range they
  cite** to tighten it to the item and to check names and numbers — the notes' ranges are often
  segment-wide.

## 4. Verify

1. `wiki_lint` → fix unresolved links, bad citations, orphans.
2. `graph_entity` for every shared page: `momentCount` > 0; `sessions` match the notes; `related`
   sensible. 0 moments means no cited sentence links that page — fix the pages that mention it.
   Then count each entity's topic and event tags (`graph_export {section: "moments"}`): one that
   tags a large share of them (a crew page on every event, the hub on everything) has a generic
   alias — remove it with `wiki_upsert`.
3. `moments_search` spot checks: one entity, two entities, a theme query; open three results'
   `startSec` with `transcript_text` to confirm the range. Fix pages, not queries.
4. Wide citations: in `graph_export {section: "moments"}`, citations on shared pages longer than
   ~3 minutes are segment-wide, not moments — split them into per-item citations. Also check
   that shared-page moments link other entities (their `entities` list more than the page
   itself), that no page repeats the same items in two sections or another page's items, and
   that every shared page opens with its cross-episode synthesis.
5. Leftover misheard names: `search {showId, kinds: ["transcript"]}` per misspelling in the
   conventions file.

## Report

Sessions processed (topics, events, recap citations each) and skipped, shared pages created or
updated, verification results (entities with moment counts; any with 0), open questions left in
pages, and how to use it: `graph_entity` / `moments_search` (with `mergeGapSec` for clips →
`compilations_create`), `graph_export` or the `/api/shows/<showId>/export/` files for RAG and graph
databases. Undo: transcript, topic and event changes from each session's **Agents** tab; wiki
pages, show rules and event buttons from the show's **Changes** page (and page revisions).

If an AutoLogger tool was missing, failed, or cost far too many calls or tokens along the way — or
something was left for later — file it with the `report-issue` skill when the task is done and
list the issue links in your report.
