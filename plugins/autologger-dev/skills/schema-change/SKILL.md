---
name: schema-change
description: Change the AutoLogger Postgres schema safely with Drizzle — edit schema.ts, generate a migration, apply it, update mappers, entities and tests. Use for any new table, column, index or constraint in autologger.
argument-hint: "<schema change>"
---

# Change the schema

The schema lives in `apps/server/src/db/schema.ts` (Drizzle). Migrations in
`apps/server/drizzle/` are **generated** — never hand-edit them (a hook in this plugin blocks it).
The one exception is a data migration (see below).

## Steps

1. Edit `schema.ts`. Conventions:
   - text ids with a prefix from `newId('xyz')`; `created_at`/`updated_at` via the local helpers;
     timestamps `withTimezone`, mode `'date'`.
   - foreign keys with explicit `onDelete` (`cascade` for owned rows, `set null` for authorship).
   - enums as `text(..., { enum: [...] })` (not Postgres enums).
   - full-text search: a generated `tsvector` column + GIN index (see `events.search`).
   - every new content table that agents can write needs an entry in `ops/changes.ts` `TABLES`
     so undo works; generated columns are skipped automatically.
2. Generate: `cd apps/server && npx drizzle-kit generate --name <short_name>`. Read the SQL it
   produced. For a column that must be NOT NULL on existing data, add it nullable or with a default
   first.
3. Apply: `npm run db:migrate` (the API also migrates on boot). Tests migrate `autologger_test`
   themselves.
4. Update `ops/map.ts`, `packages/contract/src/entities.ts` and any op that reads/writes the table.
5. Verify: `npx tsc -p apps/server && (cd apps/server && npx vitest run)`.

## Data migrations (backfills)

To change existing rows rather than the schema: `cd apps/server && npx drizzle-kit generate
--custom --name <change>`. It creates an empty `.sql` starting with `-- Custom SQL migration file`
plus its meta entry; write your SQL in that file (the hook allows it; meta stays generated).
- Make it idempotent (e.g. `where col is null`) — it runs once per database, but tests and reruns
  must not double-apply.
- Verify on a copy of the dev DB (`pg_dump … | psql` into a private database), report how many rows
  it touches, then drop the copy. Never run it against the shared dev database yourself; the API
  applies it on boot after merge.
- Add a test that seeds old-style rows and runs the migration's SQL.

Destructive changes (drop/rename column or table) — stop and confirm with the user first; there is
no automatic down-migration.
