// The command lines this CLI hands the user to run in a terminal: the full npx form (the bare
// `autologger-mcp` is not on PATH for a plugin install), and the dev-token pipeline that reuses the
// stored client registration with CLIENT_ID.
import { fileURLToPath } from 'node:url';
import { isLoopback } from './http.ts';
import { registrationUsable } from './oauth.ts';
import type { Credentials } from './store.ts';

export const CLI_NAME = 'autologger-mcp';

/** The plugin's own folder (where package.json is). */
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

/** A client id as autologger issues them; anything else is never put in a command line. */
const CLIENT_ID_SHAPE = /^[A-Za-z0-9_.~-]{1,200}$/;

/**
 * The stored client for the server, when `make dev-mcp-token CLIENT_ID=<id>` can reuse it instead of
 * registering another: one is stored, was registered at the server's current registration endpoint
 * (`registrationEndpoint`, else the one stored from the last discovery), and is not old enough for
 * the server to have swept it (registrationUsable, the rule login uses).
 */
export function reusableClientId(creds: Credentials, now: number, registrationEndpoint = creds.endpoints?.registration_endpoint): string | undefined {
  const client = creds.client;
  if (client === undefined || registrationEndpoint === undefined) return undefined;
  if (!registrationUsable(client, registrationEndpoint, now)) return undefined;
  return CLIENT_ID_SHAPE.test(client.client_id) ? client.client_id : undefined;
}

/**
 * The line a user runs in their autologger-2 checkout to sign in without a browser: autologger's
 * dev-only `make dev-mcp-token` piped into this CLI's `import-tokens` for the server, so the tokens
 * never reach the screen. With `clientId`, make reuses that client rather than registering one.
 */
export function importTokensCommand(server: string, clientId?: string): string {
  const reuse = clientId !== undefined ? ` CLIENT_ID=${shellQuote(clientId)}` : '';
  return `make dev-mcp-token EMAIL=<address>${reuse} | ${terminalCommand(`import-tokens --server ${shellQuote(server)}`)}`;
}

/**
 * The second way to sign in, for a loopback server (a local dev stack): the dev-token line. Empty
 * for any other server, where `make dev-mcp-token` does not apply.
 */
export function devTokenHint(server: string, clientId?: string): string {
  if (!isLoopback(server)) return '';
  return `Or, on a local dev stack without Google sign-in, run in the autologger-2 checkout (your email for <address>; DEV_SLOT=N in front for dev slot N):\n  ${importTokensCommand(server, clientId)}`;
}

/**
 * The exact `index build` command for a server and scope (`['--show', '<id>']`, `['--all']`, ...),
 * with any further arguments (`--max-reads 400`, `--json`). Every part is shell-quoted.
 */
export function indexBuildCommand(server: string, scopeArgs: readonly string[], more: readonly string[] = []): string {
  return terminalCommand(['index', 'build', '--server', server, ...scopeArgs, ...more].map(shellQuote).join(' '));
}
