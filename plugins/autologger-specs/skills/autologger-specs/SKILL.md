---
name: autologger-specs
description: Keeps autologger's docs/specs/ in step with code before a change is finished, so the specs-with-code PR gate does not fail. Use in an autologger checkout (a git repo with scripts/lifecycle.yaml and docs/specs/) before committing, finishing a task or opening a PR that changed code, when asked which spec covers a file, or when scripts/check-change.sh reports specs-with-code or specs failures.
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-specs:*)
---

# Keep autologger specs in step with code

Autologger's PR gate `specs-with-code` fails when a file covered by a spec's `lifecycle.spec_paths`
globs (in `scripts/lifecycle.yaml`) changes and the spec `docs/specs/<name>.md` does not. Every
check below goes through this plugin's CLI, which applies the gate's own rules. Run the commands
exactly as written, from anywhere inside the checkout (or add `--repo <path>`), with no install or
build step first.

## Before finishing a change

1. List the specs the change would fail the gate on (changed, staged and untracked files against
   the merge-base with `origin/main` or `main`, using the map from that base):

   ```sh
   npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-specs stale --json
   ```

   - Exit 0: nothing is stale; stdout is JSON with `"stale": []`.
   - Exit 1: stdout is empty and stderr lists each stale spec as
     `docs/specs/<name>.md not changed, but its spec_paths cover: <files>`.

2. For each stale spec, open `docs/specs/<name>.md`, and update its requirements and scenarios to
   describe what the code does now. Edit only what the change really affects; keep the shape
   (`# ` title, `## Purpose` with text, `### Requirement:` headings each with `#### Scenario:`).
   If the change truly leaves behavior alone (a pure refactor or comment), say so to the user
   instead of inventing spec text: the PR then needs the `no-spec-needed` label, which is the
   human's call.

3. Run the repository's own spec gates; this exits with their status and streams their output on
   stderr:

   ```sh
   npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-specs gate --json
   ```

Repeat until both pass. Do not edit `scripts/lifecycle.yaml`'s `spec_paths` to make a file stop
counting: the gate reads the map from the merge-base, so that does not help this change.

## Which specs cover a file

Before changing a file, see which specs describe it (paths are relative to the current directory
inside the checkout; several may be given):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-specs which --json <path>
```

It prints a JSON object mapping each repo-relative path to its spec names (`[]` when none). Read
those specs first: they are the current description of the behavior you are changing.

To check that every spec is well-formed and mapped (the `specs` gate, plus a `#### Scenario:`
under every requirement):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-specs lint --json
```

To write a new spec, use the `autologger-new-spec` skill.

## Errors

Exit codes: 0 success, 1 the check failed (stale specs, lint problems, a failing gate) or the
command could not run, 2 a usage error or not inside an autologger checkout. On a non-zero exit the
reason is on stderr; act on it or show it to the user instead of guessing. Every command and option:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-specs --help
```
