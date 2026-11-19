// desktop doctor: reads `claude mcp list` (faked), prints OpenReel's registration line, registers nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findOpenreel, REGISTRATION_LINE } from '../src/desktop.ts';
import type { Runner } from '../src/runner.ts';
import { call, sandbox } from './helpers.ts';

const box = sandbox();
const claude = (stdout: string, extra: Partial<Awaited<ReturnType<Runner>>> = {}): { runner: Runner; calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, stdout, stderr: '', ...extra };
    },
  };
};

const LISTING = `Checking MCP server health...

autologger-dev: https://localhost:8787/mcp (HTTP) - ✓ Connected
`;

test('not registered: says so and prints the registration line from docs/MCP-SETUP.md', async () => {
  const fake = claude(LISTING);
  const r = await call({ env: box.env, cwd: box.cwd, runner: fake.runner }, 'desktop', 'doctor', '--json');
  assert.equal(r.code, 0);
  const report = JSON.parse(r.stdout);
  assert.deepEqual([report.claude, report.registered, report.entry, report.connected], ['ok', false, null, null]);
  assert.equal(report.registration_line, 'claude mcp add openreel -- node /path/to/mcp-shim/index.js');
  assert.equal(report.doc, 'https://github.com/Augani/openreel-video/blob/main/docs/MCP-SETUP.md');
  assert.deepEqual(report.tools, ['create_project', 'import_media_from_path', 'import_timeline_xml', 'export_video']);
  assert.deepEqual(fake.calls, [['claude', 'mcp', 'list']], 'doctor only lists; it never runs claude mcp add');
});

test('registered and connected, or registered but the app is not running', async () => {
  const on = JSON.parse((await call({ env: box.env, cwd: box.cwd, runner: claude(`${LISTING}openreel: node /Applications/OpenReel.app/Contents/Resources/app.asar.unpacked/dist/mcp-shim/index.js - ✓ Connected\n`).runner }, 'desktop', 'doctor', '--json')).stdout);
  assert.deepEqual([on.registered, on.connected], [true, true]);
  assert.match(on.entry, /^openreel: node /);
  const off = JSON.parse((await call({ env: box.env, cwd: box.cwd, runner: claude('openreel: node /opt/OpenReel/resources/app.asar.unpacked/dist/mcp-shim/index.js - ✗ Failed to connect\n').runner }, 'desktop', 'doctor', '--json')).stdout);
  assert.deepEqual([off.registered, off.connected], [true, false]);
  assert.match(off.next, /start OpenReel Desktop/);
  assert.equal(findOpenreel('reel: node /x/mcp-shim/index.js - ✓ Connected'), 'reel: node /x/mcp-shim/index.js - ✓ Connected', 'found by its shim under another name');
});

test('no claude CLI: reported, exit 0', async () => {
  const r = await call({ env: box.env, cwd: box.cwd, runner: claude('', { code: null, error: 'ENOENT' }).runner }, 'desktop', 'doctor');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /not registered[\s\S]*claude CLI is not on PATH[\s\S]*Register with: claude mcp add openreel/);
  assert.equal(REGISTRATION_LINE.startsWith('claude mcp add openreel -- node '), true);
  assert.equal((await call({ env: box.env, cwd: box.cwd }, 'desktop', 'register')).code, 2);
});
