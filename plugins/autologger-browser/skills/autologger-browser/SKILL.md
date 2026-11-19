---
name: autologger-browser
description: Gives agent-browser a Chromium profile that trusts a local autologger dev stack's private CA (and only there), optionally signed in with make dev-login, and prints the exact agent-browser flags to use. Use when working on autologger custom dashboards or any autologger dev-stack page in a browser (https://localhost:8787, https://dashboards.localhost, a dev slot's https://localhost:2N787 or https://dashboards-N.localhost), or when agent-browser shows ERR_CERT_AUTHORITY_INVALID on one of them.
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-browser doctor:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-browser --help:*)
---

# autologger-browser

A local autologger dev stack serves HTTPS with certificates from a private dev CA. This plugin's
TypeScript CLI makes a dedicated Chromium profile for agent-browser that trusts that CA, in the
profile's own NSS database only (never the user's browser, `~/.pki/nssdb` or the system store),
and prints the agent-browser flags that use it. Run it exactly as written below, from any
directory, with no install or build step first.

**Never use `--ignore-https-errors`** (or any flag that turns certificate checks off) for a dev
stack page. If a page shows a certificate error, run `doctor` and follow its fixes.

The dev slot is 0 (`https://localhost:8787`, runtime `https://dashboards.localhost`) unless you
append `--slot <N>` to every command (`https://localhost:2N787`, `https://dashboards-N.localhost`).

## 1. Check what is missing

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-browser doctor --json
```

It prints `{"slot", "ok", "checks": [{"name", "status", "detail", "fix"}]}` and exits 0 whatever it
finds. Checks: `agent_browser`, `chromium`, `certutil`, `dev_ca`, `profile`, `app_tls`,
`runtime_tls`; `status` is `ok`, `missing` or `fail`, and `fix` says what to do. Fixes that install
system packages (`certutil` from `libnss3-tools`, chromium, agent-browser) are the user's to run:
tell them the fix, do not install anything yourself.

## 2. The dev CA

If `dev_ca` is missing (or `app_tls` says the CA is stale), the CA file comes from the
autologger-dev plugin: run its `autologger-dev ca --repo <autologger-2 checkout>` command (its
skill, `autologger-dev`, says how), which writes `~/.autologger-dev/autologger-dev-ca.crt`. Then
continue here.

## 3. Set up the profile

`setup` writes files (under `~/.autologger-dev/browser/slot-<N>/` only), so it is not pre-approved;
run it when `profile` is not ok, or after the CA changed (after `make dev-reset`):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-browser setup --json
```

It prints `flags` (the agent-browser global flags, in order: `--session autologger-dev-<N>
--profile <dir> --executable-path <launcher>`), `command` (`agent-browser` plus those flags,
shell-quoted), `app_url`, `runtime_url`, `trust` (`added`, `replaced` or `unchanged`) and
`restart_needed`. Re-running it is safe: it is a no-op when nothing changed. When `restart_needed`
is true and that session is already open, run `agent-browser --session autologger-dev-<N> close`
before using it again. `--ca <file>` uses another CA file.

## 4. Sign the profile in (optional; the user's step)

To see pages as a signed-in user, the profile needs a session cookie from autologger's dev-only
`make dev-login EMAIL=<address>`, which **creates or signs in a dev account**, so it is the user's
step. Give them this pipeline to run in their autologger-2 checkout (put `DEV_SLOT=N ` before
`make` and add `--slot N` after `signin` for dev slot N), in their terminal or here by typing `!`
and the line: `make dev-login EMAIL=<address> | ` followed by the command below. Only if the user
asks you to run it, ask first, naming the email and the slot, then run the whole pipeline yourself.

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-browser signin --json
```

`signin` reads the single `<cookie name>=<token>` line on stdin and stores it in the profile as the
slot's Secure, HttpOnly session cookie. It prints the cookie name, origin and expiry, never the
token. The token is a secret: **never print, echo, copy, save or read it**, never run `make
dev-login` on its own or into a file, and never put the token in a command line. Pipe it straight
into `signin`.

## 5. Use the browser

Always start agent-browser with the flags `setup` printed, on every command, e.g.:

```
agent-browser --session autologger-dev-0 --profile <dir> --executable-path <launcher> open https://localhost:8787
agent-browser --session autologger-dev-0 --profile <dir> --executable-path <launcher> snapshot -i
```

Close the session when done: `agent-browser --session autologger-dev-0 close`.

## Starting over

`reset` closes the slot's session and deletes its profile, NSS database and launcher (and the
sign-in with them). It is destructive, so ask the user first:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-browser reset --json
```

Exit codes: 0 success, 1 the command failed, 2 usage error. On a non-zero exit the reason is on
stderr; show it to the user instead of guessing. Every command and option:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-browser --help
```
