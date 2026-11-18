# autologger-marketplace

Claude Code plugins for developers and agents working on, or with,
[autologger](https://github.com/kwcantrell/autologger-2), published as one plugin marketplace.

Every plugin ships its own TypeScript CLI, and the plugin's skills call that CLI through `npx`
instead of carrying the logic in their prompts. There are no plugins yet; `templates/plugin/` is the
starting point for new ones.

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
```

`new-plugin` copies `templates/plugin/` to `plugins/my-plugin/`, renames the template's plugin,
skill and CLI to `my-plugin`, and adds the plugin to `.claude-plugin/marketplace.json`. Then replace
the example `hello` command and skill with the real ones. [CLAUDE.md](CLAUDE.md) describes the
layout and the CLI convention every plugin follows.
