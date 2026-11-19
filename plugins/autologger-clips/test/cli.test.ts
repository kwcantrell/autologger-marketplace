// End to end: runs the exact npx command lines from every skill, the way Claude Code would after
// installing the plugin (a fresh copy, unrelated cwd, no npm install or build step).
//
// Commands that act on the machine run only against fakes: `yt-dlp`, `git`, `pnpm` and `claude` on
// PATH are shell scripts (no network, no real clone or install), and HOME and the config dir are temp
// dirs. No real editor is started and nothing is downloaded.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeTools } from './fakeTools.ts';
import { mp4, script } from './helpers.ts';

const CLI_NAME = 'autologger-clips';
const INVOCATION = `npx --yes --offline --loglevel=error --package="\${CLAUDE_PLUGIN_ROOT}" -- ${CLI_NAME}`;
const SKILLS = ['clip-moments', 'compile-playlist'];
/** The commands a skill may pre-approve: the read-only ones. */
const READ_ONLY = ['timeline', 'compile', 'media list', 'editor status', 'desktop doctor', '--help'];
/** Commands that act on the machine or the media map: never pre-approved. */
const ACTING = ['media set', 'media remove', 'media fetch', 'editor start', 'editor stop'];

const source = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), `${CLI_NAME}-e2e-`));
const home = join(scratch, 'home');
mkdirSync(home);

// Simulate the plugin cache: Claude Code installs a plugin by copying its folder.
const pluginRoot = join(scratch, 'plugin-cache', CLI_NAME);
cpSync(source, pluginRoot, { recursive: true, filter: (path) => !path.includes('node_modules') });
const cwd = join(scratch, 'unrelated-cwd');
mkdirSync(cwd);

// Fakes on PATH.
const bin = join(scratch, 'bin');
const { log } = fakeTools(bin);
const fixture = join(scratch, 'fixture.mp4');
writeFileSync(fixture, mp4({ durationS: 600, fpsNum: 30000, fpsDen: 1001 }));
script(
  bin,
  'yt-dlp',
  `echo "yt-dlp $*" >> "${log}"
[ "$1" = "--version" ] && { echo "2026.11.01"; exit 0; }
dir=""; prev=""
for a; do [ "$prev" = "-P" ] && dir="$a"; prev="$a"; done
for last; do :; done
id=\${last##*v=}
echo "[download] Destination: $dir/$id.mp4" >&2
cp "${fixture}" "$dir/$id.mp4"
echo "$dir/$id.mp4"`,
);
script(bin, 'claude', `echo "claude $*" >> "${log}"\necho "Checking MCP server health..."\necho ""\necho "autologger-dev: https://localhost:8787/mcp (HTTP) - ✓ Connected"`);

const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_')));
env.CLAUDE_PLUGIN_ROOT = pluginRoot;
// Empty npx cache, and offline: proves nothing is fetched from the registry.
env.npm_config_cache = join(scratch, 'npm-cache');
env.npm_config_offline = 'true';
env.PATH = `${bin}:${process.env.PATH ?? ''}`;
env.HOME = home;
env.AUTOLOGGER_CLIPS_CONFIG_DIR = join(scratch, 'config');
delete env.XDG_CONFIG_HOME;

after(async () => {
  // Never leave a fake editor running.
  await sh(`${INVOCATION} editor stop --json`);
  rmSync(scratch, { recursive: true, force: true });
});

// The files the skills' commands name, as Claude would have written them.
writeFileSync(join(cwd, 'local video.mp4'), mp4({ durationS: 300, fpsNum: 25 }));
writeFileSync(
  join(cwd, 'clips.json'),
  JSON.stringify([
    { session_id: 'S1', start_s: 30, end_s: 40, label: 'Pasta', session_date: '2026-01-15', session_title: 'Episode 1' },
    { session_id: 'S1', start_s: 38, end_s: 45, label: 'More pasta', session_date: '2026-01-15', session_title: 'Episode 1' },
  ]),
);
// What `autologger-mcp call list_session_media --json` prints, saved by the agent.
const items = [{ ordinal: 1, recording_ordinal: 1, kind: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', video_id: 'dQw4w9WgXcQ', file_name: null, duration_s: 600, take_start_s: 12.5, take_stop_s: 612.5 }];
writeFileSync(join(cwd, 'media.json'), JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ items }) }], structuredContent: { items } }));

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

const skillText = (skill: string): string => readFileSync(join(pluginRoot, 'skills', skill, 'SKILL.md'), 'utf8');
const skillCommands = (skill: string): string[] => shCommands(skillText(skill));

/** The Bash(<prefix>:*) rules in a skill's allowed-tools, as prefixes. */
function allowedPrefixes(skill: string): string[] {
  const line = /^allowed-tools: (.*)$/m.exec(skillText(skill).split('\n---', 1)[0] ?? '')?.[1] ?? '';
  return [...line.matchAll(/Bash\(([^)]*):\*\)/g)].map((m) => m[1] ?? '');
}
const preApproved = (skill: string, command: string): boolean => allowedPrefixes(skill).some((p) => command === p || command.startsWith(`${p} `));

/** Fills a skill's `<placeholder>` values with the files and ids above. */
function fill(command: string): string {
  const values: Record<string, string> = {
    session_id: 'S1',
    video_file: 'local video.mp4',
    offset_s: '0',
    media_json_file: 'media.json',
    clips_file: 'clips.json',
    timeline_file: 'out/clips.fcpxml',
  };
  return command.replace(/<([a-z_]+)>/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`no value for <${name}> in ${command}`);
    return value;
  });
}

/** Runs a shell command line asynchronously. */
async function sh(command: string, shellEnv: NodeJS.ProcessEnv = env): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn('/bin/sh', ['-c', command], { cwd, env: shellEnv });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const timer = setTimeout(() => child.kill(), 90_000);
  const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  return { status, stdout, stderr };
}

const calls = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);

test('every skill calls the CLI only through the shared npx invocation, and covers every command', () => {
  assert.deepEqual(readdirSync(join(pluginRoot, 'skills')).sort(), [...SKILLS].sort());
  for (const skill of SKILLS) {
    const commands = skillCommands(skill);
    assert.ok(commands.length >= 2, `expected npx command lines in ${skill}`);
    for (const command of commands) assert.ok(command.startsWith(`${INVOCATION} `), command);
  }
  const all = SKILLS.flatMap(skillCommands);
  for (const sub of [...READ_ONLY, ...ACTING]) {
    if (sub === 'compile' || sub === 'timeline') continue;
    assert.ok(all.some((c) => c.startsWith(`${INVOCATION} ${sub} `) || c === `${INVOCATION} ${sub}`), sub);
  }
  assert.ok(skillCommands('clip-moments').some((c) => c.startsWith(`${INVOCATION} timeline `)));
  assert.ok(skillCommands('compile-playlist').some((c) => c.startsWith(`${INVOCATION} compile `) && c.includes(' --title-cards')));
  assert.equal(existsSync(join(pluginRoot, 'node_modules')), false);
});

test('allowed-tools pre-approves only the read-only commands; media set|remove|fetch and editor start|stop prompt', () => {
  for (const skill of SKILLS) {
    const prefixes = allowedPrefixes(skill);
    assert.deepEqual([...prefixes].sort(), READ_ONLY.map((c) => `${INVOCATION} ${c}`).sort(), skill);
    for (const command of skillCommands(skill)) {
      const acting = ACTING.some((a) => command.startsWith(`${INVOCATION} ${a} `) || command === `${INVOCATION} ${a}`);
      assert.equal(preApproved(skill, command), !acting, `${skill}: ${command}`);
    }
    for (const sub of ['media set S1 x', 'media remove S1', 'media fetch S1 --media-json x', 'editor start', 'editor start --json', 'editor stop --json', 'medialist', 'editor statusx']) {
      assert.equal(preApproved(skill, `${INVOCATION} ${sub}`), false, `${skill}: ${sub}`);
    }
  }
});

test('the skills ask the user before acting commands and downloads', () => {
  const clip = skillText('clip-moments');
  assert.match(clip, /\*\*ask the user before downloading\*\*/);
  assert.match(clip, /If `running` is false, \*\*ask the user\*\* before starting it/);
  assert.match(clip, /\*\*Ask the user before `export_video`\*\*/);
  assert.match(clip, /never run `claude mcp add`\s+yourself/);
  assert.match(clip, /`explore-wiki` skill: `index build`, then `moments[\s\S]*`query-session-data` skill/);
  assert.match(skillText('compile-playlist'), /\*\*Ask the user once for the whole download\*\*/);
});

test('every skill command line runs from a fresh copy against the fakes and exits 0', async () => {
  for (const skill of SKILLS) {
    for (const command of skillCommands(skill).map(fill)) {
      const before = calls().length;
      const { status, stdout, stderr } = await sh(command);
      assert.equal(status, 0, `${skill}: ${command}\nstderr: ${stderr}`);
      assert.notEqual(stdout, '', command);
      if (command.endsWith(' --help')) assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
      if (!command.includes(' --json')) continue;
      const out = JSON.parse(stdout);
      const ran = calls().slice(before);
      if (command.includes(' media fetch ')) {
        assert.equal(out.path, join(home, 'Documents', 'autologger-clips', 'S1', 'dQw4w9WgXcQ.mp4'));
        assert.equal(out.offset_s, 12.5);
        assert.ok(ran.some((c) => c.startsWith('yt-dlp --no-playlist ') && c.endsWith(' -- https://www.youtube.com/watch?v=dQw4w9WgXcQ')), ran.join('\n'));
      }
      if (command.includes(' timeline ') || command.includes(' compile ')) {
        const text = readFileSync(out.out, 'utf8');
        assert.match(text, /<fcpxml version="1\.10">/);
        assert.equal(out.clips.length, 1, 'the overlapping ranges were merged');
        assert.deepEqual(out.merged[0].from, [1, 2]);
        // S1 is the downloaded video (offset 12.5 s) in the clip-moments run, the local one (offset 0) in compile-playlist.
        const offset = command.includes(' compile ') ? 0 : 12.5;
        assert.deepEqual([out.clips[0].video_in_s, out.clips[0].video_out_s], [30 - offset, 45 - offset]);
        if (command.includes(' --title-cards')) assert.equal(out.title_cards[0].text, 'Episode 1 (2026-01-15)');
      }
      if (command.includes(' editor start ')) {
        assert.match(out.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
        assert.ok(ran.some((c) => c.startsWith('pnpm dev --host 127.0.0.1 --port ')), ran.join('\n'));
        const status = await sh(`${INVOCATION} editor status --json`);
        assert.equal(JSON.parse(status.stdout).answers, true);
      }
      if (command.includes(' editor stop ')) assert.equal(out.stopped, true);
      if (command.includes(' desktop doctor ')) {
        assert.deepEqual([out.claude, out.registered], ['ok', false]);
        assert.deepEqual(ran, ['claude mcp list']);
      }
    }
  }
  assert.ok(!calls().some((c) => c.startsWith('claude mcp add')), 'desktop doctor registered something');
});

test('an unknown command through npx exits 2 with the message on stderr', async () => {
  const { status, stdout, stderr } = await sh(`${INVOCATION} no-such-command`);
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /unknown command 'no-such-command'/);
});

test('media fetch through npx without yt-dlp on PATH fails with the install hint', async () => {
  const noYtdlp = join(scratch, 'bin-no-ytdlp');
  mkdirSync(noYtdlp);
  // npm runs the bin through sh; nothing else from /bin or /usr/bin (where a yt-dlp may live).
  symlinkSync('/bin/sh', join(noYtdlp, 'sh'));
  const { status, stdout, stderr } = await sh(`${INVOCATION} media fetch S2 --media-json media.json --json`, { ...env, PATH: `${noYtdlp}:${dirnameOfNode()}` });
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /^autologger-clips: yt-dlp is not on PATH; install it/);
});

/** The directory of the node and npx in use, so a narrowed PATH can still run npx. */
function dirnameOfNode(): string {
  return join(process.execPath, '..');
}

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
