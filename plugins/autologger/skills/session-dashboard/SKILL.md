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
  `events` (`categories`, `limit`), `summary_stats`, `category_count` (`categories`) — each with
  fixed field names.

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
   Keep titles short. `markdown` is Markdown (tables render; no HTML).
6. Save with `dashboards_save`. If validation fails, read the error path and fix the spec.

## Gotchas

- The `events` query's `label` field is the **button name**, not a time. For a time column use
  `atSec` (seconds from the start, rounded to ms as in `events_list`); a `table` without `columns`
  shows `atSec` as a duration.
- Live count of one category on a stat: `{ type: "stat", query: { name: "category_count",
  categories: ["Key insight"] } }` (0 when none) — not an `events_over_time` bucket workaround.
- Event `atSec` snaps to the session's frame grid when logged, so compare the values the query
  returns, not the ones you sent.
- For a chapter timeline use `{ "name": "topics", "maxLevel": 1 }`; without `maxLevel` the query
  returns every level and the timeline gets crowded.
- Values can be formatted: `format` on a `stat`, a bar/line value axis, a `pie` (legend and
  tooltip — e.g. talk time in `"minutes"`) and per `table` column (`{ key, label, format }`, e.g.
  `atSec` as `"duration"`) — `"duration"` (seconds → M:SS / H:MM:SS), `"minutes"` (seconds →
  minutes, one decimal), `"number"`, `"percent"` (0–1 ratio). Long bar labels: `labelMaxChars`
  (about 18) truncates with the full label in the tooltip.
- Unknown widget fields are rejected with their path (e.g. `spec.widgets[4].colour`) — fix the
  field rather than retrying; nothing is silently dropped.
- Small fixes to a saved dashboard (a label, a format, a caption): `dashboards_updateWidgets`
  with `[{ id, ...changedFields }]` instead of resending the whole spec (`null` removes an
  optional field). Adding, removing or reordering widgets still uses `dashboards_save`.
- Speaker talk time is only as good as diarization: if the transcript still has lines that mix
  two voices, say so in the widget `caption`.
- Speaking pace: bind a `stat` to `summary_stats` field `wpm` (live; words over first-to-last
  transcript line, `speechSec`). Don't compute it by hand.
- Keep everything live: Length = `stat` on `summary_stats` field `audioSec` with
  `format: "duration"`; chapter lengths = horizontal `bar` on `{ "name": "topics", "maxLevel": 1 }`
  with x `label`, y `durationSec`, `format: "minutes"`, `labelMaxChars: 18`.
- `dashboards_save` with `compact: true` returns only `{ id, revision }`.
- When several dashboards belong to one series, keep the same layout and widget ids so they read
  as a set. When one layout is applied to many sessions, some will lack speech, topics or events:
  give those widgets `emptyText` (e.g. "No speech in this session"), or `hideWhenEmpty: true` where
  a blank is better gone (`speaker_talk_time` pies, the `summary_stats` `wpm` stat).

## Report back

One line per widget saying what it shows, and where to find it: the session's **Dashboards** tab.

If an AutoLogger tool was missing, failed, or cost far too many calls or tokens along the way — or
something was left for later — file it with the `report-issue` skill when the task is done and
list the issue links in your report.
