---
name: autologger-dev
description: Brings up a local autologger dev stack (kwcantrell/autologger-2) in HTTPS mode with its MCP endpoint on, and connects Claude to it at https://localhost:8787/mcp - diagnoses what is missing (docker, local OpenBao, overrides, the dev CA, NODE_EXTRA_CA_CERTS), runs the safe make steps, writes the dev CA and lists what the user must do. Use when the user wants to run autologger locally, start or fix the local dev stack, use the local MCP server, or when a localhost:8787 request fails with a TLS certificate error or "cannot reach".
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-dev:*)
---

# autologger-dev

Every step goes through this plugin's own TypeScript CLI. Run it exactly as written below, from any
directory, with no install or build step first; `${CLAUDE_PLUGIN_ROOT}` is this plugin's folder and npx
resolves the `autologger-dev` command from its `package.json`.

The checkout is `--repo <path>` if you append it to a command (doctor, up, ca), else
`$AUTOLOGGER_REPO`, else the current directory. Append `--repo <path to autologger-2>` when the
user's autologger-2 checkout is not the current directory. The server is `https://localhost:8787`
unless `--server <url>` (status, connect, doctor) or `$AUTOLOGGER_URL` says otherwise.

## 1. Diagnose first, always

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-dev doctor --json
```

It is read-only and exits 0 whatever it finds. `checks` is a list of `{name, status, detail, fix}`
with `status` `ok`, `missing` or `fail`. Work through the ones that are not `ok` in order, using
their `fix`. Tell the user which checks are not ok, in one line each.

- `checkout` missing: ask the user where their autologger-2 checkout is and re-run with `--repo`.
- `docker`, `make`, `node`: installing software is the user's call; tell them what is missing.
- `openbao`, `openbao_credentials`, `custom_dashboards`, `dev_server` missing: step 2 (`up`) fixes these.
- `google_client` missing: step 5; the stack still comes up without it, but nobody can sign in.
- `node_extra_ca_certs` missing or a `dev_server` TLS failure: steps 3 and 5.

## 2. Bring the stack up - ask the user first

`up` builds and starts containers (it can take several minutes and uses a lot of disk), so show
the plan and **ask the user before running it for real**:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-dev up --dry-run --json
```

Then, only after the user agrees:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-dev up --json
```

It runs, only as needed and in this order, `make dev-bao`, `make dev-bao-set
CUSTOM_DASHBOARDS_ENABLED=1` and `DEV_HTTPS=1 make dev-up`, with make's output on stderr. On exit 1
the message names the step that failed; show it and the end of the make output to the user, and do
not try other make targets to work around it. `warnings` says when the Google client is still a
placeholder (step 5).

## 3. Write the dev CA

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-dev ca --json
```

It runs `DEV_HTTPS=1 make dev-ca`, refuses anything but one public PEM certificate, writes it to
`path` (default `~/.autologger-dev/autologger-dev-ca.crt`, or `--out <file>`) and returns the
`export` line.

## 4. Check the endpoint

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-dev status --json
```

`answers`, `protected_resource.ok` and `mcp.exists` should all be true. `tls: "untrusted"` means
Node does not trust the dev CA yet (step 3, then the export in step 5); TLS verification is never
turned off, so never suggest `NODE_TLS_REJECT_UNAUTHORIZED=0` or `curl -k` style workarounds.

## 5. Hand the rest to the user

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-dev connect --json
```

It prints commands and never runs them. Give the user, from its fields:

- `node_extra_ca_certs_export` (when not null): they put it in the environment Claude Code starts
  in (for example their shell profile) and **restart Claude Code**; Node reads it only at startup.
- `claude_mcp_add`: they run it to register the MCP server, then sign in from `/mcp`.
- or `autologger_mcp_login`, with the autologger-mcp plugin's sign-in skill: they run it in a
  terminal because it opens a browser.
- The Google OAuth client (when doctor's `google_client` is not ok): the user creates their own
  client with the authorized redirect `https://localhost:8787/auth/google/callback`, puts
  `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `~/.autologger-local-openbao/overrides.env`
  themselves, then runs `make dev-bao` and step 2 again. Never ask them to paste the values to you.

## Rules

- Never print, read out, copy or summarise values from the OpenBao state directory
  (`~/.autologger-local-openbao`: `overrides.env`, `secrets.json`, `secret_id`, `ca.pem`) or from
  `.env.openbao.dev`. The CLI reports only whether a key is set or a placeholder; do the same.
- Never run `make dev-reset`, `stage-reset`, any `*-down` target, a stage or prod target, or
  `make dev-bao-set` with any other key. If the stack seems broken beyond what `up` fixes, tell the
  user what doctor and up reported and let them decide.
- Do not write the Google client, edit `overrides.env`, or run `claude mcp add` or the login yourself.

Exit codes: 0 success, 1 the command failed, 2 usage error. On a non-zero exit the reason is on stderr;
show it to the user instead of guessing. To see every command and option:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-dev --help
```
