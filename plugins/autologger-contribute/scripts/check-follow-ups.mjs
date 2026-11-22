#!/usr/bin/env node
// PreToolUse guard (Bash): in AutoLogger repos, `gh pr create` / `gh pr edit` bodies must list
// follow-ups as issue links, so deferred work is tracked instead of buried in PR prose.
// A "## Follow-ups" section passes when it is empty, says "None", or every bullet references an
// issue (#123, owner/repo#123 or an issues URL). Exit 2 blocks the call; stderr is the reason.
// Only acts when the working directory is an AutoLogger checkout or the marketplace repo.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let command = '';
let cwd = process.cwd();
try {
  const input = JSON.parse(raw);
  command = input?.tool_input?.command ?? '';
  cwd = input?.cwd ?? cwd;
} catch {
  process.exit(0);
}
if (!/\bgh\s+pr\s+(create|edit)\b/.test(command)) process.exit(0);

// Scope: only AutoLogger repos.
let remote = '';
try {
  remote = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch {
  process.exit(0);
}
if (!/autologger/i.test(remote)) process.exit(0);

// Find the body: --body/-b "<text>" or --body-file/-F <path>.
function argAfter(flags) {
  const re = new RegExp(`(?:^|\\s)(?:${flags})(?:=|\\s+)("([^"\\\\]|\\\\.)*"|'[^']*'|\\S+)`, 's');
  const m = command.match(re);
  if (!m) return null;
  let v = m[1];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v.replace(/\\"/g, '"').replace(/\\n/g, '\n');
}

let body = argAfter('--body|-b');
const file = argAfter('--body-file|-F');
if (body === null && file !== null) {
  if (file === '-') process.exit(0); // stdin: can't inspect
  const path = isAbsolute(file) ? file : join(cwd, file);
  if (!existsSync(path)) process.exit(0);
  body = readFileSync(path, 'utf8');
}
if (body === null) process.exit(0);
// A heredoc/command substitution body can't be inspected reliably; let it through.
if (/\$\(|<</.test(body)) process.exit(0);

// The section runs from its heading to the next "## " heading or the generated-by footer.
const all = body.split('\n');
const start = all.findIndex((l) => /^##\s*Follow-?ups\s*$/i.test(l.trim()));
if (start === -1) process.exit(0);
const section = [];
for (const l of all.slice(start + 1)) {
  if (/^##\s/.test(l) || l.startsWith('🤖')) break;
  section.push(l);
}

// Group into items: a top-level bullet (or an unindented paragraph line) starts an item; indented
// lines continue it. An item is tracked when any of its lines references an issue.
const issueRef = /(^|[\s(])(#\d+|[\w.-]+\/[\w.-]+#\d+)\b|\/issues\/\d+/;
const items = [];
for (const l of section) {
  if (!l.trim() || l.trim().startsWith('<!--')) continue;
  if (/^\S/.test(l) || items.length === 0) items.push([l.trim()]);
  else items[items.length - 1].push(l.trim());
}
const untracked = items
  .filter((it) => !(it.length === 1 && /^[-*]?\s*_?none\.?_?$/i.test(it[0])))
  .filter((it) => !it.some((l) => issueRef.test(l)))
  .map((it) => it[0]);
if (untracked.length === 0) process.exit(0);

console.error(
  'The PR body lists follow-ups that are not tracked as issues:\n' +
    untracked.map((l) => `  ${l.slice(0, 120)}`).join('\n') +
    '\nFile each one first (`gh issue create -R kwcantrell/autologger -l follow-up …`, or the ' +
    'marketplace repo for plugin/skill items; search for duplicates first — see the file-issue ' +
    'skill), then list them under "## Follow-ups" as `- #123 short title` (or write "None").',
);
process.exit(2);
