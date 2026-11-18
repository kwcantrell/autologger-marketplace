---
name: autologger-new-spec
description: Writes a new autologger spec (docs/specs/<name>.md) in the shape the specs gate requires and maps it in scripts/lifecycle.yaml. Use in an autologger checkout when a change adds a capability no existing spec describes, when asked to write or add a spec, or when the specs gate reports a spec with a missing title, Purpose, Requirement or spec_paths entry.
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-specs:*)
---

# Write a new autologger spec

Never hand-write a spec file from scratch: scaffold it with this plugin's CLI so it has the shape
autologger's `specs` gate checks, then fill it in. Run the commands exactly as written, from
anywhere inside the checkout, with no install or build step first.

1. Check that no existing spec already covers the code (if one does, update that spec instead):

   ```sh
   npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-specs which --json <path>
   ```

2. Create the spec. `<name>` is the capability in kebab-case (it becomes `docs/specs/<name>.md`);
   pass one `--covers` per glob for the source it describes (`**/` spans directories, `*` stays in
   one directory; each glob must match a tracked file):

   ```sh
   npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-specs new <name> --covers <glob> --json
   ```

   It prints JSON with `file`, `entry` and `unmatched`. Exit 1 means the spec already exists;
   exit 2 means the name is not kebab-case. If `unmatched` is not empty, fix those globs.

3. Add `entry` verbatim under `lifecycle.spec_paths` in `scripts/lifecycle.yaml`, in alphabetical
   order among the other specs (the CLI does not edit the YAML). Keep its indentation: the name at
   four spaces, the `- ` items at four spaces.

4. Replace every `TODO` in the new spec: a `## Purpose` paragraph, then one `### Requirement:`
   per behavior, each stating what the system SHALL do with at least one `#### Scenario:` using
   `- **WHEN** ...` / `- **THEN** ...` lines. Describe what the code does now, not plans.

5. Check the spec and the map, then run the repository's own gate:

   ```sh
   npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-specs lint <name> --json
   npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- autologger-specs gate specs --json
   ```

   `lint` exits 1 with each problem on stderr (missing title, empty Purpose, no Requirement, a
   Requirement without a Scenario, a missing or broken `spec_paths` entry); fix them and run it
   again. `gate` exits with the status of `scripts/check-change.sh --only specs`.

Exit codes: 0 success, 1 the command or check failed, 2 a usage error or not inside an autologger
checkout; the reason is on stderr.
