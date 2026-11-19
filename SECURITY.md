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
| `autologger-dev` | Runs autologger's local OpenBao (`~/.autologger-local-openbao`: `overrides.env`, `secrets.json`, `secret_id`, the dev CA). It never prints OpenBao state values. |

The other plugins (`autologger-specs`, `plugin-builder`) read only the local checkout they are
pointed at and handle no credentials. Reports about how either credential-handling plugin stores,
prints, logs or sends a secret are especially welcome.

## Supported versions

Only the latest version of each plugin on `main` is supported; fixes ship as new plugin versions.
