// connect: what is left for the user to connect Claude to the dev server's MCP endpoint. It prints
// commands and never runs them: trusting the CA needs a Claude Code restart, and both ways of
// connecting (claude mcp add, autologger-mcp login) are the user's to run.
import { accessSync, constants, statSync } from 'node:fs';
import { exportLine } from './ca.ts';
import { type Env, shellQuote } from './http.ts';
import { cliCommand, mcpServerName } from './slot.ts';
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
  steps: string[];
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

  const steps: string[] = [];
  if (exportCmd !== null) {
    if (!caExists) steps.push(`Write the dev CA first: ${cliCommand('ca', slot)} (it writes ${caFile}).`);
    steps.push(`Trust the dev CA: put \`${exportCmd}\` in the environment Claude Code starts in (e.g. your shell profile), then restart Claude Code.`);
  }
  steps.push(`Register the MCP server in Claude Code: \`${claudeAdd}\`, then sign in from /mcp in Claude Code.`);
  steps.push(
    `Or use the autologger-mcp plugin instead: \`${login}\` (run it yourself in a terminal; it opens a browser to sign in with Google).`,
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
    steps,
  };
}

export function formatConnect(r: ConnectReport): string {
  return `To connect Claude to ${r.mcp_url} (run these yourself):\n${r.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n`;
}
