---
name: plugin-advisor
description: Greets someone by calling the plugin-advisor CLI. Use when the user asks the plugin-advisor plugin to say hello. (Template skill - replace this with what the plugin does and when Claude should use it.)
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor:*)
---

# plugin-advisor

Every action goes through this plugin's own TypeScript CLI. Run it exactly as written below, from any
directory, with no install or build step first; `${CLAUDE_PLUGIN_ROOT}` is this plugin's folder and npx
resolves the `plugin-advisor` command from its `package.json`.

Greet someone (append a quoted name to greet someone other than "world"):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor hello --json
```

It prints one JSON object on stdout: `{"greeting":"Hello, world!"}`. Report the `greeting` to the user.

Exit codes: 0 success, 1 the command failed, 2 usage error. On a non-zero exit the reason is on stderr;
show it to the user instead of guessing. To see every command and option:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor --help
```
