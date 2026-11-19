// The UserPromptSubmit hook: when the prompt or the working directory is about autologger, it adds one
// line of context telling Claude to run plugin-discover's `match` first, at most once per session.
//
// Input (Claude Code's UserPromptSubmit hook input, https://code.claude.com/docs/en/hooks#userpromptsubmit-input):
//   {"session_id","transcript_path","cwd","permission_mode","hook_event_name":"UserPromptSubmit","prompt"}
// Output (exit 0, https://code.claude.com/docs/en/hooks#userpromptsubmit-decision-control):
//   {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<line>"}}
//
// It never blocks (no `decision`, never exit 2), never throws and prints nothing when the prompt is not
// about autologger. It imports only node built-ins and config.ts, to keep its start-up cheap.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type Env, hintedSessions, rememberSession } from './config.ts';

export const HINT =
  'plugin-discover: this looks like autologger work. Before starting, use the plugin-discover skill: run its `match` command with a one-line summary of the task and use the installed plugin or skill it points to.';

/**
 * Prompt keywords, matched case-insensitively. Chosen from what the marketplace plugins cover and
 * their skill descriptions: the product name, autologger-mcp's MCP tool names (`list_events`,
 * `get_session`, ...) and data nouns only in autologger phrasings, autologger-dev's dev-stack
 * vocabulary (make targets, OpenBao, the 8787 port), autologger-specs' gate, and the marketplace's own
 * tooling. Bare generic words ("session", "dashboard", "event", "wiki") are left out on purpose: they
 * would fire on unrelated work in every other project.
 */
export const PROMPT_PATTERNS: readonly RegExp[] = [
  /autologger/i,
  /\b(?:list|get|create|update|delete)_(?:studios?|shows?|sessions?|session_aggregates|events?|topics?|wiki_pages?|dashboards?|transcript_paragraphs|transcript_words)\b/i,
  /\blogged events?\b/i,
  /\bsession (?:transcripts?|aggregates|events|topics)\b/i,
  /\btranscript (?:paragraphs|words)\b/i,
  /\bshow wiki\b/i,
  /\bcustom[ _]dashboards?(?:\b|_)/i,
  /\bdev[ -]stack\b/i,
  /\bmake dev-[a-z]/i,
  /\bdev-(?:up|bao|bao-set|login|mcp-token)\b/i,
  /\bopenbao\b/i,
  /\blocalhost:(?:8787|2\d787)\b/i,
  /\bspecs-with-code\b/i,
  /\bplugin-(?:advisor|builder)\b/i,
];

/** The git remotes that make a checkout autologger work. */
export const REPOS: readonly RegExp[] = [/[/:]kwcantrell\/autologger-2(?:\.git)?\/?$/i, /[/:]kwcantrell\/autologger-marketplace(?:\.git)?\/?$/i];

export function promptMatches(prompt: string): boolean {
  return PROMPT_PATTERNS.some((p) => p.test(prompt));
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The `[remote "origin"]` url in a git config file's text. */
export function originUrl(config: string): string | undefined {
  let inOrigin = false;
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) inOrigin = /^\[remote\s+"origin"\]$/.test(line);
    else if (inOrigin) {
      const m = /^url\s*=\s*(.+)$/.exec(line);
      if (m !== null) return (m[1] ?? '').trim();
    }
  }
  return undefined;
}

/** The repo root and git config path for `cwd`'s work tree (also a linked worktree's `.git` file). */
function gitConfigOf(cwd: string): { root: string; config: string } | null {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git');
    let isDir: boolean | undefined;
    try {
      isDir = statSync(dotGit).isDirectory();
    } catch {
      isDir = undefined;
    }
    if (isDir === true) return { root: dir, config: join(dotGit, 'config') };
    if (isDir === false) {
      const gitdir = /^gitdir:\s*(.+)$/m.exec(read(dotGit) ?? '')?.[1]?.trim();
      if (gitdir === undefined) return null;
      const abs = resolve(dir, gitdir);
      const common = read(join(abs, 'commondir'))?.trim();
      return { root: dir, config: join(common === undefined ? abs : resolve(abs, common), 'config') };
    }
    if (dirname(dir) === dir) return null;
  }
}

/** Is `cwd` inside an autologger-2 or autologger-marketplace checkout? */
export function cwdMatches(cwd: string): boolean {
  const git = gitConfigOf(cwd);
  if (git === null) return false;
  const url = originUrl(read(git.config) ?? '');
  if (url !== undefined && REPOS.some((r) => r.test(url))) return true;
  // A marketplace checkout without that origin (a fork, a local clone) still has its manifest.
  const manifest = join(git.root, '.claude-plugin', 'marketplace.json');
  return existsSync(manifest) && /"name"\s*:\s*"autologger-marketplace"/.test(read(manifest) ?? '');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The hook's stdout for one input: the additionalContext JSON line, or '' to add nothing. Never
 * throws; any problem means no hint.
 */
export function hookOutput(raw: string, env: Env): string {
  try {
    if (!raw.includes('UserPromptSubmit')) return '';
    const input: unknown = JSON.parse(raw);
    if (!isObject(input) || input.hook_event_name !== 'UserPromptSubmit') return '';
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : undefined;
    if (!promptMatches(prompt) && (cwd === undefined || !cwdMatches(cwd))) return '';
    const session = typeof input.session_id === 'string' && input.session_id !== '' ? input.session_id : undefined;
    if (session !== undefined) {
      if (hintedSessions(env).includes(session)) return '';
      // Remember it first: if it cannot be stored, the catch below drops the hint, so a broken
      // config dir never means a hint on every prompt.
      rememberSession(env, session);
    }
    return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: HINT } })}\n`;
  } catch {
    return '';
  }
}
