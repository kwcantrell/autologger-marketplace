import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { doctor, formatDoctor } from './doctor.ts';
import { CliError, messageOf, UsageError } from './errors.ts';
import { formatReset, reset } from './reset.ts';
import { type Runner, spawnRunner } from './runner.ts';
import { formatSetup, setup } from './setup.ts';
import { formatSignin, signin } from './signin.ts';
import { defaultCaFile, type Env, parseSlot } from './slot.ts';
import { httpsProbe, type Probe } from './tls.ts';

export const CLI_NAME = 'autologger-browser';

/** Exit codes shared by every plugin CLI in this marketplace. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Environment (default `process.env`). */
  env?: Env;
  /** Current directory, for a relative --ca (default `process.cwd()`). */
  cwd?: string;
  /** Runs agent-browser, certutil and chromium (default: spawn them). */
  runner?: Runner;
  probe?: Probe;
  /** All of stdin (signin only). */
  readStdin?: () => Promise<string>;
  /** Whether stdin is a terminal (signin refuses one: the cookie must be piped in). */
  stdinIsTty?: boolean;
}

export const USAGE = `Usage: ${CLI_NAME} <command> [options]

A Chromium profile for agent-browser that trusts a local autologger dev stack's private CA, and
only there: its own NSS database plus a launcher passed as --executable-path. Files live in
~/.autologger-dev/browser/slot-<N>/. Certificate checks are never turned off.

Commands:
  doctor [--slot <N>] [--ca <file>]
                 Check agent-browser, Chromium, certutil, the dev CA file, the profile and its
                 trust, and that the app and dashboard runtime answer over TLS verified with the
                 CA. Each check is ok, missing or fail, with a one-line fix. Exit 0 when it ran.
  setup [--slot <N>] [--ca <file>]
                 Create (or re-use) the slot's profile, trust the CA (default
                 ~/.autologger-dev/autologger-dev-ca.crt) in its private NSS database (C,,: TLS
                 only; replaced when the file changed, else a no-op), write the launcher, and print
                 the agent-browser flags to use. Needs certutil (libnss3-tools).
  signin [--slot <N>]
                 Read one line, <cookie name>=<token>, from stdin (pipe make dev-login
                 EMAIL=<address> into it) and set it in the profile as the slot's Secure, HttpOnly
                 session cookie for its app origin. The token is never printed or put on a
                 command line. Input that is not exactly that line is refused (exit 2).
  reset [--slot <N>]
                 Close the slot's agent-browser session and delete its folder (profile, NSS
                 database, launcher), after checking it is inside ~/.autologger-dev/browser.

Options:
  --slot <N>     Dev slot 0-9 (default 0: https://localhost:8787, or DEV_PORT from
                 ~/.autologger-local-openbao/overrides.env; N: https://localhost:2N787)
  --ca <file>    The dev CA file (doctor, setup)
  --json         Print machine-readable JSON on stdout
  -h, --help     Show this help
  --version      Print the CLI version

Exit codes: 0 success, 1 command failed, 2 usage error (message on stderr).
`;

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'unknown';
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const OPTIONS = {
  doctor: ['slot', 'ca'],
  setup: ['slot', 'ca'],
  signin: ['slot'],
  reset: ['slot'],
} as const;

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
        slot: { type: 'string' },
        ca: { type: 'string' },
      },
    });
  } catch (error) {
    return usageError(io, messageOf(error));
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

  const env = io.env ?? process.env;
  const runner = io.runner ?? spawnRunner;
  const [command, ...rest] = positionals;
  const print = (json: unknown, text: string): void => io.stdout(values.json ? `${JSON.stringify(json)}\n` : text);
  try {
    if (command === undefined) throw new UsageError('missing command');
    if (!Object.hasOwn(OPTIONS, command)) throw new UsageError(`unknown command '${command}'`);
    const allowed: readonly string[] = OPTIONS[command as keyof typeof OPTIONS];
    for (const option of ['slot', 'ca'] as const) {
      if (values[option] !== undefined && !allowed.includes(option)) throw new UsageError(`${command} does not take --${option}`);
    }
    if (rest.length > 0) throw new UsageError(`${command} takes no arguments, got '${rest[0]}'`);
    const slot = parseSlot(values.slot);
    if (values.ca === '') throw new UsageError('--ca needs a file');
    const ca = values.ca === undefined ? defaultCaFile(env) : resolve(io.cwd ?? process.cwd(), values.ca);

    switch (command) {
      case 'doctor': {
        const report = await doctor({ env, runner, probe: io.probe ?? httpsProbe, slot, ca });
        print(report, formatDoctor(report));
        return EXIT.ok;
      }
      case 'setup': {
        const report = await setup({ env, runner, slot, ca });
        print(report, formatSetup(report));
        return EXIT.ok;
      }
      case 'signin': {
        if (io.stdinIsTty ?? process.stdin.isTTY) {
          throw new UsageError('signin reads the cookie line from stdin; pipe make dev-login EMAIL=<address> into it');
        }
        const input = await (io.readStdin ?? readProcessStdin)();
        const report = await signin({ env, runner, slot, input });
        print(report, formatSignin(report));
        return EXIT.ok;
      }
      default: {
        const report = await reset({ env, runner, slot });
        print(report, formatReset(report));
        return EXIT.ok;
      }
    }
  } catch (error) {
    if (error instanceof UsageError) return usageError(io, error.message);
    io.stderr(`${CLI_NAME}: ${error instanceof CliError ? error.message : messageOf(error)}\n`);
    return EXIT.failure;
  }
}

function usageError(io: Io, message: string): number {
  io.stderr(`${CLI_NAME}: ${message}\nRun '${CLI_NAME} --help' for usage.\n`);
  return EXIT.usage;
}
