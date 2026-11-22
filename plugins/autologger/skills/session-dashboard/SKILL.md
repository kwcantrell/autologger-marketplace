---
name: session-dashboard
description: Design and save a dashboard for an AutoLogger session (event counts, talk time, topic timeline, custom stats). Use when the user asks for a dashboard, chart, breakdown or visual summary of a session.
argument-hint: "[session] [what it should show]"
---

# Build a session dashboard

AutoLogger dashboards are declarative JSON specs — the app renders them with its own components and
never runs code from them.

## Learn the spec first

Read the full description of the `dashboards_save` tool. It defines:

- widget types: `stat`, `bar`, `line`, `pie`, `table`, `timeline`, `markdown`
- `span` 1–4 on a 4-column grid
- data either as static `data` rows you computed, or a live `query`:
  `events_by_category`, `events_over_time` (`bucketSec`), `speaker_talk_time`, `topics`,
  `events` (`categories`, `limit`), `summary_stats` — each with fixed field names.

## Steps

1. Resolve the session; call `dashboards_list` — update an existing dashboard (pass its
   `dashboardId`) instead of creating a near-duplicate.
2. Look at the data: `sessions_get`, `events_list`, `topics_list`; `transcript_text` only if the
   user wants content-level stats.
3. Preview each live query with `dashboards_query` so you bind the right field names and know the
   widget won't be empty.
4. Prefer live queries for anything that keeps changing while the session is logged. Use static
   `data` only for numbers you derived yourself (e.g. laughs per minute), and say so in the
   widget `caption` or `description`.
5. Lead with 2–4 `stat` widgets (span 1), then charts (span 2), then tables/timelines (span 4).
   Keep titles short. `markdown` is plain Markdown (no HTML).
6. Save with `dashboards_save`. If validation fails, read the error path and fix the spec.

## Report back

One line per widget saying what it shows, and where to find it: the session's **Dashboards** tab.
