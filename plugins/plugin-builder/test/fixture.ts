// Throwaway autologger-marketplace checkouts in a temp dir: the parts of the real repo that
// plugin-builder reads (the template, the scaffold script, the marketplace manifest) and a root
// package.json whose typecheck script is a stub. Tests never write to the real repo.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOnPath } from '../src/verify.ts';

/** The real checkout this plugin lives in (read only). */
export const REPO = fileURLToPath(new URL('../../..', import.meta.url));

export interface Fixture {
  root: string;
  /** A directory holding a fake `claude` that logs its arguments to `claudeLog` and exits 0. */
  fakeBin: string;
  claudeLog: string;
  cleanup: () => void;
}

export function fixture(options: { typecheckExit?: number } = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'plugin-builder-fixture-'));
  const root = join(base, 'checkout');
  cpSync(join(REPO, 'templates', 'plugin'), join(root, 'templates', 'plugin'), {
    recursive: true,
    filter: (path) => !path.includes('node_modules'),
  });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(join(REPO, 'scripts', 'new-plugin.ts'), join(root, 'scripts', 'new-plugin.ts'));
  mkdirSync(join(root, 'plugins'));
  mkdirSync(join(root, '.claude-plugin'));
  const manifest = JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'));
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), `${JSON.stringify({ ...manifest, plugins: [] }, null, 2)}\n`);
  const exit = options.typecheckExit ?? 0;
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, type: 'module', scripts: { typecheck: `node -e "process.exit(${exit})"` } }, null, 2)}\n`,
  );

  const fakeBin = join(base, 'bin');
  const claudeLog = join(base, 'claude.log');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'claude'), `#!/bin/sh\necho "$@" >> '${claudeLog}'\nexit 0\n`);
  chmodSync(join(fakeBin, 'claude'), 0o755);
  return { root, fakeBin, claudeLog, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Adds a plugin to the fixture with the fixture's own scaffold (scripts/new-plugin.ts). */
export function scaffoldInto(f: Fixture, name: string): string {
  const r = spawnSync(process.execPath, [join(f.root, 'scripts', 'new-plugin.ts'), name], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`scaffold failed: ${r.stderr}`);
  return join(f.root, 'plugins', name);
}

/** The environment without npm's run-script variables and without node --test's child marker. */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_') && key !== 'NODE_TEST_CONTEXT'),
  );
  return env;
}

/** `env` with the fake `claude` first on the PATH. */
export function withFakeClaude(env: NodeJS.ProcessEnv, f: Fixture): NodeJS.ProcessEnv {
  return { ...env, PATH: `${f.fakeBin}${delimiter}${env.PATH ?? ''}` };
}

/** `env` with every PATH directory that has a `claude` removed. */
export function withoutClaude(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dirs = (env.PATH ?? '').split(delimiter).filter((dir) => dir !== '' && findOnPath('claude', { PATH: dir }) === null);
  return { ...env, PATH: dirs.join(delimiter) };
}
