# plugin-builder

Helps Claude agents build new plugins for this marketplace right the first time. Its TypeScript CLI
scaffolds a plugin from the template, checks a plugin against the marketplace's CLI convention with
a fix for every finding, and runs a plugin's full verification gate. Its `build-plugin` skill walks
an agent from an idea to a passing plugin.

The convention itself lives in the repo's [CLAUDE.md](../../CLAUDE.md) ("Plugin layout" and "The CLI
convention"); this plugin applies it, it does not redefine it.

## Commands

The CLI works on the `autologger-marketplace` checkout containing the current directory (the nearest
ancestor whose `.claude-plugin/marketplace.json` is named `autologger-marketplace`), or `--repo
<path>`. Outside one it exits 2. Skills call it as

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-builder <command> [args] --json
```

and from a checkout you can run it directly with `node plugins/plugin-builder/src/cli.ts <command>`.

| Command | What it does |
| --- | --- |
| `new <name> [--description <text>]` | Runs the checkout's own `scripts/new-plugin.ts` (the same as `npm run new-plugin`), so the template has one source of truth. Exits with the scaffold's status: 1 for a taken name, 2 for a bad one, with its message on stderr. `--json` prints `{"name","path","marketplace"}`. |
| `check <name>... \| --all` | Checks plugins against the convention (below). Exit 1 on any finding, with each finding on stderr as `<file>:<line>: [<rule>] <problem>` and a `fix:` line; exit 0 and `{"plugins","findings":[]}` when clean. `--all` checks every folder in `plugins/` and every marketplace entry. |
| `verify <name>` | From the checkout root: `check <name>`, `claude plugin validate plugins/<name>`, `claude plugin validate .`, `npm run typecheck`, and `node --test plugins/<name>/test/**/*.test.ts` (the root `npm test`, limited to this plugin). Every step runs; their output streams on stderr. Prints each step as pass, fail or skipped (skipped only when `claude` is not on the PATH) and exits 1 if any failed. |

Exit codes: 0 success, 1 the command failed (findings, a failing step, a taken name), 2 a usage error
or not inside a marketplace checkout. On a non-zero exit stdout is empty and the reason is on stderr.

## Rules `check` applies

| Rule | Checks |
| --- | --- |
| `plugin-manifest` | `.claude-plugin/plugin.json` exists, is JSON, and its `name` is the folder name |
| `marketplace-entry` | `marketplace.json` lists the plugin with `source: ./plugins/<name>` (with `--all`, also: no entry without a folder) |
| `package-json` | `package.json` exists and is a JSON object |
| `package-private` | `"private": true` |
| `package-type-module` | `"type": "module"` |
| `package-bin` | `"bin"` maps the plugin name to a `.ts` file that exists in the plugin |
| `bin-shebang` | the bin file starts with `#!/usr/bin/env node` |
| `no-dependencies` | no `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies` or bundled ones |
| `skills-present` | at least one `skills/<skill>/SKILL.md` |
| `skill-name` | the skill's frontmatter `name` is its folder name |
| `skill-command-lines` | every SKILL.md has at least one `npx` line in a ` ```sh ` block |
| `npx-outside-sh` | no `npx` line outside a ` ```sh ` block (the e2e test would not run it) |
| `npx-offline` | every skill `npx` line has `--offline` |
| `npx-quoted-root` | every skill `npx` line has `--package="${CLAUDE_PLUGIN_ROOT}"`, double-quoted |
| `npx-bin-name` | every skill `npx` line runs the plugin's own bin |
| `npx-prefix` | every skill `npx` line starts with the exact prefix (flags and their order) |
| `npx-chained` | every skill `npx` line is one CLI call with plain arguments: `;`, `&`, `|`, a backtick, `$(`, `>`, `<` or a newline after the prefix and bin is flagged (the same check as `hooks-cli`). A `<placeholder>` is skipped (Claude fills it in) only when it is a whole word, with whitespace or a line edge on both sides, or fills one quote pair, `"<x>"` or `'<x>'` (also a `"…"` string inside a single-quoted JSON argument, as in `'{"id":"<id>"}'`), with whitespace, a line edge or `{}[],:` outside the quotes; a placeholder glued to other text (`<a>/tmp`, `<a><b>`, `<<a>`, `"<a>/tmp"`, `'<a>'x`) is checked like any other text. One trailing ` < <placeholder>` (a file the user named, redirected into the CLI's stdin, as autologger-mcp's `import-tokens` does) is allowed, also after a placeholder argument; a pipe, a mid-line `<` or a `<` from a literal path is not. Inside a ` ```sh ` block a line ending in `\` (trailing spaces ignored) is joined with the lines it continues and checked as one command, reported at its first line |
| `allowed-tools` | the frontmatter `allowed-tools` has `Bash(<prefix> <bin>:*)`, or per-command `Bash(<prefix> <bin> <command>:*)` rules |
| `tests-present` | `test/` has at least one `*.test.ts` |
| `e2e-test` | a test reads `SKILL.md` and runs its lines through `npx` with `CLAUDE_PLUGIN_ROOT` set |
| `relative-imports` | relative imports in `src/` and `test/` end in `.ts` (or `.json`) |
| `hooks-cli` | if `hooks/hooks.json` exists: it is JSON in Claude Code's hooks format (`{"hooks": {<Event>: [{"matcher"?, "hooks": [...]}]}}`, known event names and hook types, a positive `timeout`, boolean `async`/`once`), and every `command` hook runs the plugin's own CLI: exec form `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/src/cli.ts", ...]` (the bin file), or the skill `npx` prefix with the plugin's bin, its command and plain arguments (a shell-form command with `;`, `&`, `|`, a backtick, `$(`, `>`, `<` or a newline after the prefix is flagged, with exec form as the fix). A `hooks` field in `.claude-plugin/plugin.json` (inline hooks, a hooks file path, or an array of paths) is always flagged, not resolved: the fix moves those hooks into `hooks/hooks.json`, which Claude Code loads without the field, so every hook sits in the one file this rule validates |

`<placeholder>` arguments in skill lines are accepted; filling them is the plugin's e2e test's job.
Whether a command passes an exit status through, prints exactly one JSON value, or keeps stdout
empty on errors cannot be checked statically: the unit and e2e tests cover those.

## Tests

`test/check.test.ts` has a deliberately broken fixture plugin for every rule, and checks that the
real repo's plugins pass. `test/run.test.ts` covers `new`, `check` and `verify` in temp-dir fixture
checkouts (a fake `claude` on the PATH, or none, and the real one when installed). `test/cli.test.ts`
runs every skill command line through npx from a fresh copy of the plugin. No test writes to the real
repo.
