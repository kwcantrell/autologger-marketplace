---
name: show-wiki
description: Write a session recap and keep an AutoLogger show wiki up to date — people, recurring bits and topics, linked with [[Title]]. Use when the user asks to update the wiki, write a recap, or document who/what appeared in an episode.
argument-hint: "[session]"
---

# Update the show wiki

Each show has a wiki of Markdown pages: `person`, `topic`, `bit` (recurring segments and running
jokes), `session` (one recap per session) and `question` (an answered question — the show's
knowledge base, written by the `autologger-ask` plugin). Pages link to each other with `[[Title]]`
or `[[Title|label]]`; aliases also match. The show's team also has a shared **team wiki**
(`wiki_list {teamId}`; teamId from `teams_list`) for people, bits and topics that span its shows:
a `[[Title]]` on a show page reaches a team page when the show has no page of that name, so link
team pages like any other and edit them with `wiki_upsert {teamId}` / `wiki_patch` — never create
a show page with a team page's title (that save fails with conflict).

The wiki is a knowledge base: back facts with **citations** (see Citations below).

For a whole show or many sessions at once (detailed recaps for every episode, then the shared
pages), use the `detailed-wiki` skill instead.

## Steps

1. Resolve the session; `sessions_get` gives `showId`.
2. Read the source: `transcript_text` once with `{format: "compact", stampEverySec: 0}` (paged
   for long sessions; cite times from the per-segment `[@seconds]` stamps, no second pass in lines
   format), `topics_list`, `events_list` (both return compact rows by default). No segments? The text says why (the `transcript_text` description lists each case and what to do); an empty transcript with status `done` is final: skip the session.
3. Read the wiki before writing: `wiki_list` for the show returns `{ pages, total, nextOffset }`
   (50 per page by default, `limit` up to 200; pass `offset: nextOffset` until it is null).
   `include: "summary"` adds each page's first paragraph; `include: "body"` the full text (large —
   filter by `kind` and page it) — one call instead of a `wiki_get` per page. Do the same for
   the team wiki (`wiki_list {teamId, include: "summary"}`) so you reuse its titles. Then `wiki_get` the
   pages you will change. Update existing pages — `wiki_upsert` without
   `pageId` matches by title or alias, so reuse the exact existing title.
4. Recap page: `wiki_upsert` with `kind: "session"` and `sessionId` (returns
   `{ id, title, kind, revision, unresolvedLinks, citationCount, badCitations, clampedCitations }`
   instead of echoing the page; `wiki_patch` returns the same). Include a 2–4 sentence
   summary, key moments as citation links, and `[[links]]` to people and bits. If the session
   already has a recap (often a detailed one from `detailed-wiki`, with Rundown / Best moments
   sections), don't replace it with a short one: add to it with `wiki_patch` and `baseRevision`,
   keeping its structure. `bodyMd` is
   raw Markdown stored as sent — don't JSON-escape quotes or newlines inside it.
5. People and bits: add what this session revealed (new facts, callbacks, quotes) under a dated
   heading, each with a citation, and link back to the recap. Create a page only for someone or something that will
   matter again; keep facts grounded in the transcript — never invent biography.
6. Keep each page's existing structure and tone; don't rewrite what you didn't need to change.
   For a one-line fix or an addition use `wiki_patch` (`edits: [{ find, replace }]` — each `find`
   must match exactly once — and/or `append`, which needs no `wiki_get` first) instead of
   resending the whole body. When you edit a
   page you read earlier, pass `baseRevision` (its `revision` from `wiki_get` / `wiki_list`): if
   someone saved it since, you get `conflict` and nothing is saved — re-read it, redo your edit on
   the current text and retry with the new revision, so you never overwrite their change. Every save is
   a revision the operator can restore; wiki changes can also be undone from the show's **Changes**
   page (`changes_list` with `sessionId: null` lists show-level changes, `entity` filters by kind,
   `clientName` to one agent or Companion deck; `shows_get` lists the show's `mcpClients` and
   `companionDevices`).
7. Fix citations as each save reports them (see Citations), and links too: every `wiki_upsert` /
   `wiki_patch` result lists `unresolvedLinks` — `[[links]]` in that page with no matching page
   yet. Create those pages or fix the titles as you go, or leave a link dim on purpose and say so.
   Run `wiki_lint` for the show only after a larger batch of edits, for what single saves don't
   show: pages nothing links to (`orphans`) and older broken links or citations.

## Citations

The rules every AutoLogger wiki writer follows (`detailed-wiki` and its `session-recap` agent
point here). Syntax, end-of-audio clamping and the `badCitations` codes are in the `wiki_upsert`
tool description — read it rather than guessing.

- A citation links a claim to the session range it comes from, in seconds from the session start
  (the `[@seconds]` stamps of `transcript_text`). Prefer it to a bare `HH:MM:SS`.
- On a recap use the short form for its own session, `[label](@<startSec>-<endSec>)`; on any
  other page name the session, `[label](@<sessionId>:<startSec>-<endSec>)`.
- Start at the set-up line, end where the moment ends plus ~2 s; never past the session's audio
  end (`audioSeconds` in `sessions_get`).
- A timecode label should match the range (`t`, and `to` for a range label like
  `1:01:01–1:02:00`); when it doesn't, the save rewrites that timecode to the range and lists it
  in `relabeledCitations` — a later `find` must use the stored label.
- Every specific claim gets one, checked against the transcript text you read — no facts from
  memory.
- Fix every `badCitations` entry from the save result with `wiki_patch` straight away; after a
  clamp (`clampedCitations`), later `find` strings must use the stored end.

## Formatting and links

- Tables render (GFM). Inside a table cell, escape the pipe of an aliased link: `[[Title\|label]]`.
- A `[[link]]` resolves against a page title or alias in the same show, then in the team wiki (on
  a team page: the team wiki, then a show page whose name only one show of the team uses); anything
  else renders dim as "No page named …". Before linking, `wiki_list` and reuse the exact titles.
- For a series of sessions, decide the recap titles up front (e.g. "Chapter 3: <video title>") so
  recaps can link previous/next and a hub `topic` page can list them all — or use `detailed-wiki`,
  which owns the rules for writing shared pages after many recaps.

## Report back

The pages you created and the pages you changed, one line each.

If an AutoLogger tool was missing, failed, or cost far too many calls or tokens along the way — or
something was left for later — file it with the `report-issue` skill when the task is done and
list the issue links in your report.
