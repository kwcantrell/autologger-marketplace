# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Claude Code plugin marketplace, `autologger-marketplace` (GitHub `kwcantrell/autologger-marketplace`),
for plugins that help developers and agents work on or with autologger (`kwcantrell/autologger-2`,
checked out at `/home/autologger/autologger-2`; read-only from here).

The one rule for every plugin: **it defines a CLI written in TypeScript, run via `npx`, and its skills
call that CLI** instead of embedding logic in prompts. Skills say *when* and *which command*; the CLI
does the work and is tested like ordinary code.

| Path | What it is |
| --- | --- |
| `.claude-plugin/marketplace.json` | The marketplace manifest. A plugin loads only if it has an entry here (`source: ./plugins/<name>`). |
| `plugins/<name>/` | One plugin per folder, listed below. Created by `npm run new-plugin`. |
| `templates/plugin/` | The plugin template, itself a valid plugin (`plugin-template`), not listed in the marketplace. |
| `scripts/new-plugin.ts` | The scaffold behind `npm run new-plugin`; its tests are in `scripts/test/`. |
| `package.json`, `tsconfig.json` | Dev tooling only (typecheck, tests, scaffold). Plugins never depend on the root. |
| `factory/` | Software-factory runtime state; ignored by its own `.gitignore`. Never commit it. |

## Plugins

| Plugin | What it does |
| --- | --- |
| `autologger-dev` | Local dev stack setup for autologger and its MCP connection: `doctor`, `up` (only `dev-bao`, `dev-bao-set CUSTOM_DASHBOARDS_ENABLED=1`, `DEV_HTTPS=1 dev-up`), `ca`, `status`, `connect`. Never prints OpenBao state values. See its `README.md`. |
| `autologger-mcp` | CLI + skills for autologger's MCP endpoint: OAuth sign-in (`login`, `status`, `logout`), MCP tool calls (`tools`, `call`) and a wiki-link checker (`check-links`). See its `README.md`. |
| `autologger-specs` | Spec coverage for an autologger checkout: `which`, `stale` (the `specs-with-code` rule), `lint`, `new`, `gate`. Its `test/verify-autologger.ts` checks it against autologger's own Python gates. |
| `plugin-builder` | Builds plugins for this marketplace: `new` (runs `scripts/new-plugin.ts`), `check` (this file's convention, statically, with a fix per finding), `verify` (the full gate for one plugin). Its `build-plugin` skill is the workflow. See its `README.md`. |

## Commands

```sh
npm ci                                   # dev tooling: typescript and @types/node, pinned exactly
npm run typecheck                        # strict tsc --noEmit over templates/, plugins/ and scripts/
npm test                                 # node --test over templates/*/test, plugins/*/test, scripts/test
npm run new-plugin -- <name> [--description "<text>"]
claude plugin validate .                 # marketplace manifest
claude plugin validate plugins/<name>    # one plugin (also templates/plugin)
node plugins/plugin-builder/src/cli.ts check <name>|--all   # the convention below, checked statically
node plugins/plugin-builder/src/cli.ts verify <name>        # check + validate + typecheck + the plugin's tests
```

`plugin-builder check` reports each break of the convention below with its file, line, rule and fix;
`plugin-builder verify` runs every gate for one plugin and exits non-zero if any fails (a missing
`claude` binary shows as skipped). Run both before finishing a plugin.

`new-plugin` takes a kebab-case name (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, max 64 chars). It copies
`templates/plugin` to `plugins/<name>/`, replaces the token `plugin-template` (plugin name, skill
folder and name, CLI bin name, `CLI_NAME`) in every file and path, sets the description in
`plugin.json`, and appends the plugin to `marketplace.json`. It exits 1 if the folder or marketplace
entry already exists and 2 for a bad name or arguments, writing nothing in either case.

There is no build step and nothing compiled is committed: Node runs the `.ts` files directly.

## Plugin layout

```
plugins/<name>/
  .claude-plugin/plugin.json      name, version, description
  package.json                    "bin": { "<name>": "src/cli.ts" }, "type": "module", private
  skills/<name>/SKILL.md          calls the CLI (more skills may be added; all call the CLI)
  src/cli.ts                      entry (#!/usr/bin/env node): wires process I/O to run()
  src/run.ts                      argument parsing, commands, usage text, exit codes
  src/<logic>.ts                  command logic as plain functions
  test/*.test.ts                  node:test tests (unit + end-to-end through npx)
```

## The CLI convention

**How skills call the CLI.** Always exactly this prefix, from whatever the current directory is, with
no `cd`, install or build step:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- <name> <command> [args] --json
```

- `--package="${CLAUDE_PLUGIN_ROOT}"` makes npx resolve the `bin` from the plugin's own installed
  folder, so it works from the plugin cache (whose path changes on every plugin update, and which is
  a fresh copy with no `node_modules`). Never point a skill at a path in this repo or at a published
  npm package. Keep the quotes: the path may contain spaces.
- `--yes` skips npx's install prompt; `--loglevel=error` keeps npm notices off stderr so stderr holds
  only the CLI's own messages.
- `--offline` is a safety guard and is required. If `${CLAUDE_PLUGIN_ROOT}` ever reaches the shell
  empty, `--package=""` is resolved by npm as the registry package `undefined`, owned by a third
  party; with `--yes` and a pre-approved `allowed-tools` rule, npx would download and run it with no
  prompt. `--offline` makes that case fail with `ENOTCACHED` instead, and costs nothing in the normal
  case because a local-folder package needs no network. The end-to-end test checks both.
- Put the exact command lines in ` ```sh ` blocks in the SKILL.md, starting with `npx `. The template's
  end-to-end test (`test/cli.test.ts`) extracts and runs every such line, so a skill whose command
  does not work fails `npm test`.
- `allowed-tools` in the skill frontmatter allows that prefix (`Bash(npx --yes --offline
  --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- <name>:*)`). A CLI with commands that act on
  the machine (run a Makefile, start containers) pre-approves only its read-only commands instead,
  one rule each (`Bash(<prefix> <name> <command>:*)`, comma-separated), so the rest prompt.

**Output.** Every command accepts `--json` and then prints exactly one JSON value on stdout; skills use
`--json`. Without it, output is short human-readable text. `--help` prints usage on stdout and exits 0.

**Exit codes.** `0` success, `1` the command failed, `2` usage error (unknown command or option, bad
arguments). On any non-zero exit the message goes to stderr (`<name>: <message>`) and stdout stays
empty, also with `--json`.

**TypeScript.** Node's built-in type stripping runs the source, so: only erasable syntax (no `enum`,
`namespace` or parameter properties; `erasableSyntaxOnly` enforces it), relative imports with the
`.ts` extension, `import type` for types (`verbatimModuleSyntax`). The root `tsconfig.json` is strict
and covers every plugin; there are no per-plugin tsconfigs.

**Dependencies.** Prefer none: Node's standard library (`node:util` `parseArgs`, `node:fs`,
`fetch`, `node:test`) covers most CLIs. Type-only dev dependencies belong in the root `package.json`.
A runtime dependency in a plugin's `package.json` would have to be installed into the plugin cache
folder on first run, which needs the network, so with `--offline` it fails unless it is already in
the npm cache; Node will also not type-strip `.ts` inside `node_modules`. Do not add one without
revisiting the invocation, and pin any such version exactly.

**Tests.** `plugins/<name>/test/*.test.ts`, run by the root `npm test` with `node --test`. Keep the
template's two kinds: unit tests that call `run()` with a fake `Io`, and the end-to-end test that
copies the plugin to a temp dir and runs the SKILL.md command lines through npx from an unrelated cwd,
with an empty npm cache and `npm_config_offline=true`.

### Why npx with a local package and no TS runner (tradeoffs)

- **No network, near-zero latency.** With a local folder as `--package`, npx only symlinks it into
  `~/.npm/_npx/<hash>/` and runs the bin; nothing is fetched (the e2e test runs offline with an empty
  cache). First run and later runs both take about 0.2-0.4 s.
- **Needs Node >= 22.18** (type stripping on by default; `engines` says so). Older Node fails with
  an unknown `.ts` extension error. Pulling in a TS runner such as `tsx` would support older Node but
  costs a registry download on the first run after every plugin update (the cache path changes, so
  the npx cache key changes), and fails offline. If that is ever needed, pin the runner exactly, e.g.
  `npx --yes --package=tsx@<exact> --package="${CLAUDE_PLUGIN_ROOT}" -- <name> ...`. That form needs
  the network, so it has to drop `--offline`; guard against an empty root another way first (for
  example `--package="${CLAUDE_PLUGIN_ROOT:?}"`, after confirming Claude Code still substitutes it).
- Each plugin version leaves a small entry in `~/.npm/_npx/` (a symlink and a lockfile).
