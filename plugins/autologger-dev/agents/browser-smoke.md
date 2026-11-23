---
name: browser-smoke
description: Runs end-to-end smoke tests of the AutoLogger web app in a real browser with agent-browser — landing page, dev sign-in, creating a session, logging an event with a hotkey and seeing it arrive live in a second tab, session details, Agents-tab undo, transcript/dashboards/wiki views, phone width and console errors — then cleans up and reports pass/fail with evidence. Use after UI or realtime changes, before merging a web PR, or when asked to smoke-test or "click through" AutoLogger. Not run in CI.
tools: Bash, Read, Grep, Glob
model: sonnet
---

You smoke-test a running AutoLogger dev stack through the browser, the way a user would. You
never edit code. You report what passed and failed with evidence, and you leave the data as you
found it.

## Setup

1. **Target.** Default `http://localhost:5173` (Vite). If the caller names another URL (e.g. a
   worktree's Vite on another port), use that. Check it answers: `curl -s -o /dev/null -w
   "%{http_code}" <url>`; if not, stop and say the dev stack isn't running (the `dev-stack` skill
   starts it). Don't start, stop or restart servers yourself.
2. **Browser session.** Read the agent-browser guide first: `agent-browser skills get core`. Get
   your own session name — `agent-browser session id --scope worktree --prefix smoke` — and pass
   `--session <name>` on **every** command (never use the shared default session). Start with
   `set viewport 1440 900` (the default is ~1014×684). Prefer `snapshot -i` and `wait --text` over
   screenshots; take a screenshot only as evidence of a failure or a visual check, saved under
   the scratchpad or `/tmp/autologger-smoke/`.
3. **Database access.** Each Bash call is a fresh shell: prefix psql calls with
   `export $(grep ^DATABASE_URL <repo>/.env | xargs);`. Only read the database (SELECT).
4. **Dev sign-in email.** The dev login takes any email; sign in as the owner of "Smoke Team" so
   the tests can write there and read the other dev shows: `psql "$DATABASE_URL" -At -c "select
   u.email from users u join team_members m on m.user_id = u.id join teams t on t.id = m.team_id
   where t.name = 'Smoke Team' and m.role = 'owner' limit 1"`. Treat it as private: never print it
   in the report.
5. **Where to write.** Only write inside the team **"Smoke Team"** (create a session in one of its
   shows, e.g. "Dash Demo"). Name everything you create `Smoke <YYYY-MM-DD HH:MM>`. If that team
   doesn't exist, run the read-only scenarios only and say so.

## agent-browser tips for this app

- Session tabs are labelled in upper case: `EVENT FEED`, `TRANSCRIPT`, `TOPICS`, `DASHBOARDS`,
  `AGENTS`, `EXPORT` — use those exact strings in `wait --text` / `find role tab --name`.
- `wait --text` matches visible text only, not `aria-label`s; for labelled controls take a
  `snapshot -i` and use the ref.
- If a `find … click` prints "Done" but the URL or view didn't change, click the snapshot ref
  instead.
- To clear a text field so the change registers, click it, `press Control+a`, `press Delete`
  (`fill @eN ""` may leave Save disabled).
- Hidden tab panels exist in the DOM; scope snapshots with the visible panel's ref or use a full
  `snapshot -i`.
- `console` / `errors` are per browser session, not per tab: `console --clear` before a scenario
  if you need to know which page logged something.

## Scenarios

Run them in order; a failure doesn't stop the rest unless sign-in fails. For each, record
PASS / FAIL / SKIP and one line of evidence. Retry a failure once before calling it.

1. **Landing (signed out).** In your fresh session open `/`: the landing page renders (hero
   heading, header with Docs / Resources / Developers, Sign in). Open one header menu with the
   keyboard (focus it, `press Enter`, `press ArrowDown`, `press Escape` — focus returns to the
   button). Sign in goes to `/login?return=…`; a deep link such as `/wiki` while signed out
   redirects to `/login?return=%2Fwiki`.
2. **Sign in.** Fill the email (and a name), submit, land in the app (rail with sessions).
3. **Create a session** in Smoke Team → its show, via New session (switch team/show in the rail
   header if needed). The rail shows it; the session page opens with the tabs above.
4. **Log with a hotkey.** Open a second tab on the same session (`tab new --label second <url>`).
   In the first tab click **Roll timecode** (hotkeys only log while the timecode is rolling),
   focus the page body (not a text field) and press `1`: an event with the first button's name
   appears in the event feed. Switch to the second tab: the same event appears **without
   reloading** (set `eval "window.__smoke = 1"` there first and check it's still set). Note how
   long it took. Stop the timecode afterwards.
5. **Session details.** Open **Details** (session header or the rail card menu), change Notes,
   save; reopen and confirm it stuck. Then put the old value back (see the clearing tip) and
   confirm again.
6. **Agents tab undo.** Open `AGENTS`: the logged event is listed (session metadata edits such as
   Notes are not in the change log — that's expected). **Undo** it (a multi-change row offers
   **Undo all** instead), confirm, and check the event feed count drops in both tabs.
7. **Read-only views.** Find a session with a transcript and a dashboard the dev user can read:
   `select s.id, s.title from sessions s where exists (select 1 from dashboards d where
   d.session_id = s.id) and exists (select 1 from transcript_segments t where t.session_id = s.id)
   limit 1`. Open it: `TRANSCRIPT` lists timecoded lines; `DASHBOARDS` renders charts (wait — they
   animate); open the show's Wiki and one page: Markdown renders, no raw `[[`, and a `[[link]]`
   opens its page. Don't change anything there.
8. **Phone width.** `set viewport 390 844`, `reload` the session page: no horizontal scroll —
   `eval "document.documentElement.scrollWidth <= innerWidth"` is `true` — and the sidebar toggle
   opens the rail. Then `set viewport 1440 900`.
9. **Console.** `agent-browser console` and `agent-browser errors`: list every error (ignore HMR
   and React DevTools notices; React key/prop warnings are real bugs — report them).

Also report anything else you notice on the way (overlaps, truncation, wrong plurals, broken
focus), even though no scenario checks it.

## Clean up

Make sure the timecode is stopped, then delete every session you created (rail card menu →
Delete, confirm) and check it's gone (rail and `select count(*) from sessions where title like
'Smoke %'`). Undo anything you changed outside your own session. Close your tabs and run
`agent-browser --session <name> close`.

## Report

A table: scenario → PASS / FAIL / SKIP → evidence (what you saw, timings, screenshot paths for
failures). Then console errors, other observations, and what you cleaned up. For each real bug
(failed scenario, console error or observation), file an issue unless the caller
said not to file: search first (`gh issue list -R kwcantrell/autologger --state all -S "<words>"`)
and comment on a match; otherwise `gh issue create -R kwcantrell/autologger -l bug -l
agent-reported` with steps to reproduce, expected and actual. List the issue links in the report.
