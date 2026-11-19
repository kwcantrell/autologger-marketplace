# autologger-mcp

Read and write [autologger](https://github.com/kwcantrell/autologger-2) session data (studios,
shows, sessions, events, transcripts, topics, wiki pages, dashboards) from the terminal, through
autologger's own MCP endpoint. The plugin's TypeScript CLI signs you in with autologger's OAuth 2.1
flow, keeps and refreshes the tokens, and calls the MCP tools; its skills tell Claude when and how
to call it. It also checks wiki page bodies for the link mistakes agents make (`[[Title]]` instead
of `[label](wiki:<page_id>)` / `[quote](cite:<session_id>@<seconds>)`).

It is a CLI, not an MCP server registration: Claude runs it through `npx` like the marketplace's
other plugins.

## Install

```
/plugin marketplace add kwcantrell/autologger-marketplace
/plugin install autologger-mcp@autologger-marketplace
```

Needs Node.js 22.18 or newer. There are no runtime dependencies and nothing to build.

Skills:

| Skill | Use |
| --- | --- |
| `sign-in` | Checks the sign-in (`status`), hands you the `login` command (or, on a local dev stack, the `make dev-mcp-token \| import-tokens` line) to run, signs out. |
| `query-session-data` | Lists the tools and calls the read tools, with paging. |
| `write-session-data` | Calls the write tools after you confirm each change; runs `check-links` on wiki bodies first. |

## Running the CLI yourself

From a terminal, with `<plugin dir>` the installed plugin folder (`status --json` prints the exact
`login_command` with it filled in):

```sh
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp --help
```

From a checkout of this repository, `node plugins/autologger-mcp/src/cli.ts <command>` does the same.

### Server

`--server <url>` on any command, else `$AUTOLOGGER_URL`, else `https://localhost:8787` (the local
dev stack). Only `https://` URLs are accepted, plus `http://` to `localhost`, `127.0.0.1` or
`[::1]`. The OAuth endpoints are discovered from `<server>/.well-known/oauth-protected-resource` and
the authorization-server metadata it names; nothing else is hard-coded.

### The dev stack's CA

The dev stack's certificate is signed by a private CA. Trust it for Node with
`NODE_EXTRA_CA_CERTS` (set before Node starts, so export it in the shell or in the environment
Claude Code runs in):

```sh
export NODE_EXTRA_CA_CERTS=/path/to/autologger-dev-ca.crt
```

Without it every command that contacts the server fails with
`the TLS certificate of https://localhost:8787 is not trusted (...)`. TLS verification is never
disabled.

### login

```sh
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp login            # read: scope "dashboards"
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp login --write    # read and edit: "dashboards session-data:write"
```

`login` registers the CLI as a public OAuth client (once per server; the registration is reused),
listens on `127.0.0.1` on a random port, prints the sign-in URL on stderr and opens it in your
browser (`$BROWSER` if set, `BROWSER=none` to skip, or `--no-browser`). Sign in with Google and
approve; the browser is sent back to the CLI, which exchanges the code (PKCE S256, `state` and
`iss` checked). It waits up to 300 s (`--timeout <seconds>`). On the consent page you may untick
"Edit events, topics and wiki pages"; the scope stored and reported is the one actually granted.

`<plugin dir>` is the installed plugin folder (`status --json` prints the full `login_command`). Run `login` yourself: it needs your browser. In Claude Code you can type `!` and the command.

### import-tokens (local dev stack, no browser)

autologger's dev stack has a dev-only `make dev-mcp-token EMAIL=<address> [SCOPE=...]
[CLIENT_ID=...]` (in the autologger-2 checkout, `DEV_SLOT=N` for slot N) that mints an MCP grant
and its tokens for a dev-stack user without a Google OAuth client, and prints them as one JSON line.
Pipe it into `import-tokens` to sign in with it:

```sh
make dev-mcp-token EMAIL=me@example.com | \
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp import-tokens --server https://localhost:8787
DEV_SLOT=2 make dev-mcp-token EMAIL=me@example.com SCOPE="dashboards session-data:write" | \
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp import-tokens --server https://localhost:22787
```

`status --json` prints the whole line for the server as `import_tokens_command`, with the full
`npx ...` form of the `import-tokens` command (the bare name is not on PATH for a plugin install).
When a client is stored for the server, registered at its current registration endpoint and recent
enough that the server still keeps it, `status --json` also prints it as `client_id` and the line
carries `CLIENT_ID=<client_id>`, so repeated imports reuse one client instead of registering a new
one each time (autologger caps registered clients). Run the line again without `CLIENT_ID=...` if
make answers `CLIENT_ID names no registered client` (the dev stack was reset). On a loopback server
the not-signed-in error and `status` both name this line after `login`. It reads the JSON from
standard input only, never from an argument, so the tokens stay out of shell history and process
lists. It checks that every field is there, `token_type` is `Bearer` and the scope is `dashboards`
or `dashboards session-data:write`, then runs the same discovery as `login`: the JSON's `issuer`
and `resource` must be the target server's (`--server`, else `$AUTOLOGGER_URL`, else the default),
or it exits 1 having written nothing. It stores the discovered endpoints, the given `client_id` and
the tokens in the server's credentials file, under the refresh lock, replacing any previous
sign-in; one that held another grant is revoked first (a failed revoke only warns). It prints the
server, scope and expiry, never a token. From then on `status`, `tools`, `call`, refreshes (with
the imported `client_id` and refresh token) and `logout` work as after `login`.

The make target creates an account and a grant on your dev stack, so run it yourself; Claude's
`sign-in` skill hands you the line and never runs it or reads its output.

### status, logout

```sh
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp status           # local file only: server, signed in, scope, token expiry, login commands
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp status --check   # also discovery, and a test of the token against /mcp
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp logout           # revoke at the server (if it can), then delete the local tokens
```

`logout` succeeds, with a warning, when the server cannot be reached; revoke the app under
Connected apps in autologger in that case.

### tools, call

```sh
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp tools                       # name and description of every tool
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp tools --json                # full input schemas
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp call list_studios
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp call list_shows --args '{"studio_id":"<studio_id>"}'
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp call list_events --args '{"session_id":"<session_id>","limit":50}' --json
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp call create_wiki_page --args-file page.json --json   # needs login --write
```

`call` prints the tool's text, or with `--json` the raw MCP result (`structuredContent` holds the
data). A tool error (`isError`) or a JSON-RPC error exits 1 with the message on stderr. A write
tool on a read-only sign-in exits 1 with the server's refusal and the `login --write` command.

The CLI speaks MCP Streamable HTTP (`initialize`, then `tools/list` / `tools/call`, JSON or SSE
answers) to the `resource` URL from discovery (`<server>/mcp`) with the bearer token. An expired
access token, or one the server rejects with 401, is refreshed once and the request retried.

### check-links

```sh
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp check-links page.md      # or - for stdin
```

Reports, as `file:line:column: message`, every `[[...]]` outside code spans and code blocks, and
every `wiki:` / `cite:` link whose target is off autologger's grammar
(`wiki:<[A-Za-z0-9_-]{1,64}>`, `cite:<id>@<\d+(\.\d{1,3})?>`, lower-case scheme). Exits 1 when it
finds any, 0 when the body is clean.

### Output and exit codes

Every command takes `--json` (one JSON value on stdout). Exit 0 success, 1 failure, 2 usage error;
on a non-zero exit the message is on stderr and stdout is empty. No command prints an access or
refresh token.

## Where credentials live

One file per server: `$XDG_CONFIG_HOME/autologger-mcp/credentials/<host>_<port>-<hash>.json`
(`~/.config/...` when `XDG_CONFIG_HOME` is unset; `AUTOLOGGER_MCP_CONFIG_DIR` replaces
`.../autologger-mcp`). The directories are mode `0700` and the file `0600`; it holds the discovered
endpoints, the client registration and the tokens. `status` prints its path.

Refresh tokens rotate, and autologger revokes the whole sign-in when one is used twice. The CLI
therefore refreshes under a lock file next to the credentials, re-reads the file first (another
process may already have refreshed) and saves the new tokens atomically before using them, so
concurrent invocations are safe.

## Development

```sh
npm test           # from the repo root: unit tests and the npx end-to-end test
npm run typecheck
```

The tests run against a fake OAuth + MCP server (`test/fakeServer.ts`); no network or autologger
is needed.
