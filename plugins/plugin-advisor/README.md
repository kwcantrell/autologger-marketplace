# plugin-advisor

Makes the autologger-marketplace plugins improve from use. When Claude hits the same problem with a
marketplace plugin again and again (a CLI failing, a workaround, a step done by hand, missing skill
guidance), this plugin notices and drafts a fix: which plugin to change (or a new plugin), the
evidence, a proposed change and a paste-ready `/factory:run` request. With your confirmation, a draft
can be filed as a GitHub issue on `kwcantrell/autologger-marketplace`, which is **public**.

Occurrences come from two places:

- **Claude**, through the `plugin-advisor` skill, records each friction with `record` (after a
  workaround, a manual step, missing or wrong guidance, or a user correction).
- **A hook** (`hooks/hooks.json`) records every failed run of a marketplace plugin's CLI on its own.

## Commands

Skills call the CLI as

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor <command> [args] --json
```

and from a checkout you can run `node plugins/plugin-advisor/src/cli.ts <command>`.

| Command | What it does |
| --- | --- |
| `record --plugin <name> --kind <kind> --summary <text> [--detail <text>]` | Stores one occurrence. `<name>` is a marketplace plugin, a proposed new plugin name (kebab-case) or `none`; `<kind>` is `cli-failure`, `workaround`, `manual-step`, `missing-guidance` or `user-correction`. `record --stdin` reads `{"plugin","kind","summary","detail"}` as JSON instead. Prints the issue's `signature` and `count`. |
| `list [--min <n>] [--plugin <name>]` | Issues grouped by signature: count, first and last seen, plugin, kind, latest summary, and status (`open`, `suggested`, `dismissed`, `filed`). |
| `show <signature>` | One issue with all its occurrences (already redacted). A unique prefix of 4+ characters works. |
| `suggest [--threshold <n>]` | For every issue seen at least `n` times (default 3) that has not been suggested yet, or whose count has grown by `n` since it was, writes a draft to `drafts/<signature>.md` and returns it. Dismissed issues are never suggested. |
| `dismiss <signature>` | Stops all further suggestions for the issue. |
| `file <signature> [--repo <owner/name>] [--confirm]` | Without `--confirm`, prints exactly the title, body and repo that would be filed, and files nothing. With `--confirm`, runs `gh issue create --repo <repo> --title <title> --body-file -` (body on stdin, no shell), records the issue URL, and refuses to file the same issue again. Before either, it re-checks the draft and exits 1 if anything secret-looking is left: each stored value the draft quotes (summaries, detail lines) is checked on its own, and the rest of the draft, including anything edited in by hand, without them. The repo defaults to `kwcantrell/autologger-marketplace`. |
| `hook` | Reads a Claude Code hook input on stdin and records a failed marketplace CLI call. Used by `hooks/hooks.json`; prints nothing and always exits 0. |

Exit codes: 0 success, 1 the command failed, 2 usage error. On a non-zero exit stdout is empty and the
reason is on stderr.

The skill pre-approves `record`, `list`, `show`, `suggest` and `--help`. `file` and `dismiss` always
ask for permission, and the skill has Claude show you the dry run and wait for an explicit yes
before `file --confirm`.

## The log

Everything is kept in `$PLUGIN_ADVISOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/plugin-advisor`, else
`~/.config/plugin-advisor`: directories `0700`, files `0600`. The CLI refuses a location inside a git
checkout, so the log can't be committed by accident.

| File | Contents |
| --- | --- |
| `occurrences.jsonl` | One occurrence per line: signature, plugin, kind, summary, optional detail, timestamp, source (`record` or `hook`), and for the hook the subcommand and exit code. Trimmed to the newest 2000 lines once it passes 1 MiB. |
| `state.json` | Per issue: when it was last suggested (and at what count), dismissed, or filed (with the issue URL). |
| `drafts/<signature>.md` | The draft suggestion: a `# title` line, then target, problem, evidence, proposed change and the `/factory:run` line. This file is what `file` sends. |

**Redaction.** Before anything is stored, the summary and detail are redacted: everything after
any key that ends in `authorization` (`Authorization:`, `Proxy-Authorization:`, `HTTP_AUTHORIZATION:`,
`x_authorization=`, any casing, with `:` or `=`) to the end of the line (any scheme), or to the
closing quote when the value or the pair is quoted, every cookie value after `Cookie:` or `Set-Cookie:` (in `Set-Cookie:` only,
attributes such as `Path`, `Domain`, `Expires`, `Max-Age`, `Secure`, `HttpOnly` and `SameSite` keep
their values; in a request `Cookie:` header a `path=...` is a cookie and is redacted), bearer and
basic credentials, autologger `alm_`/`alr_` tokens, `autologger_sid` cookie values, `KEY=value`,
`key: value`, `"key": "value"` and `--key value` where the key looks secret (token, secret,
password, api key, cookie, credential, session, session id and similar) whatever the value's length,
also when the pair sits inside an ordinary value (`failed: password=x`), when the key is quoted after
other text (`{b'token': b'x'}`, a Python repr), when its quotes are escaped once or more
(`{\"password\": \"x\"}`, JSON logged inside a JSON string; also a value holding an escaped quote,
`{\"password\": \"a\\\"b\"}`, a number, `{\"token\": 123456}`, or a bare word before a `,` or `}`,
`{\"password\": hunter2}`), when only the value's quotes are escaped (`password: \"x\"`), and with any spaces around the separator, Unicode ones
such as NBSP included (the separator and value stay on the key's line: `password=` at the end of a
line leaves the next line alone), the value after
`--password` in any command, the value after `-p` (`-p x`, `-p=x`, `-px`) only in commands where
`-p` takes a password: the MySQL and MariaDB clients and tools (`mysql`, `mysqldump`, `mysqladmin`,
`mysqlsh`, `mariadb`, `mariadb-dump` and the rest), the MongoDB shell and tools (`mongo`, `mongosh`,
`mongodump`, `mongorestore`, `mongoexport`, `mongoimport`, ...), `sshpass`, `cqlsh`, `rabbitmqadmin`,
`rdesktop`, `7z` and `rar`/`unrar`, also with a version after the name (`mysql8`, `mysql5.7`,
`mariadb10.11`), up to the end of that command (a newline not continued with `\`, which trailing
spaces or tabs may follow, or `;`, `|`, `&`), also when an authorization value on its first
line takes the rest of that line (`Authorization: x; mysql \` then `-p secret`, `-ptoken db` or
`-p 'a b'`; `mysql -H Authorization: x \` then `-p secret`), so `mkdir -p`, `ssh -p 2222`, `docker run -p 8080:80`, `psql -p 5433` and
`gcc -pthread` are kept, JWTs, URL credentials, PEM private keys,
common provider tokens (GitHub, Slack, AWS, `sk-`), and long random-looking strings (including full
40-character git SHAs and UUIDs; short SHAs are kept) all become `[redacted]`. Redaction is one
left-to-right scan per rule, so very long lines (thousands of `a=` pairs) do not overflow the stack,
and no rule restarts its scan at every character of a long word, so its time grows linearly with the
text (64 KB of mixed text takes well under half a second). The input is not cut before redaction.
Then summaries are made one line and capped at 200 characters, details at 2000. A cut never lands
inside a `[redacted]` marker or leaves a dangling `key=` behind. Only an exact `[redacted]` counts as
already redacted: text after a typed marker (`Cookie: a=[redacted] x; b=secret`) is still redacted.

**Signatures.** An issue's signature is a hash of the plugin, the kind and the summary normalised:
lower-cased, with URLs, emails, paths, UUIDs, hex, ids and numbers masked. So "call failed for
session 98 at /tmp/x.json" and "Call failed for session 7 at ./y" are the same issue.

## The hook

`hooks/hooks.json` registers `node ${CLAUDE_PLUGIN_ROOT}/src/cli.ts hook` (exec form, no shell) as an
`async` `PostToolUseFailure` hook on `Bash`.

- **Why PostToolUseFailure.** Claude Code fires `PostToolUse` only for tool calls that succeed. A
  Bash command that exits non-zero fires `PostToolUseFailure` instead, with the command in
  `tool_input.command` and an `error` string whose first line is `Exit code N`, followed by the
  command's output ([hooks reference](https://code.claude.com/docs/en/hooks), "PostToolUseFailure
  input"). So the hook runs only after failed Bash calls, never after successful ones.
- **What counts.** A command running `npx ... -- <bin> <command>` where `<bin>` is a marketplace
  plugin's bin, or `node .../plugins/<plugin>/src/cli.ts <command>` (also the plugin cache's
  `.../<plugin>/<version>/src/cli.ts`). The bins are read at run time from the marketplace's
  `.claude-plugin/marketplace.json` and each plugin's `package.json` `bin`: next to this plugin in a
  checkout, else at the install location Claude Code records in
  `~/.claude/plugins/known_marketplaces.json`. If neither is found, a built-in list of the plugins at
  the time of writing is used.
- **What is kept.** Only the plugin, the subcommand, the exit code and the redacted first line of the
  CLI's own error message (`<bin>: ...`, or npm's `npm error ...`). Never the command line and never
  the command's stdout.
- **Never in the way.** It prints nothing, always exits 0, and swallows any error. It runs `async`,
  so Claude does not wait for it. Input that cannot be a marketplace CLI failure is rejected by a
  string check before the rest of the CLI is loaded.
- **Why `node` and not the `npx` prefix.** The hook runs this plugin's own CLI either way. `npx`
  would add about 0.3 s of npm start-up to every failed Bash call. `node` on `src/cli.ts` needs no
  `--offline` guard, because it never resolves a package.
