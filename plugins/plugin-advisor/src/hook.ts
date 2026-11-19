// The PostToolUseFailure hook on Bash: records a `cli-failure` occurrence when a marketplace plugin's
// CLI exits non-zero. Claude Code fires PostToolUse only for tool calls that succeed; a Bash command
// that exits non-zero fires PostToolUseFailure, whose input carries the command in
// `tool_input.command` and an `error` string whose first line is `Exit code N`, followed by the
// command's output (stdout and stderr interleaved). See https://code.claude.com/docs/en/hooks.
//
// It never prints, never exits non-zero and never throws: any problem means nothing is recorded. It
// keeps only the plugin, the subcommand, the exit code and the redacted first line of the CLI's own
// error message; never the command line or the command's stdout.
import { record } from './advisor.ts';
import { marketplacePlugins, type Env } from './plugins.ts';
import { cap, oneLine, redact, SUMMARY_MAX } from './redact.ts';
import { Store } from './store.ts';
import { quickReject } from './hook-filter.ts';

export { quickReject };

export interface CliCall {
  /** The bin as written in the command. */
  bin: string;
  plugin: string;
  subcommand?: string;
}

export interface CliFailure extends CliCall {
  exitCode: number;
  /** The CLI's own error line (`<bin>: ...`) or npm's, redacted; undefined when there is none. */
  message?: string;
}

const SUBCOMMAND = /^[a-z][a-z0-9-]{0,39}$/;

function subcommandOf(rest: string): string | undefined {
  const next = rest.trim().split(/\s+/, 1)[0] ?? '';
  const word = next.replace(/^["']|["']$/g, '');
  return SUBCOMMAND.test(word) ? word : undefined;
}

/**
 * The marketplace CLI calls in a Bash command: `npx ... -- <bin> <command>` and
 * `node .../plugins/<plugin>/src/cli.ts <command>` (also `.../<plugin>/<version>/src/cli.ts`, the
 * plugin cache layout). `bins` maps bin names to plugin names; `plugins` lists plugin folders.
 */
export function cliCalls(command: string, bins: ReadonlyMap<string, string>, plugins: readonly string[]): CliCall[] {
  const out: CliCall[] = [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const npx = /(?:^|[\s(])npx\s(?:.*?\s)?--\s+["']?([a-z][a-z0-9-]*)["']?(\s.*)?$/.exec(segment);
    if (npx !== null) {
      const bin = npx[1] ?? '';
      const plugin = bins.get(bin);
      if (plugin !== undefined) {
        const sub = subcommandOf(npx[2] ?? '');
        out.push({ bin, plugin, ...(sub === undefined ? {} : { subcommand: sub }) });
      }
      continue;
    }
    const node = /(?:^|[\s(])node\s+(?:.*?\s)?["']?(\S*?)\/src\/cli\.ts["']?(\s.*)?$/.exec(segment);
    if (node !== null) {
      const parts = (node[1] ?? '').split('/').filter((p) => p !== '');
      let name = parts[parts.length - 1] ?? '';
      if (/^\d/.test(name)) name = parts[parts.length - 2] ?? '';
      if (plugins.includes(name)) {
        const sub = subcommandOf(node[2] ?? '');
        out.push({ bin: name, plugin: name, ...(sub === undefined ? {} : { subcommand: sub }) });
      }
    }
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The failure described by one hook input, or null when it is not a non-zero exit of a marketplace
 * CLI. When one command runs several marketplace CLIs, the last one is taken (the exit status of a
 * `;`-separated or piped command is the last one's).
 */
export function failureOf(input: unknown, bins: ReadonlyMap<string, string>, plugins: readonly string[]): CliFailure | null {
  if (!isObject(input) || input.hook_event_name !== 'PostToolUseFailure' || input.tool_name !== 'Bash') return null;
  if (input.is_interrupt === true) return null;
  const toolInput = input.tool_input;
  const command = isObject(toolInput) && typeof toolInput.command === 'string' ? toolInput.command : '';
  const error = typeof input.error === 'string' ? input.error : '';
  const [first = '', ...rest] = error.split('\n');
  const exit = /^Exit code (\d+)\s*$/.exec(first.trim());
  if (exit === null) return null;
  const exitCode = Number(exit[1]);
  if (exitCode === 0) return null;
  const calls = cliCalls(command, bins, plugins);
  const call = calls[calls.length - 1];
  if (call === undefined) return null;
  const own = rest.find((line) => line.startsWith(`${call.bin}: `) || line.startsWith(`${call.plugin}: `));
  const npm = rest.find((line) => /^npm (error|ERR!) /.test(line));
  const line = own ?? npm;
  const message = line === undefined ? undefined : cap(oneLine(redact(line)), SUMMARY_MAX);
  return { ...call, exitCode, ...(message === undefined || message === '' ? {} : { message }) };
}

/** The summary stored for a failure: `<bin> <command> exited <n>: <message>`. */
export function failureSummary(f: CliFailure): string {
  return `${f.bin}${f.subcommand === undefined ? '' : ` ${f.subcommand}`} exited ${f.exitCode}${f.message === undefined ? '' : `: ${f.message}`}`;
}

/**
 * The whole hook: parse the input, record the failure if it is one. Swallows every error, because a
 * hook that fails shows a notice in the conversation; losing one occurrence is the better outcome.
 */
export function handleHookInput(raw: string, env: Env, pluginRoot: string, now: Date): CliFailure | null {
  try {
    if (quickReject(raw)) return null;
    const { bins, plugins } = marketplacePlugins(pluginRoot, env);
    const failure = failureOf(JSON.parse(raw), bins, plugins);
    if (failure === null) return null;
    record(
      new Store(env),
      { plugin: failure.plugin, kind: 'cli-failure', summary: failureSummary(failure), exitCode: failure.exitCode, ...(failure.subcommand === undefined ? {} : { subcommand: failure.subcommand }) },
      now,
      'hook',
    );
    return failure;
  } catch {
    return null;
  }
}
