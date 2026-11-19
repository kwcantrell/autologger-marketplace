// End to end: runs the exact npx command lines from the skill, the way Claude Code would after
// installing the plugin (a fresh copy, unrelated cwd, no npm install or build step).
//
// Only fakes run here: `certutil`, `agent-browser` and `chromium` on PATH are shell scripts (certutil
// keeps its state in the database folder; agent-browser logs its arguments and stdin), HOME is a temp
// dir holding a fixture CA. No real browser is started and no real NSS database is touched. doctor's
// two TLS probes go to a closed port on 127.0.0.1 (AUTOLOGGER_BROWSER_TEST_PROBE_ORIGIN, test only),
// never to a dev stack on this machine (localhost:8787, dashboards.localhost).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI_NAME = 'autologger-browser';
const SKILL = 'skills/autologger-browser/SKILL.md';
const INVOCATION = `npx --yes --offline --loglevel=error --package="\${CLAUDE_PLUGIN_ROOT}" -- ${CLI_NAME}`;
const TOKEN = 'e2e-T0ken-never-printed-7f6e5d4c3b2a';

const source = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), `${CLI_NAME}-e2e-`));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Simulate the plugin cache: Claude Code installs a plugin by copying its folder.
const pluginRoot = join(scratch, 'plugin-cache', CLI_NAME);
cpSync(source, pluginRoot, { recursive: true, filter: (path) => !path.includes('node_modules') });
const cwd = join(scratch, 'unrelated-cwd');
mkdirSync(cwd);

const home = join(scratch, 'home');
mkdirSync(join(home, '.autologger-dev'), { recursive: true });
copyFileSync(join(source, 'test', 'fixtures', 'test-ca-1.crt'), join(home, '.autologger-dev', 'autologger-dev-ca.crt'));
const bin = join(scratch, 'bin');
mkdirSync(bin);
const abLog = join(scratch, 'agent-browser.log');
const script = (name: string, body: string): void => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
script('chromium', 'echo "Chromium 156.0.0.0 (fake)"');
script(
  'certutil',
  `[ "$1" = -H ] && exit 1
[ "$1" = -d ] || exit 1
dir=\${2#sql:}; shift 2
case "$1" in
  -N) : > "$dir/cert9.db"; exit 0 ;;
esac
[ -f "$dir/cert9.db" ] || exit 255
case "$1" in
  -L)
    if [ "$2" = -n ]; then [ -f "$dir/ca.pem" ] && cat "$dir/ca.pem" && exit 0; exit 255; fi
    printf 'Certificate Nickname    Trust Attributes\\n                        SSL,S/MIME,JAR/XPI\\n\\n'
    [ -f "$dir/ca.pem" ] && printf 'autologger-dev-ca       %s\\n' "$(cat "$dir/trust")"
    exit 0 ;;
  -D) rm -f "$dir/ca.pem" "$dir/trust"; exit 0 ;;
  -A) cp "$7" "$dir/ca.pem"; printf '%s' "$5" > "$dir/trust"; exit 0 ;;
esac
exit 1`,
);
script(
  'agent-browser',
  `echo "ARGS $*" >> "$FAKE_AB_LOG"
case " $* " in
  *" --version "*) echo "agent-browser 0.43.0 (fake)" ;;
  *" batch "*) echo "STDIN $(cat)" >> "$FAKE_AB_LOG"; echo '[{"error":null,"index":0,"result":{"set":true},"success":true}]' ;;
  *) echo "closed" ;;
esac`,
);

const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_') && !key.startsWith('AGENT_BROWSER_')),
);
env.CLAUDE_PLUGIN_ROOT = pluginRoot;
// Empty npx cache, and offline: proves nothing is fetched from the registry.
env.npm_config_cache = join(scratch, 'npm-cache');
env.npm_config_offline = 'true';
env.PATH = `${bin}:${process.env.PATH ?? ''}`;
env.HOME = home;
env.FAKE_AB_LOG = abLog;
delete env.LOCAL_BAO_DIR;

// A port nothing listens on: bound, then closed, so the probe is refused at once.
const closedPort = await new Promise<number>((resolve) => {
  const server = createTcpServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    server.close(() => resolve(port));
  });
});
const PROBE_ORIGIN = `https://127.0.0.1:${closedPort}`;
env.AUTOLOGGER_BROWSER_TEST_PROBE_ORIGIN = PROBE_ORIGIN;

// Commands in the ```sh blocks of a skill: each starts at a line beginning with "npx " and, like the
// shell, continues over lines ending in an odd number of backslashes (only the "\" and the newline
// are removed). Mirrors npxLines in plugin-builder's check.ts; copied so this test stays standalone.
function shCommands(text: string): string[] {
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  const continues = (s: string): boolean => (/\\+$/.exec(s)?.[0].length ?? 0) % 2 === 1;
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    lines.forEach((line, index) => {
      let command = line.trim();
      if (!command.startsWith('npx ')) return;
      for (let next = index + 1; continues(command) && next < lines.length; next++) {
        command = `${command.slice(0, -1)}${(lines[next] ?? '').trimEnd()}`;
      }
      out.push(command.trim());
    });
  }
  return out;
}

function skillCommands(): string[] {
  return shCommands(readFileSync(join(pluginRoot, SKILL), 'utf8'));
}

function sh(command: string, input?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('sh', ['-c', command], { cwd, env, encoding: 'utf8', timeout: 60_000, input: input ?? '' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('the skill calls the CLI only through the shared npx invocation, and pre-approves only read-only commands', () => {
  const commands = skillCommands();
  assert.ok(commands.length >= 5, `expected npx command lines in ${SKILL}`);
  for (const command of commands) assert.ok(command.startsWith(`${INVOCATION} `), command);
  assert.equal(existsSync(join(pluginRoot, 'node_modules')), false);
  const text = readFileSync(join(pluginRoot, SKILL), 'utf8');
  const allowed = /^allowed-tools: (.*)$/m.exec(text)?.[1] ?? '';
  const rules = allowed.split(/,\s*(?=Bash\()/);
  assert.deepEqual(rules, [`Bash(${INVOCATION} doctor:*)`, `Bash(${INVOCATION} --help:*)`]);
  // The skill never suggests turning certificate checks off, only forbids it.
  for (const line of text.split('\n').filter((l) => l.includes('--ignore-https-errors'))) assert.match(line, /Never use/);
});

test('every skill command line runs from a fresh copy in order (doctor, setup, signin, reset, help) and exits 0', () => {
  for (const command of skillCommands()) {
    const signin = command.includes(' signin');
    const { status, stdout, stderr } = sh(command, signin ? `autologger_sid=${TOKEN}\n` : undefined);
    assert.equal(status, 0, `${command}\nstderr: ${stderr}`);
    assert.notEqual(stdout, '', command);
    if (command.endsWith(' --help')) assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
    if (command.includes(' --json')) JSON.parse(stdout);
    if (command.includes(' setup ')) {
      const report = JSON.parse(stdout) as { flags: string[]; profile: string };
      assert.equal(report.profile, join(home, '.autologger-dev', 'browser', 'slot-0', 'profile'));
      assert.equal(report.flags[0], '--session');
    }
    if (command.includes(' doctor ')) {
      const report = JSON.parse(stdout) as { slot: number; ok: boolean; checks: Array<{ name: string; status: string; detail: string; fix: string | null }> };
      assert.equal(report.slot, 0);
      assert.equal(typeof report.ok, 'boolean');
      for (const c of report.checks) {
        assert.equal(typeof c.detail, 'string');
        assert.ok(['ok', 'missing', 'fail'].includes(c.status), c.name);
        assert.equal(c.fix === null, c.status === 'ok', c.name);
      }
      assert.equal(report.checks.find((c) => c.name === 'certutil')?.status, 'ok');
      // Both probes went to the test origin only, and found nothing there.
      for (const name of ['app_tls', 'runtime_tls']) {
        const check = report.checks.find((c) => c.name === name);
        assert.equal(check?.status, 'fail', name);
        assert.equal(check?.detail, `${PROBE_ORIGIN} cannot be reached (ECONNREFUSED)`);
      }
      assert.ok(!stdout.includes('localhost:8787') && !stdout.includes('dashboards.localhost'), stdout);
    }
    assert.ok(!stdout.includes(TOKEN) && !stderr.includes(TOKEN), `${command} printed the token`);
  }
  const log = readFileSync(abLog, 'utf8');
  const argLines = log.split('\n').filter((l) => l.startsWith('ARGS '));
  assert.ok(argLines.some((l) => l.includes(' batch ')), 'signin did not run agent-browser batch');
  for (const line of argLines) assert.ok(!line.includes(TOKEN), 'the token was on agent-browser\'s command line');
  assert.match(log, new RegExp(`STDIN .*"autologger_sid","${TOKEN}".*"--secure","--http-only"`));
  // reset ran last: the slot folder is gone, the CA file is not.
  assert.equal(existsSync(join(home, '.autologger-dev', 'browser', 'slot-0')), false);
  assert.ok(existsSync(join(home, '.autologger-dev', 'autologger-dev-ca.crt')));
});

test('signin through npx refuses a cookie for another slot with exit 2 and empty stdout', () => {
  const { status, stdout, stderr } = sh(`${INVOCATION} signin --json`, `autologger_sid_3=${TOKEN}\n`);
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /autologger-browser: the cookie is autologger_sid_3/);
  assert.ok(!stderr.includes(TOKEN));
});

test('an unknown command through npx exits 2 with the message on stderr', () => {
  const { status, stdout, stderr } = sh(`${INVOCATION} no-such-command`);
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
    const child = spawn('sh', ['-c', `${INVOCATION} --help`], { cwd, env: onlineEnv });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.resume();
    const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.notEqual(status, 0);
    assert.equal(stdout, '');
    assert.deepEqual(requests, [], 'npx contacted the registry');
  } finally {
    registry.close();
  }
});
