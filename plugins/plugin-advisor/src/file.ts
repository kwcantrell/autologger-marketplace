// file: opens a draft as a GitHub issue with `gh issue create`. A dry run unless confirmed; the draft
// is redaction-checked again first; the body goes to gh on stdin and the title as one argv element,
// with no shell in between.
import { spawnSync } from 'node:child_process';
import { issues, MARKETPLACE_REPO, resolveSignature, UsageError } from './advisor.ts';
import { containsSecret, redact } from './redact.ts';
import { CliError, type Store } from './store.ts';
import type { Env } from './plugins.ts';

export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const GH_TIMEOUT_MS = 60_000;

export interface FileResult {
  signature: string;
  repo: string;
  title: string;
  body: string;
  /** False for a dry run. */
  filed: boolean;
  url?: string;
  /** True for the marketplace repo, which is public. Other repos may be public too. */
  knownPublic: boolean;
}

/** Splits a draft into its `# title` line and the body after it. */
export function splitDraft(text: string): { title: string; body: string } {
  const [first = '', ...rest] = text.split('\n');
  if (!first.startsWith('# ')) throw new CliError('the draft does not start with a "# <title>" line; run suggest again to rewrite it');
  return { title: first.slice(2).trim(), body: rest.join('\n').replace(/^\n+/, '') };
}

/** Line numbers (1-based, in the draft) that still hold secret-looking text. */
export function secretLines(text: string): number[] {
  return text
    .split('\n')
    .map((line, i) => (containsSecret(line) ? i + 1 : 0))
    .filter((n) => n > 0);
}

export function fileIssue(store: Store, wanted: string, options: { repo?: string; confirm: boolean; env: Env }): FileResult {
  const repo = options.repo ?? MARKETPLACE_REPO;
  if (!REPO.test(repo)) throw new UsageError(`--repo must be <owner>/<name>, got ${JSON.stringify(repo)}`);
  const state = store.state();
  const issue = resolveSignature(issues(store.occurrences(), state), wanted);
  const sig = issue.signature;
  const filed = state.issues[sig]?.filed;
  if (filed !== undefined) throw new CliError(`issue ${sig} was already filed as ${filed.url}; not filing it twice`);
  if (state.issues[sig]?.dismissedAt !== undefined) throw new CliError(`issue ${sig} is dismissed; not filing it`);
  const text = store.readDraft(sig);
  if (text === null) throw new CliError(`issue ${sig} has no draft yet; run suggest first`);
  const whole = secretLines(text);
  if (whole.length > 0 || containsSecret(text)) {
    throw new CliError(
      `refusing to file ${sig}: the draft at ${store.draftPath(sig)} still has secret-looking text${whole.length > 0 ? ` on line ${whole.join(', ')}` : ''}; edit it out or dismiss the issue`,
    );
  }
  const { title, body } = splitDraft(text);
  const result: FileResult = { signature: sig, repo, title, body, filed: false, knownPublic: repo === MARKETPLACE_REPO };
  if (!options.confirm) return result;

  const gh = spawnSync('gh', ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-'], {
    input: body,
    encoding: 'utf8',
    env: options.env as NodeJS.ProcessEnv,
    timeout: GH_TIMEOUT_MS,
    shell: false,
  });
  if (gh.error !== undefined) {
    const code = (gh.error as NodeJS.ErrnoException).code;
    throw new CliError(code === 'ENOENT' ? 'gh is not on PATH; install the GitHub CLI and run gh auth login' : `gh could not be run: ${gh.error.message}`);
  }
  if (gh.status !== 0) {
    const reason = redact((gh.stderr ?? '').trim().split('\n')[0] ?? '');
    throw new CliError(`gh issue create exited ${String(gh.status)}${reason === '' ? '' : `: ${reason}`}`);
  }
  const url = /https:\/\/\S+\/issues\/\d+/.exec(gh.stdout ?? '')?.[0];
  if (url === undefined) throw new CliError('gh issue create succeeded but printed no issue URL; check the repo before filing again');
  state.issues[sig] = { ...state.issues[sig], filed: { url, repo, at: new Date().toISOString() } };
  store.saveState(state);
  return { ...result, filed: true, url };
}
