---
name: knowledge-graph
description: Turn a whole AutoLogger show into a searchable knowledge graph and wiki — conventions first, then one read per session for cleanup, topics, events and a cited recap, then shared entity pages, then a verification pass — so agents can find moments and clips by person, recurring bit or theme with moments_search and graph_entity. Use when the user wants a show documented end to end, a knowledge base / RAG source / knowledge graph built from episodes, or "make this show searchable for clips".
argument-hint: "<show name or id>"
---

# Build a show knowledge graph

The wiki *is* the graph: pages are entities, `[[links]]` relations, aliases alternate names, and
every citation a **moment** — a session range described by the block (sentence, list item, table
row) that cites it and tagged with the page plus the pages linked in that block. `moments_search`
and `graph_entity` serve it live; `graph_export` and `/api/shows/<id>/export/*.jsonl|.jsonld`
download it. Full reference: `/docs/agents/knowledge-graph` on the user's server.

For one session use `show-wiki`; to only (re)write recaps and shared pages of an already-cleaned
show, `detailed-wiki` is enough. This skill is the whole pipeline.

## 0. Plan and cost

`shows_list` → `sessions_list {showId}`. Note transcript status, total audio hours, and what
already exists (`wiki_list {include: "summary"}`, `categories_list`). Tell the user the plan and
the cost before starting: roughly **120k agent tokens per hour of audio** for stage 2 (one read:
cleanup + topics + events + recap) plus ~250k per shared-pages writer. Offer a lighter level
(recaps and topics only; or only named sessions) for big shows. Make a notes folder in the
scratchpad (`<scratchpad>/kg-notes/`).

## 1. Conventions — you, once, before any parallel work

Read one representative transcript (compact, `stampEverySec: 0`) and write a **conventions
file** (`<notes>/conventions.md`) that every later agent receives:

- **Speaker roster**: names for host(s) and recurring voices, only as the transcript supports
  them; fixed labels for the rest ("Producer", "Crew", "Clip", "Music", "Guest: <name>").
- **Canonical names** of recurring segments/bits, people and running jokes, each with the
  misspellings heard. These become shared page titles and aliases in stage 3 — fix them now.
- **Show rules**: misheard show/host/site/sponsor names → `shows_update {transcriptRules}`;
  names said every episode → `keyTerms`. Apply the rules to already-transcribed sessions with
  `transcript_replace` (no `rules` = the show's).
- **Event buttons** (`categories_save`, keep existing ones): for talk shows Segment, Story,
  Funny moment, Quote, Clip played, Ad read, Plug, Callback, Note.
- **Episode order**: if titles carry the on-air number but `episode`/`episodeDate` don't match,
  say which to trust; recaps must use the trusted order.

## 2. Per session — one read (parallel)

Run the `session-document` agent, 2–4 sessions per agent, 4–6 agents at a time. Pass: showId, the
sessions (id, exact recap title, previous/next titles), the conventions file, the fixed list of
shared page titles it may link (stage 3 creates them all), and the notes folder. It reads each
transcript once and does cleanup → topics → events → recap → notes. Don't edit shared pages yet.

## 3. Shared pages (parallel, disjoint)

From the notes, create pages only for people, bits and topics in **two or more** sessions. Split
writers so no page has two writers (e.g. hub + people + topics / recurring bits). Give each the
conventions file, the notes folder and the full title list. Every shared page:

- opens with a context line and a paragraph that stands alone (show, kind, host, episodes);
- has **aliases** for every name used (conventions file + notes);
- has a **"By episode"** list: one list item per appearance, one claim each, cited with the long
  form `[EP 00:12:31](/sessions/<id>?t=<start>&to=<end>)`, `[[linking]]` every other entity in it;
- keeps uncertainty in the sentence ("spelling unconfirmed", "As of EP 16…").

The hub: what the show is, an episode guide (table **and** a prose "By episode" list — tables
chunk badly), and links to every shared page.

## 4. Verify

1. `wiki_lint` → fix unresolved links, bad citations, orphans.
2. `graph_entity` for every shared page: `momentCount` > 0; `sessions` match the notes; `related`
   sensible. 0 moments means no cited block links that page — fix the pages that mention it.
3. `moments_search` spot checks: one entity, two entities, a theme query; open 3 results'
   `startSec` with `transcript_text` to confirm the range. Fix pages, not queries.
4. A show-wide leftover check of misheard names: `search {showId, kinds: ["transcript"]}` per
   misspelling from the conventions file.

## Report

Sessions processed (topics, events, recap citations each), shared pages created, verification
results (entities with their moment counts; any with 0), open questions left in pages, and how to
use it: `graph_entity` / `moments_search` (with `mergeGapSec` for clips → `compilations_create`),
`graph_export` or the `/api/shows/<showId>/export/` files for RAG and graph databases. Every wiki
save is a revision; topics, events and transcript edits undo from each session's Agents tab.

If an AutoLogger tool was missing, failed, or cost far too many calls or tokens along the way — or
something was left for later — file it with the `report-issue` skill when the task is done and
list the issue links in your report.
