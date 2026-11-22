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

1. **Lint clean-up** — `npx biome check .` reports ~150 errors, mostly formatting and import order.
   `npx biome check --write .` fixes those safely; the ~16 real findings (`noExplicitAny`,
   `useExhaustiveDependencies`, duplicate CSS properties) need a look each. Verify: lint clean,
   typecheck and tests green. Keep it to one PR per area (server / web / companion) so reviews stay
   readable.
2. **Session date in search results** — `SearchHit` has `sessionTitle` but no date, so identical
   titles are ambiguous. Add `sessionDate` in `packages/contract/src/entities.ts`, select it in
   `apps/server/src/ops/search.ts`, show it in `apps/web/src/routes/search/`. Verify: a search test
   plus the search page.
3. **Split the web bundle** — the main chunk is ~790 kB. Lazy-load routes and the dashboards
   renderer (recharts) with `React.lazy`. Verify: `npx vite build` chunk sizes, pages still load.

## Medium (a few days)

4. **Keep wiki history on delete** — `wiki.delete` hard-deletes, so revisions cascade away and undo
   restores a page without history. Switch to a soft delete (`deleted_at`) filtered out of list,
   get, search and title matching. Files: `db/schema.ts` (via `schema-change`), `ops/wiki.ts`,
   `ops/search.ts`, `ops/changes.ts`. Verify: delete → undo → revisions intact (test).
5. **Clean up abandoned uploads** — `media.createUpload` rows that never complete stay
   `uploading` forever. Add a periodic sweep in the worker that deletes rows (and objects) older
   than a day. Files: `apps/server/src/worker/`, `apps/server/src/media/`. Verify: unit test of the
   sweep query + a manual run.
6. **Companion presence across instances** — `online` is tracked in memory per process. Publish
   connect/disconnect on the bus (`core/bus.ts`) so any instance can answer. Verify: two servers,
   device connected to one, `companion.list` on the other.

## Larger (needs design notes first)

7. **Waveform on the timeline** — compute peaks in the worker after upload (ffmpeg is in the
   image), store them, and draw them in `apps/web/src/session/Timeline.tsx`.
8. **End-to-end smoke tests** — a few Playwright tests: sign in with the dev login, create a
   session, log an event with a hotkey, see it in a second tab.
9. **Real Deepgram integration test** — opt-in test (skipped without `DEEPGRAM_API_KEY`) that
   transcribes a short fixture end to end.
