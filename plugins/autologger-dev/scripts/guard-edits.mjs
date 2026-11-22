#!/usr/bin/env node
// PreToolUse guard for AutoLogger repos. Blocks edits that break project rules:
//   - generated Drizzle migrations (apps/server/drizzle/**) — change schema.ts and regenerate
//   - real env files (.env, .env.*, except .env.example) — they hold secrets
// Only acts inside an AutoLogger checkout (a dir with apps/server/src/db/schema.ts above the file).
// Exit 2 blocks the tool call; stderr is shown to Claude as the reason.

import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let filePath;
try {
  const input = JSON.parse(raw);
  filePath = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
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

if (rel.startsWith('apps/server/drizzle/')) {
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

process.exit(0);
