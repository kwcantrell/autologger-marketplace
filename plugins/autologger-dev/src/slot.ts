// Dev slots (autologger ADR 0038, `DEV_SLOT=0-9`): autologger can run up to ten dev stacks side by
// side, one per worktree. Every per-slot value here follows autologger's own rule, built from the one
// digit N alone (docker/compose.dev-slot.yaml, docker/compose.dev-slot-https.yaml):
//   slot 0 (DEV_SLOT unset, empty or 0)  project autologger-dev,   app https://localhost:${DEV_PORT:-8787}
//   slot N (1-9)                         project autologger-dev-N, app https://localhost:2N787
// Slot 0's DEV_PORT is a dev compose key from the local OpenBao secret, i.e. overrides.env
// (compose-run.mjs COMPOSE_KEYS.dev; docker/compose.dev-https.yaml); slot N never uses it
// (docker/compose.dev-slot.yaml).
// Shared by every slot, so not per-slot here: the local OpenBao (its container, state directory and
// overrides) and the dev CA (one root, slot 0's CA volume; `make dev-ca` on any slot prints it).
import { UsageError } from './errors.ts';
import { DEFAULT_SERVER } from './http.ts';
import type { OverridesRead } from './stack.ts';

export const CLI = 'autologger-dev';

/** `--slot`: exactly one digit 0-9 (as autologger's compose-run.mjs accepts DEV_SLOT), else a usage error. */
export function parseSlot(option: string | undefined): number {
  if (option === undefined) return 0;
  if (!/^[0-9]$/.test(option)) throw new UsageError(`--slot must be one digit 0-9 (0 is the default dev stack), not '${option}'`);
  return Number(option);
}

export const DEV_PORT_KEY = 'DEV_PORT';

/**
 * Slot 0's DEV_PORT from overrides.env: 'set' with the port (the value verbatim is digits only and
 * 1-65535), 'not set' (no line, an empty value, or overrides.env absent or unreadable) or 'invalid'
 * (anything else: non-numeric, quoted, padded, out of range). Only a valid port is ever kept.
 */
export type DevPort = { state: 'set'; port: number } | { state: 'not set' } | { state: 'invalid' };

export function devPort(overrides: OverridesRead): DevPort {
  const value = overrides.state === 'read' ? overrides.values.get(DEV_PORT_KEY) : undefined;
  if (value === undefined || value === '') return { state: 'not set' };
  if (!/^[0-9]{1,5}$/.test(value)) return { state: 'invalid' };
  const port = Number(value);
  return port >= 1 && port <= 65535 ? { state: 'set', port } : { state: 'invalid' };
}

/**
 * The slot's app origin in HTTPS mode: slot 0's is https://localhost:<DEV_PORT> when overrides.env
 * sets a valid DEV_PORT, else https://localhost:8787; slot N's is always https://localhost:2N787.
 */
export function slotServer(slot: number, port: DevPort = { state: 'not set' }): string {
  if (slot !== 0) return `https://localhost:2${slot}787`;
  // As an origin, so it compares equal to a resolved --server (443 drops out, as URL does).
  return port.state === 'set' ? new URL(`https://localhost:${port.port}`).origin : DEFAULT_SERVER;
}

/**
 * What make gets for the slot: nothing for slot 0 (autologger's slot-0 rule: unset is slot 0, byte
 * for byte today's stack), `DEV_SLOT=N` for slot N. The caller's own DEV_SLOT is always stripped
 * (childEnv), so this is the only DEV_SLOT make ever sees.
 */
export function slotEnv(slot: number): Record<string, string> {
  return slot === 0 ? {} : { DEV_SLOT: String(slot) };
}

/** `DEV_SLOT=N ` to put before a make command line for slot N; empty for slot 0. */
export function slotPrefix(slot: number): string {
  return slot === 0 ? '' : `DEV_SLOT=${slot} `;
}

/** The MCP server name for `claude mcp add`: autologger-dev for slot 0, autologger-dev-N for slot N. */
export function mcpServerName(slot: number): string {
  return slot === 0 ? CLI : `${CLI}-${slot}`;
}

/** The Google OAuth redirect URI the slot's app uses (each slot needs its own on the client, ADR 0038). */
export function googleRedirect(slot: number, port?: DevPort): string {
  return `${slotServer(slot, port)}/auth/google/callback`;
}

/** An autologger-dev command line for the slot, e.g. `autologger-dev up --slot 2` (no flag for slot 0). */
export function cliCommand(command: string, slot: number): string {
  return slot === 0 ? `${CLI} ${command}` : `${CLI} ${command} --slot ${slot}`;
}
