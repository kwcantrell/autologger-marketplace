// End to end: runs the exact npx command lines from every skill, the way Claude Code would after
// installing the plugin (a fresh copy, unrelated cwd, no npm install or build step), against the
// fake autologger. Commands run asynchronously so the fake server (in this process) can answer.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FakeAutologger } from './fakeServer.ts';

const CLI_NAME = 'autologger-mcp';
const INVOCATION = `npx --yes --offline --loglevel=error --package="\${CLAUDE_PLUGIN_ROOT}" -- ${CLI_NAME}`;
/** Skills in the order their commands run: reads, then writes, then seeding, then sign-in (which ends with logout). */
const SKILL_ORDER = ['query-session-data', 'write-session-data', 'seed-dev-stack', 'sign-in'];

const source = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), `${CLI_NAME}-e2e-`));
const server = new FakeAutologger();
// seed-dev-stack copies from a source server to a local target: two more fakes, with session data.
const seedSource = new FakeAutologger({
  data: {
    sessions: [
      {
        session_id: 'S1',
        show_id: 'shw_src',
        categories: [{ id: 'cat_a', label: 'Joke' }],
        events: [{ event_id: 'e1', wall_time_utc: '2026-01-01T10:00:00.000Z', category: 'cat_a', category_label: 'Joke', message: 'a joke', metadata: {}, version: 1 }],
        topics: [{ id: 't1', session_time: '00:01:00:00', duration_sec: 30, topic_level: 1, summary: 'Openers', ordinal: 1, version: 1 }],
      },
    ],
    pages: [{ page_id: 'pg_a', show_id: 'shw_src', kind: 'session', title: 'Session one', aliases: [], body_md: 'A [quote](cite:S1@2).', revision: 1, session_id: 'S1' }],
  },
});
const seedTarget = new FakeAutologger({
  data: { sessions: [{ session_id: 'T1', show_id: 'shw_t', categories: [{ id: 'cat_t', label: 'joke' }], events: [], topics: [] }], pages: [] },
});
const printed: string[] = [];

// Simulate the plugin cache: Claude Code installs a plugin by copying its folder.
const pluginRoot = join(scratch, 'plugin-cache', CLI_NAME);
cpSync(source, pluginRoot, { recursive: true, filter: (path) => !path.includes('node_modules') });
const cwd = join(scratch, 'unrelated-cwd');
mkdirSync(cwd);

// Plays the user's browser: follows the authorization URL to the CLI's loopback callback.
const browser = join(scratch, 'bin', 'fake-browser');
mkdirSync(join(scratch, 'bin'));
writeFileSync(
  browser,
  `#!/usr/bin/env node
const answer = await fetch(process.argv[2], { redirect: 'manual' });
await (await fetch(answer.headers.get('location'))).text();
`,
);
chmodSync(browser, 0o755);

const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_')),
);
env.CLAUDE_PLUGIN_ROOT = pluginRoot;
// Empty npx cache, and offline: proves nothing is fetched from the registry.
env.npm_config_cache = join(scratch, 'npm-cache');
env.npm_config_offline = 'true';
env.AUTOLOGGER_MCP_CONFIG_DIR = join(scratch, 'config');
env.BROWSER = browser;
delete env.AUTOLOGGER_URL;

before(async () => {
  await seedSource.start();
  await seedTarget.start();
  await server.start();
  env.AUTOLOGGER_URL = server.base;
});
after(async () => {
  await seedSource.close();
  await seedTarget.close();
  await server.close();
  rmSync(scratch, { recursive: true, force: true });
});

// Commands in the ```sh blocks of a skill: each starts at a line beginning with "npx " and, like the
// shell, continues over lines ending in an odd number of backslashes (only the "\" and the newline
// are removed), stopping at the closing fence (the last element of the split), so a dangling "\" there
// is kept. Mirrors npxLines in plugin-builder's check.ts; copied so this test stays standalone. Unlike
// npxLines, a block opens only at "```sh" + newline and ends at the next "```" anywhere in a line.
function shCommands(text: string): string[] {
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  const continues = (s: string): boolean => (/\\+$/.exec(s)?.[0].length ?? 0) % 2 === 1;
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    lines.forEach((line, index) => {
      let command = line.trim();
      if (!command.startsWith('npx ')) return;
      for (let next = index + 1; continues(command) && next < lines.length - 1; next++) {
        command = `${command.slice(0, -1)}${(lines[next] ?? '').trimEnd()}`;
      }
      out.push(command.trim());
    });
  }
  return out;
}

function skillCommands(skill: string): string[] {
  return shCommands(readFileSync(join(pluginRoot, 'skills', skill, 'SKILL.md'), 'utf8'));
}

/** The Bash(<prefix>:*) rules in a skill's allowed-tools, as prefixes. */
function allowedPrefixes(skill: string): string[] {
  const text = readFileSync(join(pluginRoot, 'skills', skill, 'SKILL.md'), 'utf8');
  const line = /^allowed-tools: (.*)$/m.exec(text)?.[1] ?? '';
  return [...line.matchAll(/Bash\((.*?):\*\)/g)].map((m) => m[1] ?? '');
}

/** Fills a skill's `<placeholder>` values with ids the fake servers accept. */
function fill(command: string): string {
  const seed: Record<string, string> = {
    source_server: seedSource.base,
    local_server: seedTarget.base,
    source_session_id: 'S1',
    snapshot_file: join(cwd, 'snapshot.json'),
    mapping: 'S1=T1',
  };
  return command.replace(/<([a-z_]+)>/g, (_, name: string) => seed[name] ?? `${name.toUpperCase()}-1`);
}

async function sh(command: string, extraEnv: NodeJS.ProcessEnv = env): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn('sh', ['-c', command], { cwd, env: extraEnv });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const timer = setTimeout(() => child.kill(), 60_000);
  const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  printed.push(stdout, stderr);
  return { status, stdout, stderr };
}

test('every skill calls the CLI only through the shared npx invocation', () => {
  assert.deepEqual(readdirSync(join(pluginRoot, 'skills')).sort(), [...SKILL_ORDER].sort());
  for (const skill of SKILL_ORDER) {
    const commands = skillCommands(skill);
    assert.ok(commands.length >= 2, `expected npx command lines in ${skill}`);
    for (const command of commands) assert.ok(command.startsWith(`${INVOCATION} `), command);
    // Every command line is pre-approved except import-tokens, which writes credentials, and
    // import --confirm, which writes session data: no rule (in any skill) may cover them, so Claude
    // has to ask first. Neither may export --force, which replaces a file.
    const prefixes = allowedPrefixes(skill);
    assert.ok(prefixes.length > 0 && prefixes.every((p) => p.startsWith(`${INVOCATION} `)), skill);
    for (const command of commands) {
      const allowed = prefixes.some((p) => command.startsWith(p));
      const writes = command.startsWith(`${INVOCATION} import-tokens`) || command.startsWith(`${INVOCATION} import --confirm`);
      assert.equal(allowed, !writes, `${skill}: ${command}`);
    }
    assert.ok(!prefixes.some((p) => `${INVOCATION} import-tokens --json`.startsWith(p)), `${skill} pre-approves import-tokens`);
    assert.ok(!prefixes.some((p) => `${INVOCATION} import --confirm --snapshot x --json`.startsWith(p)), `${skill} pre-approves import --confirm`);
    assert.ok(!prefixes.some((p) => `${INVOCATION} export --force --server x --json`.startsWith(p)), `${skill} pre-approves export --force`);
  }
  assert.ok(skillCommands('sign-in').some((c) => c.startsWith(`${INVOCATION} import-tokens `)), 'the sign-in skill shows import-tokens');
  assert.equal(existsSync(join(pluginRoot, 'node_modules')), false);
});

test('before sign-in, tools and call through npx exit 1 with "not signed in"', async () => {
  for (const command of [`${INVOCATION} tools --json`, `${INVOCATION} call list_studios --json`]) {
    const { status, stdout, stderr } = await sh(command);
    assert.equal(status, 1, stderr);
    assert.equal(stdout, '');
    assert.match(stderr, /^autologger-mcp: not signed in to http:\/\/127\.0\.0\.1:\d+; run npx --yes --offline --loglevel=error --package=\S+ -- autologger-mcp login --server http:\/\/127\.0\.0\.1:\d+ \(to edit session data, run npx \S+ \S+ \S+ --package=\S+ -- autologger-mcp login --write --server /);
  }
});

test('login --write through npx: browser sign-in via $BROWSER and the loopback redirect', async () => {
  const { status, stdout, stderr } = await sh(`${INVOCATION} login --write --json`);
  assert.equal(status, 0, stderr);
  const report = JSON.parse(stdout);
  assert.equal(report.scope, 'dashboards session-data:write');
  assert.match(stderr, /Open this URL in a browser to sign in/);
});

test('every skill command line runs from a fresh copy and exits 0', async () => {
  // Files the write skill's commands name, as Claude would have written them.
  writeFileSync(join(cwd, 'wiki-page.md'), 'See [Jane](wiki:p_1) and [the joke](cite:S1@125.5).\n');
  writeFileSync(join(cwd, 'wiki-page.json'), JSON.stringify({ show_id: 'SHOW-1', kind: 'topic', title: 'Jokes', body_md: 'x' }));
  // The output of `make dev-mcp-token` the user saved, fed to import-tokens on stdin (fake tokens).
  writeFileSync(join(cwd, 'TOKEN_FILE-1'), server.mintDevTokens('dashboards session-data:write'), { mode: 0o600 });
  // The user's sign-ins for seed-dev-stack: the source read-only, the local target with --write.
  for (const [base, write] of [[seedSource.base, ''], [seedTarget.base, ' --write']] as const) {
    const login = await sh(`${INVOCATION} login${write} --server ${base} --json`);
    assert.equal(login.status, 0, login.stderr);
  }
  let imported: Record<string, unknown> | undefined;
  for (const skill of SKILL_ORDER) {
    for (const command of skillCommands(skill).map(fill)) {
      const { status, stdout, stderr } = await sh(command);
      assert.equal(status, 0, `${command}\nstderr: ${stderr}`);
      assert.notEqual(stdout, '', command);
      if (command.includes(' --json')) JSON.parse(stdout);
      if (command.includes(' import-tokens ')) imported = JSON.parse(stdout);
    }
  }
  // seed-dev-stack: export read the source, the dry run wrote nothing, --confirm wrote the target.
  assert.ok(seedSource.calls.every((c) => c.tool === undefined || !c.tool.startsWith('create_')));
  assert.deepEqual(seedTarget.writeCounts.succeeded, 3, 'one event, one topic, one wiki page');
  assert.equal(seedTarget.options.data?.pages[0]?.body_md, 'A [quote](cite:T1@2).');
  const called = server.calls.filter((c) => c.tool !== undefined).map((c) => c.tool);
  assert.ok(called.includes('create_wiki_page') && called.includes('list_studios'), called.join(','));
  // import-tokens replaced the browser sign-in (revoking its grant), then logout revoked the import.
  assert.equal(imported?.replaced, true);
  assert.equal(imported?.revoked_previous, true);
  assert.equal(server.counts.revocations, 2, 'import-tokens revokes the login grant; the sign-in skill ends with logout');
});

test('check-links through npx exits 1 on a [[...]] link', async () => {
  writeFileSync(join(cwd, 'bad.md'), 'See [[Jane]].\n');
  const { status, stdout, stderr } = await sh(`${INVOCATION} check-links bad.md --json`);
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /bad\.md:1:5: '\[\[Jane\]\]' is not a link/);
});

test('an unknown command through npx exits 2 with the message on stderr', async () => {
  const { status, stdout, stderr } = await sh(`${INVOCATION} no-such-command`);
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /unknown command 'no-such-command'/);
});

test('no token appeared in any output', () => {
  assert.ok(server.issued.length > 0);
  const all = [...printed, readFileSync(join(cwd, 'snapshot.json'), 'utf8'), readFileSync(join(cwd, 'snapshot.json.import-state.json'), 'utf8')].join('\n');
  for (const t of [...server.issued, ...seedSource.issued, ...seedTarget.issued]) assert.ok(!all.includes(t), 'a token was printed or stored');
});

// Guard against `--package=""`: npm reads an empty spec as the registry package `undefined` (owned by a
// third party), and `--yes` would install and run it unprompted. `--offline` in the invocation must
// stop that before any request, even when npm itself is allowed online.
test('with CLAUDE_PLUGIN_ROOT empty, the invocation fails without contacting a registry', async () => {
  const requests: string[] = [];
  const registry = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = registry.address() as AddressInfo;
    const onlineEnv: NodeJS.ProcessEnv = {
      ...env,
      CLAUDE_PLUGIN_ROOT: '',
      npm_config_cache: join(scratch, 'npm-cache-empty-root'),
      npm_config_registry: `http://127.0.0.1:${port}/`,
      // npm's own version check also uses the registry; it is not what this test is about.
      npm_config_update_notifier: 'false',
    };
    delete onlineEnv.npm_config_offline;
    const { status, stdout } = await sh(`${INVOCATION} --help`, onlineEnv);
    assert.notEqual(status, 0);
    assert.equal(stdout, '');
    assert.deepEqual(requests, [], 'npx contacted the registry');
  } finally {
    registry.close();
  }
});
