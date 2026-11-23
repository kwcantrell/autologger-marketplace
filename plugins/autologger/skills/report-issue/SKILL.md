---
name: report-issue
description: File a GitHub issue for a problem met while working with AutoLogger — an MCP tool that is missing, errors, returns far too much, needs many calls or a workaround, or an AutoLogger skill/plugin that gave wrong or outdated guidance — and for work deliberately left for later. Use at the end of any AutoLogger task where something got in the way, or when the user asks to report a bug, request a feature or track a follow-up.
argument-hint: "[what went wrong or what was left for later]"
---

# Report an AutoLogger issue

Problems found while using AutoLogger should end up as issues someone can track, not as prose in a
chat or a PR description. Don't interrupt the user's task for this: **note each problem as it
happens** (tool, what you needed, what happened, exact error, what you did instead) and file them
together when the task is done. (Contributors tracking follow-ups from a code change use the
`autologger-contribute` plugin's `file-issue` skill instead.)

## What is worth an issue

- An MCP tool is **missing** for something you needed, so you had to work around it (another tool,
  the shell, the browser) or give up.
- A tool **errors** in a way that isn't your mistake, or **misbehaves** (wrong data, silently
  dropped fields, ignored options).
- A tool **costs too much**: huge responses, one call per item where a batch would do, no way to
  wait, page or filter.
- A tool **description or skill is wrong or misleading** (it made you call the tool incorrectly).
- **Deferred work**: something you or the user decided to leave for later.

Not worth an issue: your own mistakes, one-off data problems in a session (fix them), or
questions the docs already answer.

## Where it goes

- App, MCP tools, server, worker, web UI → `kwcantrell/autologger`
- Skills, plugins, hooks, the marketplace → `kwcantrell/autologger-marketplace`

## Steps

1. Check you can file: `gh auth status`. If `gh` is missing or not signed in, or the user has no
   access, don't stop — write the issue text out in your final report so the user can file it.
2. **Search first**, open and closed:
   `gh issue list -R <repo> --state all -S "<tool name or key words>" --limit 10`.
   If one already covers it, add your evidence as a comment (`gh issue comment <n> -R <repo> -F
   body.md`) instead of filing a duplicate. Reopen nothing; mention closed matches in your comment.
3. **One issue per distinct problem.** Title: `<Area>: <the problem, plainly>` (Areas as in commit messages — app: Core,
   Web, Media, MCP, Companion, Dev, Docs; marketplace: Skills, Plugins). Body (write it to a file
   and pass `-F`):

   ```markdown
   ## Problem
   <what you were doing, which tool (e.g. `transcript_replace`), the input shape, what happened —
   exact error text or response size — and what you did instead>

   ## Impact
   <how often / how costly: extra calls, KB of output, failed step, wrong data>

   ## Proposal
   <optional: the smallest change that would fix it>

   Found while: <task, e.g. "annotating a 19-episode playlist">
   ```

   Labels: `agent-reported`, plus `bug` (misbehaves), `enhancement` (missing / too costly) or
   `documentation` (wrong description or skill); add `follow-up` for deferred work.
   `gh issue create -R <repo> -t "<title>" -F body.md -l agent-reported -l <kind>`
4. Keep it safe to share: ids (`ses_…`, `show_…`) and short quotes are fine; never paste secrets,
   tokens, `.env` values, personal data or long transcript passages.

## Report back

A list of issues filed or commented on (`#n title — link`), and any you only drafted because
`gh` wasn't available.
