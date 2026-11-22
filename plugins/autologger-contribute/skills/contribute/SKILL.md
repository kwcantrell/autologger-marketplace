---
name: contribute
description: The AutoLogger contribution workflow from idea to pull request — scoping, branching, which implementation guide to follow, tests, review, commit messages and the PR. Use when someone wants to fix a bug, add a feature or otherwise make a change to autologger and asks how to do it properly.
argument-hint: "<what you want to change>"
---

# Contribute a change

## 1. Scope it

- One concern per change. If the request mixes a feature with a refactor, split it.
- Check it fits the architecture (`ARCHITECTURE.md` → "Decisions" and "Deliberately removed").
  Proposals that reintroduce removed things — in-app LLM calls, bespoke REST routes, RLS
  policies, sandboxed dashboard code — need a design discussion first, not a PR.
- Write down in one or two sentences what will be different for a user or agent when it is done.
  That sentence becomes the PR summary.

## 2. Branch

Never work on `main`. Branch from an up-to-date `main`:
`git switch -c <type>/<short-name>` with `type` = `feat`, `fix`, `docs`, `chore` or `refactor`.

## 3. Build it the house way

Pick the guide for the kind of change (from the `autologger-dev` plugin):

| Change | Guide |
|---|---|
| New capability, endpoint, MCP tool, Companion action | `add-op` |
| Table / column / index | `schema-change` |
| UI | `web-feature` |
| Hardware control | `companion-module` |

Non-negotiables: authorization inside the op, `ctx.record` for content writes, contract types for
every input and output, op descriptions an agent can act on, no edits to generated migrations or
`.env` files.

## 4. Test it

- Server behaviour → a focused test in `apps/server/src/test` (happy path, a permission failure,
  undo if it writes content). Tests run against real Postgres; keep them lean.
- UI → check it in the browser against the dev stack, including a second tab for live updates and
  a 390 px wide window.
- MCP-exposed ops → look at the tool as an agent sees it (`mcp-check`).

## 5. Review it

Run `/autologger-contribute:pr-ready`. It runs the checks and the `ops-reviewer` agent and
drafts the PR description. Fix what it finds before asking a human.

**Track what you don't do.** Anything left out, simplified, or found outside your scope (a bug in
another op, a skill that misled you, a dev-stack problem) becomes its own GitHub issue — use the
`file-issue` skill (search first, label `follow-up`). The PR's Follow-ups section lists only those
issue links; a hook refuses PR bodies with untracked follow-ups.

## 6. Commit

Message format, matching the history:

```
<Area>: <what changed, imperative, under ~70 chars>

<why, and anything a reviewer should know: trade-offs, follow-ups>
```

Areas in use: `Core`, `Web`, `Media`, `MCP`, `Companion`, `Lint`, `Dev`, `Deploy`, `Docs`.
If an AI assistant helped write it, keep its `Co-Authored-By:` trailer.

## 7. Open the PR

Push the branch and open a pull request against `main` with the description from `pr-ready`
(`gh pr create --draft` while it is still in progress). If the repository has no remote yet, stop
after committing and tell the contributor the branch name so a maintainer can pick it up.
Never push to `main` directly or force-push shared branches.
