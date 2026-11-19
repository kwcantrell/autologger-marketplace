---
name: plugin-advisor
description: Records friction with the autologger-marketplace plugins (autologger-mcp, autologger-dev, autologger-specs, plugin-builder and the rest) and suggests a plugin change once the same issue recurs. Use after working around a marketplace plugin's bug or gap, after doing by hand something a plugin should do, when a plugin skill's guidance was missing or wrong, when the user corrects how a plugin was used, and at the end of a task to check for recurring issues worth a fix.
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor record:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor list:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor show:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor suggest:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor --help:*)
---

# plugin-advisor

Makes the marketplace plugins improve from use. You record each friction with a marketplace plugin as
it happens; the CLI groups occurrences of the same issue, and once one recurs it writes a draft
suggestion (which plugin to change, the evidence, a proposed change and a paste-ready `/factory:run`
request) for the user. Every action goes through this plugin's CLI, run exactly as written below from
any directory. Failed runs of a marketplace plugin's CLI are recorded automatically by this plugin's
hook, so you do not need to record those yourself.

The log is local to this machine (`~/.config/plugin-advisor/`, owner-only). The CLI redacts
anything that looks like a token or secret before storing it, but do your part too.

## When to record

Record one occurrence, right after it happens, when:

- you worked around a marketplace plugin's bug or gap (`--kind workaround`);
- you did by hand something a plugin should do for you (`--kind manual-step`);
- a plugin skill's guidance was missing or wrong (`--kind missing-guidance`);
- the user corrected how you used a plugin (`--kind user-correction`);
- a plugin CLI failed in a way the hook could not see, for example inside a pipeline that still
  exited 0 (`--kind cli-failure`).

`--plugin` is the marketplace plugin involved (for example `autologger-mcp`). Prefer an existing
plugin: use a new plugin name only when no existing plugin is a sensible home for the fix, and
`none` when you cannot tell. `--summary` is one short, general sentence describing the problem, the
same way each time it happens ("call list_events fails for a session with no events"), so repeats
group together. `--detail` is optional context: what you tried and what worked.

**Never put secrets, tokens, cookies, passwords, private keys or private user data (names, emails,
session contents, transcript text) in a summary or detail.** Describe the problem, not the data.

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor record --plugin <plugin> --kind <kind> --summary "<summary>" --json
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor record --plugin <plugin> --kind <kind> --summary "<summary>" --detail "<detail>" --json
```

It prints `{"signature","plugin","kind","summary","count","redacted"}`. Do not mention a record to
the user unless they ask; it is bookkeeping.

## Suggest at natural break points

At the end of a task (or another natural pause), check whether anything has crossed the threshold
(3 occurrences by default; `--threshold <n>` changes it):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor suggest --json
```

It prints `{"threshold","suggestions":[...]}`, each suggestion with `signature`, `plugin`, `count`,
`summary`, `target`, `title`, `draft` (the draft's path) and `factoryRun`. It writes a draft for
each, and will not suggest the same issue again until its count grows by the threshold again. If
`suggestions` is empty, say nothing. Otherwise tell the user in one or two lines per issue, for
example: "`autologger-mcp` keeps failing on X (seen 4 times). I drafted a suggested fix; want to see
it?". If they want it, show the draft and its `/factory:run` line, which they can paste to build the
change through the factory. Never start a factory run yourself.

To look at what has been recorded, or at one issue in full (its occurrences are already redacted):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor list --json
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor list --plugin <plugin> --json
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor show <signature> --json
```

`list` also takes `--min <n>` to show only issues seen at least `n` times.

## Filing a draft as a GitHub issue

Only when the user asks for it. `kwcantrell/autologger-marketplace` is a **public** repository:
anyone can read what is filed there. Always go through these steps, in order.

First, the dry run. It files nothing and prints exactly the title, body and repository that would be
filed:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor file <signature> --json
```

Then show the user the title and the whole body, remind them that the repository is public, and ask
for an explicit yes. Read the body yourself for anything private, and offer to leave it unfiled if in
doubt. Anything short of a clear yes means do not file.

Only after that yes, file it. This runs `gh issue create`, so it asks for permission:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor file <signature> --confirm --json
```

It prints the issue's `url`; give it to the user. The CLI refuses (exit 1) to file a draft that still
holds secret-looking text, and never files the same issue twice. `--repo <owner/name>` files
somewhere else, such as a fork; ask the user whether that repository is public too.

## Dismissing an issue

When the user says an issue is not worth fixing, stop suggesting it (this asks for permission):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor dismiss <signature> --json
```

## Exit codes

0 success, 1 the command failed, 2 usage error. On a non-zero exit the reason is on stderr; show it
to the user instead of guessing. Every command and option:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- plugin-advisor --help
```
