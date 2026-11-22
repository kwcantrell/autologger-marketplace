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
  rows change.
- Throw `AppError` helpers from `core/errors.ts` (`badRequest`, `conflict`, `unavailable`, …).
- Map rows to entities in `ops/map.ts`; never return raw rows.
- A new domain file must be imported in `ops/index.ts`.
- Server code runs on Node type stripping: no enums, namespaces or parameter properties; relative
  imports end in `.ts`.

## 3. Test — `apps/server/src/test/*.test.ts`

Add a focused test using the harness (`studio()`, `makeUser()`, `asAgent()`, `call()`,
`failsWith()`): one happy path, one permission failure, one undo if it writes content.
Run: `cd apps/server && npx vitest run`.

## 4. Web (if user-facing)

Call it with `rpc('<name>', input)` from `apps/web/src/api/rpc.ts` and add a query/mutation hook in
`apps/web/src/api/queries.ts`. Live updates arrive through `apps/web/src/api/live.ts`.

## 5. Verify

`npx tsc -p apps/server && npx tsc -p apps/web && (cd apps/server && npx vitest run)`.
For MCP-exposed ops, run the `mcp-check` skill to see the tool as an agent will.
