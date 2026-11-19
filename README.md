# autologger-marketplace

Claude Code plugins for developers and agents working on, or with,
[autologger](https://github.com/kwcantrell/autologger-2), published as one plugin marketplace.

Every plugin ships its own TypeScript CLI, and the plugin's skills call that CLI through `npx`
instead of carrying the logic in their prompts. `templates/plugin/` is the starting point for new
ones.

## Plugins

| Plugin | What it does |
| --- | --- |
| [`autologger-dev`](plugins/autologger-dev/README.md) | Brings up a local autologger dev stack (local OpenBao, HTTPS mode, the dev CA) and connects Claude to its MCP server: diagnoses what is missing, runs the safe `make` steps, writes the dev CA and lists what is left for the user. |
| [`autologger-browser`](plugins/autologger-browser/README.md) | A Chromium profile for agent-browser that trusts a local dev stack's private CA in its own NSS database only (no `--ignore-https-errors`), optionally signed in with `make dev-login`, plus the exact agent-browser flags: `doctor`, `setup`, `signin`, `reset`. |
| [`autologger-mcp`](plugins/autologger-mcp/README.md) | Read and write autologger session data (studios, shows, sessions, events, transcripts, topics, wiki pages, dashboards) through autologger's MCP endpoint, signed in with autologger's OAuth; checks wiki bodies for broken links. |
| [`autologger-specs`](plugins/autologger-specs/README.md) | Keeps an autologger checkout's `docs/specs/` in step with code: which specs cover a file, which specs the `specs-with-code` gate would fail on, scaffolding and linting specs, and running the repo's own spec gates. |
| [`plugin-advisor`](plugins/plugin-advisor/README.md) | Notices recurring friction with these plugins (CLI failures, workarounds, manual steps, missing guidance), recorded by Claude and by a hook, in a local redacted log; once an issue recurs it drafts a suggested plugin change with a paste-ready `/factory:run` request, and can file it as a GitHub issue after you confirm. |
| [`plugin-discover`](plugins/plugin-discover/README.md) | Before autologger work, finds the installed plugin or skill that fits the task (a deterministic local `match` over Claude Code's own plugin records), offers to install a fitting autologger-marketplace plugin that is not installed (mode `ask`, `notify`, `auto-install` or `off`), and points at plugin-advisor when nothing fits. A `UserPromptSubmit` hook hints at it once per session on autologger prompts. |
| [`plugin-builder`](plugins/plugin-builder/README.md) | Builds plugins for this marketplace: scaffolds one from the template, checks it against the CLI convention with a fix for each finding, and runs its full verification gate. |

## Add the marketplace

In Claude Code, add it from GitHub:

```
/plugin marketplace add kwcantrell/autologger-marketplace
```

or from a local checkout (useful while developing a plugin):

```
/plugin marketplace add /path/to/autologger-marketplace
```

## Install a plugin

```
/plugin install <plugin-name>@autologger-marketplace
```

`/plugin` with no arguments lists the marketplace's plugins. After pulling changes to a local
checkout, run `/plugin marketplace update autologger-marketplace` and then `/reload-plugins` (or
restart Claude Code).

Plugins need Node.js 22.18 or newer on the `PATH` (`node` and `npx`): their CLIs are TypeScript run
directly by Node, with no build step.

## Create a plugin

```sh
npm ci                                      # once: dev tooling (TypeScript, Node types)
npm run new-plugin -- my-plugin --description "What it does."
npm run typecheck && npm test
claude plugin validate plugins/my-plugin && claude plugin validate .
node plugins/plugin-builder/src/cli.ts verify my-plugin   # or all of the above, plus the convention check
```

`new-plugin` copies `templates/plugin/` to `plugins/my-plugin/`, renames the template's plugin,
skill and CLI to `my-plugin`, and adds the plugin to `.claude-plugin/marketplace.json`. Then replace
the example `hello` command and skill with the real ones. [CLAUDE.md](CLAUDE.md) describes the
layout and the CLI convention every plugin follows.

Changing an existing plugin? Raise its `version` in `.claude-plugin/plugin.json` and `package.json`:
Claude Code caches plugins by version, so `/plugin marketplace update` skips a change shipped under
the same one. CI's `scripts/check-versions.ts` fails a pull request that changes `plugins/<name>/`
without a higher version ("Versions" in [CLAUDE.md](CLAUDE.md)).

## Security

Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue;
and never put a token or other secret in any issue.
