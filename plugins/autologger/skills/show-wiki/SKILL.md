---
name: show-wiki
description: Write a session recap and keep an AutoLogger show wiki up to date — people, recurring bits and topics, linked with [[Title]]. Use when the user asks to update the wiki, write a recap, or document who/what appeared in an episode.
argument-hint: "[session]"
---

# Update the show wiki

Each show has a wiki of Markdown pages: `person`, `topic`, `bit` (recurring segments and running
jokes), `session` (one recap per session) and `question` (an answered question — the show's
knowledge base, written by the `autologger-ask` plugin). Pages link to each other with `[[Title]]`
or `[[Title|label]]`; aliases also match.

The wiki is a knowledge base: back facts with **citations** — a Markdown link to the session
range they come from, `[short label](/sessions/<sessionId>?t=<startSec>&to=<endSec>)` (seconds as
in `transcript_text`'s `@seconds`). They render as chips that play that range. Prefer a citation
to a bare `HH:MM:SS`.

## Steps

1. Resolve the session; `sessions_get` gives `showId`.
2. Read the source: `transcript_text` (`format: "compact"`, paged for long sessions),
   `topics_list`, `events_list` (`compact: true`).
3. Read the wiki before writing: `wiki_list` for the show returns `{ pages, total, nextOffset }`
   (50 per page by default, `limit` up to 200; pass `offset: nextOffset` until it is null).
   `include: "summary"` adds each page's first paragraph; `include: "body"` the full text (large —
   filter by `kind` and page it) — one call instead of a `wiki_get` per page. Then `wiki_get` the
   pages you will change. Update existing pages — `wiki_upsert` without
   `pageId` matches by title or alias, so reuse the exact existing title.
4. Recap page: `wiki_upsert` with `kind: "session"`, `sessionId` and `compact: true` (returns
   `{ id, revision, unresolvedLinks }` instead of echoing the page). Include a 2–4 sentence
   summary, key moments as citation links, and `[[links]]` to people and bits. `bodyMd` is
   raw Markdown stored as sent — don't JSON-escape quotes or newlines inside it.
5. People and bits: add what this session revealed (new facts, callbacks, quotes) under a dated
   heading, each with a citation, and link back to the recap. Create a page only for someone or something that will
   matter again; keep facts grounded in the transcript — never invent biography.
6. Keep each page's existing structure and tone; don't rewrite what you didn't need to change.
   For a one-line fix or an addition use `wiki_patch` (`edits: [{ find, replace }]` — each `find`
   must match exactly once — and/or `append`) instead of resending the whole body. Every save is
   a revision the operator can restore.
7. Check links: `wiki_lint` for the show lists every `[[link]]` with no matching page
   (`unresolved`), pages nothing links to (`orphans`) and broken citations (unknown session, bad
   range). Fix titles, or leave a link dim on
   purpose and say so.

## Formatting and links

- Tables render (GFM). Inside a table cell, escape the pipe of an aliased link: `[[Title\|label]]`.
- A `[[link]]` resolves only against an exact page title or alias in the same show; anything else
  renders dim as "No page named …". Before linking, `wiki_list` and reuse the exact titles.
- For a series of sessions, decide the recap titles up front (e.g. "Chapter 3: <video title>") so
  recaps can link previous/next and a hub `topic` page can list them all. Write shared pages
  (people, the hub, recurring bits) once, after the recaps — not in parallel from several agents.

## Report back

The pages you created and the pages you changed, one line each.

If an AutoLogger tool was missing, failed, or cost far too many calls or tokens along the way — or
something was left for later — file it with the `report-issue` skill when the task is done and
list the issue links in your report.
