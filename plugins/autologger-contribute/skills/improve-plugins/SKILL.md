---
name: improve-plugins
description: Contribute to the AutoLogger plugin marketplace itself — add or improve a skill, agent, hook or MCP config in the autologger, autologger-ask, autologger-dev or autologger-contribute plugins, bump a pinned external skill plugin, validate and bump versions. Use when someone wants to change what these Claude Code plugins do.
argument-hint: "<what to add or change>"
---

# Improve the AutoLogger plugins

The marketplace repo (`kwcantrell/autologger-marketplace`) has this shape:

```
.claude-plugin/marketplace.json    # every plugin: name, source, version, description, tags, dependencies
plugins/autologger/                # users: MCP connection + session skills, session-recap and session-document agents
plugins/autologger-ask/            # users: cited show Q&A + clip compilations, session-scan agent
plugins/autologger-dev/            # contributors: implementation skills, agents, guard hook, dev MCP servers
plugins/autologger-contribute/     # newcomers: onboarding, workflow, follow-up hook
  (each plugin)
  .claude-plugin/plugin.json       # name, version, description, userConfig, dependencies
  skills/<name>/SKILL.md           # frontmatter: name, description, argument-hint
  agents/<name>.md                 # frontmatter: name, description, tools, model, isolation
  hooks/hooks.json  .mcp.json  scripts/  references/   # references/: shared Markdown agents read
```

`marketplace.json` also lists **pinned external skill plugins** (`react-best-practices`,
`composition-patterns`, `react-view-transitions`, `react-expert`) as `git-subdir` sources with a
`sha`, and allows the cross-marketplace `impeccable` dependency
(`allowCrossMarketplaceDependenciesOn`). Bump a pin by changing its `sha` (and `version`).

## Pick the right plugin

- Helps someone **use** AutoLogger through an agent → `autologger`. Skills there call MCP tools
  (op names with `_`, e.g. `topics_replace`); check the tool exists and read its description and
  input schema in the app repo (`apps/server/src/ops/*.ts`, `packages/contract/src/ops.ts`)
  before relying on it.
- Answers questions **across a show and keeps them** (wiki question pages, compilations) →
  `autologger-ask`. Quick read-only lookups stay in `autologger:find-moments`.
- Helps someone **change AutoLogger's code** → `autologger-dev`.
- Helps someone **get started or follow the process** → `autologger-contribute`.

A skill or agent may only rely on skills from its own plugin or a declared dependency; otherwise
inline the rule or say which plugin to install.

## Writing a good skill

- The `description` decides when Claude uses it: say what it does **and** when to use it, with
  the words users actually say. Don't overlap another skill's triggers — say which one to use
  instead.
- The body is instructions for Claude: steps, which tools or files, what to report back. Point at
  files instead of pasting code that will drift.
- Keep it short — the always-on cost is the description; the body loads only when used
  (`claude plugin details <plugin>@autologger` shows the token cost).
- **One copy per rule.** Tool mechanics (formats, limits, error codes) belong in the MCP tool
  descriptions in the app — point at them rather than restating them. A rule several skills
  share lives in one skill (e.g. citations in `show-wiki`, shared wiki pages in `detailed-wiki`)
  and the others name it; agents that share setup read a file in `references/` via
  `${CLAUDE_PLUGIN_ROOT}` (substituted in skill and agent bodies, not set in Bash).
- Read-only skills say so. Write skills in `autologger` / `autologger-ask` mention that changes
  are undoable from the session's Agents tab (wiki and event-button changes: the show's Changes
  page).

## Hooks and scripts

Hooks go in `hooks/hooks.json` (top-level `"hooks"` key), scripts under `scripts/` referenced as
`${CLAUDE_PLUGIN_ROOT}/scripts/...`. Exit code 2 blocks a tool call with stderr as the reason.
Make hooks fast and scoped to AutoLogger checkouts so they never affect other projects. Test them
by piping a sample payload: `echo '{"tool_input":{"file_path":"…"}}' | node scripts/x.mjs; echo $?`,
and add the cases to `.github/workflows/validate.yml`, which tests both hooks in CI.

## Validate and release

```bash
claude plugin validate --strict .
claude plugin validate --strict plugins/<plugin>
claude plugin details <plugin>@autologger
```

Bump `version` in both the plugin's `plugin.json` and its `marketplace.json` entry (patch for
wording, minor for new skills or agents, major for removals or renames); keep `dependencies` and
the descriptions in step between the two files too. Update the marketplace `README.md` tables, and
in the app repo `docs/agents/plugins.md` when a user-facing skill changes. Then follow the
`contribute` workflow for the commit and PR. Users get it with
`claude plugin update <plugin>@autologger`.
