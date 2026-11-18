// The autologger-marketplace checkout the CLI works on.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const MARKETPLACE_NAME = 'autologger-marketplace';
export const MARKETPLACE_PATH = '.claude-plugin/marketplace.json';
/** The kebab-case plugin name rule of scripts/new-plugin.ts. */
export const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Exit 2: the CLI was not pointed at a marketplace checkout. */
export class NotACheckoutError extends Error {}
/** Exit 1: the command could not do its job. */
export class CommandError extends Error {}

export interface MarketplaceEntry {
  name?: unknown;
  source?: unknown;
}

export interface Marketplace {
  name?: unknown;
  plugins?: unknown;
}

function readMarketplace(root: string): Marketplace | null {
  const path = join(root, MARKETPLACE_PATH);
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof value === 'object' && value !== null ? (value as Marketplace) : null;
  } catch {
    return null;
  }
}

/** The plugin entries of a checkout's marketplace.json (entries that are not objects are dropped). */
export function marketplaceEntries(root: string): MarketplaceEntry[] {
  const plugins = readMarketplace(root)?.plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.filter((p): p is MarketplaceEntry => typeof p === 'object' && p !== null);
}

/**
 * The nearest directory at or above `repoOption` (relative to cwd) or cwd whose
 * .claude-plugin/marketplace.json is named autologger-marketplace.
 */
export function findCheckout(cwd: string, repoOption?: string): string {
  const start = repoOption === undefined ? cwd : resolve(cwd, repoOption);
  if (!existsSync(start) || !statSync(start).isDirectory()) {
    throw new NotACheckoutError(`--repo ${repoOption}: no such directory`);
  }
  let dir = realpathSync(start);
  for (;;) {
    if (readMarketplace(dir)?.name === MARKETPLACE_NAME) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const hint = repoOption === undefined ? '; run it inside the checkout or pass --repo <path>' : '';
  throw new NotACheckoutError(
    `not inside an ${MARKETPLACE_NAME} checkout: no ${MARKETPLACE_PATH} named '${MARKETPLACE_NAME}' at or above ${start}${hint}`,
  );
}
