# Security policy

Plugins from this marketplace run on the machines of everyone who installs them, so a security
problem here is a problem on theirs. Thank you for reporting one privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/kwcantrell/autologger-marketplace/security/advisories/new)**
(the repo's **Security** tab, then **Report a vulnerability**). Only the maintainer sees the report.

**Never open a public issue, pull request or discussion for a vulnerability.** Public issues are
for ordinary bugs and suggestions, and some are filed automatically by tooling (for example the
plugin-advisor plugin).

**No secret ever belongs in an issue**, public or not, in this repo or anywhere else: no OAuth
access or refresh token, no `client_id`/`client_secret`, no OpenBao `secret_id` or `secrets.json`
value, no credentials file, no `.env` or `overrides.env` content, no private key. If you pasted one
by mistake, revoke or rotate it first (sign out with `autologger-mcp logout`, or re-mint the dev
token), then delete it from the issue. Redact such values from logs and command output before you
attach them to any report.

## What handles credentials

| Plugin | Credentials it touches |
| --- | --- |
| `autologger-mcp` | autologger OAuth access and refresh tokens (from `login` or `import-tokens`), kept in a per-server credentials file under `$XDG_CONFIG_HOME/autologger-mcp/credentials/` (or `~/.config/...`). |
| `autologger-dev` | Reads autologger's local OpenBao state (`~/.autologger-local-openbao`: `overrides.env`, `secrets.json`, `secret_id`) and the dev CA (`~/.autologger-dev/`). It never prints OpenBao state values and mints no tokens or credentials. |
| `autologger-browser` | Keeps a browser profile per dev slot under `~/.autologger-dev/browser/slot-<N>/` (directories mode 700) holding the session cookie stored by `signin` (`autologger_sid`, `autologger_sid_N`), and a private NSS database that trusts the dev CA. It changes no system or user trust store. |
| `plugin-advisor` | Keeps a local log of problems Claude hit, redacted on write (tokens, cookies, `KEY=value` secrets, JWTs, URL credentials, private keys). Its `file --confirm` posts that redacted text as a **public** GitHub issue via `gh`, and re-checks for secrets first. |
| `plugin-discover` | Reads installed-plugin metadata and this marketplace's manifest, and can install a plugin from this marketplace (`claude plugin install`) in its configured mode. It handles no credentials. |
| `autologger-clips` | Handles no credentials (it has no OAuth of its own; the session media list comes from `autologger-mcp`). Keeps a session-to-video map (`media.json`, mode 0600) under `$XDG_CONFIG_HOME/autologger-clips/` (or `~/.config/...`), downloads a session's own YouTube source with `yt-dlp` only after the user agrees, clones OpenReel at a pinned commit into `~/.autologger-clips/openreel/` and runs its `pnpm install` and `pnpm dev` on 127.0.0.1 only on `editor start`. |
| `autologger-specs`, `plugin-builder` | Read and write files in the local checkout they are pointed at. They handle no credentials. |

A plugin added to the marketplace later is covered by the same rule: it should state in its README
what credentials, tokens, cookies or personal data it reads, stores or sends, and this table is
kept in step with the marketplace manifest (a test fails when a plugin is missing here). Reports
about how any plugin stores, prints, logs or sends a secret, or about what it installs or files
without asking, are especially welcome.

## Supported versions

Only the latest version of each plugin on `main` is supported; fixes ship as new plugin versions.
