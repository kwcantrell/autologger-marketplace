---
name: companion-module
description: Work on the AutoLogger Bitfocus Companion integration — the /ws/companion protocol, device ops, and the module in apps/companion (actions, feedbacks, variables, presets). Use for any change to hardware control or the Companion module.
---

# Companion module

Two halves that must stay in sync:

- **Server**: `apps/server/src/ws/companion.ts` (socket, auth with `ald_` device tokens, state
  pushes) and `apps/server/src/ops/companion.ts` (`companion.*` ops). Messages are typed in
  `packages/contract/src/ws.ts`; the socket only accepts ops listed in `COMPANION_OPS`.
- **Module**: `apps/companion` — a standalone Companion module (normal TypeScript compiled with
  `tsc`, NodeNext, `.js` import suffixes). It deliberately copies the small timecode math instead
  of importing the workspace contract, so it can be packaged on its own.

## Changing behaviour

1. Protocol change → update `ws.ts` types first, then server, then `apps/companion/src/connection.ts`
   and `state.ts`. Keep old messages working or bump the module version and add an upgrade script
   in `upgrades.ts`.
2. New hardware action → if it needs a new op, add it with the `add-op` skill, include
   `'companion'` in `surfaces`, add it to `COMPANION_OPS`, then add the action in `actions.ts`.
3. Variables/feedbacks/presets are derived from `CompanionState` in `state.ts` — keep that mapping
   pure and covered by `state.test.ts`.

## Verify

```bash
cd apps/companion && npm run build && npm test
node scripts/smoke.mjs http://localhost:5173             # raw /ws/companion protocol, end to end
node scripts/connection-check.mjs http://localhost:5173  # the built module's connection: roll, log, stop, revoke
```

Both scripts sign in with the dev login (`DEV_LOGIN=1`) and create their own device; pass the dev
URL explicitly (their built-in default port is stale).

## Release

- `npm run package` in `apps/companion` builds the installable `.tgz`.
- Keep `version` in `apps/companion/package.json` and `apps/companion/companion/manifest.json` in step.
- Update `docs/developers/companion-protocol.md` for protocol changes and `docs/guide/companion.md`
  for anything operators see.
