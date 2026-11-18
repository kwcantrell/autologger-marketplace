import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_GATES, GATE_SCRIPT, gate } from './gate.ts';
import { CONFIG_PATH, NotACheckoutError, findRepo } from './repo.ts';
import { ArgumentError, lint, newSpec, stale, which } from './specs.ts';

export const CLI_NAME = 'autologger-specs';

/** Exit codes shared by every plugin CLI in this marketplace. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** The directory the CLI was run from; the checkout is found from it unless --repo is given. */
  cwd: string;
}

export const USAGE = `Usage: ${CLI_NAME} <command> [options]

Keeps an autologger checkout's docs/specs/ in step with its code, using the same rules as its
\`specs\` and \`specs-with-code\` gates (scripts/lib/check_change.py).

Commands:
  which <path>...             Specs whose lifecycle.spec_paths globs cover each path
  stale [--base <ref>]        Specs whose covered files changed since the merge-base while the spec
                              did not (the specs-with-code gate); exit 1 if any
  lint [<spec>...]            Spec shape (title, Purpose, Requirement with Scenario) and the
                              spec_paths map, like the specs gate; exit 1 on any problem
  new <name> [--covers <glob>]...
                              Create docs/specs/<name>.md and print the spec_paths entry to add
                              to ${CONFIG_PATH} (the YAML is not edited)
  gate [<check>...] [--base <ref>]
                              Run ${GATE_SCRIPT} --only <checks> (default: ${DEFAULT_GATES.join(',')}),
                              streaming its output to stderr; exits with its status

Options:
  --repo <path>  The autologger checkout (default: the git checkout containing the current directory)
  --json         Print machine-readable JSON on stdout
  -h, --help     Show this help
  --version      Print the CLI version

Paths are relative to the current directory when it is inside the checkout, else to its root.
Exit codes: 0 success, 1 command failed (or stale specs / lint problems / gate failure),
2 usage error or not an autologger checkout (message on stderr).
`;

class UsageError extends Error {}

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  which: [],
  stale: ['base'],
  lint: [],
  new: ['covers'],
  gate: ['base'],
};

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'unknown';
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', default: false },
        repo: { type: 'string' },
        base: { type: 'string' },
        covers: { type: 'string', multiple: true },
      },
    });
  } catch (error) {
    return usageError(io, error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;

  if (values.help) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  if (values.version) {
    io.stdout(`${version()}\n`);
    return EXIT.ok;
  }

  const [command, ...rest] = positionals;
  if (command === undefined) return usageError(io, 'missing command');
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) return usageError(io, `unknown command '${command}'`);
  for (const option of ['base', 'covers'] as const) {
    if (values[option] !== undefined && !allowed.includes(option)) {
      return usageError(io, `${command} does not take --${option}`);
    }
  }
  const json = values.json;
  const print = (value: unknown, text: string) => io.stdout(json ? `${JSON.stringify(value)}\n` : text);

  try {
    switch (command) {
      case 'which': {
        if (rest.length === 0) throw new UsageError('which needs at least one path');
        const repo = findRepo(io.cwd, values.repo);
        const result = which(repo, rest);
        const lines = Object.entries(result).map(([path, specs]) => `${path}: ${specs.length ? specs.join(', ') : '(no spec)'}\n`);
        print(result, lines.join(''));
        return EXIT.ok;
      }
      case 'stale': {
        if (rest.length > 0) throw new UsageError(`stale takes no arguments, got '${rest[0]}'`);
        const repo = findRepo(io.cwd, values.repo);
        const result = stale(repo, values.base);
        const against = result.base ? `${result.baseRef} (${result.base.slice(0, 12)})` : 'no base (every tracked file counts as changed)';
        if (result.stale.length > 0) {
          const lines = result.stale.map((s) => `${s.file} not changed, but its spec_paths cover: ${s.covered.join(', ')}`);
          io.stderr(
            `${CLI_NAME}: ${result.stale.length} spec(s) not updated for the code they cover, against ${against}:\n` +
              `${lines.join('\n')}\n`,
          );
          return EXIT.failure;
        }
        const text = result.active
          ? `No stale specs against ${against}: ${result.checked} non-test file(s) changed; every spec they map to changed too.\n`
          : `lifecycle.spec_paths is empty on the base; the specs-with-code gate is not active.\n`;
        print(result, text);
        return EXIT.ok;
      }
      case 'lint': {
        const repo = findRepo(io.cwd, values.repo);
        const result = lint(repo, rest);
        if (result.problems.length > 0) {
          io.stderr(`${CLI_NAME}: ${result.problems.length} spec problem(s):\n${result.problems.join('\n')}\n`);
          return EXIT.failure;
        }
        print(result, `${result.specs.length} spec(s) well-formed and mapped in lifecycle.spec_paths\n`);
        return EXIT.ok;
      }
      case 'new': {
        if (rest.length !== 1) throw new UsageError(`new takes exactly one spec name, got ${rest.length}`);
        const repo = findRepo(io.cwd, values.repo);
        const result = newSpec(repo, rest[0] ?? '', values.covers ?? []);
        const notes: string[] = [];
        if (result.covers.length === 0) notes.push('Replace the placeholder glob with globs for the source this spec describes.');
        if (result.unmatched.length) notes.push(`Warning: these globs match no tracked file, so the specs gate would fail: ${result.unmatched.join(', ')}`);
        if (result.mapped) notes.push('Note: lifecycle.spec_paths already has an entry for this name; keep one.');
        print(
          result,
          `Created ${result.file}. Fill in its TODOs, and add this entry under lifecycle.spec_paths in ${CONFIG_PATH}:\n\n` +
            `${result.entry}\n${notes.map((n) => `${n}\n`).join('')}`,
        );
        return EXIT.ok;
      }
      case 'gate': {
        const names = rest.flatMap((n) => n.split(',')).map((n) => n.trim()).filter((n) => n !== '');
        for (const n of names) if (!/^[a-z][a-z-]*$/.test(n)) throw new UsageError(`'${n}' is not a check name`);
        const repo = findRepo(io.cwd, values.repo);
        const result = await gate(repo, names, values.base, io.stderr);
        if (result.exitCode !== 0) {
          io.stderr(`${CLI_NAME}: ${result.command.join(' ')} exited ${result.exitCode}\n`);
          return result.exitCode;
        }
        print(result, `gate passed: ${result.command.join(' ')}\n`);
        return EXIT.ok;
      }
      default:
        return usageError(io, `unknown command '${command}'`);
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof ArgumentError) return usageError(io, error.message);
    if (error instanceof NotACheckoutError) {
      io.stderr(`${CLI_NAME}: ${error.message}\n`);
      return EXIT.usage;
    }
    io.stderr(`${CLI_NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.failure;
  }
}

function usageError(io: Io, message: string): number {
  io.stderr(`${CLI_NAME}: ${message}\nRun '${CLI_NAME} --help' for usage.\n`);
  return EXIT.usage;
}
