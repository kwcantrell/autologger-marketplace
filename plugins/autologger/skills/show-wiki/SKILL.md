---
name: show-wiki
description: Write a session recap and keep an AutoLogger show wiki up to date — people, recurring bits and topics, linked with [[Title]]. Use when the user asks to update the wiki, write a recap, or document who/what appeared in an episode.
argument-hint: "[session]"
---

# Update the show wiki

Each show has a wiki of Markdown pages: `person`, `topic`, `bit` (recurring segments and running
jokes) and `session` (one recap per session). Pages link to each other with `[[Title]]` or
`[[Title|label]]`; aliases also match.

## Steps

1. Resolve the session; `sessions_get` gives `showId`.
2. Read the source: `transcript_text`, `topics_list`, `events_list`.
3. Read the wiki before writing: `wiki_list` for the show, then `wiki_get` on every page you might
   touch. Update existing pages — `wiki_upsert` without `pageId` matches by title or alias, so
   reuse the exact existing title.
4. Recap page: `wiki_upsert` with `kind: "session"` and `sessionId`. Include a 2–4 sentence
   summary, key moments with `HH:MM:SS` times, and `[[links]]` to people and bits.
5. People and bits: add what this session revealed (new facts, callbacks, quotes) under a dated
   heading, and link back to the recap. Create a page only for someone or something that will
   matter again; keep facts grounded in the transcript — never invent biography.
6. Keep each page's existing structure and tone; don't rewrite what you didn't need to change.
   Every save is a revision the operator can restore.

## Formatting and links

- Tables render (GFM). Inside a table cell, escape the pipe of an aliased link: `[[Title\|label]]`.
- A `[[link]]` resolves only against an exact page title or alias in the same show; anything else
  renders dim as "No page named …". Before linking, `wiki_list` and reuse the exact titles.
- For a series of sessions, decide the recap titles up front (e.g. "Chapter 3: <video title>") so
  recaps can link previous/next and a hub `topic` page can list them all. Write shared pages
  (people, the hub, recurring bits) once, after the recaps — not in parallel from several agents.

## Report back

The pages you created and the pages you changed, one line each.
