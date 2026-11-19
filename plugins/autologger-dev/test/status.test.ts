// status: against local test HTTP(S) servers (real fetch), and connect's printed steps.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import type { StatusReport } from '../src/status.ts';
import { EXIT } from '../src/run.ts';
import { cli, DEV_TOKEN_8787, fixture, loginHint, tempDir } from './helpers.ts';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `${(server.address() as AddressInfo).port}`;
}

async function withServer<T>(handler: RequestListener, fn: (origin: string, requests: string[]) => Promise<T>): Promise<T> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  const port = await listen(server);
  try {
    return await fn(`http://127.0.0.1:${port}`, requests);
  } finally {
    server.close();
  }
}

/** Answers like the dev stack with /mcp on: PRM naming the resource, /mcp 401 without a token. */
function devStack(origin: () => string, mcpOn = true): RequestListener {
  return (req, res) => {
    if (req.url === '/.well-known/oauth-protected-resource' && mcpOn) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: `${origin()}/mcp`, authorization_servers: [origin()] }));
    } else if (req.url === '/mcp' && mcpOn) {
      res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="x"' }).end();
    } else if (req.url === '/') {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":"Login required."}');
    } else {
      res.writeHead(404).end();
    }
  };
}

async function statusJson(server: string): Promise<StatusReport> {
  const { code, stdout, stderr } = await cli({ fetch }, 'status', '--server', server, '--json');
  assert.equal(code, EXIT.ok, stderr);
  return JSON.parse(stdout) as StatusReport;
}

test('status: a dev stack with /mcp on answers, names its resource and has /mcp', async () => {
  let origin = '';
  await withServer(devStack(() => origin), async (o, requests) => {
    origin = o;
    const r = await statusJson(o);
    assert.equal(r.answers, true);
    assert.equal(r.http_status, 401);
    assert.equal(r.tls, null);
    assert.deepEqual(r.protected_resource, { ok: true, resource: `${o}/mcp`, detail: `names the resource ${o}/mcp` });
    assert.equal(r.mcp.exists, true);
    assert.equal(r.mcp.http_status, 401);
    assert.equal(r.fix, null);
    assert.deepEqual(requests, ['GET /', 'GET /.well-known/oauth-protected-resource', 'POST /mcp']);
    const text = await cli({ fetch }, 'status', '--server', o);
    assert.match(text.stdout, /Protected-resource metadata: OK, names the resource/);
    assert.match(text.stdout, /MCP endpoint: \/mcp exists and asks for sign-in \(401\)/);
  });
});

test('status: a stack without /mcp reports both missing with the up fix', async () => {
  await withServer(devStack(() => '', false), async (o) => {
    const r = await statusJson(o);
    assert.equal(r.answers, true);
    assert.equal(r.protected_resource.ok, false);
    assert.match(r.protected_resource.detail, /answered HTTP 404/);
    assert.equal(r.mcp.exists, false);
    assert.match(r.fix ?? '', /autologger-dev up/);
  });
});

test('status: PRM that is not JSON naming a resource is not ok', async () => {
  await withServer((req, res) => res.writeHead(req.url === '/mcp' ? 401 : 200).end('<html>'), async (o) => {
    const r = await statusJson(o);
    assert.equal(r.protected_resource.ok, false);
    assert.match(r.protected_resource.detail, /did not return JSON naming a resource URL/);
    assert.equal(r.mcp.exists, true);
  });
});

test('status: nothing listening is reported (exit 0) with the up fix', async () => {
  const server = createServer();
  const port = await listen(server);
  server.close();
  const r = await statusJson(`http://127.0.0.1:${port}`);
  assert.equal(r.answers, false);
  assert.match(r.error ?? '', /cannot reach http:\/\/127\.0\.0\.1:\d+/);
  assert.match(r.fix ?? '', /autologger-dev up/);
  assert.equal(r.mcp.exists, false);
});

test('status: the server comes from --server, else AUTOLOGGER_URL, else https://localhost:8787', async () => {
  const seen: string[] = [];
  const fake: typeof fetch = async (url) => {
    seen.push(String(url));
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'refused' } });
  };
  await cli({ fetch: fake }, 'status');
  await cli({ fetch: fake, env: { AUTOLOGGER_URL: 'http://localhost:9' } }, 'status');
  assert.deepEqual(seen, ['https://localhost:8787/', 'http://localhost:9/']);
  // undici's AggregateError for localhost has an empty message: the code is shown instead.
  const aggregate: typeof fetch = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }) });
  };
  const r = JSON.parse((await cli({ fetch: aggregate }, 'status', '--json')).stdout) as StatusReport;
  assert.equal(r.error, 'cannot reach https://localhost:8787: ECONNREFUSED');
  for (const bad of ['http://example.com', 'ftp://localhost', 'https://user:pw@localhost']) {
    const r = await cli({ fetch: fake }, 'status', '--server', bad);
    assert.equal(r.code, EXIT.usage, bad);
    assert.equal(r.stdout, '');
  }
});

// A server whose certificate no trusted CA signed (the dev stack's, before `ca`): reported as a TLS
// trust failure with the ca / NODE_EXTRA_CA_CERTS fix. TLS verification is never turned off.
const openssl = spawnSync('openssl', ['version']).status === 0;
test('status: an untrusted TLS certificate is reported as such, with the ca fix', { skip: !openssl && 'openssl not installed' }, async () => {
  const dir = tempDir();
  const made = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
  ]);
  assert.equal(made.status, 0, made.stderr.toString());
  const server = createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (_req, res) =>
    res.writeHead(200).end('{}'),
  );
  const port = await listen(server as unknown as Server);
  try {
    const r = await statusJson(`https://localhost:${port}`);
    assert.equal(r.answers, false);
    assert.equal(r.tls, 'untrusted');
    assert.match(r.error ?? '', /the TLS certificate of https:\/\/localhost:\d+ is not trusted \(DEPTH_ZERO_SELF_SIGNED_CERT\)/);
    assert.match(r.fix ?? '', /autologger-dev ca.*NODE_EXTRA_CA_CERTS/);
    const text = await cli({ fetch }, 'status', '--server', `https://localhost:${port}`);
    assert.match(text.stdout, /Not answering: the TLS certificate .* is not trusted/);
    assert.match(text.stdout, /Fix: run autologger-dev ca/);
  } finally {
    server.close();
  }
});

test('connect prints the CA export, claude mcp add, the autologger-mcp login and the dev-token line, and runs nothing', async () => {
  const f = fixture();
  const { code, stdout, stderr } = await cli({ env: f.env }, 'connect', '--json');
  assert.equal(code, EXIT.ok, stderr);
  const r = JSON.parse(stdout) as Record<string, unknown>;
  const caFile = join(f.home, '.autologger-dev', 'autologger-dev-ca.crt');
  assert.equal(r.server, 'https://localhost:8787');
  assert.equal(r.mcp_url, 'https://localhost:8787/mcp');
  assert.equal(r.node_extra_ca_certs_set, false);
  assert.equal(r.ca_file, caFile);
  assert.equal(r.ca_file_exists, false);
  assert.equal(r.node_extra_ca_certs_export, `export NODE_EXTRA_CA_CERTS=${caFile}`);
  assert.equal(r.claude_mcp_add, 'claude mcp add --transport http autologger-dev https://localhost:8787/mcp');
  assert.equal(r.autologger_mcp_login, loginHint('https://localhost:8787'));
  // Slot 0: no DEV_SLOT in front of make.
  assert.equal(r.dev_mcp_token, DEV_TOKEN_8787);
  // Never the bare autologger-mcp, which is not on PATH for a plugin install.
  assert.doesNotMatch(JSON.stringify(r), /autologger-mcp import-tokens/);
  const steps = r.steps as string[];
  assert.match(steps[0] ?? '', /autologger-dev ca/);
  assert.match(steps[1] ?? '', /restart Claude Code/);
  assert.equal(steps.length, 5);
  assert.equal(steps[4], `Or, with no Google sign-in (the stack's Google client may stay a placeholder), use the autologger-mcp plugin with a dev token: ${DEV_TOKEN_8787} (run it yourself; it creates that dev-stack account and an MCP grant, and pipes the tokens into autologger-mcp without showing them).`);

  const text = await cli({ env: f.env }, 'connect');
  assert.match(text.stdout, /^To connect Claude to https:\/\/localhost:8787\/mcp \(run these yourself\):\n {2}1\. /);
  assert.match(text.stdout, /claude mcp add --transport http autologger-dev https:\/\/localhost:8787\/mcp/);
  assert.ok(text.stdout.includes(loginHint('https://localhost:8787')), text.stdout);
  assert.doesNotMatch(text.stdout, /autologger-mcp login --server/);
  assert.ok(text.stdout.includes(`  5. Or, with no Google sign-in (the stack's Google client may stay a placeholder), use the autologger-mcp plugin with a dev token: ${DEV_TOKEN_8787} (`), text.stdout);
  assert.doesNotMatch(text.stdout, /autologger-mcp import-tokens/);
});

test('connect leaves out the export when NODE_EXTRA_CA_CERTS is set to a readable file, and for http://', async () => {
  const f = fixture();
  const ca = join(f.home, 'ca.crt');
  writeFileSync(ca, 'x');
  let r = JSON.parse((await cli({ env: { ...f.env, NODE_EXTRA_CA_CERTS: ca } }, 'connect', '--json')).stdout) as Record<string, unknown>;
  assert.equal(r.node_extra_ca_certs_set, true);
  assert.equal(r.node_extra_ca_certs_export, null);
  assert.equal((r.steps as string[]).length, 3);
  r = JSON.parse((await cli({ env: f.env }, 'connect', '--server', 'http://localhost:8787', '--json')).stdout) as Record<string, unknown>;
  assert.equal(r.node_extra_ca_certs_export, null);
  assert.equal(r.claude_mcp_add, 'claude mcp add --transport http autologger-dev http://localhost:8787/mcp');
});
