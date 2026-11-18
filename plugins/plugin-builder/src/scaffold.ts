// new: runs the checkout's own scaffold (scripts/new-plugin.ts, the script behind `npm run new-plugin`),
// so the template and its renaming rules have one source of truth.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CommandError, MARKETPLACE_PATH } from './repo.ts';

export const SCAFFOLD_SCRIPT = 'scripts/new-plugin.ts';

export interface ScaffoldResult {
  /** The scaffold's exit status: 0 created, 1 refused (name taken), 2 bad name or arguments. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Created {
  name: string;
  path: string;
  marketplace: string;
}

/** Runs `node scripts/new-plugin.ts <name> [--description <text>]` in the checkout, without a shell. */
export function runScaffold(root: string, name: string, description: string | undefined, env: NodeJS.ProcessEnv): ScaffoldResult {
  const script = join(root, SCAFFOLD_SCRIPT);
  if (!existsSync(script)) throw new CommandError(`${SCAFFOLD_SCRIPT} not found in ${root}`);
  const args = [script, name];
  if (description !== undefined) args.push('--description', description);
  const r = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' });
  if (r.error) throw new CommandError(`could not run ${SCAFFOLD_SCRIPT}: ${r.error.message}`);
  return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

export function created(name: string): Created {
  return { name, path: `plugins/${name}`, marketplace: MARKETPLACE_PATH };
}
