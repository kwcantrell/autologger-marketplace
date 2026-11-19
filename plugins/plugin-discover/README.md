# plugin-discover

Makes Claude use the right plugin for autologger work. Before an autologger task (MCP data, an
autologger-2 or autologger-marketplace checkout, the dev stack, specs, marketplace plugins), Claude
runs `match` with a one-line summary of the task and uses the installed plugin or skill that fits. If
none does but an autologger-marketplace plugin that is not installed would, it follows the mode:
asks you and installs it (`ask`, the default), only tells you the install command (`notify`),
installs it and tells you (`auto-install`), or says nothing (`off`). If nothing fits at all and
plugin-advisor is installed, Claude records the gap there, so a new plugin can be suggested through
plugin-advisor's `suggest` and built with `/factory:run`.

Two things trigger it: the `plugin-discover` skill's own description, and a `UserPromptSubmit` hook
that adds a one-line hint when the prompt or the working directory is about autologger.

## Commands

Skills call the CLI as

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-discover <command> [args] --json
```

and from a checkout you can run `node plugins/plugin-discover/src/cli.ts <command>`.

| Command | What it does |
| --- | --- |
| `catalog` | Every installed plugin (id, version, scope, description, `enabled`, and each skill's name and frontmatter `description`), the user's own skills (`~/.claude/skills/*/SKILL.md`), and every autologger-marketplace plugin that is not installed, with its description, skills and install command. Read-only. |
| `match "<task text>"` | Ranks those entries against the task: `installed` and `available` lists (top 5 each, best first), each entry with `score` and `reason` (the matched terms), available ones with `installCommand`. `none_applicable: true` when nothing reaches the threshold, plus `advisor.record`/`advisor.suggest` command lines when plugin-advisor is installed and enabled. Also prints the `mode`; with mode `off`, `available` is always empty. Read-only. |
| `settings` | Prints the mode (`ask` by default). |
| `settings set mode <mode>` | Sets it to `ask`, `notify`, `auto-install` or `off`; anything else is a usage error. |
| `install <name> [--confirmed]` | Runs `claude plugin install <name>@autologger-marketplace` (spawned directly, no shell, 120 s timeout) only if `<name>` is in the marketplace manifest and not installed, the mode is not `off` or `notify`, and the mode is `auto-install` or `--confirmed` is passed. Every refusal exits 1 with the reason (in `notify` mode, the reason includes the command to run). On success it says to run `/reload-plugins`. |
| `hook` | Reads a `UserPromptSubmit` hook input on stdin and prints the hint, or nothing. Used by `hooks/hooks.json`; always exits 0. |

Exit codes: 0 success, 1 the command failed, 2 usage error. On a non-zero exit stdout is empty and the
reason is on stderr.

The skill pre-approves only `match`, `catalog` and `--help`. `install` and `settings` always ask for
permission, and the skill passes `--confirmed` only after you said yes.

## Where it reads from

From Claude Code's own records, in `$CLAUDE_CONFIG_DIR` or else `~/.claude`, without running
`claude`: `claude` may not be on `PATH` (in the hook, tests or CI), and spawning it costs far more
than reading a few small files.

- `plugins/installed_plugins.json` (version 2): installed plugins and their `installPath`. A
  `project` or `local` install counts only inside its `projectPath`.
- `<installPath>/.claude-plugin/plugin.json` and `<installPath>/skills/*/SKILL.md`: descriptions.
- `settings.json`, then each `.claude/settings.json` and `.claude/settings.local.json` from `/` down
  to the current directory: `enabledPlugins["<id>"]: false` marks a plugin disabled.
- `skills/*/SKILL.md`: the user's own skills.
- The autologger-marketplace manifest: next to this plugin in a checkout (`../../.claude-plugin/`),
  else the `installLocation` recorded in `plugins/known_marketplaces.json`, the same way
  plugin-advisor finds it. Only this marketplace is used for suggesting or installing.

## How match scores

Deterministic and local; Claude treats the result as a shortlist and reads the descriptions itself.

1. The task and each entry's text (plugin name, description, skill names and descriptions) become
   terms: lowercase words split on anything but letters and digits (`list_events` is `list` +
   `events`), without stop words or words every entry shares (`autologger`, `plugin`, `skill`,
   `claude`, ...), lightly stemmed (`events` to `event`, `logged` to `log`).
2. Each distinct task term found in the entry scores 1, or 2 for an autologger-specific term
   (`session`, `event`, `transcript`, `wiki`, `dashboard`, `mcp`, `oauth`, `spec`, `openbao`, `dev`,
   `stack`, `tls`, ...). A term in the plugin or skill name counts double.
3. Each pair of adjacent task terms also adjacent in the entry (a phrase, like "dev stack") adds 2.
4. An entry is listed only with a score of at least **3** (the threshold): one autologger term plus
   any other, a phrase, or three plain terms. If nothing reaches it, `none_applicable` is true.

The best skill in a plugin is the one whose own name and description score highest.

## The hook

`hooks/hooks.json` runs `node ${CLAUDE_PLUGIN_ROOT}/src/cli.ts hook` on every `UserPromptSubmit`
(timeout 5 s). It prints `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}`
with one line telling Claude to run `match` first, when either:

- the input's `cwd` is inside a git checkout whose `origin` is `kwcantrell/autologger-2` or
  `kwcantrell/autologger-marketplace` (linked worktrees too), or one with an
  `autologger-marketplace` `.claude-plugin/marketplace.json`; or
- the prompt matches the keyword list in `src/hook.ts`: `autologger`, autologger-mcp's MCP tool
  names (`list_events`, `get_session`, ...), autologger data phrases ("logged events", "session
  transcript", "custom dashboards", "show wiki"), dev-stack words ("dev stack", `make dev-*`,
  `dev-bao`, OpenBao, `localhost:8787`), `specs-with-code`, and `plugin-advisor`/`plugin-builder`.
  The list comes from the marketplace plugins' skill descriptions; bare generic words ("session",
  "dashboard", "event", "wiki", "mcp") are left out because they would fire in unrelated projects.

It hints at most once per session: the input's `session_id` is remembered in
`hinted-sessions.json` (last 200) in the config dir; if it cannot be written, no hint is given. It
never blocks a prompt and never exits non-zero; any error means no output. It loads only
`src/hook.ts` and `src/config.ts`, and takes about 60 ms in total (about 35 ms above bare `node`
start-up).

## Config

`$PLUGIN_DISCOVER_CONFIG_DIR`, else `$XDG_CONFIG_HOME/plugin-discover`, else
`~/.config/plugin-discover` (directory `0700`, files `0600`): `config.json` holds `{"mode": ...}`, and
`hinted-sessions.json` the hook's sessions.
