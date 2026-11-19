import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CA_COMMAND, fetchCa, formatCa } from './ca.ts';
import { connect, formatConnect } from './connect.ts';
import { doctor, formatDoctor } from './doctor.ts';
import { messageOf, UsageError } from './errors.ts';
import { DEFAULT_SERVER, type Env, type Fetch, resolveServer } from './http.ts';
import { type Runner, spawnRunner } from './runner.ts';
import { devPort, parseSlot, slotServer } from './slot.ts';
import { defaultCaFile, readOverrides, redactor, resolveCheckout, secretValues } from './stack.ts';
import { formatStatus, status } from './status.ts';
import { formatUp, planUp, runUp, STEPS } from './up.ts';

export const CLI_NAME = 'autologger-dev';

/** Exit codes shared by every plugin CLI in this marketplace. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Environment (default `process.env`). */
  env?: Env;
  /** Current directory (default `process.cwd()`). */
  cwd?: string;
  /** Runs docker, make and node (default: spawn them). */
  runner?: Runner;
  fetch?: Fetch;
}

export const USAGE = `Usage: ${CLI_NAME} <command> [options]

Brings up a local autologger dev stack (kwcantrell/autologger-2) in HTTPS mode and connects Claude
to its MCP server at ${DEFAULT_SERVER}/mcp (https://localhost:<DEV_PORT>/mcp when
overrides.env sets DEV_PORT), or to dev slot N's at https://localhost:2N787/mcp.

Commands:
  doctor [--repo <path>] [--slot <N>] [--server <url>]
                 Check what is missing: the checkout, docker, make, Node, the local OpenBao
                 container, .env.openbao.dev, the Google client and CUSTOM_DASHBOARDS_ENABLED in
                 overrides.env (set, placeholder, quoted or padded only, never values),
                 NODE_EXTRA_CA_CERTS and the dev server. Each check is ok, missing or fail, with a one-line fix.
                 An invalid DEV_PORT in overrides.env is a one-line note. Exit 0 when it ran.
  up --repo <path> [--slot <N>] [--dry-run]
                 Run, in the checkout and only as needed: ${STEPS['dev-bao'].command},
                 ${STEPS['dev-bao-set'].command}, then ${STEPS['dev-up'].command}.
                 make's output goes to stderr; the first failing step stops it (exit 1).
                 --dry-run prints the steps without running them.
  ca --repo <path> [--slot <N>] [--out <file>]
                 Run ${CA_COMMAND}, check the output is one PEM certificate, write it
                 (default ~/.autologger-dev/autologger-dev-ca.crt, mode 644) and print the
                 export NODE_EXTRA_CA_CERTS=<file> line. An existing file there is replaced only
                 if it is a regular file holding one PEM certificate; anything else (another
                 file, a directory, a symlink) is refused with exit 1 and left as it was.
  status [--slot <N>] [--server <url>]
                 Whether the server answers, serves /.well-known/oauth-protected-resource naming
                 its resource, and has /mcp. A TLS trust failure is reported with its fix.
  connect [--slot <N>] [--server <url>]
                 Print (never run) what is left to connect Claude: the NODE_EXTRA_CA_CERTS export,
                 claude mcp add --transport http autologger-dev <server>/mcp (autologger-dev-N for
                 slot N), autologger-mcp login, or, with no Google client needed,
                 make dev-mcp-token EMAIL=<address> (DEV_SLOT=N for slot N) piped into
                 autologger-mcp import-tokens --server <server>.

Options:
  --repo <path>    autologger-2 checkout (default: $AUTOLOGGER_REPO; for doctor only, else the
                   current directory). up and ca need --repo or $AUTOLOGGER_REPO, and refuse a
                   checkout whose origin remote is not github.com/kwcantrell/autologger-2.
  --slot <N>       autologger dev slot N, one digit 0-9 (ADR 0038; default 0, the default stack).
                   Slot 0's server is https://localhost:<DEV_PORT> when overrides.env sets DEV_PORT
                   to a port (digits only, 1-65535, no quotes or spaces), else ${DEFAULT_SERVER}.
                   Slot N's server is https://localhost:2N787 (DEV_PORT never applies); up and ca
                   pass DEV_SLOT=N to make dev-up and make dev-ca (nothing for slot 0). The local
                   OpenBao and the dev CA are shared by every slot.
  --server <url>   dev server (default: --slot's server if given, else $AUTOLOGGER_URL, else slot
                   0's server); https://, or http:// to localhost/127.0.0.1/[::1]. With --slot it
                   must be that slot's own server (same origin), else exit 2: the MCP server name
                   and the fixes name the slot, so they must be about the server checked.
  --json           Print machine-readable JSON on stdout
  -h, --help       Show this help
  --version        Print the CLI version

Never runs a *-reset, *-down, stage or prod target, and never prints a value from the OpenBao
state directory (~/.autologger-local-openbao) or .env.openbao.dev.

Exit codes: 0 success, 1 command failed, 2 usage error (message on stderr).
`;

const OPTIONS = {
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', default: false },
  repo: { type: 'string' },
  server: { type: 'string' },
  slot: { type: 'string' },
  out: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
} as const;

type OptionName = keyof typeof OPTIONS;
/** Commands that run the checkout's Makefile: they need an explicit checkout. */
const MAKEFILE_COMMANDS = new Set(['up', 'ca']);
const COMMON: OptionName[] = ['json', 'help', 'version'];
const COMMAND_OPTIONS: Record<string, OptionName[]> = {
  doctor: ['repo', 'server', 'slot'],
  up: ['repo', 'dry-run', 'slot'],
  ca: ['repo', 'out', 'slot'],
  status: ['server', 'slot'],
  connect: ['server', 'slot'],
};

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'unknown';
}

/** Buffers text into whole lines, so a value split across chunks is still scrubbed as one. */
function lineWriter(write: (text: string) => void): { push: (text: string) => void; flush: () => void } {
  let buffer = '';
  return {
    push(text) {
      buffer += text;
      const end = buffer.lastIndexOf('\n');
      if (end >= 0) {
        write(buffer.slice(0, end + 1));
        buffer = buffer.slice(end + 1);
      }
    },
    flush() {
      if (buffer !== '') write(`${buffer}\n`);
      buffer = '';
    },
  };
}

export async function run(argv: readonly string[], rawIo: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: OPTIONS });
  } catch (error) {
    return usageError(rawIo, messageOf(error));
  }
  const { values, positionals } = parsed;

  if (values.help) {
    rawIo.stdout(USAGE);
    return EXIT.ok;
  }
  if (values.version) {
    rawIo.stdout(`${version()}\n`);
    return EXIT.ok;
  }

  const [command, ...rest] = positionals;
  if (command === undefined) return usageError(rawIo, 'missing command');
  const allowed = COMMAND_OPTIONS[command];
  if (allowed === undefined) return usageError(rawIo, `unknown command '${command}'`);
  for (const [name, value] of Object.entries(values)) {
    const key = name as OptionName;
    if (value === undefined || value === false || COMMON.includes(key) || allowed.includes(key)) continue;
    return usageError(rawIo, `${command} does not take --${name}`);
  }
  if (rest.length > 0) return usageError(rawIo, `${command} takes no arguments`);
  if (values.out === '') return usageError(rawIo, '--out needs a file path');
  if (values.repo === '') return usageError(rawIo, '--repo needs a path');
  let slot: number;
  try {
    slot = parseSlot(values.slot);
  } catch (error) {
    return usageError(rawIo, messageOf(error));
  }

  const env = rawIo.env ?? process.env;
  const cwd = rawIo.cwd ?? process.cwd();
  const checkout = resolveCheckout(values.repo, env, cwd);
  // up and ca run the checkout's Makefile: never one found only by being the current directory.
  if (MAKEFILE_COMMANDS.has(command) && checkout.source === 'current directory') {
    return usageError(rawIo, `${command} runs the checkout's Makefile, so it needs --repo <path> or AUTOLOGGER_REPO; it does not default to the current directory`);
  }

  const runner = rawIo.runner ?? spawnRunner;
  const fetchFn = rawIo.fetch ?? fetch;

  // No value from the OpenBao state directory or .env.openbao.dev may leave this process, whoever
  // printed it (make and docker included): scrub every write on the way out. The files are read
  // again for each write, because a make step (make dev-bao) can write a new secret and print it
  // in the same step; by the time its output reaches us the file is already on disk. A value seen
  // once stays hidden for the rest of the run, even after a step replaces or removes it.
  const hidden = new Set<string>();
  let secrets: string[] = [];
  const learnSecrets = (): void => {
    const before = hidden.size;
    for (const value of secretValues(env, checkout.path)) hidden.add(value);
    if (hidden.size !== before) secrets = [...hidden].sort((a, b) => b.length - a.length);
  };
  learnSecrets();
  const scrub = (text: string): string => {
    learnSecrets();
    return redactor(secrets)(text);
  };
  const io = { stdout: (t: string) => rawIo.stdout(scrub(t)), stderr: (t: string) => rawIo.stderr(scrub(t)) };
  const json = values.json;
  const out = (value: unknown, text: string): void => io.stdout(json ? `${JSON.stringify(value)}\n` : text);
  // Slot 0's server follows DEV_PORT in overrides.env (slot N's never does); only a valid port is kept.
  const port = devPort(readOverrides(env));
  const slotOrigin = slotServer(slot, port);
  // --server wins; else --slot's own server; else $AUTOLOGGER_URL, else the default (slot 0's) stack.
  // --server and --slot together must name the same origin: everything the command prints for the
  // slot (the MCP server name, fixes like `up --slot N`) would otherwise be about another stack.
  const server = (): string => {
    if (values.server !== undefined) {
      const origin = resolveServer(values.server, env);
      if (values.slot !== undefined && origin !== slotOrigin) {
        throw new UsageError(`--server ${origin} is not dev slot ${slot}'s server (${slotOrigin}); pass --slot ${slot} alone for that slot, or --server alone for another server`);
      }
      return origin;
    }
    return values.slot !== undefined ? slotOrigin : resolveServer(undefined, env, slotOrigin);
  };

  try {
    switch (command) {
      case 'doctor': {
        const report = await doctor({ env, runner, fetch: fetchFn, checkout, server: server(), slot, devPort: port });
        out(report, formatDoctor(report));
        return EXIT.ok;
      }
      case 'up': {
        const progress = lineWriter(io.stderr);
        const ctx = { env, runner, checkout, slot, devPort: port, progress: progress.push, endOutput: progress.flush };
        const plan = await planUp(ctx);
        for (const w of plan.warnings) io.stderr(`${CLI_NAME}: warning: ${w}\n`);
        if (values['dry-run']) {
          out(plan, formatUp(plan));
          return EXIT.ok;
        }
        try {
          await runUp(ctx, plan);
        } finally {
          progress.flush();
        }
        out(plan, formatUp(plan));
        return EXIT.ok;
      }
      case 'ca': {
        const target = values.out !== undefined ? resolve(cwd, values.out) : defaultCaFile(env);
        const report = await fetchCa({ env, runner, checkout, slot, out: target, diagnostics: io.stderr });
        out(report, formatCa(report));
        return EXIT.ok;
      }
      case 'status': {
        const report = await status(fetchFn, server(), slot);
        out(report, formatStatus(report));
        return EXIT.ok;
      }
      case 'connect': {
        const report = connect(env, server(), slot);
        out(report, formatConnect(report));
        return EXIT.ok;
      }
    }
    return usageError(io, `unknown command '${command}'`);
  } catch (error) {
    if (error instanceof UsageError) return usageError(io, error.message);
    io.stderr(`${CLI_NAME}: ${messageOf(error)}\n`);
    return EXIT.failure;
  }
}

function usageError(io: Pick<Io, 'stderr'>, message: string): number {
  io.stderr(`${CLI_NAME}: ${message}\nRun '${CLI_NAME} --help' for usage.\n`);
  return EXIT.usage;
}
