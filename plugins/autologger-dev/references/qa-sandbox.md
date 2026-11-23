# QA sandbox — shared rules for the browser agents

The `browser-smoke`, `visual-review`, `bug-hunt` and `ui-designer` agents all follow this. Each
agent's own file adds its name prefix and what it may write.

## Target

Default `http://localhost:5173` (Vite); use another URL only if the caller names one, and only a
`localhost` / `127.0.0.1` one. Check it answers: `curl -s -o /dev/null -w "%{http_code}" <url>`; if
not, stop and say the dev stack isn't running (the `dev-stack` skill starts it). Never start, stop
or restart the user's servers.

## Browser session

Read `agent-browser skills get core` first. Get your own session —
`agent-browser session id --scope worktree --prefix <your prefix>` — and pass `--session <name>`
on **every** command (never the shared default). Start with `set viewport 1440 900`. Close it at
the end: `agent-browser --session <name> close`.

## Database (read-only)

Each Bash call is a fresh shell: prefix psql calls with
`export $(grep ^DATABASE_URL <repo>/.env | xargs);` and run only SELECTs. Never read or print other
`.env` values.

## Sign in

Sign in with the dev login as the owner of the **Smoke Team** team:

```bash
psql "$DATABASE_URL" -At -c "select u.email from users u join team_members m on m.user_id = u.id
  join teams t on t.id = m.team_id where t.name = 'Smoke Team' and m.role = 'owner' limit 1"
```

If there is no Smoke Team, `node ${CLAUDE_PLUGIN_ROOT}/scripts/seed.mjs <url>` creates one — only
if the caller agreed; otherwise do read-only work and say so. Treat the email, cookies and tokens
as private: never put them in a report or an issue.

## Writing

Write only inside Smoke Team, only things you create, named `<Your prefix> <YYYY-MM-DD HH:MM> …`.
Never change or delete anything you didn't create. Before finishing, delete what you created and
confirm with a SELECT on your prefix that nothing is left.

## Filing issues

Unless the caller said not to file:

1. Confirm the bug once more from a clean state.
2. **Security-sensitive** (another user's data visible or writable, script running from user
   content, auth or session bypass, secrets leaking): **never file publicly** — the repo is public.
   Put it at the top of your report under "Security — report privately" with severity and the class
   of problem.
3. Search first: `gh issue list -R kwcantrell/autologger --state all -S "<key words>"`; on a match,
   comment with the new evidence instead.
4. Otherwise `gh issue create -R kwcantrell/autologger -l bug -l agent-reported -t "<Area>: <what is
   wrong>" -F <body.md>`, Area one of Core, Web, Media, MCP, Companion, Dev, Docs. Body: **Steps to
   reproduce**, **Expected**, **Actual** (error text or what the screenshot shows — screenshots
   stay local), and the op or component involved if you found it.
5. One issue per root cause; at most 10 per run, worst first; list the rest in your report.
