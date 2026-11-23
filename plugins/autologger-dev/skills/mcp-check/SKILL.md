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

From `apps/server` (both default to `:18081`, so pass the URL):

```bash
node scripts/mcp-smoke.ts $B           # PAT + full OAuth: register → authorize → consent → token → refresh → revoke
node scripts/mcp-sdk-client.ts $B $T   # official SDK client: tools and prompts
```

## In Claude Code

`autologger-dev` already connects the `autologger-local` MCP server to `dev_url` (sign in with
`/mcp`). The tool list is cached per connection: after adding or changing an op, reconnect it in
`/mcp` (or restart) before testing. For a PAT instead:
`claude mcp add --transport http autologger-pat $B/mcp --header "Authorization: Bearer $T"`.
Revoke the PAT afterwards (`tokens.revoke`).
