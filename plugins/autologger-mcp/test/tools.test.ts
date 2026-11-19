// `tools` and `call` over MCP Streamable HTTP against the fake server.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { messageFromEventStream } from '../src/mcp.ts';
import { FakeAutologger, WRITE_SCOPE_REFUSAL } from './fakeServer.ts';
import { cli, tempConfigDir, transcript } from './helpers.ts';

const servers: FakeAutologger[] = [];
after(async () => {
  const printed = transcript.join('\n');
  for (const server of servers) {
    for (const t of server.issued) assert.ok(!printed.includes(t), 'a token was printed');
    await server.close();
  }
});

async function signedIn(options: ConstructorParameters<typeof FakeAutologger>[0] = {}, ...loginArgs: string[]) {
  const server = await new FakeAutologger(options).start();
  servers.push(server);
  const configDir = tempConfigDir();
  const result = await cli({ configDir, server: server.base }, 'login', ...loginArgs);
  assert.equal(result.code, 0, result.stderr);
  server.calls.length = 0;
  return { server, configDir, run: (...argv: string[]) => cli({ configDir, server: server.base }, ...argv) };
}

test('tools: initialize, then every page of tools/list, all to the discovered MCP endpoint', async () => {
  const { server, run } = await signedIn();
  const result = await run('tools');
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines[0], 'list_studios  The studios the user belongs to.');
  assert.ok(lines.some((l) => l.startsWith('fail_tool')), 'second page listed');
  assert.ok(!lines.some((l) => l.startsWith('create_event')), 'no write tools on a read grant');
  assert.deepEqual(
    server.calls.map((c) => `${c.method} ${c.path} ${c.rpc}`),
    [
      'POST /rpc/mcp initialize',
      'POST /rpc/mcp notifications/initialized',
      'POST /rpc/mcp tools/list',
      'POST /rpc/mcp tools/list',
    ],
  );
});

test('tools --json prints the full schemas', async () => {
  const { run } = await signedIn({}, '--write');
  const result = await run('tools', '--json');
  const { tools } = JSON.parse(result.stdout);
  const shows = tools.find((t: { name: string }) => t.name === 'list_shows');
  assert.deepEqual(shows.inputSchema.required, ['studio_id']);
  assert.ok(tools.some((t: { name: string }) => t.name === 'create_wiki_page'));
});

test('call passes --args and prints the text, or the raw result with --json', async () => {
  const { server, run } = await signedIn();
  const text = await run('call', 'list_shows', '--args', '{"studio_id":"S1"}');
  assert.deepEqual(text, { code: 0, stdout: 'list_shows: 1 item\n', stderr: '' });
  const call = server.calls.find((c) => c.tool === 'list_shows');
  assert.deepEqual(call?.arguments, { studio_id: 'S1' });

  const raw = await run('call', 'list_shows', '--args', '{"studio_id":"S1"}', '--json');
  const result = JSON.parse(raw.stdout);
  assert.deepEqual(result.structuredContent.items[0].arguments, { studio_id: 'S1' });
  assert.equal(result.content[0].type, 'text');
});

test('call reads arguments from --args-file (a file or stdin), and with none sends {}', async () => {
  const { server, configDir, run } = await signedIn();
  const file = join(configDir, 'args.json');
  writeFileSync(file, '{"session_id":"abc"}');
  assert.equal((await run('call', 'get_session', '--args-file', file)).code, 0);
  assert.deepEqual(server.calls.find((c) => c.tool === 'get_session')?.arguments, { session_id: 'abc' });
  const piped = await cli({ configDir, server: server.base, stdin: '{"session_id":"from-stdin"}' }, 'call', 'list_events', '--args-file', '-');
  assert.equal(piped.code, 0, piped.stderr);
  assert.deepEqual(server.calls.find((c) => c.tool === 'list_events')?.arguments, { session_id: 'from-stdin' });
  assert.equal((await run('call', 'list_studios')).code, 0);
  assert.deepEqual(server.calls.find((c) => c.tool === 'list_studios')?.arguments, {});
});

test('bad --args are usage errors (exit 2) and nothing is sent', async () => {
  const { server, run } = await signedIn();
  for (const args of [['--args', '{nope'], ['--args', '[1]'], ['--args', '{}', '--args-file', 'x'], ['--args-file', '/no/such/file']]) {
    const result = await run('call', 'list_studios', ...args);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.stdout, '');
  }
  const missing = await run('call');
  assert.equal(missing.code, 2);
  assert.equal(server.calls.length, 0);
});

test('a tool error (isError) exits 1 with its text on stderr and nothing on stdout, also with --json', async () => {
  const { run } = await signedIn();
  for (const json of [[], ['--json']]) {
    const result = await run('call', 'fail_tool', ...json);
    assert.deepEqual(result, { code: 1, stdout: '', stderr: 'autologger-mcp: fail_tool failed: Session not found\n' });
  }
});

test('a JSON-RPC error exits 1 with its message', async () => {
  const { run } = await signedIn();
  const result = await run('call', 'no_such_tool', '--json');
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^autologger-mcp: tools\/call failed: MCP error -32602: Tool no_such_tool not found \(JSON-RPC -32602\)\n$/);
});

test('a write tool on a read-only sign-in fails with the refusal and how to get write access, no stack trace', async () => {
  const { run } = await signedIn();
  const result = await run('call', 'create_wiki_page', '--args', '{"show_id":"S","kind":"topic","title":"T"}');
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes(WRITE_SCOPE_REFUSAL));
  assert.match(result.stderr, /This sign-in is read-only \(scope 'dashboards'\)\. To edit, run in a terminal:\n  npx .* login --write --server /);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('a write tool with the write scope succeeds', async () => {
  const { run } = await signedIn({}, '--write');
  const result = await run('call', 'create_wiki_page', '--args', '{"show_id":"S","kind":"topic","title":"T"}', '--json');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).structuredContent.ok, true);
});

test('answers sent as text/event-stream are read too', async () => {
  const { run } = await signedIn({ sse: true });
  const result = await run('call', 'list_studios', '--json');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).structuredContent.total, 1);
});

test('messageFromEventStream picks the answer with the request id', () => {
  const body = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nid: 7\ndata: {"jsonrpc":"2.0",\ndata: "id":3,"result":{}}\n\n';
  assert.deepEqual(messageFromEventStream(body, 3), { jsonrpc: '2.0', id: 3, result: {} });
  assert.equal(messageFromEventStream(body, 4), undefined);
});

test('tools and call without credentials exit 1 with a "not signed in" message, without contacting the server', async () => {
  const configDir = tempConfigDir();
  const offline: typeof fetch = async () => {
    throw new Error('network used');
  };
  for (const argv of [['tools'], ['call', 'list_studios', '--json']]) {
    const result = await cli({ configDir, server: 'https://localhost:8787', fetch: offline }, ...argv);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^autologger-mcp: not signed in to https:\/\/localhost:8787; run npx --yes --offline --loglevel=error --package=\S+ -- autologger-mcp login --server https:\/\/localhost:8787 \(to edit session data, run npx .* login --write --server https:\/\/localhost:8787 instead\)/);
  }
});
