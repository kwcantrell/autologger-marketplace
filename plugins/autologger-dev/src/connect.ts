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
   * Connects without Google sign-in: where to get autologger-mcp's import_tokens_command for this
   * server (make dev-mcp-token piped into import-tokens) and how to run it (DEV_SLOT=N for slot N).
   */
  dev_mcp_token: string;
  steps: string[];
}

/**
 * How to connect without a Google OAuth client: autologger's dev-only `make dev-mcp-token` piped into
 * autologger-mcp's `import-tokens`, so the tokens never reach the screen. The plugins share no code
 * and autologger-dev cannot know where autologger-mcp is installed, so this points at the whole line
 * autologger-mcp prints itself as `import_tokens_command` (its full npx form, reusing a stored client
 * with CLIENT_ID=), rather than a bare `autologger-mcp`, which is not on PATH for a plugin install.
 */
export function devMcpTokenCommand(server: string, slot: number): string {
  const s = shellQuote(server);
  return `get import_tokens_command from autologger-mcp's \`status --server ${s} --json\` (the autologger-mcp sign-in skill runs it; it is the whole make dev-mcp-token line, piped into autologger-mcp's import-tokens in its full npx form) and run that line in the autologger-2 checkout with the user's email for <address>${
    slot === 0 ? '' : ` and \`${slotPrefix(slot)}\` in front of make`
  }`;
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
    `Or, with no Google sign-in (the stack's Google client may stay a placeholder), use the autologger-mcp plugin with a dev token: ${devToken} (run it yourself; it creates that dev-stack account and an MCP grant, and pipes the tokens into autologger-mcp without showing them).`,
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
