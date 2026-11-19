// desktop doctor: whether OpenReel Desktop's MCP shim is registered in Claude Code, read from
// `claude mcp list`. It prints the registration line from OpenReel's docs/MCP-SETUP.md and never
// registers anything itself.
import type { Env } from './media.ts';
import type { Runner } from './runner.ts';

export const MCP_SETUP_DOC = 'https://github.com/Augani/openreel-video/blob/main/docs/MCP-SETUP.md';
/** The line from OpenReel's docs/MCP-SETUP.md ("Claude Code"); the user puts in their shim path. */
export const REGISTRATION_LINE = 'claude mcp add openreel -- node /path/to/mcp-shim/index.js';
export const SHIM_PATHS = {
  macos: '/Applications/OpenReel.app/Contents/Resources/app.asar.unpacked/dist/mcp-shim/index.js',
  windows_linux: '<install dir>/resources/app.asar.unpacked/dist/mcp-shim/index.js',
  development_build: 'apps/desktop/dist/mcp-shim/index.js',
};
export const DESKTOP_TOOLS = ['create_project', 'import_media_from_path', 'import_timeline_xml', 'export_video'];

export interface DesktopReport {
  claude: 'ok' | 'missing' | 'failed';
  registered: boolean;
  /** The `claude mcp list` line for the server, when registered. */
  entry: string | null;
  /** Whether that line says the server is connected (OpenReel Desktop running). */
  connected: boolean | null;
  registration_line: string;
  shim_paths: typeof SHIM_PATHS;
  doc: string;
  tools: string[];
  next: string;
}

/** The `claude mcp list` line of an MCP server named openreel (or whose command runs the mcp-shim). */
export function findOpenreel(listing: string): string | null {
  for (const raw of listing.split('\n')) {
    const line = raw.trim();
    if (/^openreel\s*:/i.test(line) || /mcp-shim[\\/]index\.js/.test(line)) return line;
  }
  return null;
}

export async function desktopDoctor(env: Env, runner: Runner): Promise<DesktopReport> {
  const r = await runner('claude', ['mcp', 'list'], { env, timeoutMs: 60_000 });
  const claude = r.error === 'ENOENT' ? 'missing' : r.code === 0 ? 'ok' : 'failed';
  const entry = claude === 'ok' ? findOpenreel(r.stdout) : null;
  const connected = entry === null ? null : /connected/i.test(entry) && !/(failed|not connected|disconnected)/i.test(entry);
  const next =
    claude === 'missing'
      ? 'the claude CLI is not on PATH, so registration cannot be checked; run this where Claude Code is installed'
      : claude === 'failed'
        ? `claude mcp list failed (${r.error ?? `exit ${r.code}`}); run it yourself to see why`
        : entry === null
          ? `OpenReel Desktop's MCP server is not registered; the user installs OpenReel Desktop, copies the line from its Settings > MCP (or registration_line with their shim path) into a terminal, then restarts Claude Code`
          : connected
            ? 'registered and connected: the OpenReel tools are available'
            : 'registered but not connected: start OpenReel Desktop (its shim needs the app running), then run this again';
  return { claude, registered: entry !== null, entry, connected, registration_line: REGISTRATION_LINE, shim_paths: SHIM_PATHS, doc: MCP_SETUP_DOC, tools: DESKTOP_TOOLS, next };
}
