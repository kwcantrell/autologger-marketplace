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
| `plugins/<name>/` | One plugin per folder (none yet). Created by `npm run new-plugin`. |
| `templates/plugin/` | The plugin template, itself a valid plugin (`plugin-template`), not listed in the marketplace. |
| `scripts/new-plugin.ts` | The scaffold behind `npm run new-plugin`; its tests are in `scripts/test/`. |
| `package.json`, `tsconfig.json` | Dev tooling only (typecheck, tests, scaffold). Plugins never depend on the root. |
| `factory/` | Software-factory runtime state; ignored by its own `.gitignore`. Never commit it. |

## Commands

```sh
npm ci                                   # dev tooling: typescript and @types/node, pinned exactly
npm run typecheck                        # strict tsc --noEmit over templates/, plugins/ and scripts/
npm test                                 # node --test over templates/*/test, plugins/*/test, scripts/test
npm run new-plugin -- <name> [--description "<text>"]
claude plugin validate .                 # marketplace manifest
claude plugin validate plugins/<name>    # one plugin (also templates/plugin)
```

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
npx --yes --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- <name> <command> [args] --json
```

- `--package="${CLAUDE_PLUGIN_ROOT}"` makes npx resolve the `bin` from the plugin's own installed
  folder, so it works from the plugin cache (whose path changes on every plugin update, and which is
  a fresh copy with no `node_modules`). Never point a skill at a path in this repo or at a published
  npm package. Keep the quotes: the path may contain spaces.
- `--yes` skips npx's install prompt; `--loglevel=error` keeps npm notices off stderr so stderr holds
  only the CLI's own messages.
- Put the exact command lines in ` ```sh ` blocks in the SKILL.md, starting with `npx `. The template's
  end-to-end test (`test/cli.test.ts`) extracts and runs every such line, so a skill whose command
  does not work fails `npm test`.
- `allowed-tools` in the skill frontmatter allows that prefix (`Bash(npx --yes --loglevel=error
  --package="${CLAUDE_PLUGIN_ROOT}" -- <name>:*)`).

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
A runtime dependency in a plugin's `package.json` makes npx install it into the plugin cache folder
on first run, which needs the network, and Node will not type-strip `.ts` inside `node_modules`.
Pin any such version exactly.

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
  `npx --yes --package=tsx@<exact> --package="${CLAUDE_PLUGIN_ROOT}" -- <name> ...`.
- Each plugin version leaves a small entry in `~/.npm/_npx/` (a symlink and a lockfile).
