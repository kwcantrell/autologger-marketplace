// reset: removes the slot's folder (profile, NSS database, launcher) and nothing else, after
// checking that it is a real directory directly inside this plugin's own folder.
import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { CliError } from './errors.ts';
import type { Runner } from './runner.ts';
import { type Env, sessionName, slotPaths } from './slot.ts';

export interface ResetContext {
  env: Env;
  runner: Runner;
  slot: number;
}

export interface ResetReport {
  slot: number;
  dir: string;
  removed: boolean;
}

/** Why `dir` may not be removed as the slot folder inside `base`, or null when it may. */
export function removalRefusal(base: string, dir: string): string | null {
  const baseStat = lstatSync(base);
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) return `${base} is not a real directory`;
  const dirStat = lstatSync(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return `${dir} is not a real directory`;
  const rel = relative(realpathSync(base), realpathSync(dir));
  if (rel === '' || rel.startsWith('..') || rel.includes(sep) || !/^slot-[0-9]$/.test(rel)) return `${dir} is not a slot folder inside ${base}`;
  return null;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export async function reset(ctx: ResetContext): Promise<ResetReport> {
  const paths = slotPaths(ctx.env, ctx.slot);
  if (!exists(paths.dir)) return { slot: ctx.slot, dir: paths.dir, removed: false };
  const refusal = removalRefusal(paths.base, paths.dir);
  if (refusal !== null) throw new CliError(`refusing to remove ${paths.dir}: ${refusal}. Nothing was removed`);
  // A browser still running on the profile would write it again: close the slot's session first.
  await ctx.runner('agent-browser', ['--session', sessionName(ctx.slot), 'close'], { env: ctx.env, timeoutMs: 30_000 });
  rmSync(paths.dir, { recursive: true, force: true });
  return { slot: ctx.slot, dir: paths.dir, removed: true };
}

export function formatReset(report: ResetReport): string {
  return report.removed ? `Removed dev slot ${report.slot}'s browser profile, NSS database and launcher (${report.dir}).\n` : `Nothing to remove: ${report.dir} does not exist.\n`;
}
