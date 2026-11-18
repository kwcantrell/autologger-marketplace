// Usage: npm run new-plugin -- <kebab-case-name> [--description "<text>"]
// Copies templates/plugin to plugins/<name>/, renames the template's identifiers (plugin name, skill
// name, CLI bin name: all the token "plugin-template") and adds the plugin to marketplace.json.
// Exit codes: 0 created, 1 refused (name taken or filesystem error), 2 usage error (bad arguments or name).
import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const TEMPLATE_TOKEN = 'plugin-template';
export const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MARKETPLACE = join('.claude-plugin', 'marketplace.json');

export class ScaffoldError extends Error {
  readonly exitCode: 1 | 2;
  constructor(message: string, exitCode: 1 | 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

interface Marketplace {
  plugins: { name: string; source: string; description?: string }[];
}

export function validateName(name: string): void {
  if (!NAME_PATTERN.test(name) || name.length > MAX_NAME_LENGTH) {
    throw new ScaffoldError(
      `invalid plugin name '${name}': use kebab-case (lowercase letters and digits separated by single hyphens, starting with a letter, at most ${MAX_NAME_LENGTH} characters)`,
      2,
    );
  }
  if (name === TEMPLATE_TOKEN) throw new ScaffoldError(`'${name}' is the template's own name`, 2);
}

export function scaffold(root: string, name: string, description?: string): string {
  validateName(name);
  const target = join(root, 'plugins', name);
  const marketplacePath = join(root, MARKETPLACE);
  const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8')) as Marketplace;
  if (existsSync(target)) throw new ScaffoldError(`plugins/${name} already exists`, 1);
  if (marketplace.plugins.some((p) => p.name === name)) {
    throw new ScaffoldError(`marketplace.json already lists a plugin named '${name}'`, 1);
  }

  const summary = description ?? `${name}: TODO describe what this plugin does.`;
  try {
    cpSync(join(root, 'templates', 'plugin'), target, {
      recursive: true,
      filter: (path) => basename(path) !== 'node_modules',
    });
    renameTree(target, name);
    const manifestPath = join(target, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.description = summary;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }

  marketplace.plugins.push({ name, source: `./plugins/${name}`, description: summary });
  writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
  return target;
}

/** Replaces the template token in every file's contents and in every file and directory name. */
function renameTree(dir: string, name: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    let path = join(dir, entry.name);
    if (entry.name.includes(TEMPLATE_TOKEN)) {
      const renamed = join(dir, entry.name.replaceAll(TEMPLATE_TOKEN, name));
      renameSync(path, renamed);
      path = renamed;
    }
    if (entry.isDirectory()) {
      renameTree(path, name);
    } else if (entry.isFile()) {
      const text = readFileSync(path, 'utf8');
      if (text.includes(TEMPLATE_TOKEN)) writeFileSync(path, text.replaceAll(TEMPLATE_TOKEN, name));
    }
  }
}

function main(argv: string[]): number {
  let name: string | undefined;
  let description: string | undefined;
  let root = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { description: { type: 'string' }, root: { type: 'string' } },
    });
    if (positionals.length !== 1) throw new ScaffoldError('expected exactly one plugin name', 2);
    name = positionals[0];
    description = values.description;
    if (values.root !== undefined) root = values.root;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`new-plugin: ${message}\nUsage: npm run new-plugin -- <kebab-case-name> [--description "<text>"]\n`);
    return 2;
  }
  try {
    const target = scaffold(root, name ?? '', description);
    process.stdout.write(`Created ${target} and added '${name}' to ${MARKETPLACE}.\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`new-plugin: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof ScaffoldError ? error.exitCode : 1;
  }
}

// Run main() only when executed directly (tests import this module). --root is for tests.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
