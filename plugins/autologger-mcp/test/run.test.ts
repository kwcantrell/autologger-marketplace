import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLI_NAME, EXIT, run } from '../src/run.ts';

async function call(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    env: { AUTOLOGGER_MCP_CONFIG_DIR: '/nonexistent/autologger-mcp-test' },
    fetch: async () => {
      throw new Error('no network in these tests');
    },
  });
  return { code, stdout, stderr };
}

test('--help prints usage on stdout', async () => {
  const { code, stdout, stderr } = await call('--help');
  assert.equal(code, EXIT.ok);
  assert.equal(stderr, '');
  assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
  for (const word of ['login', 'status', 'logout', 'tools', 'call', 'check-links', '--json', 'NODE_EXTRA_CA_CERTS', 'AUTOLOGGER_URL']) {
    assert.ok(stdout.includes(word), word);
  }
});

test('--version prints the package version', async () => {
  const { code, stdout } = await call('--version');
  assert.equal(code, EXIT.ok);
  assert.match(stdout, /^\d+\.\d+\.\d+\n$/);
});

for (const argv of [
  ['nope'],
  ['nope', '--json'],
  [],
  ['tools', '--bogus'],
  ['tools', 'extra'],
  ['status', '--write'],
  ['tools', '--args', '{}'],
  ['login', '--timeout', '0'],
  ['login', '--timeout', 'soon'],
  ['status', '--server', 'ftp://x'],
  ['status', '--server', 'http://evil.example'],
]) {
  test(`usage error for ${JSON.stringify(argv)}: exit 2, message on stderr only`, async () => {
    const { code, stdout, stderr } = await call(...argv);
    assert.equal(code, EXIT.usage);
    assert.equal(stdout, '');
    assert.match(stderr, new RegExp(`^${CLI_NAME}: .+\\nRun '${CLI_NAME} --help' for usage\\.\\n$`));
  });
}

test('an unreachable server is exit 1 with a readable message', async () => {
  const { code, stdout, stderr } = await call('login', '--server', 'https://localhost:1');
  assert.equal(code, EXIT.failure);
  assert.equal(stdout, '');
  assert.match(stderr, /^autologger-mcp: cannot reach https:\/\/localhost:1: no network in these tests\n$/);
});

// A server whose certificate no trusted CA signed (as the dev stack's, without its CA) is refused,
// with the documented remedy; TLS verification is never turned off.
const openssl = spawnSync('openssl', ['version']).status === 0;
test('an untrusted TLS certificate fails with a NODE_EXTRA_CA_CERTS hint', { skip: !openssl && 'openssl not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autologger-mcp-tls-'));
  try {
    const made = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    ]);
    assert.equal(made.status, 0, made.stderr.toString());
    const server = createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (_req, res) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}'),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      let stdout = '';
      let stderr = '';
      const code = await run(['status', '--check', '--server', `https://localhost:${port}`], {
        stdout: (t) => (stdout += t),
        stderr: (t) => (stderr += t),
        env: { AUTOLOGGER_MCP_CONFIG_DIR: dir },
      });
      assert.equal(code, EXIT.failure);
      assert.equal(stdout, '');
      assert.match(stderr, /the TLS certificate of https:\/\/localhost:\d+ is not trusted \(DEPTH_ZERO_SELF_SIGNED_CERT\)\. .*NODE_EXTRA_CA_CERTS=/);
    } finally {
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
