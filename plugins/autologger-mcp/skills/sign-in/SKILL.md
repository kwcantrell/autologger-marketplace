---
name: sign-in
description: Checks, explains and ends the autologger-mcp sign-in to an autologger server. Use when the user wants to connect to, sign in to, or sign out of autologger from Claude Code, asks which autologger account or permissions are active, or when another autologger-mcp command failed with "not signed in", "invalid_grant" or a TLS certificate error.
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-mcp:*)
---

# Signing in to autologger

The `autologger-mcp` CLI signs in with autologger's own OAuth (a browser page, then a redirect back
to the CLI on `127.0.0.1`) and keeps the tokens in the user's config directory. Run its commands
exactly as written, from any directory, with no install or build step.

The server is `$AUTOLOGGER_URL`, else `https://localhost:8787` (the local dev stack). Add
`--server <url>` to any command for another one.

## Check the sign-in

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-mcp status --json
```

This reads only the local credentials file. It prints `server`, `signed_in`, `scope`
(`dashboards` reads; `dashboards session-data:write` can also edit events, topics and wiki pages),
`can_write`, `access_token_expires_at` and `login_command` / `login_write_command`. An expired
access token is fine when `can_refresh` is true: the next call refreshes it.

To also check that the server is reachable and accepts the token:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-mcp status --check --json
```

## Signing in is the user's step

**Never run `login` yourself.** It opens the user's browser, waits for them to sign in with Google
and approve the access, and that cannot happen inside your shell. Instead, give the user the
`login_command` from `status --json` (or `login_write_command` when they want Claude to edit
session data), and tell them to run it in their own terminal, or in this Claude Code session by
typing `!` followed by the command. Then wait for them to say it finished and run `status --json`
again. On the consent page they may untick "Edit events, topics and wiki pages"; the scope then
stays `dashboards` and the write tools are refused.

If a command fails with a TLS certificate error (for example `SELF_SIGNED_CERT_IN_CHAIN`), the
server uses a private CA, as the dev stack does. Tell the user to set
`NODE_EXTRA_CA_CERTS=/path/to/their-ca.crt` (for the dev stack, its CA certificate file) in the
environment Claude Code runs in, and restart it. Never suggest turning TLS verification off.

## Signing out

Only when the user asks to sign out:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-mcp logout --json
```

It revokes the sign-in at the server and deletes the local tokens; if the server cannot be reached
it still deletes them and prints a warning on stderr (the user can then revoke the app under
Connected apps in autologger).

Exit codes: 0 success, 1 the command failed, 2 usage error; the reason is on stderr. Show it to the
user instead of guessing. No command ever prints a token; never try to read the credentials file.
