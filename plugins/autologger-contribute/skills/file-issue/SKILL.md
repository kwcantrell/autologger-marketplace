---
name: file-issue
description: Turn follow-ups and problems found while changing AutoLogger into tracked GitHub issues — anything deferred, simplified or left out of a change, review findings not fixed in the PR, bugs or gaps noticed outside the current scope, and problems with the contributor plugins themselves. Use before opening or updating a pull request that has follow-ups, after a review, or whenever the user asks to track something for later.
argument-hint: "[what to track]"
---

# File follow-ups and problems as issues

A follow-up that lives only in a PR description is lost once the PR merges. Every deferred item
gets its own issue, and the PR links to it.

## When

- **Before `gh pr create` / `gh pr edit`:** each item you would write under "Follow-ups" (left out,
  simplified vs. the issue, "could later", "not verified on …").
- **After a review:** findings you agreed with but are not fixing in this PR.
- **While coding:** a bug or gap outside your scope (another op, the web, a skill, a hook, the dev
  stack). Note it and keep going; file it before you finish.

## Where

- App code, MCP tools, web, worker, dev stack → `kwcantrell/autologger`
- Skills, agents, hooks, plugin config → `kwcantrell/autologger-marketplace`

## Steps

1. Search first: `gh issue list -R <repo> --state all -S "<key words>" --limit 10`. If an issue
   already covers it, comment with the new context instead of opening another.
2. One issue per item. Title `<Area>: <problem or change>` (Areas as in commit messages: Core, Web,
   Media, MCP, Companion, Dev, Docs; Plugins/Skills for the marketplace). Body in a file:

   ```markdown
   ## Problem
   <what is missing or wrong, with file:line or tool name>

   ## Proposal
   <the change, and what "done" looks like>

   Follow-up from #<issue or PR>.
   ```

   `gh issue create -R <repo> -t "<title>" -F body.md -l follow-up -l <bug|enhancement|documentation>`
   (add `agent-reported` when it came from using AutoLogger through an agent).
3. In the PR description, the **Follow-ups** section lists only links: `- #123 short title`.
   Write `None` when there are none. The `autologger-contribute` hook refuses `gh pr create` /
   `gh pr edit` bodies whose Follow-ups items have no issue reference.

## Report back

The issues created or commented on, one line each, and the updated Follow-ups section.
