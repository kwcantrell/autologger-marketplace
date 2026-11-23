#!/usr/bin/env node
// PreToolUse guard for AutoLogger repos. Blocks edits that break project rules:
//   - generated Drizzle migrations (apps/server/drizzle/**) — change schema.ts and regenerate
//   - real env files (.env, .env.*, except .env.example) — they hold secrets
//   - edits by the code-editing agents (react-expert, ui-designer) while the checkout is on its
//     default branch — they must `git switch -c <branch>` first
// Only acts inside an AutoLogger checkout (a dir with apps/server/src/db/schema.ts above the file).
// Exit 2 blocks the tool call; stderr is shown to Claude as the reason.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let filePath;
let agentType;
try {
  const input = JSON.parse(raw);
  filePath = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
  agentType = input?.agent_type;
} catch {
  process.exit(0);
}
if (!filePath) process.exit(0);

function findRepoRoot(start) {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'apps', 'server', 'src', 'db', 'schema.ts'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const root = findRepoRoot(dirname(filePath));
if (!root) process.exit(0);
const rel = relative(root, filePath).split(sep).join('/');
const name = basename(filePath);

// drizzle-kit `generate --custom` creates a migration whose SQL is written by hand (data
// migrations). Allow editing such a file — a top-level `.sql` that already starts with drizzle's
// custom placeholder — but never meta/** or generated migrations.
const CUSTOM_MARK = '-- Custom SQL migration file';
function isCustomMigration() {
  if (!/^apps\/server\/drizzle\/[^/]+\.sql$/.test(rel) || !existsSync(filePath)) return false;
  try {
    return readFileSync(filePath, 'utf8').trimStart().startsWith(CUSTOM_MARK);
  } catch {
    return false;
  }
}

if (rel.startsWith('apps/server/drizzle/') && !isCustomMigration()) {
  console.error(
    `${rel} is a generated migration. Edit apps/server/src/db/schema.ts and run ` +
      '`npx drizzle-kit generate --name <change>` in apps/server instead (see the schema-change skill).',
  );
  process.exit(2);
}

if ((name === '.env' || name.startsWith('.env.')) && name !== '.env.example') {
  console.error(
    `${rel} holds local secrets and is not edited by agents. Tell the user which variable to set ` +
      '(document new variables in .env.example).',
  );
  process.exit(2);
}

// Agents that edit code in the user's checkout must work on a branch, never the default branch.
// agent_type is the plugin-qualified name ("autologger-dev:react-expert"); accept the bare name too.
const BRANCHING_AGENTS = new Set(['react-expert', 'ui-designer']);
const [agentPlugin, agentName] =
  typeof agentType === 'string' && agentType.includes(':')
    ? agentType.split(':', 2)
    : [undefined, agentType];
if (BRANCHING_AGENTS.has(agentName) && (agentPlugin === undefined || agentPlugin === 'autologger-dev')) {
  const git = (...args) => {
    try {
      return execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return '';
    }
  };
  const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
  const originHead = git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
  const defaults = new Set(originHead ? [originHead.replace(/^origin\//, '')] : ['main', 'master']);
  if (branch && defaults.has(branch)) {
    console.error(
      `This checkout is on its default branch (${branch}). Before editing, create a branch with ` +
        '`git switch -c <prefix>/<short-topic>` (e.g. react/session-perf, design/<screen>); it keeps ' +
        'any uncommitted changes. Mention the branch in your report.',
    );
    process.exit(2);
  }
}

process.exit(0);
