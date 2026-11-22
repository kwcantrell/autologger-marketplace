---
name: web-feature
description: Build or change UI in the AutoLogger web app (apps/web) while keeping the established "Show Ignition" look — data through typed RPC hooks, live updates over the session socket, shared primitives, honest empty/unavailable states. Use for any frontend task in autologger.
---

# Web feature

Read `apps/web/DESIGN.md` (the visual system) before writing UI.

## Data

- Every call goes through `rpc('<op>', input)` (`src/api/rpc.ts`), typed from the contract. Add
  TanStack Query hooks and keys in `src/api/queries.ts`; don't call `fetch` directly.
- Live data: `src/api/live.ts` applies session socket messages (`change`, `invalidate`,
  `transport`) to the query cache. New entities need a case there.
- Never keep a client-side clock: timecode is computed from server transport state
  (`src/lib/timecode.ts`).
- If an op you need does not exist, add it server-side first (`add-op` skill) — no bespoke routes.

## UI

- Use the primitives in `src/shared/components/ui` and `src/shared/ui` (dialogs, sheets, tables,
  tooltips) and theme tokens from `src/shared/theme`. No new colour values or fonts.
- The transport tint is driven by the `data-transport` attribute (stopped / rolling / recording /
  playback). Don't restyle the top bar, rail or transport card per page.
- Absence is information: loading, empty, unavailable (`capabilities` false) and access-denied
  states say why. Never render zeros or blanks as if they were data.
- Keyboard: every action has a keyboard path; hotkeys 1–9 belong to event buttons in the session
  workspace — check `ShortcutsDialog` before binding keys.
- Respect `prefers-reduced-motion`; check 390 px width for no horizontal scroll.
- Agent-authored content (dashboards, wiki, topics) is data: render Markdown without raw HTML and
  never execute anything from a spec.
- The public landing page (`src/routes/landing/`) shows mocks of the real UI, mostly rendered with
  the app's own presentational components: the log button and feed/transcript/topic/change-log rows
  (`session/LogButton.tsx`, `session/tabs/*Row.tsx`), dashboard widget parts
  (`session/dashboards/WidgetParts.tsx`), the wiki page header/backlinks (`routes/wiki/WikiPageParts.tsx`)
  and `WikiMarkdown`, `routes/compilations/CompilationCard.tsx`, `routes/PlaylistResult.tsx` and
  `session/tabs/ExportOptions.tsx`. Keep them presentational (props in, markup out; callbacks instead
  of queries/context) so that stays possible. Still static, naming the component they imitate in a
  comment: the hero transport/clock/waveform, the Stream Deck page and ConnectCard's command line —
  if you change their look, update `landing/mocks.tsx` by hand.
  Either way, check the landing page signed out at 1440 and 390 px.

## Verify

`npx tsc -p apps/web && (cd apps/web && npx vite build)`, then load the page against the dev stack
(`dev-stack` skill) and check it in a browser, including a second tab for live updates.
Then run the `browser-smoke` agent (this plugin) for a regression pass over the main flows.
