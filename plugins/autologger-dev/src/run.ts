import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CA_COMMAND, fetchCa, formatCa } from './ca.ts';
import { connect, formatConnect } from './connect.ts';
import { doctor, formatDoctor } from './doctor.ts';
import { messageOf, UsageError } from './errors.ts';
import { DEFAULT_SERVER, type Env, type Fetch, resolveServer } from './http.ts';
import { type Runner, spawnRunner } from './runner.ts';
import { defaultCaFile, redactor, resolveCheckout, secretValues } from './stack.ts';
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
to its MCP server at ${DEFAULT_SERVER}/mcp.

Commands:
  doctor [--repo <path>] [--server <url>]
                 Check what is missing: the checkout, docker, make, Node, the local OpenBao
                 container, .env.openbao.dev, the Google client and CUSTOM_DASHBOARDS_ENABLED in
                 overrides.env (set, placeholder, quoted or padded only, never values),
                 NODE_EXTRA_CA_CERTS and the dev server. Each check is ok, missing or fail, with a one-line fix. Exit 0 when it ran.
  up --repo <path> [--dry-run]
                 Run, in the checkout and only as needed: ${STEPS['dev-bao'].command},
                 ${STEPS['dev-bao-set'].command}, then ${STEPS['dev-up'].command}.
                 make's output goes to stderr; the first failing step stops it (exit 1).
                 --dry-run prints the steps without running them.
  ca --repo <path> [--out <file>]
                 Run ${CA_COMMAND}, check the output is one PEM certificate, write it
                 (default ~/.autologger-dev/autologger-dev-ca.crt, mode 644) and print the
                 export NODE_EXTRA_CA_CERTS=<file> line. An existing file there is replaced only
                 if it is a regular file holding one PEM certificate; anything else (another
                 file, a directory, a symlink) is refused with exit 1 and left as it was.
  status [--server <url>]
                 Whether the server answers, serves /.well-known/oauth-protected-resource naming
                 its resource, and has /mcp. A TLS trust failure is reported with its fix.
  connect [--server <url>]
                 Print (never run) what is left to connect Claude: the NODE_EXTRA_CA_CERTS export,
                 claude mcp add --transport http autologger-dev <server>/mcp, or autologger-mcp login.

Options:
  --repo <path>    autologger-2 checkout (default: $AUTOLOGGER_REPO; for doctor only, else the
                   current directory). up and ca need --repo or $AUTOLOGGER_REPO, and refuse a
                   checkout whose origin remote is not github.com/kwcantrell/autologger-2.
  --server <url>   dev server (default: $AUTOLOGGER_URL, else ${DEFAULT_SERVER}); https://, or
                   http:// to localhost/127.0.0.1/[::1]
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
  out: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
} as const;

type OptionName = keyof typeof OPTIONS;
/** Commands that run the checkout's Makefile: they need an explicit checkout. */
const MAKEFILE_COMMANDS = new Set(['up', 'ca']);
const COMMON: OptionName[] = ['json', 'help', 'version'];
const COMMAND_OPTIONS: Record<string, OptionName[]> = {
  doctor: ['repo', 'server'],
  up: ['repo', 'dry-run'],
  ca: ['repo', 'out'],
  status: ['server'],
  connect: ['server'],
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

  try {
    switch (command) {
      case 'doctor': {
        const server = resolveServer(values.server, env);
        const report = await doctor({ env, runner, fetch: fetchFn, checkout, server });
        out(report, formatDoctor(report));
        return EXIT.ok;
      }
      case 'up': {
        const progress = lineWriter(io.stderr);
        const ctx = { env, runner, checkout, progress: progress.push, endOutput: progress.flush };
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
        const report = await fetchCa({ env, runner, checkout, out: target, diagnostics: io.stderr });
        out(report, formatCa(report));
        return EXIT.ok;
      }
      case 'status': {
        const report = await status(fetchFn, resolveServer(values.server, env));
        out(report, formatStatus(report));
        return EXIT.ok;
      }
      case 'connect': {
        const report = connect(env, resolveServer(values.server, env));
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
