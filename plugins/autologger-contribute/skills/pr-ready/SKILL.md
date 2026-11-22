---
name: pr-ready
description: Check an AutoLogger change before opening a pull request — runs typecheck, lint on changed files and tests, reviews the diff against the architecture rules, and drafts the PR description. Use when a contributor says they are done, asks "is this ready", or wants a PR description.
---

# Ready for a pull request?

Work from the repo root of the contributor's AutoLogger checkout, on their branch.

## 1. What changed

`git status` and `git diff main...HEAD --stat` (plus uncommitted changes). If they are on `main`,
stop and help them move the work to a branch first (`contribute` skill, step 2).

## 2. Checks

Run and report each result verbatim when something fails:

```bash
npm run typecheck
npx biome check $(git diff --name-only main...HEAD -- '*.ts' '*.tsx' '*.css' '*.json')
cd apps/server && npx vitest run        # needs the dev Postgres and autologger_test database
```

Lint only the changed files so pre-existing findings don't block them; never "fix" unrelated
files in the same PR. If `apps/companion` changed: `cd apps/companion && npm run build && npx vitest run`.
If `apps/web` changed: `cd apps/web && npx vite build`.

## 3. Review

If the `autologger-dev` plugin is installed, delegate to its `ops-reviewer` agent. Otherwise check
the diff yourself against `CLAUDE.md`: one op per capability, authorization first, change log for
content writes, realtime publish, contract types, agent-quality descriptions, erasable TypeScript,
no hand-edited migrations, a focused test.

Also check: secrets or `.env` files staged? Unrelated changes mixed in? Schema change without a
generated migration?

## 4. PR description

Draft it from the diff:

```markdown
## What
<one or two sentences: what is different for users / agents / developers>

## Why
<the problem or request>

## How
<key decisions; ops added or changed (name, surfaces); schema changes>

## Verification
- [ ] typecheck  - [ ] lint (changed files)  - [ ] server tests  - [ ] web build / browser check
<what you checked by hand, with steps>

## Follow-ups
<anything deliberately left out>
```

End with a clear verdict: **ready**, or the list of what to fix first.
