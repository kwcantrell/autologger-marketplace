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
  `transport`) to the query cache; `src/api/liveShow.ts` does the same for the show socket (jobs,
  sessions, compilations, changes, devices). New entities need a case there.
- Never keep a client-side clock: timecode is computed from server transport state
  (`src/lib/timecode.ts`). The clock and playhead are external stores (`useTransportClockStore`):
  subscribe in the small leaf that shows them, never high in the tree — reading them in a page
  component re-renders the whole session every frame.
- If an op you need does not exist, add it server-side first (`add-op` skill) — no bespoke routes.

## Design tools

`autologger-dev` brings two design aids. Both serve `DESIGN.md`, never the other way round.

- **impeccable** (a plugin dependency, installed with `autologger-dev`): one skill with
  subcommands, `/impeccable:impeccable <command>` (or `/impeccable <command>` if installed with
  `npx impeccable install`). Useful here: `shape` to plan a screen before code; `critique`
  (scored UX review) and `audit` (technical quality) on a finished screen; `polish`, `harden`
  (errors, overflow, edge cases), `adapt` (phone/tablet), `clarify` (copy), `onboard` (empty
  states and first run), `layout` and `typeset` for targeted fixes. Treat its advice as input:
  anything that conflicts with `DESIGN.md` (new colours, fonts, glows, gradients, decorative
  motion) loses. Don't run `init`, `document` or `extract` without asking — they write
  `PRODUCT.md` / `DESIGN.md` and would overwrite the design contract.
- **shadcn/ui MCP server** (`shadcn`, bundled with `autologger-dev`, reads
  `apps/web/components.json`): search, view and get examples of registry components and the
  `add` command for one (`search_items_in_registries`, `view_items_in_registries`,
  `get_item_examples_from_registries`, `get_add_command_for_items`, `get_audit_checklist`). The
  project is shadcn on **Base UI** (`base-nova`): use `render`, not Radix `asChild`; toasts are
  `sonner` as already used here. Add a new primitive only when `src/shared/components/ui` lacks
  it, run the add command from `apps/web`, then restyle it to the `--si-*` tokens and DESIGN.md
  radii/type before use; never overwrite an existing primitive with the registry version.

## UI

- Use the primitives in `src/shared/components/ui` and `src/shared/ui` and theme tokens from
  `src/shared/theme`. No new colour values or fonts, and no hand-built controls:
  - tooltips: `shared/ui/Tooltip` (`shared` for list rows, `titleWhenDisabled` for disabled
    controls) — never a native `title` on a control;
  - links that are actions: `Button variant="link" size="inline"`, icon/row buttons through
    `Button` variants — no raw `<button>`/`<a>` styling;
  - tables from the `table` parts; selects `NativeSelect` (or `Select`); inputs with addons
    `InputGroup`; disclosure `Collapsible`; progress `Progress`; key hints `Kbd`;
  - load errors `LoadErrorAlert`, route-level loading/missing/denied `components/RouteState`.
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
  `session/tabs/ExportOptions.tsx` and ConnectCard's `session/tabs/CopyRow.tsx`. Keep them presentational (props in, markup out; callbacks instead
  of queries/context) so that stays possible. Still static, naming the component they imitate in a
  comment: the hero transport/clock/waveform and the Stream Deck page —
  if you change their look, update the mock by hand.
  The hero mock is in `landing/heroMock.tsx`; the feature mocks in `landing/mocks.tsx` and
  `landing/wikiMocks.tsx` (the only ones that pull in react-markdown) load lazily near the
  viewport, behind placeholders whose heights are set per mock in `LandingPage.tsx` — if you
  change a mock's size, re-measure it at 390, 800, 1024 and 1440 px — plus 1116 px, the
  `min-[69.75rem]` step, for the Logging, Transcript, Topics and Compilations mocks — and update
  those heights.
  Either way, check the landing page signed out at 1440 and 390 px.
- Docs live in the repo's `docs/` folder and are served at `/docs`: `docs/guide/<slug>.md` (users),
  `docs/agents/<slug>.md` (agents & MCP), `docs/developers/<slug>.md` (developers), each with front matter
  (`title`, `section` = folder, `order`, `description`); files without front matter aren't published and
  bad front matter fails the web build. Link pages as `/docs/<section>/<slug>`, anchors keep hyphens.
  Renamed a label, added a setting or changed a flow? Update the matching `docs/guide/` page in the
  same PR. Renaming a page's slug also means updating `DOC_PAGES` in `src/lib/docsLinks.ts`. The docs pages reuse the landing header/footer (`routes/landing/chrome.tsx`).

## Verify

`npm run typecheck -w @autologger/web && npm test -w @autologger/web && (cd apps/web && npx vite build)`, then load the page against the dev stack
(`dev-stack` skill) and check it in a browser, including a second tab for live updates.
Then run the `browser-smoke` agent (this plugin) for a regression pass over the main flows.
