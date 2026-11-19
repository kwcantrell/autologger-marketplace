// connect: what is left for the user to connect Claude to the dev server's MCP endpoint. It prints
// commands and never runs them: trusting the CA needs a Claude Code restart, and every way of
// connecting (claude mcp add, autologger-mcp login, make dev-mcp-token piped into autologger-mcp
// import-tokens) is the user's to run.
import { accessSync, constants, statSync } from 'node:fs';
import { exportLine } from './ca.ts';
import { type Env, shellQuote } from './http.ts';
import { cliCommand, mcpServerName, slotPrefix } from './slot.ts';
import { defaultCaFile } from './stack.ts';

export interface ConnectReport {
  server: string;
  /** The dev slot (0 is the default stack). */
  slot: number;
  mcp_url: string;
  /** Whether NODE_EXTRA_CA_CERTS is set to a readable file in this environment. */
  node_extra_ca_certs_set: boolean;
  /** The CA file the export line names (the one `ca` writes by default). */
  ca_file: string;
  ca_file_exists: boolean;
  /** The export to add where Claude Code starts (then restart it); null when not needed. */
  node_extra_ca_certs_export: string | null;
  /** Registers the MCP server as autologger-dev, or autologger-dev-N for slot N. */
  claude_mcp_add: string;
  autologger_mcp_login: string;
  /**
   * Connects without Google sign-in: autologger's dev-only make dev-mcp-token (run in the checkout,
   * DEV_SLOT=N for slot N) piped into autologger-mcp import-tokens for this server.
   */
  dev_mcp_token: string;
  steps: string[];
}

/**
 * The line that mints MCP tokens for a dev-stack user and imports them into autologger-mcp, with no
 * Google OAuth client: autologger's `make dev-mcp-token` (dev only; `DEV_SLOT=N` for slot N) piped
 * into `autologger-mcp import-tokens`, so the tokens never reach the screen.
 */
export function devMcpTokenCommand(server: string, slot: number): string {
  return `${slotPrefix(slot)}make dev-mcp-token EMAIL=<address> | autologger-mcp import-tokens --server ${shellQuote(server)}`;
}

function readableFile(path: string | undefined): boolean {
  if (path === undefined || path === '') return false;
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function connect(env: Env, server: string, slot = 0): ConnectReport {
  const mcpUrl = `${server}/mcp`;
  const needsCa = server.startsWith('https:');
  const caSet = readableFile(env.NODE_EXTRA_CA_CERTS);
  const caFile = defaultCaFile(env);
  const caExists = readableFile(caFile);
  const exportCmd = needsCa && !caSet ? exportLine(caFile) : null;
  const name = mcpServerName(slot);
  const claudeAdd = `claude mcp add --transport http ${name} ${shellQuote(mcpUrl)}`;
  const login = `autologger-mcp login --server ${shellQuote(server)}`;
  const devToken = devMcpTokenCommand(server, slot);

  const steps: string[] = [];
  if (exportCmd !== null) {
    if (!caExists) steps.push(`Write the dev CA first: ${cliCommand('ca', slot)} (it writes ${caFile}).`);
    steps.push(`Trust the dev CA: put \`${exportCmd}\` in the environment Claude Code starts in (e.g. your shell profile), then restart Claude Code.`);
  }
  steps.push(`Register the MCP server in Claude Code: \`${claudeAdd}\`, then sign in from /mcp in Claude Code.`);
  steps.push(
    `Or use the autologger-mcp plugin instead: \`${login}\` (run it yourself in a terminal; it opens a browser to sign in with Google).`,
  );
  steps.push(
    `Or, with no Google sign-in (the stack's Google client may stay a placeholder), use the autologger-mcp plugin with a dev token: in the autologger-2 checkout run \`${devToken}\` with your email (run it yourself; it creates that dev-stack account and an MCP grant, and pipes the tokens into autologger-mcp without showing them).`,
  );
  return {
    server,
    slot,
    mcp_url: mcpUrl,
    node_extra_ca_certs_set: caSet,
    ca_file: caFile,
    ca_file_exists: caExists,
    node_extra_ca_certs_export: exportCmd,
    claude_mcp_add: claudeAdd,
    autologger_mcp_login: login,
    dev_mcp_token: devToken,
    steps,
  };
}

export function formatConnect(r: ConnectReport): string {
  return `To connect Claude to ${r.mcp_url} (run these yourself):\n${r.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n`;
}
