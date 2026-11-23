---
name: dev-stack
description: Start, check, seed or reset the AutoLogger local development stack (Postgres, S3, API, worker, Vite) and sign in with the dev login. Use when asked to run autologger locally, get a dev environment up, seed demo data, or debug why the dev servers aren't working.
argument-hint: "[start|status|seed|stop]"
---

# AutoLogger dev stack

| Piece | Where | Started by |
|---|---|---|
| Postgres 17 | `localhost:54329` (db `autologger`, tests use `autologger_test`) | `docker compose -f compose.dev.yaml up -d` |
| S3 (SeaweedFS) | `localhost:9000`, key `autologger` / `autologger-secret` | same |
| API + WS + MCP | `localhost:${PORT}` from `.env` (default 18081) | `npm run dev:server` |
| Worker | — | `npm run dev:worker -w @autologger/server` (needs `yt-dlp` on PATH for YouTube import), or in Docker with yt-dlp included: `docker compose -f compose.dev.yaml --profile worker up -d --build` (run one or the other) |
| Web (Vite) | `localhost:5173`, proxies `/api`, `/auth`, `/oauth/*`, `/mcp`, `/ws` | `npm run dev:web` |

| Local import helper | served by the API at `/api/importer/autologger-import.mjs` | `node autologger-import.mjs …` with `AUTOLOGGER_URL` and `AUTOLOGGER_TOKEN` (source in `apps/importer`) — uploads YouTube/local media from the user's machine when the server can't download |

`.env` at the repo root (copy `.env.example`). `PUBLIC_URL` should be the Vite origin in dev
(`http://localhost:5173`) so OAuth redirects and MCP discovery point at the proxy. Waveforms and
compilations need `ffmpeg` (`FFMPEG_PATH` if it isn't on PATH).

## start

1. `docker compose -f compose.dev.yaml up -d`; wait for `pg_isready`. Once per volume, create the
   test database: `docker exec <postgres container> createdb -U autologger autologger_test` (`docker ps` shows the name)
   (ignore "already exists").
2. `npm install` if `node_modules` is missing.
3. Start API, worker and Vite in the background (separate processes). The API runs migrations on
   boot. npm 12 rejects `npm run x -- --flags`; call `npx vite …` directly for Vite flags.
4. Check: `curl -s localhost:5173/api/capabilities` → `{"ok":true,…}`.

## status

Check the three ports, `/healthz`, and `/api/capabilities` (shows which integrations are on:
`storage`, `transcription` needs `DEEPGRAM_API_KEY`, `youtube` needs storage and yt-dlp,
`googleAuth`, `devLogin`).

## seed

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/seed.mjs [baseUrl] [email]` (defaults
`http://localhost:5173`, `owner@example.com`; pass the plugin's `dev_url` if yours differs). It
signs in with the dev login and creates the **Smoke Team** team — the sandbox the browser-smoke,
visual-review, bug-hunt and ui-designer agents write in — with a show and a session holding a short
transcript, events, topics, a dashboard and wiki pages, through the RPC API, then prints the
session URL. Each run creates a new team; run it once per fresh database.

## Sign in

`DEV_LOGIN=1` enables the email form on the login page and `POST /auth/dev-login {"email"}`. The
**first account ever** becomes the instance admin; later accounts are `pending` until approved in
Settings → Admin, invited to a team, or listed in `SUPERADMIN_EMAILS`.

## stop / reset

Stop the background processes. `docker compose -f compose.dev.yaml down` keeps data;
add `-v` only if the user explicitly wants to wipe the dev database and media.
