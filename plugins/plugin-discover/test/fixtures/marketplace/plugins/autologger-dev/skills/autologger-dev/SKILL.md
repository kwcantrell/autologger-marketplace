---
name: autologger-dev
description: Brings up a local autologger dev stack (kwcantrell/autologger-2) in HTTPS mode with its MCP endpoint on, and connects Claude to it at https://localhost:8787/mcp (or a dev slot's https://localhost:2N787/mcp) - diagnoses what is missing (docker, local OpenBao, overrides, the dev CA, NODE_EXTRA_CA_CERTS), runs the safe make steps, writes the dev CA and lists what the user must do. Use when the user wants to run autologger locally, start or fix the local dev stack, use the local MCP server, or when a localhost:8787 request fails with a TLS certificate error or "cannot reach".
---

# autologger-dev

Fixture copy: frontmatter only.
