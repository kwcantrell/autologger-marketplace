# autologger-browser

A Chromium profile for [agent-browser](https://github.com/vercel-labs/agent-browser) that trusts a
local [autologger](https://github.com/kwcantrell/autologger-2) dev stack's private CA, and only
there, so Claude can drive real pages on `https://localhost:8787`, the dashboard runtime at
`https://dashboards.localhost`, or a dev slot's `https://localhost:2N787` and
`https://dashboards-N.localhost`, without certificate errors and without
`--ignore-https-errors`. The profile can also be signed in with autologger's dev-only
`make dev-login`.

agent-browser's own `--ca-cert` trusts a CA only in a throwaway NSS database and does not support
`--profile`, so it cannot give a persistent, signed-in profile. This plugin can.

## Install

```
/plugin marketplace add kwcantrell/autologger-marketplace
/plugin install autologger-browser@autologger-marketplace
```

Needs Node.js 22.18 or newer to run the CLI, with no runtime dependencies and nothing to build.
Linux only. On `PATH`: `agent-browser`, a Chromium (`chromium`, `chromium-browser` or
`google-chrome`, or `AGENT_BROWSER_EXECUTABLE_PATH`) and `certutil` (Debian/Ubuntu
`libnss3-tools`, or `agent-browser install --with-deps`). The dev CA file comes from the
`autologger-dev` plugin's `autologger-dev ca` (`~/.autologger-dev/autologger-dev-ca.crt`).

| Skill | Use |
| --- | --- |
| `autologger-browser` | Runs `doctor`, then `setup`, gives you the `make dev-login ... \| ... signin` line to run, and uses agent-browser only with the printed flags. |

## Commands

| Command | What it does |
| --- | --- |
| `doctor [--slot N] [--ca file]` | Read-only. Named checks, each `ok`, `missing` or `fail` with a fix: `agent_browser` (and its version), `chromium`, `certutil`, `dev_ca` (present and one PEM certificate), `profile` (created, launcher current, the CA trusted `C,,`), `app_tls` and `runtime_tls` (the app and runtime answer over TLS verified with the CA alone). Exits 0 whatever it finds. |
| `setup [--slot N] [--ca file]` | Creates or re-uses the slot's folder, trusts the CA in its private NSS database, writes the launcher, prints the agent-browser flags (`--json`: `flags`, `command`, `session`, `profile`, `launcher`, `app_url`, `runtime_url`, `trust`, `restart_needed`). Replaces the CA when the file changed (after `make dev-reset`), otherwise a no-op. |
| `signin [--slot N]` | Reads one line, `<cookie name>=<token>`, from stdin (`make dev-login EMAIL=<address> \| autologger-browser signin`) and stores it in the profile as the slot's session cookie: `autologger_sid` (slot 0) or `autologger_sid_N`, Secure, HttpOnly, SameSite Lax, path `/`, for the slot's app origin, expiring in 14 days (autologger's default `SESSION_DAYS`). Refuses (exit 2, nothing run) anything that is not exactly one such line for that slot. |
| `reset [--slot N]` | Closes the slot's agent-browser session and deletes the slot folder (profile, NSS database, launcher), after checking it is a real `slot-N` directory directly inside `~/.autologger-dev/browser`. |

Every command takes `--json` and exits 0 (success), 1 (failed) or 2 (usage error), with the
message on stderr.

**Ports.** Slot 0's app origin is `https://localhost:<DEV_PORT>` when
`~/.autologger-local-openbao/overrides.env` (or `$LOCAL_BAO_DIR/overrides.env`) sets a valid
`DEV_PORT` (digits only, 1-65535, no leading zero, read verbatim as autologger-dev reads it), else
`https://localhost:8787`. It sets doctor's `app_tls` probe and setup's `app_url`. Slots 1-9 always
use `2N787`. The session cookie `signin` sets is not tied to a port.

**CA fixes.** When the dev CA is missing or stale, doctor's fix is
`autologger-dev ca --repo <path to autologger-2>` (plus `--slot N`): autologger-dev's `ca` runs the
checkout's Makefile, so it needs the checkout.

## How the trust is scoped

Everything lives in `~/.autologger-dev/browser/slot-<N>/` (directories mode 700):

```
slot-<N>/
  profile/                    Chromium user data dir (agent-browser --profile)
  home/.local/share/pki/nssdb private NSS database (cert9.db, key4.db)
  home/.pki/nssdb             symlink to the database above
  chromium-launcher.sh        agent-browser --executable-path (mode 700)
```

1. **A private NSS database.** `setup` creates it with `certutil -N --empty-password` and adds the
   dev CA with `certutil -A -n autologger-dev-ca -t C,,`: a trusted CA for TLS server
   certificates only, not for e-mail or code signing. Every `certutil` call names this database
   with `-d sql:<dir>`; the user's `~/.pki/nssdb`, `~/.local/share/pki/nssdb`, the system trust
   store and `/etc` policies are never touched.
2. **A launcher.** Chromium on Linux reads user trust from the NSS database at
   `$XDG_DATA_HOME/pki/nssdb` (current versions; `$HOME/.pki/nssdb` when that exists, hence the
   symlink). The launcher is a short `/bin/sh` script whose only job is to set `HOME` and
   `XDG_DATA_HOME` to `slot-<N>/home` for the Chromium process (keeping the real `~/.Xauthority`
   for X11 when `XAUTHORITY` is unset) and `exec` the real Chromium with agent-browser's
   arguments unchanged. It adds no flag: no `--ignore-certificate-errors`, no SPKI list.
3. **A session of its own.** The printed flags include `--session autologger-dev-<N>`, so
   agent-browser never reuses a browser that was launched without the profile.

Chromium started any other way (agent-browser without these flags, the user's own browser) does not
see the CA: without the flags, `https://localhost:8787` fails with `ERR_CERT_AUTHORITY_INVALID`.
Certificate hostname, validity and chain checks all stay on.

## The sign-in cookie

`signin` passes the cookie to agent-browser on **stdin** (`agent-browser <flags> batch --bail
--json --omit-command`, one `cookies set ... --secure --http-only` command as JSON), so the token is
never in a command line or the process list, never in a temp file, and never in this CLI's output
or error messages (agent-browser's error text is scrubbed of it). `make dev-login` creates or signs
in a dev account, so running that pipeline is the user's step, or Claude's only after asking.

## Testing

`npm test` at the repo root runs `test/*.test.ts`. The end-to-end test sets
`AUTOLOGGER_BROWSER_TEST_PROBE_ORIGIN` to a closed port on `127.0.0.1`: **test only**, it makes
doctor probe that https origin in place of both the app and runtime origins, so the test never sends
a request to a dev stack running on the machine. Do not set it otherwise.
