# AutoLogger plugin marketplace

[![Validate plugins](https://github.com/kwcantrell/autologger-marketplace/actions/workflows/validate.yml/badge.svg)](https://github.com/kwcantrell/autologger-marketplace/actions/workflows/validate.yml)

Claude Code plugins for [AutoLogger](https://github.com/kwcantrell/autologger), in two groups:

| For | Plugin | What it is |
|---|---|---|
| People who **use** AutoLogger | [`autologger`](#autologger--for-producers-and-operators) | MCP connection plus skills for working with sessions |
| | [`autologger-ask`](#autologger-ask--ask-your-show) | Cited answers kept in the show wiki, and clip compilations (needs `autologger`) |
| People who **build** AutoLogger | [`autologger-dev`](#autologger-dev--for-contributors) | Implementation guides, review/QA/design agents, guard hook, dev MCP servers |
| | [`autologger-contribute`](#autologger-contribute--how-to-contribute) | Onboarding and the idea-to-PR workflow |

```bash
claude plugin marketplace add kwcantrell/autologger-marketplace

# users
claude plugin install autologger@autologger
claude plugin install autologger-ask@autologger

# contributors
claude plugin marketplace add pbakaus/impeccable            # needed by autologger-dev
claude plugin install autologger-dev@autologger
claude plugin install autologger-contribute@autologger
```

Inside Claude Code the same works with `/plugin marketplace add …` and `/plugin install …`.

## `autologger` — for producers and operators

Connects Claude to your AutoLogger server over MCP (OAuth: Claude opens your browser to approve
access the first time; run `/mcp` to sign in) and adds skills that use it.

| Skill | What it does |
|---|---|
| **Bring sessions in** | |
| `/autologger:import-videos` | Imports a YouTube video or playlist into a show: one session per video, downloaded and transcribed, then optionally annotated. |
| `/autologger:transcript-cleanup` | Fixes systematic transcription errors (jargon, numbers, spoken math), names speakers and notes what changed. |
| **Annotate a session** | |
| `/autologger:session-topics` | Chapters a session from its transcript (`topics_replace`). |
| `/autologger:log-moments` | Finds moments you describe and logs them as timecoded events with your show's buttons. |
| `/autologger:session-dashboard` | Designs a declarative dashboard (live queries + computed stats). |
| **Document the show** | |
| `/autologger:show-wiki` | Writes a session recap and updates people / recurring-bit pages. |
| `/autologger:detailed-wiki` | Builds a detailed, cited wiki for a whole show: an in-depth recap per session (written in parallel by the `session-recap` agent), then host, guest, bit, topic and hub pages from those recaps. |
| **Look things up (read-only)** | |
| `/autologger:knowledge-graph` | The whole pipeline for making a show searchable by person, recurring bit or theme: show-wide conventions first, one read per session (cleanup, topics, events, a recap written as findable moments, by the `session-document` agent), shared entity pages, then a verification pass with `graph_entity` and `moments_search`. Needs AutoLogger with the knowledge-graph tools. |
| `/autologger:find-moments` | Quick lookup across sessions, answered in chat with timecodes; nothing saved. For answers worth keeping, use `autologger-ask`. |
| `/autologger:session-brief` | Editor / producer / social brief for one session, in chat. |
| **When something gets in the way** | |
| `/autologger:report-issue` | Files a GitHub issue for a missing or misbehaving MCP tool, wrong skill guidance, or deferred work. |

Claude also picks these up automatically when you ask in plain words ("chapter yesterday's
episode"). Everything it writes is attributed to you plus the client name, and can be undone from
the session's **Agents** tab (wiki and event-button changes from the show's **Changes** page).

Configure the server URL (asked at install, or later):

```bash
echo '{"server_url":"https://autologger.example.com"}' | claude plugin configure autologger@autologger --values-stdin
```

Prefer a static token (scripts, headless runs)? Skip the plugin's server and add one yourself:
`claude mcp add --transport http autologger https://autologger.example.com/mcp --header "Authorization: Bearer alp_…"`
(create the token in AutoLogger → Settings → Agents).

## `autologger-ask` — ask your show

Needs the `autologger` plugin (it uses that MCP connection).

| Piece | What it does |
|---|---|
| `/autologger-ask:ask` | Answers a question about a show with timecode ranges in each session, saves it to the show wiki as a cited `question` page (the knowledge base grows with every question) and offers a compilation for YouTube-sourced sessions. |
| `/autologger-ask:compile-clips` | Turns ranges (or a wiki question page's citations) into one MP4, built by the AutoLogger server from the YouTube sources; play or download it under **Compilations**. |
| `session-scan` agent | Reads one session end to end for a question; `ask` runs it on many sessions in parallel when search misses paraphrases. |

## `autologger-dev` — for contributors

**Implementation guides (skills)**

| Skill | What it does |
|---|---|
| `/autologger-dev:add-op` | The one way to add a capability: contract → op with authz, change log, publish → test → web hook, other callers (MCP instructions, importer), docs. |
| `/autologger-dev:schema-change` | Drizzle schema edits, generated migrations, undo registration. |
| `/autologger-dev:web-feature` | UI work on the shadcn/Base UI primitives that keeps the Show Ignition look, typed RPC hooks, live updates and the `/docs` pages. |
| `/autologger-dev:companion-module` | The `/ws/companion` protocol and the Bitfocus module, kept in sync; smoke scripts and packaging. |
| `/autologger-dev:dev-stack` | Start / check / seed / stop the local stack; dev login; the local import helper. |
| `/autologger-dev:mcp-check` | See and call the MCP tools the way an agent does. |

**Agents**

| Agent | What it does |
|---|---|
| `ops-reviewer` | Reviews a diff against the architecture rules before you commit. |
| `ui-designer` | Designs and refines web app screens within DESIGN.md: plans, builds with the shadcn/Base UI primitives, checks at three widths, critiques and polishes with impeccable. Runs in its own git worktree and leaves edits on a `design/<topic>` branch there; give it a branch to build on existing work. |
| `react-expert` | Senior React reviewer and architect for `apps/web`: **critique**, **simplify**, **optimize** or **architect**. Runs in its own git worktree and leaves edits on a `react/<topic>` branch there; it can't see uncommitted changes in your checkout, so give it a branch. |
| `browser-smoke` | Clicks through the main flows in a real browser and reports pass/fail. |
| `visual-review` | Looks over every page at desktop, tablet and phone width for visual bugs and files an issue for each. |
| `bug-hunt` | Tries to break the local stack (odd input, races, undo, access, API edges) and files an issue per reproducible bug; security findings are reported privately. |

The QA and design agents share one set of sandbox rules (`references/qa-sandbox.md`: sign-in, writing only inside the **Smoke Team** team that `scripts/seed.mjs` creates, filing issues).

**Tooling**

| Piece | What it does |
|---|---|
| Guard hook | Blocks edits to generated migrations (`apps/server/drizzle/**`) and real `.env` files in AutoLogger checkouts, and stops the `react-expert` and `ui-designer` agents from editing while the checkout is on its default branch. |
| `autologger-local` MCP server | Your dev server's MCP endpoint (`dev_url`, default `http://localhost:5173`), so you can try new tools immediately. Use exactly the server's `PUBLIC_URL` origin — OAuth discovery rejects other hostnames (`127.0.0.1` ≠ `localhost`). If both plugins point at the same URL, Claude Code keeps a single connection. |
| `shadcn` MCP server | The official shadcn/ui MCP server (`shadcn@4.23.0 mcp --cwd apps/web`): search, view and add registry components for the Base UI setup in `apps/web/components.json`. Needs `npx`. |
| `scripts/seed.mjs` | The Smoke Team with a show and a session (transcript, events, topics, dashboard, wiki) through the RPC API. |

**Dependencies (installed with `autologger-dev`)**

| Plugin | What it is |
|---|---|
| `impeccable` | Paul Bakaus's design skill (`/impeccable:impeccable <command>`: shape, critique, audit, polish, harden, adapt…), from the `impeccable` marketplace. |
| `react-best-practices`, `composition-patterns`, `react-view-transitions` | Vercel Engineering's React skills from [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) (MIT), pinned to a commit in this marketplace. |
| `react-expert` | Jeff Allan's React 18/19 skill from [jeffallan/claude-skills](https://github.com/jeffallan/claude-skills) (MIT), pinned to a commit. Not to be confused with the `autologger-dev:react-expert` agent. |

Bump a pin by updating its `sha` in `marketplace.json`.

## `autologger-contribute` — how to contribute

| Piece | What it does |
|---|---|
| `/autologger-contribute:start-here` | Guided first tour: product, code map, one op end to end, run the stack and tests. |
| `/autologger-contribute:first-tasks` | Live starter tasks from the `good first issue` / `help wanted` labels, matched to your interests. |
| `/autologger-contribute:contribute` | The workflow from idea to PR: scope, branch, which guide to follow, tests, commit format, PR. |
| `/autologger-contribute:pr-ready` | Runs the checks, reviews the diff and drafts the PR description. |
| `/autologger-contribute:file-issue` | Files follow-ups, unfixed review findings and out-of-scope bugs as GitHub issues. |
| `/autologger-contribute:improve-plugins` | How to add or change skills, agents, hooks and pins in this marketplace. |
| Follow-ups hook | Blocks `gh pr create` / `gh pr edit` in AutoLogger repos when a "Follow-ups" item has no issue link. |

Pairs with `autologger-dev`, which holds the implementation guides it points to.

## Layout

```
.claude-plugin/marketplace.json     all plugins, versions, dependencies and the pinned external skills
plugins/autologger/                 .claude-plugin/plugin.json, .mcp.json, skills/*, agents/
plugins/autologger-ask/             .claude-plugin/plugin.json, skills/*, agents/
plugins/autologger-dev/             .claude-plugin/plugin.json, .mcp.json, skills/*, agents/, references/, hooks/, scripts/
plugins/autologger-contribute/      .claude-plugin/plugin.json, skills/*, hooks/, scripts/
```

Validate before publishing: `claude plugin validate --strict .` and `claude plugin validate --strict plugins/<plugin>`.
CI runs the same checks plus tests of both hooks on every push and pull request.

## Contributing

Use the `contribute` workflow from `autologger-contribute` (and its `improve-plugins` skill): branch,
change, validate, bump the plugin `version` in both `plugin.json` and `.claude-plugin/marketplace.json`,
then open a pull request.
