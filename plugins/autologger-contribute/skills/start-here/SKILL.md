---
name: start-here
description: Guided first tour for a new AutoLogger contributor — what the product is, how the code is laid out, the one idea that holds it together (the ops registry), getting the dev stack running, and proving it works by running the tests. Use when someone is new to the autologger codebase, asks "where do I start", or wants to contribute for the first time.
---

# Start here

Walk the contributor through this interactively — one step at a time, show real code, and check
they are with you before moving on. Work inside their AutoLogger checkout (the repo root has
`ARCHITECTURE.md` and `apps/server/src/db/schema.ts`). If you are not in one, ask where it is, or
clone it: `git clone https://github.com/kwcantrell/autologger.git`.

## 1. The product in two minutes

Read `README.md` and the first section of `ARCHITECTURE.md`, then explain in your own words:
operators log events against running timecode, audio gets transcribed, and **AI happens only
through external agents over MCP** — the app itself never calls an LLM. Every agent change is
attributed and undoable from the session's Agents tab.

## 2. The map

Show the layout and what lives where:

| Path | Role |
|---|---|
| `packages/contract` | Zod input schemas, entity types, op catalog — the single API definition |
| `apps/server/src/ops` | One file per domain; every capability is an op |
| `apps/server/src/core` | Op registry, authorization, change log, realtime bus |
| `apps/server/src/{http,ws,mcp}` | Thin adapters: RPC, WebSockets, MCP + OAuth |
| `apps/server/src/{media,worker}` | S3, Deepgram, YouTube, background jobs |
| `apps/web` | React SPA (design system in `apps/web/DESIGN.md`) |
| `apps/companion` | Bitfocus Companion hardware module |
| `apps/importer` | Local import helper (`autologger-import.mjs`): uploads YouTube/local media from a user's machine over RPC |
| `docs/` | User, agent and developer guides, served by the web app at `/docs` |

## 3. Follow one op end to end

Trace `events.create` together:
`packages/contract/src/ops.ts` (input schema) → `apps/server/src/ops/events.ts` (`defineOp`:
`requireSession`, insert, `ctx.record`, `ctx.publish`) → `apps/server/src/http/app.ts`
(`POST /api/rpc/:op`) → `apps/server/src/mcp/server.ts` (same op as the `events_create` tool) →
`apps/web/src/api/rpc.ts` and the session socket in `apps/web/src/api/live.ts`.

Point out the rules in `CLAUDE.md` as they appear: authorize first, record writes for undo,
publish after commit, descriptions written for agents, erasable TypeScript only.

## 4. Run it

Follow the dev stack steps (the `autologger-dev` plugin's `dev-stack` skill has the details):
`docker compose -f compose.dev.yaml up -d`, `cp .env.example .env`, `npm install`,
`npm run dev:server`, `npm run dev:worker -w @autologger/server`, `cd apps/web && npx vite`.
Sign in at http://localhost:5173 with any email (dev login; the first account is the admin).

## 5. Prove it works

```bash
docker exec <postgres-container> createdb -U autologger autologger_test   # once
npm run typecheck
cd apps/server && npx vitest run
```

## 6. Next

Suggest `/autologger-contribute:first-tasks` to pick something, and `/autologger-contribute:contribute`
for the workflow. Recommend installing `autologger-dev@autologger` for the implementation skills (first `claude plugin marketplace add pbakaus/impeccable`: it depends on the impeccable design plugin).
