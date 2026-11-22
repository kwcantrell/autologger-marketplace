---
name: mcp-check
description: Exercise the AutoLogger MCP server the way an agent sees it — list tools, read descriptions and schemas, call tools with a personal access token, and run the OAuth smoke script. Use after adding or changing an MCP-exposed op, or when debugging agent access.
argument-hint: "[tool name to inspect]"
---

# Check the MCP surface

Tools are generated from ops with `'mcp'` in `surfaces`: name `domain.verb` → `domain_verb`,
description = the op description, input schema = `z.toJSONSchema(opInputs[name])`.

## Get a token

With the dev stack running and a cookie from the dev login, create a PAT through RPC:

```bash
B=http://localhost:5173
curl -s -c /tmp/al.jar -H 'content-type: application/json' -X POST $B/auth/dev-login -d '{"email":"owner@example.com"}'
curl -s -b /tmp/al.jar -H 'content-type: application/json' -X POST $B/api/rpc/tokens.createPat -d '{"name":"mcp-check"}'
```

## Inspect

```bash
T=alp_...   # token from above
H=(-H "Authorization: Bearer $T" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream')
curl -s "${H[@]}" -X POST $B/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s "${H[@]}" -X POST $B/mcp -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sessions_list","arguments":{}}}'
```

Review each changed tool as an agent would: Is the description enough to call it correctly
without reading code (units, where ids come from, side effects, undo)? Are optional fields
obvious? Do errors come back with a readable `code: message`?

## Full flow

`apps/server/scripts/mcp-smoke.ts` runs PAT + OAuth (register → authorize → consent → token →
refresh → revoke) against a running server; `scripts/mcp-sdk-client.ts` connects with the official
SDK client. Run with `node --env-file=../../.env scripts/<file>.ts` from `apps/server`.

To try it in Claude Code itself: `claude mcp add --transport http autologger-dev $B/mcp --header "Authorization: Bearer $T"`.
Revoke the PAT afterwards (`tokens.revoke`).
