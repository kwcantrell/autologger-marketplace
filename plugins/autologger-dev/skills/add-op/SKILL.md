---
name: add-op
description: Add or change a capability in the AutoLogger codebase the right way — one op in the registry, with contract schema, authorization, change-log recording, realtime publish, an agent-quality description and a test. Use whenever a task needs a new endpoint, MCP tool, Companion action or server behaviour in autologger.
argument-hint: "<what the op should do>"
---

# Add an op

In AutoLogger every capability is one **op**. HTTP RPC (`POST /api/rpc/<name>`), MCP tools
(`<name>` with `.` → `_`) and the Companion socket all dispatch through the registry — so you never
add a REST route for a feature. Read `ARCHITECTURE.md` and `CLAUDE.md` at the repo root first.

## 1. Contract — `packages/contract/src/ops.ts`

- Add the Zod input schema to `opInputs` under the op name (`domain.verb`, e.g. `topics.merge`).
  Reuse the local helpers (`id`, `name`, `sec`, `timecode`). Bound every string and array.
- Add the output type to `OpOutputs`. Entity shapes live in `entities.ts`; add fields there rather
  than inventing ad-hoc objects. The compile-time check at the bottom of `ops.ts` fails until both
  sides exist.

## 2. Implementation — `apps/server/src/ops/<domain>.ts`

```ts
defineOp({
  name: 'topics.merge',
  description: '…written for an LLM reading the MCP tool list: units, where ids come from, side effects…',
  kind: 'write',                       // 'read' ops get readOnlyHint in MCP
  surfaces: ['web', 'mcp'],            // add 'companion' only if hardware needs it
  async run(ctx, input) {
    const { session } = await requireSession(ctx, input.sessionId, 'write');
    // … ctx.db is the transaction …
    await ctx.record({ entity: 'topic', entityId, kind: 'update', summary, showId: session.showId,
                       sessionId: session.id, before: snapshot(prev), after: snapshot(next) });
    ctx.publish(`session:${session.id}`, changeMessage('topic', 'upsert', id, entity));
    return entity;
  },
});
```

Rules:
- **Authorize first**, with `requireSession` / `requireShow` / `requireTeamRole`
  (`core/authz.ts`). Missing access is `not_found`, not `forbidden`.
- **Record every content write** (events, topics, transcript segments, dashboards, wiki pages,
  categories) with before/after `snapshot(...)` so the Agents tab can undo it. New entity kinds
  need an entry in `ops/changes.ts` `TABLES`.
- **Publish** realtime messages with `ctx.publish` (sent after commit); use `invalidate` when many
  rows change. Session content goes on `session:<id>`; show-level entities (jobs, sessions,
  compilations, changes, devices) on `show:<id>` (channels in `core/bus.ts`, messages in the
  contract's `ws.ts`).
- Side effects that must only happen if the transaction commits (deleting S3 objects, waking the
  worker) go in `ctx.afterCommit(task)`.
- Throw `AppError` helpers from `core/errors.ts` (`badRequest`, `conflict`, `unavailable`, …).
- Map rows to entities in `ops/map.ts`; never return raw rows.
- A new domain file must be imported in `ops/index.ts`.
- Every op runs inside one `db.transaction` (`core/op.ts`, pool of 10). Never do slow external
  work (yt-dlp, HTTP, sleeps) in `run`: put it in `prepare(actor, input)`, which runs before the
  transaction (authorize there too; `run` re-authorizes and gets the result as its third
  argument). Long-polling reads use `watch(input, signal)`, which waits on the bus after commit
  and re-runs the op — see `jobs.list`.
- Agent-facing bulk or large outputs take `compact` (default false): add the compact shape to
  `CompactOpOutputs` in `packages/contract/src/ops.ts` (not a union in `OpOutputs`), so
  `OpResult<N, I>` types callers by their input with no casts.
- Rows inserted in one transaction share `now()`; give batches explicit, increasing timestamps when
  order matters (see `enqueueJob`'s `at`).
- Server code runs on Node type stripping: no enums, namespaces or parameter properties; relative
  imports end in `.ts`.

## 3. Test — `apps/server/src/test/*.test.ts`

Add a focused test using the harness (`studio()`, `makeUser()`, `asAgent()`, `call()`,
`failsWith()`): one happy path, one permission failure, one undo if it writes content.
Run: `npm test -w @autologger/server`.

## 4. Web (if user-facing)

Call it with `rpc('<name>', input)` from `apps/web/src/api/rpc.ts` and add a query/mutation hook in
`apps/web/src/api/queries.ts`. Live updates arrive through `apps/web/src/api/live.ts` (session
socket) and `apps/web/src/api/liveShow.ts` (show socket). UI work follows the `web-feature` skill.

## 5. Other callers

- **MCP:** `SERVER_INSTRUCTIONS` in `apps/server/src/mcp/server.ts` and `mcp/prompts.ts` name
  tools — update them when a workflow tool is added or renamed. `destructiveHint` comes from the
  `DESTRUCTIVE` verb regex there; name destructive ops with a matching verb.
- **Importer:** `apps/importer/autologger-import.mjs` is an untyped RPC client (`media.*`,
  `compilations.*` uploads, playlist import). If you change those ops' inputs or outputs, update
  it and run `npm test -w @autologger/importer`.
- **Companion:** ops with the `companion` surface → `companion-module` skill.

## 6. Verify

`npm run typecheck && npm test && npm run lint` (all workspaces; bad front matter in `docs/`
fails the web build).
For MCP-exposed ops, run the `mcp-check` skill to see the tool as an agent will.
If the op adds or changes something users or agents rely on, update the matching page under
`docs/guide/`, `docs/agents/` or `docs/developers/` (served at `/docs`) in the same PR.
