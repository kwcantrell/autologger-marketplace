import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { importTokens, isExpired, login, logout, parseDevTokenGrant, requireSignedIn, TokenSource } from './auth.ts';
import { CliError, messageOf, UsageError } from './errors.ts';
import { DEFAULT_SERVER, type Fetch, isObject, resolveServer } from './http.ts';
import { checkLinks } from './links.ts';
import { McpClient, resultText } from './mcp.ts';
import { discover, WRITE_SCOPE } from './oauth.ts';
import { CredentialStore, type Env, redact } from './store.ts';

export const CLI_NAME = 'autologger-mcp';

/** Exit codes shared by every plugin CLI in this marketplace. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Environment (default `process.env`). */
  env?: Env;
  /** Clock in epoch ms (default `Date.now`). */
  now?: () => number;
  /** Opens a URL in a browser (default: `$BROWSER`, else the platform's opener). */
  openUrl?: (url: string) => void;
  /** Reads standard input (default: the process's). */
  readStdin?: () => Promise<string>;
  fetch?: Fetch;
}

const DEFAULT_LOGIN_TIMEOUT_S = 300;

export const USAGE = `Usage: ${CLI_NAME} <command> [options]

Reads and writes autologger session data through autologger's MCP endpoint, signed in with
autologger's OAuth (browser sign-in, tokens kept and refreshed locally).

Commands:
  login [--write]              Sign in through the browser. Default scope 'dashboards' (read);
                               --write also asks for 'session-data:write' (edit events, topics,
                               wiki pages). Options: --no-browser, --timeout <seconds> (default ${DEFAULT_LOGIN_TIMEOUT_S}).
  status [--check]             Server, signed in or not, granted scope and token expiry, from the
                               local file only; --check also runs discovery and tests the token.
  import-tokens                Store the JSON line autologger's dev-only 'make dev-mcp-token' prints,
                               read from stdin only (pipe it in), as the sign-in for the server.
                               Its issuer and resource must be the server's own (from discovery);
                               a previous sign-in with another grant is revoked first.
  logout                       Revoke the sign-in at the server (when it can) and delete the
                               local tokens.
  tools                        List the MCP tools (name and description; --json: full schemas).
  call <tool> [--args '<json>' | --args-file <path|->]
                               Call one tool with a JSON object of arguments and print its result
                               (--json: the raw MCP result).
  check-links <file|->         Report [[...]] links and malformed wiki:/cite: links in a wiki body
                               (Markdown); exit 1 if any are found.

Options:
  --server <url>   autologger server (default: $AUTOLOGGER_URL, else ${DEFAULT_SERVER})
  --json           Print machine-readable JSON on stdout
  -h, --help       Show this help
  --version        Print the CLI version

Environment:
  AUTOLOGGER_URL             Default server.
  AUTOLOGGER_MCP_CONFIG_DIR  Credentials directory (default: $XDG_CONFIG_HOME/autologger-mcp,
                             else ~/.config/autologger-mcp).
  NODE_EXTRA_CA_CERTS        A CA certificate file to trust, e.g. the dev stack's private CA.
  BROWSER                    Program that opens the sign-in URL.

Exit codes: 0 success, 1 command failed, 2 usage error (message on stderr).
`;

const OPTIONS = {
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', default: false },
  server: { type: 'string' },
  write: { type: 'boolean', default: false },
  'no-browser': { type: 'boolean', default: false },
  timeout: { type: 'string' },
  check: { type: 'boolean', default: false },
  args: { type: 'string' },
  'args-file': { type: 'string' },
} as const;

type OptionName = keyof typeof OPTIONS;
const COMMON: OptionName[] = ['json', 'help', 'version'];
const COMMAND_OPTIONS: Record<string, OptionName[]> = {
  login: ['server', 'write', 'no-browser', 'timeout'],
  status: ['server', 'check'],
  'import-tokens': ['server'],
  logout: ['server'],
  tools: ['server'],
  call: ['server', 'args', 'args-file'],
  'check-links': [],
};

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'unknown';
}

/** The plugin's own folder (where package.json is), for the login command shown to users. */
function packageRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
}

function shellQuote(text: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

function terminalCommand(args: string): string {
  return `npx --yes --offline --loglevel=error --package=${shellQuote(packageRoot())} -- ${CLI_NAME} ${args}`;
}

/** The exact command a user runs in a terminal to sign in. */
export function loginCommand(server: string, write: boolean): string {
  return terminalCommand(`login${write ? ' --write' : ''} --server ${shellQuote(server)}`);
}

/** The exact command a user pipes `make dev-mcp-token` into, in a terminal. */
export function importTokensCommand(server: string): string {
  return terminalCommand(`import-tokens --server ${shellQuote(server)}`);
}

function defaultOpenUrl(env: Env): (url: string) => void {
  return (url) => {
    const browser = env.BROWSER;
    let command: string;
    let args: string[];
    if (browser !== undefined && browser !== '') {
      if (browser === 'none') return;
      [command, args] = [browser, [url]];
    } else if (process.platform === 'darwin') {
      [command, args] = ['open', [url]];
    } else if (process.platform === 'win32') {
      [command, args] = ['rundll32', ['url.dll,FileProtocolHandler', url]];
    } else {
      [command, args] = ['xdg-open', [url]];
    }
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true, env: { ...env } as NodeJS.ProcessEnv });
      child.on('error', () => {});
      child.unref();
    } catch {
      // The URL is printed; the user can open it by hand.
    }
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function iso(ms: number | undefined): string | null {
  return ms === undefined ? null : new Date(ms).toISOString();
}

export async function run(argv: readonly string[], rawIo: Io): Promise<number> {
  // Nothing this CLI prints may carry a token: scrub every line on the way out.
  const io = { ...rawIo, stdout: (t: string) => rawIo.stdout(redact(t)), stderr: (t: string) => rawIo.stderr(redact(t)) };
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: OPTIONS });
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

  const [command, ...rest] = positionals;
  if (command === undefined) return usageError(io, 'missing command');
  const allowed = COMMAND_OPTIONS[command];
  if (allowed === undefined) return usageError(io, `unknown command '${command}'`);
  for (const [name, value] of Object.entries(values)) {
    const key = name as OptionName;
    if (value === undefined || value === false || COMMON.includes(key) || allowed.includes(key)) continue;
    return usageError(io, `${command} does not take --${name}`);
  }

  const env = rawIo.env ?? process.env;
  const ctxBase = { fetch: rawIo.fetch ?? fetch, now: rawIo.now ?? Date.now };
  const json = values.json;
  const out = (value: unknown, text: string): void => io.stdout(json ? `${JSON.stringify(value)}\n` : text);
  const warn = (message: string): void => io.stderr(`${CLI_NAME}: warning: ${message}\n`);

  try {
    if (command === 'check-links') {
      if (rest.length !== 1) throw new UsageError('check-links takes one file (or - for stdin)');
      const file = rest[0] ?? '-';
      let body: string;
      try {
        body = file === '-' ? await (rawIo.readStdin ?? readStdin)() : readFileSync(file, 'utf8');
      } catch (error) {
        throw new CliError(`cannot read ${file}: ${messageOf(error)}`);
      }
      const problems = checkLinks(body);
      if (problems.length > 0) {
        const name = file === '-' ? '<stdin>' : file;
        const lines = problems.map((p) => `${name}:${p.line}:${p.column}: ${p.message}`);
        throw new CliError(`${problems.length} link problem${problems.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
      }
      out({ file, problems: [] }, `${file}: no link problems\n`);
      return EXIT.ok;
    }

    const server = resolveServer(values.server, env);
    const store = new CredentialStore(env, server);
    const ctx = { ...ctxBase, store };

    switch (command) {
      case 'login': {
        if (rest.length > 0) throw new UsageError('login takes no arguments');
        let timeoutS = DEFAULT_LOGIN_TIMEOUT_S;
        if (values.timeout !== undefined) {
          timeoutS = Number(values.timeout);
          if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > 3600) {
            throw new UsageError('--timeout must be a whole number of seconds from 1 to 3600');
          }
        }
        const openUrl = values['no-browser'] ? undefined : (rawIo.openUrl ?? defaultOpenUrl(env));
        const result = await login(ctx, {
          write: values.write,
          timeoutMs: timeoutS * 1000,
          present: (url) => {
            io.stderr(
              `Open this URL in a browser to sign in to ${server}:\n\n  ${url}\n\nWaiting up to ${timeoutS} s for the sign-in to finish...\n`,
            );
            openUrl?.(url);
          },
        });
        const report = { ...result, expires_at: iso(result.expires_at), can_write: result.scope.split(' ').includes(WRITE_SCOPE) };
        out(
          report,
          `Signed in to ${server} with scope '${result.scope}'${
            result.expires_at !== undefined ? `; the access token expires ${report.expires_at}` : ''
          }.\n${!report.can_write && values.write ? 'Write access was not granted.\n' : ''}`,
        );
        return EXIT.ok;
      }
      case 'status': {
        if (rest.length > 0) throw new UsageError('status takes no arguments');
        const creds = store.load();
        const tokens = creds.tokens;
        const now = ctx.now();
        const report: Record<string, unknown> = {
          server,
          credentials_file: store.path,
          signed_in: tokens !== undefined,
          scope: tokens?.scope ?? null,
          can_write: tokens?.scope.split(' ').includes(WRITE_SCOPE) ?? false,
          access_token_expires_at: iso(tokens?.expires_at),
          access_token_expired: tokens === undefined ? null : isExpired(tokens, now),
          can_refresh: tokens?.refresh_token !== undefined,
          login_command: loginCommand(server, false),
          login_write_command: loginCommand(server, true),
          import_tokens_command: importTokensCommand(server),
        };
        if (values.check) {
          const d = await discover(ctx.fetch, server);
          report.discovery = {
            resource: d.resource,
            issuer: d.issuer,
            scopes_supported: d.scopes_supported,
            revocation: d.revocation_endpoint !== undefined,
          };
          if (tokens !== undefined) {
            const source = new TokenSource(ctx);
            const client = new McpClient({ endpoint: requireSignedIn(store).endpoints.resource, tokens: source, fetch: ctx.fetch, clientVersion: version() });
            await client.initialize();
            const after = store.load().tokens;
            report.token_valid = true;
            report.scope = after?.scope ?? report.scope;
            report.access_token_expires_at = iso(after?.expires_at);
            report.access_token_expired = false;
          }
        }
        const lines = [
          `Server: ${server}`,
          report.signed_in
            ? `Signed in, scope '${String(report.scope)}'; access token ${
                report.access_token_expired ? 'expired' : 'expires'
              } ${String(report.access_token_expires_at ?? 'never')}${report.can_refresh ? ' (refreshable)' : ''}`
            : `Not signed in. Run in a terminal:\n  ${loginCommand(server, false)}`,
          ...(values.check ? [`Discovery: OK (resource ${(report.discovery as { resource: string }).resource})`] : []),
          ...(report.token_valid === true ? ['Token: accepted by the server'] : []),
          `Credentials: ${store.path}`,
        ];
        out(report, `${lines.join('\n')}\n`);
        return EXIT.ok;
      }
      case 'import-tokens': {
        // Tokens never come from an argument: those end up in shell history and process lists.
        if (rest.length > 0) throw new UsageError('import-tokens takes no arguments; pipe the output of make dev-mcp-token into it');
        let reader = rawIo.readStdin;
        if (reader === undefined) {
          if (process.stdin.isTTY) throw new UsageError('import-tokens reads the token JSON from standard input; pipe the output of make dev-mcp-token into it');
          reader = readStdin;
        }
        let text: string;
        try {
          text = await reader();
        } catch (error) {
          throw new CliError(`cannot read standard input: ${messageOf(error)}`);
        }
        const grant = parseDevTokenGrant(text);
        const result = await importTokens(ctx, grant, warn);
        const report = { ...result, expires_at: iso(result.expires_at), can_write: result.scope.split(' ').includes(WRITE_SCOPE) };
        out(
          report,
          `Signed in to ${server} with imported tokens, scope '${result.scope}'; the access token expires ${report.expires_at}.\n${
            result.replaced ? `The previous sign-in was replaced${result.revoked_previous ? ' (revoked at the server)' : ''}.\n` : ''
          }`,
        );
        return EXIT.ok;
      }
      case 'logout': {
        if (rest.length > 0) throw new UsageError('logout takes no arguments');
        const result = await logout(ctx, warn);
        out(
          { ...result, signed_in: false },
          result.was_signed_in
            ? `Signed out of ${server}${result.revoked ? ' (revoked at the server)' : ''}.\n`
            : `Not signed in to ${server}; nothing to do.\n`,
        );
        return EXIT.ok;
      }
      case 'tools': {
        if (rest.length > 0) throw new UsageError('tools takes no arguments');
        const client = connect(ctx);
        await client.initialize();
        const tools = await client.listTools();
        out(
          { tools },
          tools.map((t) => `${t.name}${t.description ? `  ${t.description.split('\n')[0] ?? ''}` : ''}`).join('\n') + '\n',
        );
        return EXIT.ok;
      }
      case 'call': {
        const [tool, ...extra] = rest;
        if (tool === undefined || tool === '') throw new UsageError('call needs a tool name');
        if (extra.length > 0) throw new UsageError(`call takes one tool name; pass arguments with --args`);
        const args = await toolArguments(values.args, values['args-file'], rawIo);
        const tokens = new TokenSource(ctx);
        const client = connect(ctx, tokens);
        await client.initialize();
        const result = await client.callTool(tool, args);
        if (result.isError === true) {
          let message = resultText(result);
          if (!tokens.scope.split(' ').includes(WRITE_SCOPE) && message.includes(WRITE_SCOPE)) {
            message += `\nThis sign-in is read-only (scope '${tokens.scope}'). To edit, run in a terminal:\n  ${loginCommand(server, true)}`;
          }
          throw new CliError(`${tool} failed: ${message}`);
        }
        out(result, `${resultText(result)}\n`);
        return EXIT.ok;
      }
    }
    return usageError(io, `unknown command '${command}'`);
  } catch (error) {
    if (error instanceof UsageError) return usageError(io, error.message);
    io.stderr(`${CLI_NAME}: ${messageOf(error)}\n`);
    return EXIT.failure;
  }

  function connect(ctx: ConstructorParameters<typeof TokenSource>[0], tokens = new TokenSource(ctx)): McpClient {
    return new McpClient({ endpoint: tokens.endpoints.resource, tokens, fetch: ctx.fetch, clientVersion: version() });
  }
}

async function toolArguments(inline: string | undefined, file: string | undefined, io: Io): Promise<Record<string, unknown>> {
  if (inline !== undefined && file !== undefined) throw new UsageError('use --args or --args-file, not both');
  let text: string | undefined = inline;
  let source = '--args';
  if (file !== undefined) {
    source = file;
    try {
      text = file === '-' ? await (io.readStdin ?? readStdin)() : readFileSync(file, 'utf8');
    } catch (error) {
      throw new UsageError(`cannot read --args-file ${file}: ${messageOf(error)}`);
    }
  }
  if (text === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${source} is not valid JSON: ${messageOf(error)}`);
  }
  if (!isObject(value)) throw new UsageError(`${source} must be a JSON object`);
  return value;
}

function usageError(io: Io, message: string): number {
  io.stderr(`${CLI_NAME}: ${message}\nRun '${CLI_NAME} --help' for usage.\n`);
  return EXIT.usage;
}
