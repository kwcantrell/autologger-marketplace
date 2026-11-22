---
name: first-tasks
description: Curated starter tasks for new AutoLogger contributors, sized and pointed at the files involved, with how to verify each. Use when a contributor asks what they could work on, wants a good first issue, or has time to help.
---

# Good first tasks

Before suggesting a task, check it is still open: look at the referenced code (and `git log`,
open issues/PRs if the repo has a remote). Drop tasks that are done; mention anything new you
notice instead. Ask about the contributor's interests (backend, UI, hardware, docs) and offer
2–3 that fit. Each task should end with the `contribute` workflow.

## Small (an afternoon)

1. **Shrink the main web chunk** — routes and the dashboards renderer (recharts) are already
   lazy-loaded, but the main chunk is still ~790 kB. Find what is in it (`npx vite build` with a
   bundle visualizer such as `rollup-plugin-visualizer`), then lazy-load heavy pieces that the first
   screen does not need (Markdown rendering, the command palette, settings) or split stable vendor
   code with `build.rollupOptions.output.manualChunks`. Verify: chunk sizes before/after in the PR,
   every route still loads.

## Medium (a few days)

2. **Keep wiki history on delete** — `wiki.delete` hard-deletes, so revisions cascade away and undo
   restores a page without history. Switch to a soft delete (`deleted_at`) filtered out of list,
   get, search and title matching. Files: `db/schema.ts` (via `schema-change`), `ops/wiki.ts`,
   `ops/search.ts`, `ops/changes.ts`. Verify: delete → undo → revisions intact (test).
3. **Clean up abandoned uploads** — `media.createUpload` rows that never complete stay
   `uploading` forever. Add a periodic sweep in the worker that deletes rows (and objects) older
   than a day. Files: `apps/server/src/worker/`, `apps/server/src/media/`. Verify: unit test of the
   sweep query + a manual run.
4. **Companion presence across instances** — `online` is tracked in memory per process. Publish
   connect/disconnect on the bus (`core/bus.ts`) so any instance can answer. Verify: two servers,
   device connected to one, `companion.list` on the other.
5. **Show-level change log** — changes that belong to a show rather than a session (show wiki
   pages, event buttons) are recorded with no `sessionId`, so no session's Agents tab lists them and
   the web app has no Undo button for them (`changes.revert` works over the API and MCP). Add a
   change log to the show's wiki or settings view using `changes.list {showId}`, filtered to
   show-level changes, with the same Undo flow as the Agents tab. Files: `apps/web/src/routes/wiki/`
   or `apps/web/src/settings/`, reusing `apps/web/src/session/tabs/AgentsTab.tsx`. Verify: delete a
   show wiki page, undo it from the new view, revisions intact.

## Larger (needs design notes first)

6. **Waveform on the timeline** — compute peaks in the worker after upload (ffmpeg is in the
   image), store them, and draw them in `apps/web/src/session/Timeline.tsx`.
7. **End-to-end smoke tests** — a few Playwright tests: sign in with the dev login, create a
   session, log an event with a hotkey, see it in a second tab.
8. **Real Deepgram integration test** — opt-in test (skipped without `DEEPGRAM_API_KEY`) that
   transcribes a short fixture end to end.
