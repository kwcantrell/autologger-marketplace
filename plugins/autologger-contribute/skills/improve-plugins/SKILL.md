---
name: improve-plugins
description: Contribute to the AutoLogger plugin marketplace itself — add or improve a skill, agent, hook or MCP config in the autologger, autologger-dev or autologger-contribute plugins, validate it and bump versions. Use when someone wants to change what these Claude Code plugins do.
argument-hint: "<what to add or change>"
---

# Improve the AutoLogger plugins

The marketplace repo (`autologger-marketplace`) has this shape:

```
.claude-plugin/marketplace.json          # lists the plugins (name, source, version, tags)
plugins/autologger/                      # users: MCP connection + session skills
plugins/autologger-dev/                  # contributors: implementation skills, reviewer, hooks
plugins/autologger-contribute/           # newcomers: onboarding and workflow
  .claude-plugin/plugin.json             # name, version, description, userConfig
  skills/<name>/SKILL.md                 # frontmatter: name, description, argument-hint
  agents/<name>.md  hooks/hooks.json  .mcp.json  scripts/
```

## Pick the right plugin

- Helps someone **use** AutoLogger through an agent → `autologger`. Skills there call MCP tools
  (op names with `_`, e.g. `topics_replace`); check the tool exists and read its description in
  the server (`apps/server/src/ops/*.ts`) before relying on it.
- Helps someone **change AutoLogger's code** → `autologger-dev`.
- Helps someone **get started or follow the process** → `autologger-contribute`.

## Writing a good skill

- The `description` decides when Claude uses it: say what it does **and** when to use it, with
  the words users actually say.
- The body is instructions for Claude: steps, which tools or files, what to report back. Point at
  files instead of pasting code that will drift.
- Keep it short — the always-on cost is the description; the body loads only when used
  (`claude plugin details <plugin>@autologger` shows the token cost).
- Read-only skills say so; write skills mention that changes are undoable from the Agents tab.

## Hooks and scripts

Hooks go in `hooks/hooks.json` (top-level `"hooks"` key), scripts under `scripts/` referenced as
`${CLAUDE_PLUGIN_ROOT}/scripts/...`. Exit code 2 blocks a tool call with stderr as the reason.
Make hooks fast and scoped to AutoLogger checkouts so they never affect other projects. Test them
by piping a sample payload: `echo '{"tool_input":{"file_path":"…"}}' | node scripts/x.mjs; echo $?`.

## Validate and release

```bash
claude plugin validate --strict .
claude plugin validate --strict plugins/<plugin>
claude plugin details <plugin>@autologger
```

Bump `version` in both the plugin's `plugin.json` and its `marketplace.json` entry (patch for
wording, minor for new skills, major for removals or renamed skills), then follow the
`contribute` workflow for the commit and PR. Users get it with `claude plugin update <plugin>@autologger`.
