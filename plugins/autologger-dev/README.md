# autologger-dev

Brings up a local [autologger](https://github.com/kwcantrell/autologger-2) dev stack on this machine
in HTTPS mode, with its MCP endpoint on, and connects Claude to it at `https://localhost:8787/mcp`.

The steps are spread over autologger's `Makefile` and `docs/openbao-secrets.md` (local OpenBao,
overrides, HTTPS mode, the dev CA, trusting it in Node, registering the MCP server), and are easy to
get wrong or run out of order. This plugin's TypeScript CLI diagnoses what is missing and runs the
safe steps; its skill tells Claude when to call which command and what to hand back to you.

## Install

```
/plugin marketplace add kwcantrell/autologger-marketplace
/plugin install autologger-dev@autologger-marketplace
```

Needs Node.js 22.18 or newer to run the CLI. There are no runtime dependencies and nothing to build.
The stack itself needs `docker` (with compose and buildx), `make` and Node 22.12 or newer on `PATH`,
and a checkout of `kwcantrell/autologger-2`.

Skill:

| Skill | Use |
| --- | --- |
| `autologger-dev` | Runs `doctor`, asks you before `up`, writes the CA, checks the endpoint and hands you the steps only you can do (the Google client, the `NODE_EXTRA_CA_CERTS` restart, `claude mcp add` or `autologger-mcp login`). |

## The setup flow

1. **A checkout** of autologger-2: its root has `Makefile`, `docker/scripts/compose-run.mjs` and
   `docker/scripts/local-bao.mjs`.
2. **`make dev-bao`** starts the throwaway local OpenBao container `autologger-local-openbao`
   (127.0.0.1:8200) and writes `.env.openbao.dev` at the checkout root. Its state directory is
   `~/.autologger-local-openbao` (`overrides.env`, `secrets.json`, `ca.pem`, `secret_id`). Dev-mode
   OpenBao loses its state when the container restarts; running `make dev-bao` again fixes that.
3. **`/mcp` needs `CUSTOM_DASHBOARDS_ENABLED` on** (`1`, `true` or `yes`, any case; `make dev-bao-set CUSTOM_DASHBOARDS_ENABLED=1`) and
   HTTPS mode. **Google sign-in needs a real Google OAuth client**: `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET` in `overrides.env` (the defaults are `REPLACE_ME` placeholders), with the
   authorized redirect `https://localhost:8787/auth/google/callback`. You create that client and put
   it there yourself; the plugin never writes it.
4. **`DEV_HTTPS=1 make dev-up`** migrates, builds and starts the stack at `https://localhost:8787`.
5. **`DEV_HTTPS=1 make dev-ca > <file>`** prints the HTTPS gate's root CA (public certificate only).
6. **Trust it** with `NODE_EXTRA_CA_CERTS=<file>` in the environment Claude Code runs in. Node reads
   it only at startup, so restart Claude Code after setting it.
7. **Connect**: `claude mcp add --transport http autologger-dev https://localhost:8787/mcp`, or the
   [autologger-mcp](../autologger-mcp/README.md) plugin's `autologger-mcp login --server
   https://localhost:8787` (run it yourself: it opens a browser).

`doctor` checks 1-7, `up` runs 2-4, `ca` runs 5, `connect` prints 6-7, and `status` checks the result.

## Running the CLI yourself

From a terminal, with `<plugin dir>` the installed plugin folder:

```sh
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-dev --help
```

From a checkout of this repository, `node plugins/autologger-dev/src/cli.ts <command>` does the same.

The checkout is `--repo <path>`, else `$AUTOLOGGER_REPO`; `doctor` alone falls back to the current
directory. `up` and `ca`, which run the checkout's Makefile, exit 2 without `--repo` or
`$AUTOLOGGER_REPO`, and exit 1 (naming the URL) when the checkout's `origin` remote is not
github.com/kwcantrell/autologger-2 (https or ssh, `.git` optional). The server is
`--server <url>`, else `$AUTOLOGGER_URL`, else `https://localhost:8787`; only `https://` URLs, and
`http://` to `localhost`, `127.0.0.1` or `[::1]`, are accepted (the same rule as autologger-mcp).
`$LOCAL_BAO_DIR` and `$LOCAL_BAO_NAME`, as `make dev-bao` reads them, change the state directory and
container name.

## Dev slots (`--slot <N>`)

autologger can run up to ten dev stacks side by side, one per worktree (its ADR 0038,
`DEV_SLOT=0-9`). `doctor`, `up`, `ca`, `status` and `connect` take `--slot <N>`, exactly one digit
0-9 (anything else is a usage error, exit 2), following autologger's own rule
(`docker/compose.dev-slot.yaml`, `docker/compose.dev-slot-https.yaml`):

| | Slot 0 (no `--slot`, or `--slot 0`) | Slot N (1-9) |
| --- | --- | --- |
| Server (`status`, `connect`, `doctor`'s `dev_server`) | `https://localhost:8787` | `https://localhost:2N787` |
| `up` runs | `DEV_HTTPS=1 make dev-up` | `DEV_HTTPS=1 DEV_SLOT=N make dev-up` |
| `ca` runs | `DEV_HTTPS=1 make dev-ca` | `DEV_HTTPS=1 DEV_SLOT=N make dev-ca` |
| MCP server name (`connect`) | `autologger-dev` | `autologger-dev-N` |
| Google redirect (`doctor`, `up`) | `https://localhost:8787/auth/google/callback` | `https://localhost:2N787/auth/google/callback` |

Shared by every slot, so unchanged by `--slot`: the local OpenBao (container, state directory,
`overrides.env`; `make dev-bao` and `make dev-bao-set` never get `DEV_SLOT`) and the dev CA (one
root for every slot, so one CA file and one `NODE_EXTRA_CA_CERTS`). Without `--slot`, every command
behaves exactly as slot 0; the JSON of every command has a `slot` field. The server is `--server`
if given, else the slot's server when `--slot` is given, else `$AUTOLOGGER_URL`, else
`https://localhost:8787`. Make never sees a `DEV_SLOT` from your environment, only the one `--slot`
sets. Use `--slot` from an autologger worktree that has its own slot, with that worktree as `--repo`.

## Commands

Every command takes `--json` (exactly one JSON value on stdout) and `--help`.

| Command | What it does |
| --- | --- |
| `doctor [--repo <path>] [--slot <N>] [--server <url>]` | Named checks, each `ok`, `missing` or `fail` with a one-line fix: `checkout`, `docker` (daemon reachable), `make`, `node` (>= 22.12), `openbao` (container running), `openbao_credentials` (`.env.openbao.dev`), `google_client` (non-placeholder in `overrides.env`; `KEY=`, `KEY=""` and `KEY=''` count as not set), `custom_dashboards` (`CUSTOM_DASHBOARDS_ENABLED` on the way autologger's server reads it: trimmed and lower-cased, `1`, `true` or `yes`, so `true`, `YES` and ` 1 ` are `ok` with the state `enabled`; `0`, `false`, empty or no line is `missing`, `not enabled`), `node_extra_ca_certs` (set to a readable file), `dev_server` (answers; a TLS trust failure is `fail`). **Quotes:** autologger stores an `overrides.env` value verbatim, quotes included, so `GOOGLE_CLIENT_ID="abc"` or `CUSTOM_DASHBOARDS_ENABLED='1'` (a matching pair around a non-empty value) is `fail` with the key's state `quoted` (in `--json`, the check's `keys`) and the fix to remove the quotes and run `make dev-bao` and `up` again; mismatched quotes are an ordinary value. The server does not remove quotes, so a quoted `CUSTOM_DASHBOARDS_ENABLED` (`"1"`, `'true'`) is off and `quoted` too. **Spaces:** a Google value with whitespace before or after it (`GOOGLE_CLIENT_ID= abc`) is kept verbatim too, so it is `fail` with the state `padded` and the fix to remove the spaces; `CUSTOM_DASHBOARDS_ENABLED` has no `padded` state, since the server trims it. **Both:** a value that is quoted and has spaces around (or just inside) its quotes (`GOOGLE_CLIENT_ID= "abc" `) keeps the state `quoted`, and its one fix says to remove both the quotes and the spaces. For `CUSTOM_DASHBOARDS_ENABLED` the fix also says that running `up` rewrites it as `1`, so editing it by hand is optional. Read-only. Exit 0 whenever it ran. |
| `up --repo <path> [--slot <N>] [--dry-run]` | Runs in the checkout, in order and only as needed: `make dev-bao` (container not running or `.env.openbao.dev` missing), `make dev-bao-set CUSTOM_DASHBOARDS_ENABLED=1` (not already on: `1`, `true` or `yes` in any case, spaces around it allowed), `DEV_HTTPS=1 make dev-up` (always; `DEV_HTTPS=1 DEV_SLOT=N make dev-up` with `--slot N`). make's output streams to stderr; the first failing step stops it with exit 1 naming the step. Warns when the Google client is a placeholder, quoted, padded, or quoted and padded (one warning naming both; the stack still comes up); a quoted `CUSTOM_DASHBOARDS_ENABLED` is rewritten as `1` by `dev-bao-set`. A step's last output line without a newline is ended before the next step's header. `--dry-run` prints the plan and runs nothing. |
| `ca --repo <path> [--slot <N>] [--out <file>]` | Runs `DEV_HTTPS=1 make dev-ca` (`DEV_HTTPS=1 DEV_SLOT=N make dev-ca` with `--slot N`), refuses (exit 1, nothing written) anything but exactly one valid PEM certificate or anything that looks like a private key, writes it to `--out` (default `~/.autologger-dev/autologger-dev-ca.crt`, mode 644, missing parent folders created and removed again (only those, only if empty) if `ca` then fails, so nothing is left behind, written to a temp file in the same directory and renamed over the target; an existing file there is replaced only if it is a regular file holding one PEM certificate, otherwise exit 1 and it is left unchanged) and prints the `export NODE_EXTRA_CA_CERTS=<path>` line. |
| `status [--slot <N>] [--server <url>]` | Whether the server answers, whether `<server>/.well-known/oauth-protected-resource` returns JSON naming the resource, and whether `<server>/mcp` exists (any answer but 404). A TLS trust failure is reported as `tls: "untrusted"` with the `ca` / `NODE_EXTRA_CA_CERTS` fix. Exit 0 whenever it ran. |
| `connect [--slot <N>] [--server <url>]` | Prints, never runs, what is left: the `NODE_EXTRA_CA_CERTS` export (when unset), `claude mcp add --transport http autologger-dev <server>/mcp` (`autologger-dev-N` with `--slot N`), and the alternative `autologger-mcp login --server <server>`. |

Exit codes: 0 success, 1 the command failed, 2 usage error. On a non-zero exit the message is on
stderr as `autologger-dev: <message>` and stdout is empty.

## Safety

- **No secret value leaves the CLI.** It reads `overrides.env` only to say whether a key is set, a
  placeholder, quoted or padded. Every line it prints, make's and docker's output included, is
  scrubbed of any value found in `overrides.env`, `secrets.json`, `secret_id` and `.env.openbao.dev`. Those files are read
  again for every write, so a value `make dev-bao` generates and prints in the same step is caught,
  and a value seen once stays hidden for the rest of the run, even after a step replaces or removes it.
- **A fixed step list.** `up` can run only the three commands above. It never runs a `*-reset`,
  `*-down`, stage or prod target, or `dev-bao-set` with another key, and drops `CONFIRM`,
  `DEV_SLOT`, `DEV_HTTPS`, `EMAIL`, `STAGE_*` and make's own `MAKEFLAGS`, `GNUMAKEFLAGS`, `MFLAGS`,
  `MAKELEVEL` and `MAKEFILES` from make's environment (so it acts on the default dev slot unless
  `--slot N` adds `DEV_SLOT=N`, and a parent make cannot add flags, variables or "Entering
  directory" lines to `ca`'s output).
- **`ca --out` never clobbers another file.** An existing file at the target is replaced only if it
  is a regular file holding one PEM certificate (an earlier `ca` run's); a directory, a symlink or
  any other file is refused with exit 1 and left unchanged. The certificate is written to a new temp
  file in the target's directory (created exclusively, never through a symlink) and renamed over the
  target after a last check, so a file swapped in at the target is replaced whole or refused, never
  written into; no temp file is left behind on failure.
- **No Makefile from an untrusted repository.** Only `up` and `ca` run `make`, and only in a checkout
  named explicitly (`--repo` or `$AUTOLOGGER_REPO`, never the current directory) whose `origin` is
  github.com/kwcantrell/autologger-2. The skill pre-approves only `doctor`, `status`, `connect`,
  `up --dry-run` and `--help`, so `up` and `ca` always get a permission prompt, and it tells Claude to
  ask the user, naming the checkout path, before either.
- **TLS verification is never turned off.** The dev CA is trusted through `NODE_EXTRA_CA_CERTS`.

## Tests

`npm test` at the repository root runs them. Unit tests call `run()` with a scripted command runner,
canned or local-server fetches and a temp home and checkout: no real docker, make, network or home
directory. The end-to-end test runs the skill's command lines through `npx` from a copy of the
plugin, offline, with fake `docker` and `make` scripts on `PATH`, a fake checkout and a local test
server.
