# autologger-specs

Keeps an autologger checkout's `docs/specs/` in step with its code. Autologger's PR gate
`specs-with-code` fails when a file covered by a spec's `lifecycle.spec_paths` globs (in
`scripts/lifecycle.yaml`) changes and `docs/specs/<name>.md` does not; the `specs` gate checks each
spec's shape and the map. This plugin answers "which specs cover this file", "which specs will the
gate fail on", scaffolds new specs in the right shape, and runs the repo's own gates.

It applies autologger's own rules (`scripts/lib/check_change.py`): the same git-style glob matcher,
the same changed-file set and merge-base, the map read from the base. It needs Node.js 22.18 or
newer and git; it has no runtime dependencies (it reads `lifecycle.yaml` with its own small YAML
reader) and needs no Python, except `gate`, which runs the checkout's `scripts/check-change.sh`.

## Install

```
/plugin marketplace add kwcantrell/autologger-marketplace
/plugin install autologger-specs@autologger-marketplace
```

Two skills come with it:

- `autologger-specs`: before finishing a change in an autologger checkout, run `stale`, update the
  specs it lists, and run `gate`; also `which` for "which spec covers this file".
- `autologger-new-spec`: write a new spec with `new`, add the printed map entry, fill it in, `lint`.

## Commands

Skills run the CLI as
`npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-specs <command> --json`.
From a checkout of this marketplace you can run it directly with `node plugins/autologger-specs/src/cli.ts`.
Each command works on the git checkout containing the current directory, or `--repo <path>`; outside
an autologger checkout (no `scripts/lifecycle.yaml`) it exits 2.

```sh
# Which specs cover these files (paths relative to the current directory)
autologger-specs which server/src/routers/wiki.ts web/src/app/page.tsx
#   server/src/routers/wiki.ts: api-contract-freeze, show-wiki
#   web/src/app/page.tsx: web-frontend-platform

# Specs the specs-with-code gate would fail on: changed, staged and untracked files against the
# merge-base with origin/main (or main, or --base <ref>), minus test_globs and managed_paths
autologger-specs stale
#   autologger-specs: 2 spec(s) not updated for the code they cover, against origin/main (e25265d294b9):
#   docs/specs/api-contract-freeze.md not changed, but its spec_paths cover: server/src/routers/wiki.ts
#   docs/specs/show-wiki.md not changed, but its spec_paths cover: server/src/routers/wiki.ts
#   (exit 1; exit 0 when nothing is stale)

# Spec shape and the spec_paths map, like the specs gate, plus a Scenario under every Requirement
autologger-specs lint                 # all specs and the whole map
autologger-specs lint show-wiki       # one spec and its own map entry

# Scaffold docs/specs/<name>.md and print the entry to add under lifecycle.spec_paths
autologger-specs new clip-export --covers 'server/src/routers/clips.ts' --covers 'web/src/clips/**'
#   Created docs/specs/clip-export.md. Fill in its TODOs, and add this entry under lifecycle.spec_paths in scripts/lifecycle.yaml:
#
#       clip-export:
#       - server/src/routers/clips.ts
#       - web/src/clips/**

# Run the checkout's own gates (default specs,specs-with-code); output streams to stderr
autologger-specs gate
autologger-specs gate specs yaml --base origin/main
```

With `--json`, a successful command prints one JSON value on stdout: `which` a map of path to spec
names, `stale` `{base, baseRef, mapFrom, active, changed, checked, stale: [{spec, file, covered}]}`,
`lint` `{specs, problems}`, `new` `{file, entry, covers, unmatched, mapped}`, `gate`
`{command, exitCode, checks: [{status, check, message}]}`.

Exit codes follow the marketplace convention: 0 success; 1 failure (stale specs, lint problems, a
gate failure, an existing spec for `new`, an unreadable `lifecycle.yaml`); 2 usage error, a
non-kebab-case spec name, or not an autologger checkout. `gate` exits with the script's own status.
On a non-zero exit stdout is empty and the details are on stderr, also with `--json`.

## Differences from the gates

- `stale` has no PR context, so it ignores override labels (`no-spec-needed`) and the Dependabot
  exemption, like a local `scripts/check-change.sh` run. It lists every triggering file, where the
  gate shows the first five.
- An explicit `--base` that does not resolve is an error; `check_change.py` would silently fall
  back to `origin/main` / `main`.
- `lint` also requires a `#### Scenario:` under each `### Requirement:` (`docs/specs/README.md`
  asks for it; the gate does not check it).
- `lifecycle.yaml` is read by a small built-in YAML reader that matches PyYAML for block-style YAML
  and refuses (exit 1, with the line) anchors, aliases, tags, multi-line flow collections and other
  constructs it does not support, rather than misreading them.

## Development

```sh
npm test                                                   # from the repo root; fixture repos only
node plugins/autologger-specs/test/verify-autologger.ts /home/autologger/autologger-2
```

The second command compares the CLI with autologger's own Python gates on a real checkout (needs
python3 with PyYAML): `which` against `check_change.py` for every tracked file, `lint` against
`--only specs`, and, in a temporary `git clone`, `stale` against `--only specs-with-code` and `new`
against `--only specs`. It does not modify the checkout it is given.
