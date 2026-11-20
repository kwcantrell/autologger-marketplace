# autologger-mcp

Read and write [autologger](https://github.com/kwcantrell/autologger-2) session data (studios,
shows, sessions, events, transcripts, topics, wiki pages, dashboards) from the terminal, through
autologger's own MCP endpoint. The plugin's TypeScript CLI signs you in with autologger's OAuth 2.1
flow, keeps and refreshes the tokens, and calls the MCP tools; its skills tell Claude when and how
to call it. It also checks wiki page bodies for the link mistakes agents make (`[[Title]]` instead
of `[label](wiki:<page_id>)` / `[quote](cite:<session_id>@<seconds>)`).

It is a CLI, not an MCP server registration: Claude runs it through `npx` like the marketplace's
other plugins.

## Install

```
/plugin marketplace add kwcantrell/autologger-marketplace
/plugin install autologger-mcp@autologger-marketplace
```

Needs Node.js 22.18 or newer. There are no runtime dependencies and nothing to build.

Skills:

| Skill | Use |
| --- | --- |
| `sign-in` | Checks the sign-in (`status`), hands you the `login` command (or, on a local dev stack, the `make dev-mcp-token \| import-tokens` line) to run, signs out. |
| `query-session-data` | Lists the tools and calls the read tools, with paging. |
| `write-session-data` | Calls the write tools after you confirm each change; runs `check-links` on wiki bodies first. |
| `explore-wiki` | Cross-session questions from a local index: `index build` / `index status`, `moments` about a topic, and `person-graph` (JSON and a Mermaid diagram). |
| `annotate-sessions` | Annotates many sessions in bulk: `annotate gaps`, then per batch `annotate transcript`, a plan file of Claude-written events, topics, wiki pages and dashboards, the `annotate apply` dry run, and `annotate apply --confirm` after you say yes to that batch; `annotate undo` takes a batch back out. |
| `seed-dev-stack` | Copies sessions from another server (such as stage) onto a local dev stack: `export`, the `import` plan, and `import --confirm` after you say yes. |

autologger's AI features go through this plugin now: the in-app aichat agents are being retired, so
reading, summarising and editing session data with Claude happens through these skills and the MCP
tools the server offers.

## Running the CLI yourself

From a terminal, with `<plugin dir>` the installed plugin folder (`status --json` prints the exact
`login_command` with it filled in):

```sh
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp --help
```

From a checkout of this repository, `node plugins/autologger-mcp/src/cli.ts <command>` does the same.

### Server

`--server <url>` on any command, else `$AUTOLOGGER_URL`, else `https://localhost:8787` (the local
dev stack). Only `https://` URLs are accepted, plus `http://` to `localhost`, `127.0.0.1` or
`[::1]`. The OAuth endpoints are discovered from `<server>/.well-known/oauth-protected-resource` and
the authorization-server metadata it names; nothing else is hard-coded.

### The dev stack's CA

The dev stack's certificate is signed by a private CA. Trust it for Node with
`NODE_EXTRA_CA_CERTS` (set before Node starts, so export it in the shell or in the environment
Claude Code runs in):

```sh
export NODE_EXTRA_CA_CERTS=/path/to/autologger-dev-ca.crt
```

Without it every command that contacts the server fails with
`the TLS certificate of https://localhost:8787 is not trusted (...)`. TLS verification is never
disabled.

### login

```sh
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp login            # read: scope "dashboards"
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp login --write    # read and edit: "dashboards session-data:write"
```

`login` registers the CLI as a public OAuth client (once per server; the registration is reused),
listens on `127.0.0.1` on a random port, prints the sign-in URL on stderr and opens it in your
browser (`$BROWSER` if set, `BROWSER=none` to skip, or `--no-browser`). Sign in with Google and
approve; the browser is sent back to the CLI, which exchanges the code (PKCE S256, `state` and
`iss` checked). It waits up to 300 s (`--timeout <seconds>`). On the consent page you may untick
"Edit events, topics and wiki pages"; the scope stored and reported is the one actually granted.

`<plugin dir>` is the installed plugin folder (`status --json` prints the full `login_command`). Run `login` yourself: it needs your browser. In Claude Code you can type `!` and the command.

### import-tokens (local dev stack, no browser)

autologger's dev stack has a dev-only `make dev-mcp-token EMAIL=<address> [SCOPE=...]
[CLIENT_ID=...]` (in the autologger-2 checkout, `DEV_SLOT=N` for slot N) that mints an MCP grant
and its tokens for a dev-stack user without a Google OAuth client, and prints them as one JSON line.
Pipe it into `import-tokens` to sign in with it:

```sh
make dev-mcp-token EMAIL=me@example.com | \
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp import-tokens --server https://localhost:8787
DEV_SLOT=2 make dev-mcp-token EMAIL=me@example.com SCOPE="dashboards session-data:write" | \
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp import-tokens --server https://localhost:22787
```

`status --json` prints the whole line for the server as `import_tokens_command`, with the full
`npx ...` form of the `import-tokens` command (the bare name is not on PATH for a plugin install).
When a client is stored for the server, registered at its current registration endpoint and recent
enough that the server still keeps it, `status --json` also prints it as `client_id` and the line
carries `CLIENT_ID=<client_id>`, so repeated imports reuse one client instead of registering a new
one each time (autologger caps registered clients). Run the line again without `CLIENT_ID=...` if
make answers `CLIENT_ID names no registered client` (the dev stack was reset). On a loopback server
the not-signed-in error and `status` both name this line after `login`. It reads the JSON from
standard input only, never from an argument, so the tokens stay out of shell history and process
lists. It checks that every field is there, `token_type` is `Bearer` and the scope is `dashboards`
or `dashboards session-data:write`, then runs the same discovery as `login`: the JSON's `issuer`
and `resource` must be the target server's (`--server`, else `$AUTOLOGGER_URL`, else the default),
or it exits 1 having written nothing. It stores the discovered endpoints, the given `client_id` and
the tokens in the server's credentials file, under the refresh lock, replacing any previous
sign-in; one that held another grant is revoked first (a failed revoke only warns). It prints the
server, scope and expiry, never a token. From then on `status`, `tools`, `call`, refreshes (with
the imported `client_id` and refresh token) and `logout` work as after `login`.

The make target creates an account and a grant on your dev stack, so run it yourself; Claude's
`sign-in` skill hands you the line and never runs it or reads its output.

### status, logout

```sh
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp status           # local file only: server, signed in, scope, token expiry, login commands
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp status --check   # also discovery, and a test of the token against /mcp
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp logout           # revoke at the server (if it can), then delete the local tokens
```

`logout` succeeds, with a warning, when the server cannot be reached; revoke the app under
Connected apps in autologger in that case.

### tools, call

```sh
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp tools                       # name and description of every tool
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp tools --json                # full input schemas
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp call list_studios
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp call list_shows --args '{"studio_id":"<studio_id>"}'
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp call list_events --args '{"session_id":"<session_id>","limit":50}' --json
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp call create_wiki_page --args-file page.json --json   # needs login --write
```

`call` prints the tool's text, or with `--json` the raw MCP result (`structuredContent` holds the
data). A tool error (`isError`) or a JSON-RPC error exits 1 with the message on stderr. A write
tool on a read-only sign-in exits 1 with the server's refusal and the `login --write` command.

The CLI speaks MCP Streamable HTTP (`initialize`, then `tools/list` / `tools/call`, JSON or SSE
answers) to the `resource` URL from discovery (`<server>/mcp`) with the bearer token. An expired
access token, or one the server rejects with 401, is refreshed once and the request retried.

### check-links

```sh
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp check-links page.md      # or - for stdin
```

Reports, as `file:line:column: message`, every `[[...]]` outside code spans and code blocks, and
every `wiki:` / `cite:` link whose target is off autologger's grammar
(`wiki:<[A-Za-z0-9_-]{1,64}>`, `cite:<id>@<\d+(\.\d{1,3})?>`, lower-case scheme). Exits 1 when it
finds any, 0 when the body is clean.

### export, import (seed a local dev stack from another server)

To build against realistic data, copy data from another server (stage is `https://stage.nrvo.ai`)
onto a local dev stack. There are two ways: the **whole account** (`export --all`, then
`import --create`, which makes the teams, shows and sessions itself; see "Whole account" below), or
**chosen sessions into sessions that already exist** on the local stack, in two steps:

```sh
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp export --server https://stage.nrvo.ai --session <id> [--session <id> ...] --out snap.json
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp import --snapshot snap.json --server https://localhost:8787 --map <stage_session>=<local_session>            # dry run: the plan
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp import --confirm --snapshot snap.json --server https://localhost:8787 --map <stage_session>=<local_session>  # writes
```

Sign in to each server first: the source read-only (`login --server <source>`), the target with
`login --write --server <local>` (Google; on a stack without a Google client, the
`make dev-mcp-token ... | import-tokens` line above with `SCOPE="dashboards session-data:write"`).
Credentials are per server, so the two sign-ins coexist.

**export** calls only the read tools `get_session`, `list_events`, `list_topics`, `list_wiki_pages`
and `get_wiki_page`, follows every `next_cursor` and every `next_offset`, and writes one JSON
snapshot (mode 0600, through a temporary file): per session its `get_session` result, all events,
all topics and the wiki pages associated with it, each with its whole `body_md`. It refuses an
existing `--out`; `export --force ...` replaces it (`--force` must come right after `export`, so a
pre-approved `export --server ...` command line can never replace a file). `--out` must end in
`.json`. `--json` prints the counts per session and in total.

**What is and is not copied.** **Audio and video are never copied**, by either way: no media file
is downloaded, uploaded or imported (no YouTube or audio import on the target). The MCP write tools
create events, topics and wiki pages only; they cannot create studios, shows, sessions or
transcripts. So `import --map` copies **into sessions that already exist on the target**: each
`--map <source_session>=<target_session>` names one, and the target session's show receives the
wiki pages; it copies no transcripts or dashboards. `import --create` (below) also makes the teams,
shows and sessions, and copies transcript words and dashboards, through the local app's HTTP API.
What neither copies, and why:

- Audio and video files: out of scope by design (large, and media is not session data); a whole
  export keeps only `list_session_media`'s links and offsets, which nothing imports.
- Transcript paragraphs: autologger stores them only from its own transcript generation runs;
  neither its MCP tools nor its HTTP API can write one. The words are copied, so the target can
  generate paragraphs again.
- Session aggregates: computed by the target from what is copied.
- A session's start offset, episode and notes: the MCP read tools do not answer them, so a created
  session has offset 0 and no episode or notes (its title and frame rate are the source's).
- Hidden and archived flags: created sessions are visible and active.
- Studio dashboard templates (only a session's own dashboards are copied), team members, invites
  and show grants, OAuth apps, provider keys and AI chat history: not session data, or not the
  user's to copy.

Per kind:

- Events: `create_event` with the category's **name** (`category_label`; the target show's
  categories have other ids, and the tool resolves a name), `message`, `metadata`, the source
  `wall_time_utc` as `marked_at_utc` and the source `timecode` (frame-accurate, `HH:MM:SS:FF` or
  `HH:MM:SS;FF` at 29.97), so each event keeps its place on the session timeline. An event whose
  category the target show lacks is reported in `failed` with the target's list of categories.
- Recording takes: a session's internal `Recording N Started` / `Recording N Stopped` rows are
  paired as autologger pairs them (wall-time order, first in first out per N) and created **before
  its other events**, one whole take at a time, each with its wall time and timecode. Each take's
  **Stopped row is created first, then its Started row**, and a Started row is only created once
  its Stopped row is on the target: the target never holds a Started with no Stopped (an open take,
  which makes the web app ask to resolve an "Unresolved recording"), not even when an import stops
  between the two rows. A take row with no partner in the snapshot (a take still recording, or a
  lone Stopped) is not copied and is listed as `skip` with the reason. A target session that is
  recording (rolling) refuses take rows; they are in `failed` and copied by a rerun once it stops.
  Copying takes and timecodes needs a target whose `create_event` takes `timecode` (autologger-2
  `4d2b1a37` or later); on an older target take rows are skipped and `timecode` is a dropped field.
- Frame rate: when a target session's frame rate (`get_session` `fps`) is not the source session's,
  the plan and result list it in `frame_rate_mismatch` (both rates) and each timecode is converted
  through seconds to the target's rate and format (the frame of the target rate holding the same
  instant, with autologger's frame math: frames counted at the rounded rate). **Create the target
  session at the source's frame rate to avoid it**: then every timecode is copied exactly.
- Topics: `create_topic` with `session_time`, `duration_sec`, `topic_level` and `summary`.
- Wiki pages: `create_wiki_page` in the target session's show with `kind`, `title`, `aliases` and
  the rewritten `body_md`; a session page (`kind: session`) is the mapped target session's own.
  `[label](wiki:<page_id>)` links point at the page copied from that source page, and
  `[quote](cite:<session_id>@<seconds>)` at the mapped target session. Links to pages or sessions
  not copied are left as they are and listed in `unresolved_links`. A page that links to a page
  created after it gets its links fixed with `update_wiki_page` afterwards (`links_fixed`), also
  when that page is created only by a later run (it failed, or its session is mapped later; rerun
  with every `--map` so the earlier pages are in scope). Every body is checked with `check-links`
  before it is written.

**Fields.** import reads each write tool's `inputSchema` from the target's `tools/list` (inputs are
strict) and sends only the fields it accepts; every source field it does not send (such as an
event's `version`, or its `timecode` on a target too old to take one) is listed once in `dropped_fields`, and an item missing a field the
tool requires is skipped. A write tool the import needs that the target lacks is an error naming it.

**Dry run first.** Without `--confirm` import reads the target (`tools/list`, `get_session` of each
target session, and `list_events` of a target session an earlier run copied events into) and
prints the plan: `plan` (counts to create, already done, `fix_links`, `fix_timecode`, skipped),
`frame_rate_mismatch`, `items` (each with its `action` and `reason`), `dropped_fields` and
`unresolved_links`. It calls no write tool.
`--confirm` must come right after `import`, so a pre-approved `import --snapshot ...` command line
can never write. It refuses, with exit 1 and nothing written: a target that is the snapshot's
source server, a target session that does not exist or you cannot see, a `--map` source session
not in the snapshot, and a target sign-in without `session-data:write`.

**Rate limits.** The target allows 30 writes a minute and 300 an hour per user. On
`Rate limit exceeded; retry in N s.` import waits N + 1 seconds and retries the same write, at
most 5 times in a row and never for more than an hour per wait; `--no-wait` stops instead. Expect
a large import to take a while.

**Resuming.** After every write the source id → target id of the created item is saved in
`<snapshot>.import-state.json` (mode 0600; per target server). When import stops (a rate limit with
`--no-wait`, a network or server error), it says so and exit 1; run the same `import --confirm`
command again and it continues where it stopped, creating nothing twice. A wiki title the target
show already has (`Title already used. page_id: <id>`), or a session that already has its page,
is recorded as skipped and never overwritten. A write the target refused for another reason is in
`failed` and is tried again on the next run. A write whose answer was lost in transit (the
connection dropped after the server wrote) cannot be told apart from one that never happened, so
check the target before rerunning after such an error.

**Repairing an earlier import.** An import made before this version created events without their
timecodes (every copied event at `00:00:00:00` in the web app, take rows included). Run the same
import again (dry run, then `--confirm`) with the same snapshot, state file and `--map`s: events
the state file says were copied, whose timecode on the target (read with `list_events`) is not the
source's (converted to the target rate), are planned as `fix-timecode` (counted in
`plan.fix_timecode`) and set with `update_event` `timecode`, using the version `list_events`
answered; category, message and wall time are sent unchanged (a take row's category as
`internal`). Nothing is created twice. A version conflict (someone edited the event meanwhile) or a
take row refused because the session is recording is reported in `failed` for that event and not
retried in that run; the next rerun reads the versions again. The result counts `timecodes_fixed`.
On a target whose `update_event` takes no `timecode` (autologger-2 before `4d2b1a37`) these events
are listed as `skip` with that reason instead: update the local stack first.

Neither file holds a token, and content from the source is only ever sent as tool arguments: it
never selects a tool, a server or a file.

#### Whole account: export --all, app-signin, import --create

```sh
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp export --server https://stage.nrvo.ai --all --out all.json
make dev-login EMAIL=<address> | npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp app-signin --server https://localhost:8787   # in the autologger-2 checkout
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp import --snapshot all.json --server https://localhost:8787 --create            # dry run: the plan
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp import --confirm --snapshot all.json --server https://localhost:8787 --create  # writes
```

**export --all** reads everything the signed-in source account can see, with read tools only
(`list_studios`, `list_shows`, `list_sessions` with `include_hidden`, `list_categories`,
`get_session`, `list_events`, `list_topics`, `list_transcript_words`, `list_transcript_paragraphs`,
`list_wiki_pages`, `get_wiki_page`, `list_dashboards`, `get_dashboard`, `list_session_media`),
following every cursor and offset: each studio and show (with its categories as `list_categories`
answers them), and per session its `get_session` result (frame rate included), events, topics,
transcript words and paragraphs, its wiki pages with whole bodies (a show page several sessions list
is read once), its own dashboards with their TSX source (studio templates are left out), and the
media links and offsets (never media bytes). A show the account cannot open (`list_shows` lists it
with `can_access: false`, for example a team member's show without a grant) is warned about and
neither its categories nor its sessions are read; a show whose `list_categories` is refused is
exported without categories, with a warning. The snapshot is one JSON file (mode 0600). Progress is saved in
`<out>.export-progress.json` after every read: on a rate limit export waits as import does;
with `--no-wait`, a wait over an hour or any error it stops with exit 1, and the same command run
again continues without reading anything a second time. `--json` prints the counts.

**app-signin** stores the local app's session for `import --create`: the line `make dev-login
EMAIL=<address>` prints (`<cookie name>=<token>`), read from standard input only (never an
argument), checked with `GET /api/studio`, and kept in `<config dir>/app-cookies/<server>.json`
(mode 0600, directories 0700). Only a loopback server (`localhost`, `127.0.0.1`, `[::1]`, any port,
so dev slots too) is accepted, and the cookie is only ever sent there. It is never printed, nor
written into a snapshot or state file. Use the same account as the target's MCP sign-in (`login
--write`): the sessions it creates must be readable and writable through MCP. `app-signout` deletes
it.

**import --create** takes a snapshot from `export --all` (no `--map`) and a local target. It
refuses, with exit 1 and nothing written, a target that is not a loopback host or is the
snapshot's source server (`localhost`, `127.0.0.1` and `[::1]` count as the same host), and, with
`--confirm`, a missing app session. The dry run prints `create` (the `teams`, `shows` with their
category counts, `sessions` with title and frame rate, `transcript_words`, `transcript_paragraphs`,
`dashboards`, each `create` or `done`, and `not_copied`) and the plan for events, topics and wiki
pages as above (sessions still to create show as `new:<source id>`). `--confirm`, through the app's
HTTP API (`PUT /api/profile` to make each team active, since the app creates sessions in the
active team; the user's active team and show are set back at the end):

- Teams: `POST /api/teams`, id a slug of the source studio id (`st_Main` -> `st-main`), the
  studio's name. A team with that id the user belongs to is **reused**; one taken by a team the
  user is not in gets `-2` ... `-5`. When the user already owns 20 teams (autologger's cap) the
  studio is reported in `failed` with what to do, and the rest goes on.
- Shows: `POST /api/shows` with the name and show code, then the source show's categories (names,
  kinds, colours, dropdown options, on/off labels) with `PUT /api/profile` `show_updates`, so
  `create_event` by category name resolves.
- Sessions: `POST /api/sessions` with the title, the source frame rate (so timecodes copy
  exactly), offset 0, in the show made for it.
- Events, topics and wiki pages: the import above, into the created sessions and shows.
- Transcript words: `POST /api/sessions/:id/transcript-words` (`session_time`, `speaker`, `word`),
  one per word in order, so the target's `list_transcript_words` holds the same words.
- Dashboards: `save_dashboard` with the source title and TSX, scope the created session. One the
  target refuses (its source rules) is reported in `failed`, not fatal.

Each created team, show, session, word count and dashboard is saved by source id in the state
file's `structure` after every write: a rerun of the same command creates nothing twice and
continues. A refused write (in `failed`) is tried again by a rerun. The app answers 401 when the
cookie is no longer a session: run `make dev-login` and `app-signin` again. A 429 from the app is
waited out like an MCP rate limit (its `Retry-After`). As with the import above, a `POST` whose
answer was lost after the app made the team, show or session (a dropped connection, a proxy error)
is not recorded, so a rerun makes it again: check the target before rerunning after such an error.

### index, moments, person-graph (cross-session questions from a local index)

autologger's MCP server reads one session at a time, has no search tool yet, and allows 120 tool
calls a minute and 2,000 an hour per user. To answer "find all moments about X" or "map this
person" across a show, the CLI keeps a **local index** of what it read and answers from it:

```sh
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp index build --server <url> --show <id>      # or --studio <id>, --all
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp index status --server <url>
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp moments "crème brûlée" --server <url> --show <id> [--term <alt> ...]
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp person-graph "Jane Doe" --server <url> --show <id>
npx --yes --offline --loglevel=error --package="<plugin dir>" -- autologger-mcp index clear --server <url>
```

**What is indexed.** `index build` lists the scope (`list_studios`, `list_shows` for shows you can
open, `list_sessions` without hidden sessions) and reads, for every session, `get_session`, all
events, topics and transcript paragraphs, and `list_wiki_pages` with each page's whole body
(`get_wiki_page`, every `next_offset`). It calls read tools only. A wiki page is reachable only
through a session it is associated with (the session's own page, a page citing it, or a page that
page links to); other pages are not indexed. Transcript words, aggregates and dashboards are not.

**Where.** `$XDG_CONFIG_HOME/autologger-mcp/index/<host>_<port>-<hash>/` (`AUTOLOGGER_MCP_CONFIG_DIR`
replaces `.../autologger-mcp`), one directory per server: `meta.json` (listings and builds),
`sessions/` and `pages/` with file names hashed from the ids. Directories are `0700`, files `0600`,
written atomically. Only tool results are stored, never a token. `index status` shows what is
indexed and how old each build is; `index clear` deletes that server's index.

**Refreshing.** A later build calls the listings, `get_session` and `list_wiki_pages` for every
session, and re-reads a session's events, topics and paragraphs only when `get_session`'s
`revision` (autologger advances it on every write to the session's events, transcript and topics)
or its counts changed, and a page body only when the page's `revision` changed. Wiki pages are the
show's, not the session's, so the session revision does not cover them: their listing is read on
every build.

**Read budget.** One run makes at most `--max-reads` tool calls (default 400, a few minutes at the
server's limit, well under a 10-minute tool timeout). `Rate limit exceeded; retry in N s.` is waited
out when N is at most 90 s and the run's waits stay within 300 s; otherwise, or when the budget is
spent, the build stops cleanly between calls, keeps what it read, and answers `complete: false`
with `continue_command`, the exact command to continue. The rerun keeps the stopped run's listing
and skips the sessions it finished (for a day; after that it starts over, still skipping unchanged
content).

**moments** answers from the index only (no server calls). It matches the query and each `--term`
as whole words or phrases, ignoring case and accents, against topic titles and summaries, event
messages, transcript paragraphs, and wiki page titles, aliases and bodies. A page whose title or
alias matches adds its title and aliases as terms and its `cite:` links as moments; a body match is
a moment at the citations of the paragraph it is in. Each moment has `session_id`,
`session_title`, `session_date`, `show_id`, `seconds` (events: `timecode_total_frames /
frame_rate`; topics: `session_time`; paragraphs: `start_sec`; wiki: the citation), `source`
(`topic|event|transcript|wiki`), `snippet`, `term`, `ref` and `cite` (`cite:<session_id>@<seconds>`,
valid for `check-links`; null without a time). They are ordered by session date and time, and
moments of one session within 5 s are merged (`also`). When the scope is not fully indexed the
answer says `complete: false` and gives `build_command`.

**person-graph** finds a `person` page by `page_id`, title or alias (several matches is an error
listing them; none is an error naming `index build`) and answers `{nodes, edges, mermaid}`: the
person, the pages it links to and that link to it (one hop, with `kind`; `in_index: false` for a
page not reachable through MCP), the sessions it cites, each cited moment, and for each moment the
session topics whose span (`session_time` + `duration_sec`) holds it. `mermaid` is a `graph LR`
with generated node ids; labels are cut to 60 characters and every character other than letters,
digits, spaces and `.,:!?'()-/@` is written as a `#<code>;` entity, so quotes, brackets, newlines and
Markdown in titles stay inside their node.

**Server search.** autologger-2 plans server-side search and wiki-graph read tools; once they
exist, these commands can use them instead of the local index (a later change).

### annotate (events, topics, wiki pages and dashboards for many sessions)

Claude writes the content (from each session's transcript; not autologger's billed `generate_*`
tools) into a **plan file**; the CLI checks it against the server, creates it batch by batch,
keeps track of what it created, and can take it back out. Writes need a `login --write` sign-in;
everything else works read-only.

```sh
autologger-mcp annotate gaps --server <url> [--show <show_id> ...] --out gaps.json [--json]
autologger-mcp annotate transcript --server <url> --session <id> [--from <s>] [--to <s>] [--max-chars <n>] --json
autologger-mcp annotate dashboard --server <url> --session <id> --out overview.tsx [--title <text>]
autologger-mcp annotate apply --plan plan.json --server <url> [--json]             # dry run
autologger-mcp annotate apply --confirm --plan plan.json --server <url> [--no-wait] # writes
autologger-mcp annotate undo --plan plan.json --server <url> [--json]              # dry run
autologger-mcp annotate undo --confirm --plan plan.json --server <url> [--no-wait]  # deletes
```

- **gaps** (read only) lists every session the account can see (hidden sessions, which the write
  tools refuse, are left out; shows it cannot open are listed in `skipped_shows`), or only the
  `--show`s': show, title, date, `duration_s` (the transcript's extent, from
  `get_session_aggregates`), `last_session_time_s` (the latest event timecode), transcript words
  and paragraphs, and counts of its events (recording-take rows not counted), topics, wiki pages
  linked to it and session dashboards, with `missing` naming the kinds it has none of. It reads with
  `list_studios`, `list_shows`, `list_sessions`, `get_session` (only when `list_sessions` has no
  counts), `list_events`, `get_session_aggregates` and `list_dashboards`, through every page, and
  waits out read rate limits (`--no-wait`: stop). The report goes to `--out` (a `.json` file, mode
  0600; an existing file only when it is an earlier gaps report); `--json` prints the totals.
- **transcript** (read only) prints `[HH:MM:SS] speaker: text` lines in `text`: one per paragraph
  when the session has timed paragraphs, else words grouped by speaker (a new line at a change of
  speaker or about 400 characters). At most `--max-chars` characters (default 20000; a single
  paragraph longer than that is printed whole, with `over_max_chars`), from `--from` (inclusive) to
  `--to` (exclusive) by each unit's start second. `next_from` is the `--from` of the rest (null at
  the end): units that start at the same instant are never split, so following it prints every word
  exactly once. For a 10,000-word transcript the output is under a tenth of the raw
  `list_transcript_words` JSON. Each call reads the transcript from its start up to the range it
  prints.
- **dashboard** (read only) writes the built-in session overview to `--out` (a `.tsx` file; never
  through a symbolic link): the session's events by category (take rows left out), its topics in
  time order and its wiki pages, all read at runtime with the dashboard hooks (`useSession`,
  `useEvents`, `useTopics`, `useWikiPages`). Its imports are on autologger's custom-dashboard
  allowlist; the only value in the source is its heading, as escaped JSON data (`const DATA = ...`),
  so no session text can become code. The title defaults to `Overview: <session title>`.
- **apply** without `--confirm` is a dry run. It reads each plan session (`get_session`, its
  categories, its transcript's extent, the wiki pages linked to it) and prints per item `create`,
  `skip` (created by an earlier apply of this plan; a wiki title the show already has among the
  pages linked to the session; a session page when the session has one) or `invalid` with the
  reason (an unknown session; a category the show lacks, with the show's categories; a time outside
  the session's transcript, with a second's slack; a missing or unknown field; a wiki body failing
  `check-links`; a dashboard failing the dashboard rules below), per-session counts, the write count
  and `estimate` (the time at autologger's write window of 30 writes a minute and 300 an hour per
  user, starting from a full window; it is shared with every other write the user makes).
- **apply --confirm** (`--confirm` right after `apply`, so a pre-approved `annotate apply --plan`
  can never write) creates the valid items in plan order (per session: events, topics, wiki pages,
  dashboards) with `create_event`, `create_topic`, `create_wiki_page` and `save_dashboard`, sending
  only the fields each tool's `inputSchema` accepts (fields cut are listed in `dropped_fields`). It
  never updates or deletes. It refuses (exit 1, nothing written) a sign-in without
  `session-data:write`. Each created item's id and version is saved in
  `<plan>.apply-state.json` (mode 0600) right after its write; creates also send a
  `client_request_id` derived from the plan and item when the server takes one, so a write whose
  answer was lost is not repeated either. A rerun of the same command creates nothing twice. A rate
  limit (`Rate limit exceeded; retry in N s.`) is waited out (`--no-wait`: stop; the same command
  continues). Invalid items and writes the server refuses are listed in `failed` and do not stop the
  run; a wiki title the server reports as taken is a skip. Every created event carries
  `metadata: {"created_by": "autologger-mcp annotate", "annotate_plan": "<plan_id>",
  "annotate_item": "<key>"}` when `create_event` accepts `metadata`.
- **undo** without `--confirm` lists what the state file says this plan created. **undo --confirm**
  deletes exactly those items with `delete_event`, `delete_topic`, `delete_wiki_page` and
  `delete_dashboard`, each with the version (revision) read just before from the session's list
  tool, and only while it is still the one it was created with: an item changed since is reported in
  `changed` and left alone (a wiki page not linked to the session is deleted with its recorded
  revision, which the server refuses if it changed). Items already gone are dropped from the state
  file; deleted ones move to its `undone`. Nothing outside the state file is ever deleted.

#### The plan file

```json
{
  "format": "autologger-mcp-annotate-plan",
  "version": 1,
  "plan_id": "show-one-batch-1",
  "sessions": [
    {
      "session_id": "ses_123",
      "events": [
        { "category": "Joke", "message": "The pasta joke", "session_time": 754.2 },
        { "id": "guest-arrives", "category": "Guest", "message": "Jane arrives", "timecode": "00:12:30:00" }
      ],
      "topics": [{ "session_time": 600, "duration_sec": 240, "topic_level": 1, "summary": "Cooking stories" }],
      "wiki_pages": [{ "kind": "topic", "title": "Pasta", "aliases": ["Noodles"], "body_md": "Discussed [here](cite:ses_123@754.2)." }],
      "dashboards": [
        { "template": "session-overview", "title": "Overview" },
        { "title": "Jokes only", "tsx": "import { useEvents } from '@autologger/dashboard';\nexport default function Jokes() { ... }" }
      ]
    }
  ]
}
```

| Field | Rules |
| --- | --- |
| `format`, `version` | Required: `"autologger-mcp-annotate-plan"`, `1`. |
| `plan_id` | Optional, 1-64 of `A-Za-z0-9._-`; default the file name. Named in each event's marker. |
| `sessions[].session_id` | Each session once. Only `events`, `topics`, `wiki_pages`, `dashboards` besides it. |
| any item's `id` | Optional, 1-64 of `A-Za-z0-9._-`, unique per session and kind; the item's key is `<session>/<kind>/<id>`, else a hash of its fields (so an edited item without an `id` counts as a new one). |
| event | `category` (the show's category **name**, any case; not `internal`), `message` (1-8000 characters), and one of `session_time` (seconds, the transcript's timeline) or `timecode` (`HH:MM:SS:FF` at the session's frame rate). Sent as the category's id and a timecode (the frame holding the instant). |
| topic | `session_time` (seconds or timecode), `duration_sec` (0 or more), `summary` (1-8000), `topic_level` (1-10, default 1). Start and end must lie in the session. |
| wiki page | `kind` (`person`, `topic`, `bit`, `session`), `title` (1-200, unique in the show and in the plan), `aliases` (up to 50; none for a session page), `body_md` (up to 100,000; must pass `check-links`). Created in the session's show; a `session` page for the session itself. |
| dashboard | `title` (1-200, no control characters; default `Session overview` for the template) and either `"template": "session-overview"` or `tsx`. A `tsx` source must pass the pre-check of autologger's save rules: at most 100,000 characters, static named imports only from the allowlist (`react` may also be imported as a default or namespace), at most 60 bindings, exactly one export (`export default function`), no denied element (`script`, `iframe`, `object`, `embed`, `base`, `meta`, `link`, `form`), no `dangerouslySetInnerHTML`/`srcDoc` or string event handler, and no reference to a denied global (`window`, `document`, `fetch`, `eval`, `setInterval`, ...). Saved with session scope. |

The allowlist and denylists are copied from autologger-2's
`packages/contract/src/customDashboards.ts` into `src/dashboardRules.ts`; a test fails when the copy
drifts from an autologger-2 checkout on the machine. autologger's `save_dashboard` checks a source
again, authoritatively.

### Output and exit codes

Every command takes `--json` (one JSON value on stdout). Exit 0 success, 1 failure, 2 usage error;
on a non-zero exit the message is on stderr and stdout is empty. No command prints an access or
refresh token.

## Where credentials live

One file per server: `$XDG_CONFIG_HOME/autologger-mcp/credentials/<host>_<port>-<hash>.json`
(`~/.config/...` when `XDG_CONFIG_HOME` is unset; `AUTOLOGGER_MCP_CONFIG_DIR` replaces
`.../autologger-mcp`). The directories are mode `0700` and the file `0600`; it holds the discovered
endpoints, the client registration and the tokens. `status` prints its path.

Refresh tokens rotate, and autologger revokes the whole sign-in when one is used twice. The CLI
therefore refreshes under a lock file next to the credentials, re-reads the file first (another
process may already have refreshed) and saves the new tokens atomically before using them, so
concurrent invocations are safe.

The local app session `app-signin` stores (a `make dev-login` cookie, for `import --create`) is one
file per server in `.../autologger-mcp/app-cookies/`, also mode `0600` in `0700` directories;
`app-signout` deletes it.

## Development

```sh
npm test           # from the repo root: unit tests and the npx end-to-end test
npm run typecheck
```

The tests run against a fake OAuth + MCP server (`test/fakeServer.ts`); no network or autologger
is needed.
