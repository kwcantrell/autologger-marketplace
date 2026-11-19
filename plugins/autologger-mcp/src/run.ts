import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import { importTokens, isExpired, login, logout, parseDevTokenGrant, requireSignedIn, TokenSource } from './auth.ts';
import { CLI_NAME, devTokenHint, importTokensCommand, indexBuildCommand, loginCommand, reusableClientId } from './commands.ts';
import { CliError, messageOf, UsageError } from './errors.ts';
import { DEFAULT_SERVER, type Fetch, isObject, resolveServer } from './http.ts';
import { type Caller, RateLimitStop, readSnapshot, readState, statePath, writeJsonFile } from './copy.ts';
import { exportSessions, summarize } from './export.ts';
import { execute, plan, type Plan, type RunResult, targetSession, targetState, type TargetSession } from './importer.ts';
import { checkLinks } from './links.ts';
import { McpClient, resultText } from './mcp.ts';
import { findMoments, type Moment } from './moments.ts';
import { findPerson, personGraph, PersonNotFound } from './personGraph.ts';
import { discover, WRITE_SCOPE } from './oauth.ts';
import { CredentialStore, type Env, redact } from './store.ts';
import { budgetCaller, buildIndex, DEFAULT_MAX_READS, MAX_TOTAL_WAIT_S, MAX_WAIT_S, type Scope, scopeArgs, scopeKey, scopeText, scopeView, WikiIndex } from './wikiIndex.ts';

export { CLI_NAME, importTokensCommand, loginCommand } from './commands.ts';

/** Exit codes shared by every plugin CLI in this marketplace. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Environment (default `process.env`). */
  env?: Env;
  /** Clock in epoch ms (default `Date.now`). */
  now?: () => number;
  /** Opens a URL in a browser (default: `$BROWSER`, else the platform's opener). */
  openUrl?: (url: string) => void;
  /** Reads standard input (default: the process's). */
  readStdin?: () => Promise<string>;
  fetch?: Fetch;
  /** Waits `ms` (default: a timer); import and export wait out rate limits with it. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_LOGIN_TIMEOUT_S = 300;

export const USAGE = `Usage: ${CLI_NAME} <command> [options]

Reads and writes autologger session data through autologger's MCP endpoint, signed in with
autologger's OAuth (browser sign-in, tokens kept and refreshed locally).

Commands:
  login [--write]              Sign in through the browser. Default scope 'dashboards' (read);
                               --write also asks for 'session-data:write' (edit events, topics,
                               wiki pages). Options: --no-browser, --timeout <seconds> (default ${DEFAULT_LOGIN_TIMEOUT_S}).
  status [--check]             Server, signed in or not, granted scope and token expiry, from the
                               local file only; --check also runs discovery and tests the token.
  import-tokens                Store the JSON line autologger's dev-only 'make dev-mcp-token' prints,
                               read from stdin only (pipe it in), as the sign-in for the server.
                               Its issuer and resource must be the server's own (from discovery);
                               a previous sign-in with another grant is revoked first.
  logout                       Revoke the sign-in at the server (when it can) and delete the
                               local tokens.
  tools                        List the MCP tools (name and description; --json: full schemas).
  call <tool> [--args '<json>' | --args-file <path|->]
                               Call one tool with a JSON object of arguments and print its result
                               (--json: the raw MCP result).
  check-links <file|->         Report [[...]] links and malformed wiki:/cite: links in a wiki body
                               (Markdown); exit 1 if any are found.
  export --session <id> [--session <id> ...] --out <file.json> [--no-wait]
                               Read sessions from the server (read tools only) into a JSON snapshot
                               (mode 0600; --out must end in .json): each session's get_session,
                               all events, topics and wiki pages with whole bodies. Refuses an
                               existing --out; 'export --force ...' replaces it (--force must come
                               right after export). A rate limit is waited out (--no-wait: stop).
  import --snapshot <file> --map <source_session>=<target_session> [--map ...] [--no-wait]
                               Plan copying the snapshot's events, topics and wiki pages into
                               existing sessions of the server (the target): a dry run that writes
                               nothing. Wiki links are rewritten to the target's ids; fields the
                               target's tools do not accept are listed as dropped_fields.
  import --confirm --snapshot <file> --map ... [--no-wait]
                               Do it (--confirm must come right after import). Progress is kept in
                               <file>.import-state.json, so running it again resumes without
                               duplicates. A rate limit is waited out (--no-wait: stop instead).
                               Needs a 'login --write' sign-in to the target; refuses a target that
                               is the snapshot's source server.
  index build (--show <id> | --studio <id> | --all) [--max-reads N]
                               Read every visible session of the scope (read tools only: listings,
                               get_session, events, topics, transcript paragraphs, wiki pages with
                               whole bodies) into a local index. A later build re-reads a session's
                               content only when get_session's revision or counts changed, and a
                               page body only when its revision changed. At most N tool calls per
                               run (default ${DEFAULT_MAX_READS}); a rate limit is waited out (at most ${MAX_WAIT_S} s a wait,
                               ${MAX_TOTAL_WAIT_S} s a run). When it stops early it reports complete: false and the
                               command that continues it.
  index status                 What is indexed for the server, and how old it is.
  index clear                  Delete the server's index.
  moments "<query>" (--show <id> | --studio <id> | --all) [--term <alt> ...]
                               From the index only (no server calls): every moment whose topic,
                               event, transcript paragraph or wiki page mentions the query or a
                               --term (whole words, case and accents ignored), with session, time,
                               snippet and a cite:<session_id>@<seconds> link; ordered by session
                               date and time, near-duplicates merged.
  person-graph "<name or page_id>" (--show <id> | --studio <id> | --all)
                               From the index only: a person's wiki page, the pages it links to and
                               that link to it, the moments it cites and the topics they fall in,
                               as nodes, edges and a Mermaid diagram.

Options:
  --server <url>   autologger server (default: $AUTOLOGGER_URL, else ${DEFAULT_SERVER})
  --json           Print machine-readable JSON on stdout
  -h, --help       Show this help
  --version        Print the CLI version

Environment:
  AUTOLOGGER_URL             Default server.
  AUTOLOGGER_MCP_CONFIG_DIR  Credentials and index directory (default: $XDG_CONFIG_HOME/autologger-mcp,
                             else ~/.config/autologger-mcp).
  NODE_EXTRA_CA_CERTS        A CA certificate file to trust, e.g. the dev stack's private CA.
  BROWSER                    Program that opens the sign-in URL.

Exit codes: 0 success, 1 command failed, 2 usage error (message on stderr).
`;

const OPTIONS = {
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', default: false },
  server: { type: 'string' },
  write: { type: 'boolean', default: false },
  'no-browser': { type: 'boolean', default: false },
  timeout: { type: 'string' },
  check: { type: 'boolean', default: false },
  args: { type: 'string' },
  'args-file': { type: 'string' },
  session: { type: 'string', multiple: true },
  out: { type: 'string' },
  force: { type: 'boolean', default: false },
  snapshot: { type: 'string' },
  map: { type: 'string', multiple: true },
  confirm: { type: 'boolean', default: false },
  'no-wait': { type: 'boolean', default: false },
  show: { type: 'string' },
  studio: { type: 'string' },
  all: { type: 'boolean', default: false },
  'max-reads': { type: 'string' },
  term: { type: 'string', multiple: true },
} as const;

type OptionName = keyof typeof OPTIONS;
const COMMON: OptionName[] = ['json', 'help', 'version'];
const COMMAND_OPTIONS: Record<string, OptionName[]> = {
  login: ['server', 'write', 'no-browser', 'timeout'],
  status: ['server', 'check'],
  'import-tokens': ['server'],
  logout: ['server'],
  tools: ['server'],
  call: ['server', 'args', 'args-file'],
  'check-links': [],
  export: ['server', 'session', 'out', 'force', 'no-wait'],
  import: ['server', 'snapshot', 'map', 'confirm', 'no-wait'],
  index: ['server', 'show', 'studio', 'all', 'max-reads'],
  moments: ['server', 'show', 'studio', 'all', 'term'],
  'person-graph': ['server', 'show', 'studio', 'all'],
};

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'unknown';
}

function defaultOpenUrl(env: Env): (url: string) => void {
  return (url) => {
    const browser = env.BROWSER;
    let command: string;
    let args: string[];
    if (browser !== undefined && browser !== '') {
      if (browser === 'none') return;
      [command, args] = [browser, [url]];
    } else if (process.platform === 'darwin') {
      [command, args] = ['open', [url]];
    } else if (process.platform === 'win32') {
      [command, args] = ['rundll32', ['url.dll,FileProtocolHandler', url]];
    } else {
      [command, args] = ['xdg-open', [url]];
    }
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true, env: { ...env } as NodeJS.ProcessEnv });
      child.on('error', () => {});
      child.unref();
    } catch {
      // The URL is printed; the user can open it by hand.
    }
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function iso(ms: number | undefined): string | null {
  return ms === undefined ? null : new Date(ms).toISOString();
}

export async function run(argv: readonly string[], rawIo: Io): Promise<number> {
  // Nothing this CLI prints may carry a token: scrub every line on the way out.
  const io = { ...rawIo, stdout: (t: string) => rawIo.stdout(redact(t)), stderr: (t: string) => rawIo.stderr(redact(t)) };
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: OPTIONS });
  } catch (error) {
    return usageError(io, messageOf(error));
  }
  const { values, positionals } = parsed;

  if (values.help) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  if (values.version) {
    io.stdout(`${version()}\n`);
    return EXIT.ok;
  }

  const [command, ...rest] = positionals;
  if (command === undefined) return usageError(io, 'missing command');
  const allowed = COMMAND_OPTIONS[command];
  if (allowed === undefined) return usageError(io, `unknown command '${command}'`);
  for (const [name, value] of Object.entries(values)) {
    const key = name as OptionName;
    if (value === undefined || value === false || (Array.isArray(value) && value.length === 0) || COMMON.includes(key) || allowed.includes(key)) continue;
    return usageError(io, `${command} does not take --${name}`);
  }

  const env = rawIo.env ?? process.env;
  const ctxBase = { fetch: rawIo.fetch ?? fetch, now: rawIo.now ?? Date.now };
  const json = values.json;
  const out = (value: unknown, text: string): void => io.stdout(json ? `${JSON.stringify(value)}\n` : text);
  const warn = (message: string): void => io.stderr(`${CLI_NAME}: warning: ${message}\n`);

  try {
    if (command === 'check-links') {
      if (rest.length !== 1) throw new UsageError('check-links takes one file (or - for stdin)');
      const file = rest[0] ?? '-';
      let body: string;
      try {
        body = file === '-' ? await (rawIo.readStdin ?? readStdin)() : readFileSync(file, 'utf8');
      } catch (error) {
        throw new CliError(`cannot read ${file}: ${messageOf(error)}`);
      }
      const problems = checkLinks(body);
      if (problems.length > 0) {
        const name = file === '-' ? '<stdin>' : file;
        const lines = problems.map((p) => `${name}:${p.line}:${p.column}: ${p.message}`);
        throw new CliError(`${problems.length} link problem${problems.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
      }
      out({ file, problems: [] }, `${file}: no link problems\n`);
      return EXIT.ok;
    }

    const server = resolveServer(values.server, env);
    const store = new CredentialStore(env, server);
    const ctx = { ...ctxBase, store };

    if (command === 'index') {
      const [sub, ...extra] = rest;
      if (sub !== 'build' && sub !== 'status' && sub !== 'clear') throw new UsageError('index takes build, status or clear');
      if (extra.length > 0) throw new UsageError(`index ${sub} takes no further arguments`);
      const index = new WikiIndex(env, server);
      if (sub !== 'build') {
        for (const name of ['show', 'studio', 'all', 'max-reads'] as const) {
          const v = values[name];
          if (v !== undefined && v !== false) throw new UsageError(`index ${sub} does not take --${name}`);
        }
        if (sub === 'clear') {
          const cleared = index.clear();
          out({ server, index_dir: index.dir, cleared }, cleared ? `Deleted the index of ${server} (${index.dir}).\n` : `No index for ${server}; nothing to do.\n`);
          return EXIT.ok;
        }
        const report = indexStatus(index, ctx.now());
        out(report, statusText(report));
        return EXIT.ok;
      }
      const scope = parseScope(values);
      let maxReads = DEFAULT_MAX_READS;
      if (values['max-reads'] !== undefined) {
        maxReads = Number(values['max-reads']);
        if (!Number.isInteger(maxReads) || maxReads < 1 || maxReads > 100_000) throw new UsageError('--max-reads must be a whole number from 1 to 100000');
      }
      const tokens = new TokenSource(ctx);
      const client = connect(ctx, tokens);
      await client.initialize();
      const call = budgetCaller({
        call: (name, args) => client.callTool(name, args),
        sleep: rawIo.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        notice: (text) => io.stderr(`${CLI_NAME}: ${text}`),
        maxReads,
      });
      const result = await buildIndex({ caller: call, index, scope, now: ctx.now, warn });
      const again = indexBuildCommand(server, scopeArgs(scope), [...(values['max-reads'] !== undefined ? ['--max-reads', String(maxReads)] : []), ...(json ? ['--json'] : [])]);
      const report = { ...result, ...(result.complete ? {} : { continue_command: again }) };
      out(
        report,
        `${result.complete ? 'Indexed' : 'Partly indexed'} ${scopeText(scope)} on ${server}: ${result.sessions.in_scope} sessions (${result.sessions.content_read} read, ${result.sessions.unchanged} unchanged${
          result.sessions.done_before > 0 ? `, ${result.sessions.done_before} done by the earlier run` : ''
        }), ${result.pages.read} wiki pages read, ${result.reads} tool calls.\n${
          result.failed.map((f) => `  session ${f.session_id}: ${f.reason}\n`).join('')
        }${result.complete ? '' : `Stopped: ${result.stopped ?? 'incomplete'}. ${result.sessions.remaining} sessions remain; to continue, run:\n  ${again}\n`}`,
      );
      return EXIT.ok;
    }
    if (command === 'moments' || command === 'person-graph') {
      if (rest.length !== 1 || (rest[0] ?? '').trim() === '') throw new UsageError(command === 'moments' ? 'moments takes one query: moments "<query>" --show <id>' : 'person-graph takes one name or page id: person-graph "<name>" --show <id>');
      const query = rest[0] ?? '';
      const scope = parseScope(values);
      const view = scopeView(new WikiIndex(env, server), scope);
      const build = indexBuildCommand(server, scopeArgs(scope), ['--json']);
      const coverage = {
        server,
        scope: scopeKey(scope),
        complete: view.complete,
        sessions_indexed: view.sessions.length,
        sessions_missing: view.missing,
        built_at: view.built_at,
        oldest_check: view.oldest_check,
        ...(view.complete ? {} : { build_command: build }),
      };
      const notice = view.complete ? '' : `Note: ${scopeText(scope)} is not fully indexed${view.missing !== null ? ` (${view.missing} sessions missing)` : ''}; to index it, run:\n  ${build}\n`;
      if (command === 'moments') {
        const terms = [query, ...(values.term ?? [])];
        for (const t of terms) if (t.length > 200) throw new UsageError('a query or --term is at most 200 characters');
        const found = findMoments(view, terms);
        if (found.terms.length === 0) throw new UsageError('the query has no letters or digits to match');
        out({ ...coverage, ...found }, `${notice}${momentsText(found.moments, found.terms)}`);
        return EXIT.ok;
      }
      const matches = findPerson(view, query);
      if (matches.length === 0) {
        throw new PersonNotFound(
          `no person page '${query}' in the index of ${server} for ${scopeText(scope)} (${view.sessions.length} sessions, ${view.pages.size} wiki pages indexed). If it exists, run index build first:\n  ${build}`,
        );
      }
      if (matches.length > 1) {
        throw new CliError(`'${query}' names ${matches.length} person pages; pass one page_id:\n${matches.map((p) => `  ${p.page_id}  ${p.title}${p.aliases.length > 0 ? ` (aliases: ${p.aliases.join(', ')})` : ''}`).join('\n')}`);
      }
      const person = matches[0];
      if (person === undefined) throw new CliError('no person page');
      const graph = personGraph(view, person);
      out({ ...coverage, ...graph }, `${notice}${graph.mermaid}`);
      return EXIT.ok;
    }

    switch (command) {
      case 'login': {
        if (rest.length > 0) throw new UsageError('login takes no arguments');
        let timeoutS = DEFAULT_LOGIN_TIMEOUT_S;
        if (values.timeout !== undefined) {
          timeoutS = Number(values.timeout);
          if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > 3600) {
            throw new UsageError('--timeout must be a whole number of seconds from 1 to 3600');
          }
        }
        const openUrl = values['no-browser'] ? undefined : (rawIo.openUrl ?? defaultOpenUrl(env));
        const result = await login(ctx, {
          write: values.write,
          timeoutMs: timeoutS * 1000,
          present: (url) => {
            io.stderr(
              `Open this URL in a browser to sign in to ${server}:\n\n  ${url}\n\nWaiting up to ${timeoutS} s for the sign-in to finish...\n`,
            );
            openUrl?.(url);
          },
        });
        const report = { ...result, expires_at: iso(result.expires_at), can_write: result.scope.split(' ').includes(WRITE_SCOPE) };
        out(
          report,
          `Signed in to ${server} with scope '${result.scope}'${
            result.expires_at !== undefined ? `; the access token expires ${report.expires_at}` : ''
          }.\n${!report.can_write && values.write ? 'Write access was not granted.\n' : ''}`,
        );
        return EXIT.ok;
      }
      case 'status': {
        if (rest.length > 0) throw new UsageError('status takes no arguments');
        const creds = store.load();
        const tokens = creds.tokens;
        const now = ctx.now();
        const report: Record<string, unknown> = {
          server,
          credentials_file: store.path,
          signed_in: tokens !== undefined,
          scope: tokens?.scope ?? null,
          can_write: tokens?.scope.split(' ').includes(WRITE_SCOPE) ?? false,
          access_token_expires_at: iso(tokens?.expires_at),
          access_token_expired: tokens === undefined ? null : isExpired(tokens, now),
          can_refresh: tokens?.refresh_token !== undefined,
          login_command: loginCommand(server, false),
          login_write_command: loginCommand(server, true),
        };
        // The client make dev-mcp-token can reuse (CLIENT_ID=), judged against the registration
        // endpoint just discovered with --check, else the one stored from the last discovery.
        let registrationEndpoint = creds.endpoints?.registration_endpoint;
        if (values.check) {
          const d = await discover(ctx.fetch, server);
          registrationEndpoint = d.registration_endpoint;
          report.discovery = {
            resource: d.resource,
            issuer: d.issuer,
            scopes_supported: d.scopes_supported,
            revocation: d.revocation_endpoint !== undefined,
          };
          if (tokens !== undefined) {
            const source = new TokenSource(ctx);
            const client = new McpClient({ endpoint: requireSignedIn(store).endpoints.resource, tokens: source, fetch: ctx.fetch, clientVersion: version() });
            await client.initialize();
            const after = store.load().tokens;
            report.token_valid = true;
            report.scope = after?.scope ?? report.scope;
            report.access_token_expires_at = iso(after?.expires_at);
            report.access_token_expired = false;
          }
        }
        const clientId = reusableClientId(creds, now, registrationEndpoint);
        if (clientId !== undefined) report.client_id = clientId;
        report.import_tokens_command = importTokensCommand(server, clientId);
        const devHint = devTokenHint(server, clientId);
        const lines = [
          `Server: ${server}`,
          report.signed_in
            ? `Signed in, scope '${String(report.scope)}'; access token ${
                report.access_token_expired ? 'expired' : 'expires'
              } ${String(report.access_token_expires_at ?? 'never')}${report.can_refresh ? ' (refreshable)' : ''}`
            : `Not signed in. Run in a terminal:\n  ${loginCommand(server, false)}${devHint === '' ? '' : `\n${devHint}`}`,
          ...(values.check ? [`Discovery: OK (resource ${(report.discovery as { resource: string }).resource})`] : []),
          ...(report.token_valid === true ? ['Token: accepted by the server'] : []),
          `Credentials: ${store.path}`,
        ];
        out(report, `${lines.join('\n')}\n`);
        return EXIT.ok;
      }
      case 'import-tokens': {
        // Tokens never come from an argument: those end up in shell history and process lists.
        if (rest.length > 0) throw new UsageError('import-tokens takes no arguments; pipe the output of make dev-mcp-token into it');
        let reader = rawIo.readStdin;
        if (reader === undefined) {
          if (process.stdin.isTTY) throw new UsageError('import-tokens reads the token JSON from standard input; pipe the output of make dev-mcp-token into it');
          reader = readStdin;
        }
        let text: string;
        try {
          text = await reader();
        } catch (error) {
          throw new CliError(`cannot read standard input: ${messageOf(error)}`);
        }
        const grant = parseDevTokenGrant(text);
        const result = await importTokens(ctx, grant, warn);
        const report = { ...result, expires_at: iso(result.expires_at), can_write: result.scope.split(' ').includes(WRITE_SCOPE) };
        out(
          report,
          `Signed in to ${server} with imported tokens, scope '${result.scope}'; the access token expires ${report.expires_at}.\n${
            result.replaced ? `The previous sign-in was replaced${result.revoked_previous ? ' (revoked at the server)' : ''}.\n` : ''
          }`,
        );
        return EXIT.ok;
      }
      case 'logout': {
        if (rest.length > 0) throw new UsageError('logout takes no arguments');
        const result = await logout(ctx, warn);
        out(
          { ...result, signed_in: false },
          result.was_signed_in
            ? `Signed out of ${server}${result.revoked ? ' (revoked at the server)' : ''}.\n`
            : `Not signed in to ${server}; nothing to do.\n`,
        );
        return EXIT.ok;
      }
      case 'tools': {
        if (rest.length > 0) throw new UsageError('tools takes no arguments');
        const client = connect(ctx);
        await client.initialize();
        const tools = await client.listTools();
        out(
          { tools },
          tools.map((t) => `${t.name}${t.description ? `  ${t.description.split('\n')[0] ?? ''}` : ''}`).join('\n') + '\n',
        );
        return EXIT.ok;
      }
      case 'export': {
        if (rest.length > 0) throw new UsageError('export takes no positional arguments');
        const sessionIds = values.session ?? [];
        if (sessionIds.length === 0) throw new UsageError('export needs --session <id> (one or more)');
        for (const id of sessionIds) if (!ID_RE.test(id)) throw new UsageError(`--session '${id}' is not a session id`);
        // A pre-approved `export --server ...` command line must never be able to replace a file.
        if (values.force && argv[argv.indexOf('export') + 1] !== '--force') {
          throw new UsageError('--force must come right after export: export --force --server <url> --session <id> --out <file.json>');
        }
        if (values.out === undefined || values.out === '') throw new UsageError('export needs --out <file.json>');
        // Only a .json name: a new file can never be one a shell or a desktop session reads (~/.bash_aliases).
        if (!values.out.endsWith('.json')) throw new UsageError(`--out '${values.out}' must be a .json file`);
        const outPath = resolvePath(values.out);
        if (!values.force && existsSync(outPath)) throw new CliError(`${outPath} already exists; run 'export --force ...' to overwrite it`);
        const client = connect(ctx);
        await client.initialize();
        const snapshot = await exportSessions(caller(client, values['no-wait']), server, sessionIds, ctx.now(), warn);
        writeJsonFile(outPath, snapshot, values.force);
        const summary = summarize(snapshot, outPath);
        out(
          summary,
          `Exported from ${server} to ${outPath}:\n${summary.sessions
            .map((s) => `  session ${s.session_id}: ${s.events} events, ${s.topics} topics, ${s.wiki_pages} wiki pages`)
            .join('\n')}\n`,
        );
        return EXIT.ok;
      }
      case 'import': {
        if (rest.length > 0) throw new UsageError('import takes no positional arguments');
        // A pre-approved `import --snapshot ...` command line must never be able to write.
        if (values.confirm && argv[argv.indexOf('import') + 1] !== '--confirm') {
          throw new UsageError('--confirm must come right after import: import --confirm --snapshot <file> --map ...');
        }
        if (values.snapshot === undefined || values.snapshot === '') throw new UsageError('import needs --snapshot <file>');
        const maps = parseMaps(values.map ?? []);
        const snapshotPath = resolvePath(values.snapshot);
        const snapshot = readSnapshot(snapshotPath);
        const inSnapshot = new Set(snapshot.sessions.map((s) => s.session_id));
        for (const [source] of maps) {
          if (!inSnapshot.has(source)) {
            throw new CliError(`--map ${source}=...: session ${source} is not in the snapshot (it holds ${[...inSnapshot].join(', ') || 'no sessions'}); nothing was written`);
          }
        }
        if (snapshot.source_server === server) {
          throw new CliError(`the target ${server} is the snapshot's source server; import copies into another server (such as a local dev stack). Nothing was written`);
        }
        const tokens = new TokenSource(ctx);
        if (!tokens.scope.split(' ').includes(WRITE_SCOPE)) {
          throw new CliError(`the sign-in to ${server} is read-only (scope '${tokens.scope}'); import needs ${WRITE_SCOPE}. Nothing was written. To sign in with it, run in a terminal:\n  ${loginCommand(server, true)}`);
        }
        const client = connect(ctx, tokens);
        await client.initialize();
        const tools = new Map((await client.listTools()).map((t) => [t.name, t]));
        const call = caller(client, values['no-wait']);
        const targets: TargetSession[] = [];
        for (const [source, target] of maps) targets.push(await targetSession(call, server, source, target));
        const stateFile = statePath(snapshotPath);
        const state = readState(stateFile, snapshot.source_server);
        const input = { snapshot, targets, state: targetState(state, server), tools };
        const thePlan = plan(input);
        const missing = thePlan.tools.filter((t) => !tools.has(t));
        if (missing.length > 0) {
          throw new CliError(`the target ${server} has no ${missing.join(', ')} tool${missing.length === 1 ? '' : 's'}, which this import needs; nothing was written`);
        }
        const header = { source_server: snapshot.source_server, target_server: server, snapshot: snapshotPath, state_file: stateFile, sessions: targets };
        if (!values.confirm) {
          const report = { mode: 'dry-run', ...header, ...planReport(thePlan) };
          out(report, importText(report, thePlan));
          return EXIT.ok;
        }
        let result: RunResult;
        try {
          result = await execute({ ...input, caller: call, save: () => writeJsonFile(stateFile, state, true) }, thePlan);
        } catch (error) {
          const saved = existsSync(stateFile) ? ` Progress is saved in ${stateFile}; run the same import --confirm command again to resume (nothing is created twice).` : '';
          if (error instanceof RateLimitStop) throw new CliError(`${error.message}; stopped.${saved}`);
          throw new CliError(`${messageOf(error)}${saved}`);
        }
        const report = {
          mode: 'confirm',
          ...header,
          ...planReport(thePlan),
          created: result.created,
          links_fixed: result.links_fixed,
          skipped: result.skipped,
          failed: result.failed,
          unresolved_links: result.unresolved_links,
        };
        out(report, importText(report, thePlan));
        return EXIT.ok;
      }
      case 'call': {
        const [tool, ...extra] = rest;
        if (tool === undefined || tool === '') throw new UsageError('call needs a tool name');
        if (extra.length > 0) throw new UsageError(`call takes one tool name; pass arguments with --args`);
        const args = await toolArguments(values.args, values['args-file'], rawIo);
        const tokens = new TokenSource(ctx);
        const client = connect(ctx, tokens);
        await client.initialize();
        const result = await client.callTool(tool, args);
        if (result.isError === true) {
          let message = resultText(result);
          if (!tokens.scope.split(' ').includes(WRITE_SCOPE) && message.includes(WRITE_SCOPE)) {
            message += `\nThis sign-in is read-only (scope '${tokens.scope}'). To edit, run in a terminal:\n  ${loginCommand(server, true)}`;
          }
          throw new CliError(`${tool} failed: ${message}`);
        }
        out(result, `${resultText(result)}\n`);
        return EXIT.ok;
      }
    }
    return usageError(io, `unknown command '${command}'`);
  } catch (error) {
    if (error instanceof UsageError) return usageError(io, error.message);
    io.stderr(`${CLI_NAME}: ${messageOf(error)}\n`);
    return EXIT.failure;
  }

  function caller(client: McpClient, noWait: boolean): Caller {
    return {
      call: (name, args) => client.callTool(name, args),
      sleep: rawIo.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      noWait,
      notice: (text) => io.stderr(`${CLI_NAME}: ${text}`),
    };
  }

  function connect(ctx: ConstructorParameters<typeof TokenSource>[0], tokens = new TokenSource(ctx)): McpClient {
    return new McpClient({ endpoint: tokens.endpoints.resource, tokens, fetch: ctx.fetch, clientVersion: version() });
  }
}

/** Session ids as autologger issues them. */
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

/** The one scope option given: --show <id>, --studio <id> or --all. */
function parseScope(values: { show?: string; studio?: string; all?: boolean }): Scope {
  const given = [values.show !== undefined, values.studio !== undefined, values.all === true].filter(Boolean).length;
  if (given !== 1) throw new UsageError('give one scope: --show <id>, --studio <id> or --all');
  if (values.show !== undefined) {
    if (!ID_RE.test(values.show)) throw new UsageError(`--show '${values.show}' is not a show id`);
    return { kind: 'show', id: values.show };
  }
  if (values.studio !== undefined) {
    if (!ID_RE.test(values.studio)) throw new UsageError(`--studio '${values.studio}' is not a studio id`);
    return { kind: 'studio', id: values.studio };
  }
  return { kind: 'all' };
}

interface IndexStatus {
  server: string;
  index_dir: string;
  exists: boolean;
  sessions: number;
  pages: number;
  builds: { scope: string; completed_at: string; age_s: number; sessions: number; reads: number }[];
  pending: { scope: string; started_at: string; sessions: number; done: number } | null;
}

function indexStatus(index: WikiIndex, now: number): IndexStatus {
  if (!index.exists()) return { server: index.server, index_dir: index.dir, exists: false, sessions: 0, pages: 0, builds: [], pending: null };
  const meta = index.meta();
  return {
    server: index.server,
    index_dir: index.dir,
    exists: true,
    sessions: index.count('sessions'),
    pages: index.count('pages'),
    builds: meta.builds.map((b) => ({ ...b, age_s: Math.max(0, Math.round((now - Date.parse(b.completed_at)) / 1000)) })),
    pending: meta.pending === undefined ? null : { scope: meta.pending.scope, started_at: meta.pending.started_at, sessions: meta.pending.session_ids.length, done: meta.pending.done.length },
  };
}

function age(seconds: number): string {
  if (seconds < 120) return `${seconds} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} days`;
}

function statusText(r: IndexStatus): string {
  if (!r.exists) return `No index for ${r.server}. Build one with index build --server <url> --show <id> (or --studio <id>, --all).\n`;
  const lines = [`Index of ${r.server}: ${r.sessions} sessions, ${r.pages} wiki pages (${r.index_dir})`];
  for (const b of r.builds) lines.push(`  ${b.scope}: built ${b.completed_at} (${age(b.age_s)} ago), ${b.sessions} sessions`);
  if (r.pending !== null) lines.push(`  ${r.pending.scope}: a build stopped after ${r.pending.done} of ${r.pending.sessions} sessions; run index build again to continue`);
  return `${lines.join('\n')}\n`;
}

function momentsText(moments: readonly Moment[], terms: readonly string[]): string {
  if (moments.length === 0) return `No moments mention ${terms.map((t) => `'${t}'`).join(', ')}.\n`;
  const lines = moments.map(
    (m) => `${m.session_date} ${m.session_title || m.session_id} ${m.seconds === null ? '-' : `@${m.seconds}s`} [${m.source}] ${m.snippet}${m.cite === null ? '' : `  ${m.cite}`}`,
  );
  return `${moments.length} moment${moments.length === 1 ? '' : 's'} (terms: ${terms.join(', ')}):\n${lines.join('\n')}\n`;
}

/** `--map <source>=<target>` pairs, each source once. */
function parseMaps(raw: readonly string[]): [string, string][] {
  if (raw.length === 0) throw new UsageError('import needs --map <source_session>=<target_session> (one or more)');
  const pairs: [string, string][] = [];
  for (const text of raw) {
    const m = /^([^=]+)=([^=]+)$/.exec(text);
    if (m?.[1] === undefined || m[2] === undefined || !ID_RE.test(m[1]) || !ID_RE.test(m[2])) {
      throw new UsageError(`--map '${text}' is not <source_session>=<target_session>`);
    }
    if (pairs.some(([s]) => s === m[1])) throw new UsageError(`--map names source session ${m[1]} twice`);
    pairs.push([m[1], m[2]]);
  }
  return pairs;
}

function planReport(p: Plan): Record<string, unknown> {
  const count = (action: string) => p.items.filter((i) => i.action === action).length;
  const create = { events: 0, topics: 0, wiki_pages: 0 };
  for (const i of p.items) if (i.action === 'create') create[i.kind]++;
  return {
    plan: { create, already_done: count('done'), fix_links: count('fix-links'), skip: count('skip') },
    items: p.items,
    dropped_fields: p.dropped_fields,
    unresolved_links: p.unresolved_links,
  };
}

function importText(report: Record<string, unknown>, p: Plan): string {
  const r = report as {
    mode: string;
    target_server: string;
    sessions: TargetSession[];
    plan: { create: Record<string, number>; already_done: number; fix_links: number; skip: number };
    dropped_fields: { tool: string; field: string }[];
    unresolved_links: { source_page_id: string; link: string }[];
    created?: Record<string, number>;
    links_fixed?: number;
    failed?: { kind: string; source_id: string; reason: string }[];
    state_file: string;
  };
  const lines: string[] = [];
  const confirm = r.mode === 'confirm';
  lines.push(confirm ? `Imported into ${r.target_server}:` : `Dry run: nothing was written. Importing into ${r.target_server} would:`);
  for (const s of r.sessions) lines.push(`  session ${s.source_session_id} -> ${s.target_session_id}`);
  const c = confirm ? r.created ?? {} : r.plan.create;
  lines.push(`  ${confirm ? 'created' : 'create'}: ${c.events ?? 0} events, ${c.topics ?? 0} topics, ${c.wiki_pages ?? 0} wiki pages`);
  if (r.plan.already_done > 0) lines.push(`  already copied by an earlier run: ${r.plan.already_done}`);
  if (confirm && (r.links_fixed ?? 0) > 0) lines.push(`  wiki pages whose links were fixed afterwards: ${r.links_fixed}`);
  for (const i of p.items.filter((x) => x.action === 'skip')) lines.push(`  skip ${i.kind} ${i.source_id}: ${i.reason ?? ''}`);
  for (const f of r.failed ?? []) lines.push(`  failed ${f.kind} ${f.source_id}: ${f.reason}`);
  if (r.dropped_fields.length > 0) lines.push(`  fields the target does not accept (not sent): ${r.dropped_fields.map((d) => `${d.tool}.${d.field}`).join(', ')}`);
  if (r.unresolved_links.length > 0) lines.push(`  links left unchanged (their page or session is not copied): ${r.unresolved_links.map((u) => u.link).join(', ')}`);
  lines.push(confirm ? `Progress: ${r.state_file}` : 'Run the same command as import --confirm ... to write.');
  return `${lines.join('\n')}\n`;
}

async function toolArguments(inline: string | undefined, file: string | undefined, io: Io): Promise<Record<string, unknown>> {
  if (inline !== undefined && file !== undefined) throw new UsageError('use --args or --args-file, not both');
  let text: string | undefined = inline;
  let source = '--args';
  if (file !== undefined) {
    source = file;
    try {
      text = file === '-' ? await (io.readStdin ?? readStdin)() : readFileSync(file, 'utf8');
    } catch (error) {
      throw new UsageError(`cannot read --args-file ${file}: ${messageOf(error)}`);
    }
  }
  if (text === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${source} is not valid JSON: ${messageOf(error)}`);
  }
  if (!isObject(value)) throw new UsageError(`${source} must be a JSON object`);
  return value;
}

function usageError(io: Io, message: string): number {
  io.stderr(`${CLI_NAME}: ${message}\nRun '${CLI_NAME} --help' for usage.\n`);
  return EXIT.usage;
}
