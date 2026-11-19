// End to end: runs the exact npx command lines from the skill, the way Claude Code would after
// installing the plugin (a fresh copy, unrelated cwd, no npm install or build step).
//
// Commands that touch docker, make or the network run only against fakes here: `docker` and `make`
// on PATH are shell scripts that log their arguments, the checkout is a fake one, HOME is a temp
// dir, and AUTOLOGGER_URL points at a local test server. No real stack is started.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI_NAME = 'autologger-dev';
const SKILL = 'skills/autologger-dev/SKILL.md';
const INVOCATION = `npx --yes --offline --loglevel=error --package="\${CLAUDE_PLUGIN_ROOT}" -- ${CLI_NAME}`;
const SECRET = 'e2e-S3cr3t-never-printed-5a4b3c2d1e';

const source = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), `${CLI_NAME}-e2e-`));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Simulate the plugin cache: Claude Code installs a plugin by copying its folder.
const pluginRoot = join(scratch, 'plugin-cache', CLI_NAME);
cpSync(source, pluginRoot, { recursive: true, filter: (path) => !path.includes('node_modules') });
const cwd = join(scratch, 'unrelated-cwd');
mkdirSync(cwd);

// A fake autologger-2 checkout, home (with the OpenBao state directory) and docker/make.
const repo = join(scratch, 'autologger-2');
for (const f of ['Makefile', 'docker/scripts/compose-run.mjs', 'docker/scripts/local-bao.mjs']) {
  mkdirSync(dirname(join(repo, f)), { recursive: true });
  writeFileSync(join(repo, f), '# fake\n');
}
// up and ca run only a checkout whose origin is kwcantrell/autologger-2; real git reads it.
const quietGit = { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } } as const;
execFileSync('git', ['init', '-q', repo], quietGit);
execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:kwcantrell/autologger-2.git'], quietGit);
const home = join(scratch, 'home');
mkdirSync(join(home, '.autologger-local-openbao'), { recursive: true });
writeFileSync(join(home, '.autologger-local-openbao', 'overrides.env'), `GOOGLE_CLIENT_ID=REPLACE_ME\nDEEPGRAM_API_KEY=${SECRET}\n`);
const makeLog = join(scratch, 'make.log');
const bin = join(scratch, 'bin');
mkdirSync(bin);
const script = (name: string, body: string): void => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
script(
  'make',
  `echo "\${DEV_HTTPS:+DEV_HTTPS=$DEV_HTTPS }make $* (in $PWD)" >> "$FAKE_MAKE_LOG"
case "$1" in
  --version) echo "GNU Make 4.4.1" ;;
  dev-ca) cat "$FAKE_CA" ;;
  *) echo "fake make $1 printed DEEPGRAM_API_KEY=$FAKE_LEAK" ;;
esac`,
);
script(
  'docker',
  `case "$1" in
  info) echo 28.5.2 ;;
  container) echo false ;;
  *) exit 1 ;;
esac`,
);

const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_') && key !== 'NODE_EXTRA_CA_CERTS'),
);
env.CLAUDE_PLUGIN_ROOT = pluginRoot;
// Empty npx cache, and offline: proves nothing is fetched from the registry.
env.npm_config_cache = join(scratch, 'npm-cache');
env.npm_config_offline = 'true';
env.PATH = `${bin}:${process.env.PATH ?? ''}`;
env.HOME = home;
env.AUTOLOGGER_REPO = repo;
env.FAKE_MAKE_LOG = makeLog;
env.FAKE_CA = join(pluginRoot, 'test', 'fixtures', 'test-ca.crt');
env.FAKE_LEAK = SECRET;

// A local stand-in for the dev server with /mcp on.
let origin = '';
const devServer = createServer((req, res) => {
  if (req.url === '/.well-known/oauth-protected-resource') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: `${origin}/mcp` }));
  } else if (req.url === '/mcp' || req.url === '/') {
    res.writeHead(401).end();
  } else {
    res.writeHead(404).end();
  }
});
before(async () => {
  await new Promise<void>((resolve) => devServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(devServer.address() as AddressInfo).port}`;
  env.AUTOLOGGER_URL = origin;
});
after(() => devServer.close());

function skillCommands(): string[] {
  const text = readFileSync(join(pluginRoot, SKILL), 'utf8');
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  return blocks.flatMap((b) => b.split('\n')).filter((line) => line.startsWith('npx '));
}

/** Runs a shell command line asynchronously, so the in-process test server can answer. */
async function sh(command: string, shellEnv: NodeJS.ProcessEnv = env): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn('sh', ['-c', command], { cwd, env: shellEnv });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const timer = setTimeout(() => child.kill(), 60_000);
  const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  return { status, stdout, stderr };
}

const makeCalls = (): string[] => (existsSync(makeLog) ? readFileSync(makeLog, 'utf8').trim().split('\n').filter(Boolean) : []);

test('the skill calls the CLI only through the shared npx invocation', () => {
  const commands = skillCommands();
  assert.ok(commands.length >= 2, `expected npx command lines in ${SKILL}`);
  for (const command of commands) assert.ok(command.startsWith(`${INVOCATION} `), command);
  for (const sub of ['doctor', 'up --dry-run', 'up', 'ca', 'status', 'connect', '--help']) {
    assert.ok(
      commands.some((c) => c.startsWith(`${INVOCATION} ${sub} `) || c === `${INVOCATION} ${sub}`),
      sub,
    );
  }
  assert.equal(existsSync(join(pluginRoot, 'node_modules')), false);
});

test('every skill command line runs from a fresh copy against the fakes and exits 0', async () => {
  for (const command of skillCommands()) {
    const before = makeCalls().length;
    const { status, stdout, stderr } = await sh(command);
    assert.equal(status, 0, `${command}\nstderr: ${stderr}`);
    assert.notEqual(stdout, '', command);
    assert.ok(!stdout.includes(SECRET) && !stderr.includes(SECRET), `${command} printed a secret`);
    if (command.endsWith(' --help')) assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
    if (command.includes(' --json')) JSON.parse(stdout);
    const ran = makeCalls().slice(before).filter((c) => !c.startsWith('make --version'));
    if (command.includes(' up --dry-run')) assert.deepEqual(ran, [], 'up --dry-run ran make');
    if (command.endsWith(' up --json')) {
      assert.deepEqual(ran, [
        `make dev-bao (in ${repo})`,
        `make dev-bao-set CUSTOM_DASHBOARDS_ENABLED=1 (in ${repo})`,
        `DEV_HTTPS=1 make dev-up (in ${repo})`,
      ]);
      assert.match(stderr, /fake make dev-up printed DEEPGRAM_API_KEY=\[redacted\]/);
      assert.match(stderr, /warning: the Google OAuth client/);
    }
    if (command.endsWith(' ca --json')) {
      assert.deepEqual(ran, [`DEV_HTTPS=1 make dev-ca (in ${repo})`]);
      const report = JSON.parse(stdout) as { path: string; export: string };
      assert.equal(report.path, join(home, '.autologger-dev', 'autologger-dev-ca.crt'));
      assert.equal(readFileSync(report.path, 'utf8'), readFileSync(env.FAKE_CA ?? '', 'utf8'));
    }
    if (command.endsWith(' status --json')) {
      const report = JSON.parse(stdout) as { answers: boolean; protected_resource: { ok: boolean }; mcp: { exists: boolean } };
      assert.deepEqual([report.answers, report.protected_resource.ok, report.mcp.exists], [true, true, true]);
    }
    if (command.endsWith(' doctor --json')) {
      const report = JSON.parse(stdout) as { repo: string; checks: { name: string; status: string }[] };
      assert.equal(report.repo, repo);
      assert.equal(report.checks.find((c) => c.name === 'checkout')?.status, 'ok');
    }
  }
  for (const call of makeCalls()) assert.doesNotMatch(call, /reset|down|stage|prod|GOOGLE/, call);
});

/** The Bash(<prefix>:*) rules in the skill's allowed-tools, as command prefixes. */
function allowedPrefixes(): string[] {
  const text = readFileSync(join(pluginRoot, SKILL), 'utf8');
  const line = /^allowed-tools: (.*)$/m.exec(text.split('\n---', 1)[0] ?? '')?.[1] ?? '';
  return [...line.matchAll(/Bash\(([^)]*):\*\)/g)].map((m) => m[1] ?? '');
}
const preApproved = (command: string): boolean => allowedPrefixes().some((p) => command === p || command.startsWith(`${p} `));

test('allowed-tools pre-approves only the read-only commands, not up or ca', () => {
  assert.deepEqual(allowedPrefixes(), ['doctor', 'status', 'connect', 'up --dry-run', '--help'].map((c) => `${INVOCATION} ${c}`));
  for (const command of skillCommands()) {
    const makefile = / (up|ca)( |$)/.test(command.slice(INVOCATION.length)) && !command.includes(' up --dry-run');
    assert.equal(preApproved(command), !makefile, command);
  }
  for (const sub of ['up', 'up --json', 'up --repo /x', 'up --repo /x --dry-run', 'ca', 'ca --json', 'ca --repo /x', 'doctorx']) {
    assert.equal(preApproved(`${INVOCATION} ${sub}`), false, sub);
  }
});

test('the skill asks the user, naming the checkout path, before up and before ca', () => {
  const text = readFileSync(join(pluginRoot, SKILL), 'utf8');
  assert.match(text, /## 2\. Bring the stack up - ask the user first[\s\S]*ask the user before running it for real, naming the\s+checkout path/);
  assert.match(text, /## 3\. Write the dev CA - ask the user first[\s\S]*ask the user before\s+running it, naming the checkout path/);
});

test('up and ca through npx refuse to default to the current directory (exit 2), even in a checkout', async () => {
  const noRepo: NodeJS.ProcessEnv = { ...env };
  delete noRepo.AUTOLOGGER_REPO;
  const before = makeCalls().length;
  for (const sub of ['up --json', 'ca --json']) {
    const { status, stdout, stderr } = await sh(`cd "${repo}" && ${INVOCATION} ${sub}`, noRepo);
    assert.equal(status, 2, sub);
    assert.equal(stdout, '');
    assert.match(stderr, /needs --repo <path> or AUTOLOGGER_REPO; it does not default to the current directory/);
  }
  assert.deepEqual(makeCalls().slice(before), []);
});

test('connect --json through npx prints the commands for the user', async () => {
  const { status, stdout } = await sh(`${INVOCATION} connect --server https://localhost:8787 --json`);
  assert.equal(status, 0);
  const report = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(report.claude_mcp_add, 'claude mcp add --transport http autologger-dev https://localhost:8787/mcp');
  assert.equal(report.autologger_mcp_login, 'autologger-mcp login --server https://localhost:8787');
});

test('an unknown command through npx exits 2 with the message on stderr', async () => {
  const { status, stdout, stderr } = await sh(`${INVOCATION} no-such-command`);
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /unknown command 'no-such-command'/);
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
