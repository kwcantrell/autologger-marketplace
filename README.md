# AutoLogger plugin marketplace

[![Validate plugins](https://github.com/kwcantrell/autologger-marketplace/actions/workflows/validate.yml/badge.svg)](https://github.com/kwcantrell/autologger-marketplace/actions/workflows/validate.yml)

Claude Code plugins for [AutoLogger](https://github.com/kwcantrell/autologger): one for the people who **use** it, one for the
people who **build** it, and one for people **getting started** as contributors.

```bash
claude plugin marketplace add kwcantrell/autologger-marketplace
claude plugin install autologger@autologger                 # users
claude plugin install autologger-ask@autologger             # ask questions, cited answers, clip compilations
claude plugin marketplace add pbakaus/impeccable            # needed by autologger-dev
claude plugin install autologger-dev@autologger             # contributors
claude plugin install autologger-contribute@autologger      # new contributors
```

Inside Claude Code the same works with `/plugin marketplace add …` and `/plugin install …`.

## `autologger` — for producers and operators

Connects Claude to your AutoLogger server over MCP (OAuth: Claude opens your browser to approve
access the first time; run `/mcp` to sign in) and adds skills that use it:

| Skill | What it does |
|---|---|
| `/autologger:import-videos` | Imports a YouTube video or playlist into a show: one session per video, downloaded and transcribed, then optionally annotated. |
| `/autologger:transcript-cleanup` | Fixes systematic transcription errors (jargon, numbers, spoken math), names speakers and notes what changed. |
| `/autologger:session-topics` | Chapters a session from its transcript (`topics_replace`). |
| `/autologger:log-moments` | Finds moments you describe and logs them as timecoded events with your show's buttons. |
| `/autologger:session-dashboard` | Designs a declarative dashboard (live queries + computed stats). |
| `/autologger:show-wiki` | Writes a session recap and updates people / recurring-bit pages. |
| `/autologger:detailed-wiki` | Builds a detailed, cited wiki for a whole show: an in-depth recap per session (written in parallel by the `session-recap` agent), then host, guest, bit, topic and hub pages from those recaps. |
| `/autologger:find-moments` | Read-only search across sessions with timecodes. |
| `/autologger:session-brief` | Read-only editor / producer / social brief in chat. |

Claude also picks these up automatically when you ask in plain words ("chapter yesterday's
episode"). Everything it writes is attributed to you plus the client name, and can be undone from
the session's **Agents** tab.

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

| Piece | What it does |
|---|---|
| `/autologger-dev:add-op` | The one way to add a capability: contract → op with authz, change log, publish → test → web hook. |
| `/autologger-dev:schema-change` | Drizzle schema edits, generated migrations, undo registration. |
| `/autologger-dev:web-feature` | UI work that keeps the Show Ignition look, typed RPC hooks and live updates. |
| `/autologger-dev:companion-module` | The `/ws/companion` protocol and the Bitfocus module, kept in sync. |
| `/autologger-dev:dev-stack` | Start / check / seed / stop the local stack; dev login. |
| `/autologger-dev:mcp-check` | See and call the MCP tools the way an agent does. |
| `ui-designer` agent | Designs and refines web app screens within DESIGN.md: plans, builds with the shadcn/Base UI primitives, checks at three widths, critiques and polishes with impeccable. |
| impeccable (dependency) | Paul Bakaus's design skill (`/impeccable:impeccable <command>`: shape, critique, audit, polish, harden, adapt…), installed with `autologger-dev` from the `impeccable` marketplace. |
| `react-expert` agent | Senior React reviewer and architect for `apps/web`: **critique** a diff or feature, **simplify** components without changing behaviour, **optimize** measured re-render / waterfall / bundle costs, or **architect** a feature's component tree, state ownership and data flow. Runs in its own git worktree (`isolation: worktree`) and leaves edits on a `react/<topic>` branch there; it can't see uncommitted changes in your checkout, so give it a branch. |
| React skills (dependencies) | Installed with `autologger-dev` from this marketplace, each pinned to an upstream commit (MIT): `react-best-practices`, `composition-patterns` and `react-view-transitions` from [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills), and `react-expert` from [jeffallan/claude-skills](https://github.com/jeffallan/claude-skills). Bump a pin by updating its `sha` in `marketplace.json`. |
| `shadcn` MCP server | The official shadcn/ui MCP server (`shadcn@4.23.0 mcp --cwd apps/web`): search, view and add registry components for the Base UI setup in `apps/web/components.json`. Needs `npx`. |
| `ops-reviewer` agent | Reviews a diff against the architecture rules before you commit. |
| `browser-smoke` agent | Clicks through the main flows in a real browser and reports pass/fail. |
| `visual-review` agent | Looks over every page at desktop, tablet and phone width for visual bugs and files an issue for each. |
| `bug-hunt` agent | Tries to break the local stack (odd input, races, undo, access, API edges) and files an issue per reproducible bug; security findings are reported privately. |
| Guard hook | Blocks edits to generated migrations (`apps/server/drizzle/**`) and real `.env` files in AutoLogger checkouts, and stops the `react-expert` and `ui-designer` agents from editing while the checkout is on its default branch. |
| `autologger-local` MCP server | Your dev server's MCP endpoint (`dev_url`, default `http://localhost:5173`), so you can try new tools immediately. Use exactly the server's `PUBLIC_URL` origin — OAuth discovery rejects other hostnames (`127.0.0.1` ≠ `localhost`). If both plugins point at the same URL, Claude Code keeps a single connection. |
| `scripts/seed.mjs` | Demo team, show, session, events, topics, dashboard and wiki through the RPC API. |

## `autologger-contribute` — how to contribute

| Skill | What it does |
|---|---|
| `/autologger-contribute:start-here` | Guided first tour: product, code map, one op end to end, run the stack and tests. |
| `/autologger-contribute:contribute` | The workflow from idea to PR: scope, branch, which guide to follow, tests, commit format, PR. |
| `/autologger-contribute:first-tasks` | Curated starter tasks (small / medium / larger) with files and how to verify. |
| `/autologger-contribute:pr-ready` | Runs the checks, reviews the diff and drafts the PR description. |
| `/autologger-contribute:improve-plugins` | How to add or change skills, hooks and agents in this marketplace. |

Pairs with `autologger-dev`, which holds the implementation guides it points to.

## Layout

```
.claude-plugin/marketplace.json
plugins/autologger/       .claude-plugin/plugin.json, .mcp.json, skills/*
plugins/autologger-dev/   .claude-plugin/plugin.json, .mcp.json, skills/*, agents/, hooks/, scripts/
plugins/autologger-contribute/   .claude-plugin/plugin.json, skills/*
```

Validate before publishing: `claude plugin validate --strict .` and `claude plugin validate --strict plugins/<plugin>`.
CI runs the same checks plus a test of the `autologger-dev` guard hook on every push and pull request.

## Contributing

Use the `contribute` workflow from `autologger-contribute` (and its `improve-plugins` skill): branch,
change, validate, bump the plugin `version` in both `plugin.json` and `.claude-plugin/marketplace.json`,
then open a pull request.
