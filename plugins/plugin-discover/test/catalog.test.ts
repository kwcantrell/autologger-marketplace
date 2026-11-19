import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { claudeDir, findManifest, frontmatter, readCatalog, readSkills } from '../src/catalog.ts';
import { FIXTURES, sandbox } from './helpers.ts';

const s = sandbox();
after(s.cleanup);

test('catalog lists installed plugins with their skills and descriptions, from installed_plugins.json', () => {
  const { code, stdout, stderr } = s.call(['catalog', '--json']);
  assert.equal(code, 0, stderr);
  const c = JSON.parse(stdout);
  assert.equal(c.claudeDir, s.claudeDir);
  assert.deepEqual(
    c.installed.map((p: { id: string }) => p.id),
    ['autologger-mcp@autologger-marketplace', 'autologger-specs@autologger-marketplace', 'other-tools@other-market', 'plugin-advisor@autologger-marketplace', 'plugin-discover@autologger-marketplace'],
  );
  const mcp = c.installed[0];
  assert.match(mcp.description, /^Read and write autologger session data/);
  assert.deepEqual(mcp.skills.map((k: { name: string }) => k.name), ['query-session-data', 'sign-in', 'write-session-data']);
  assert.match(mcp.skills[0].description, /^Reads autologger session data through autologger's MCP tools/);
  assert.equal(mcp.version, '0.1.0');
  assert.equal(mcp.marketplace, 'autologger-marketplace');
  // A folded (>) description from another marketplace.
  const other = c.installed.find((p: { name: string }) => p.name === 'other-tools');
  assert.deepEqual(other.skills, [{ name: 'pdf-tools', description: 'Reads, merges and splits PDF files. Use when the user asks to combine or extract pages from a PDF.' }]);
});

test('a plugin set to false in enabledPlugins is marked disabled', () => {
  const c = JSON.parse(s.call(['catalog', '--json']).stdout);
  const enabled = Object.fromEntries(c.installed.map((p: { name: string; enabled: boolean }) => [p.name, p.enabled]));
  assert.deepEqual(enabled, { 'autologger-mcp': true, 'autologger-specs': false, 'other-tools': true, 'plugin-advisor': true, 'plugin-discover': true });
  assert.match(s.call(['catalog']).stdout, /autologger-specs@autologger-marketplace 0\.1\.0 \(disabled\)/);
});

test('a project settings file in the cwd overrides the user setting', () => {
  const project = join(s.dir, 'project');
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'autologger-specs@autologger-marketplace': true, 'autologger-mcp@autologger-marketplace': false } }));
  const c = JSON.parse(s.call(['catalog', '--json'], { cwd: project }).stdout);
  const enabled = Object.fromEntries(c.installed.map((p: { name: string; enabled: boolean }) => [p.name, p.enabled]));
  assert.equal(enabled['autologger-specs'], true);
  assert.equal(enabled['autologger-mcp'], false);
});

test('user skills come from <config>/skills, named by frontmatter or else by folder', () => {
  const c = JSON.parse(s.call(['catalog', '--json']).stdout);
  assert.deepEqual(
    c.userSkills.map((k: { name: string; description: string }) => [k.name, k.description.slice(0, 30)]),
    [
      ['notes', 'Keeps a running notes file for'],
      ['web-browse', 'Browser automation for website'],
    ],
  );
});

test('marketplace plugins not installed are listed as available, with skills and the install command', () => {
  const c = JSON.parse(s.call(['catalog', '--json']).stdout);
  assert.equal(c.manifest, join(s.marketplace, '.claude-plugin', 'marketplace.json'));
  // autologger-browser is installed for another project: not available (see the next test).
  assert.deepEqual(c.available.map((p: { name: string }) => p.name), ['autologger-dev']);
  const dev = c.available[0];
  assert.match(dev.description, /^Brings up a local autologger dev stack/);
  assert.deepEqual(dev.skills.map((k: { name: string }) => k.name), ['autologger-dev']);
  assert.equal(dev.installCommand, 'claude plugin install autologger-dev@autologger-marketplace');
});

test('a plugin installed only for another project is reported as installed elsewhere, not as missing', () => {
  const c = JSON.parse(s.call(['catalog', '--json']).stdout);
  assert.ok(!c.installed.some((p: { name: string }) => p.name === 'autologger-browser'));
  assert.ok(!c.available.some((p: { name: string }) => p.name === 'autologger-browser'));
  assert.equal(c.installedElsewhere.length, 1);
  const [browser] = c.installedElsewhere;
  assert.deepEqual(
    [browser.id, browser.name, browser.marketplace, browser.scope, browser.projectPath],
    ['autologger-browser@autologger-marketplace', 'autologger-browser', 'autologger-marketplace', 'project', join(s.dir, 'some-other-project')],
  );
  assert.match(browser.description, /agent-browser/);
  assert.deepEqual(browser.skills.map((k: { name: string }) => k.name), ['autologger-browser']);
  assert.match(s.call(['catalog']).stdout, /Installed for another project only:\n {2}autologger-browser@autologger-marketplace \(project scope, [^)]*some-other-project\)/);
});

test('a local-scoped install for another project is installed elsewhere too', () => {
  const t = sandbox({ elsewhere: [] });
  try {
    const records = join(t.claudeDir, 'plugins', 'installed_plugins.json');
    const data = JSON.parse(readFileSync(records, 'utf8'));
    data.plugins['autologger-dev@autologger-marketplace'] = [{ scope: 'local', projectPath: join(t.dir, 'elsewhere'), installPath: join(t.dir, 'nowhere'), version: '0.1.0' }];
    writeFileSync(records, JSON.stringify(data));
    const c = JSON.parse(t.call(['catalog', '--json']).stdout);
    assert.deepEqual(c.installedElsewhere.map((p: { id: string; scope: string }) => [p.id, p.scope]), [['autologger-dev@autologger-marketplace', 'local']]);
    assert.deepEqual(c.available.map((p: { name: string }) => p.name), ['autologger-browser']);
  } finally {
    t.cleanup();
  }
});

test('a project-scoped install counts inside its project', () => {
  const inside = join(s.dir, 'some-other-project', 'src');
  mkdirSync(inside, { recursive: true });
  const c = JSON.parse(s.call(['catalog', '--json'], { cwd: inside }).stdout);
  assert.ok(c.installed.some((p: { name: string; scope: string }) => p.name === 'autologger-browser' && p.scope === 'project'));
  assert.deepEqual(c.installedElsewhere, []);
  assert.deepEqual(c.available.map((p: { name: string }) => p.name), ['autologger-dev']);
});

test('without a known marketplace, available is empty and the manifest is null', () => {
  const t = sandbox({ knownMarketplace: false });
  try {
    const c = JSON.parse(t.call(['catalog', '--json']).stdout);
    assert.equal(c.manifest, null);
    assert.deepEqual(c.available, []);
    assert.match(t.call(['catalog']).stdout, /marketplace manifest not found/);
  } finally {
    t.cleanup();
  }
});

test('findManifest prefers the checkout next to the plugin', () => {
  const root = join(s.marketplace, 'plugins', 'plugin-discover');
  assert.equal(findManifest(root, join(s.dir, 'no-claude')), join(s.marketplace, '.claude-plugin', 'marketplace.json'));
  assert.equal(findManifest(join(s.dir, 'a', 'b'), join(s.dir, 'no-claude')), null);
});

test('CLAUDE_CONFIG_DIR is honoured, else ~/.claude under HOME', () => {
  assert.equal(claudeDir({ CLAUDE_CONFIG_DIR: '/x/claude', HOME: '/h' }), '/x/claude');
  assert.equal(claudeDir({ CLAUDE_CONFIG_DIR: '', HOME: '/h' }), '/h/.claude');
  assert.deepEqual(readCatalog({ HOME: join(s.dir, 'empty-home') }, { pluginRoot: join(s.dir, 'x', 'y'), cwd: s.cwd }), {
    claudeDir: join(s.dir, 'empty-home', '.claude'),
    manifest: null,
    installed: [],
    installedElsewhere: [],
    userSkills: [],
    available: [],
  });
});

test('frontmatter reads plain, quoted and block scalars', () => {
  assert.deepEqual(frontmatter('---\nname: a\ndescription: "say \\"hi\\""\nother: x\n---\nbody'), { name: 'a', description: 'say "hi"', other: 'x' });
  assert.deepEqual(frontmatter("---\ndescription: 'it''s'\n---\n"), { description: "it's" });
  assert.deepEqual(frontmatter('---\ndescription: |\n  one\n  two\nname: b\n---\n'), { description: 'one\ntwo', name: 'b' });
  assert.deepEqual(frontmatter('no frontmatter'), {});
});

test('frontmatter reads multi-line block descriptions in full, blank lines included', () => {
  assert.deepEqual(readSkills(join(FIXTURES, 'block-scalars')), [
    {
      name: 'folded-skill',
      description: 'Reads the first paragraph of a folded description, which spans two lines.\nThe second paragraph comes after a blank line and mentions openbao and the dev stack.',
    },
    { name: 'literal-skill', description: 'First line of a literal description.\n\nThird line, after a blank line: session transcripts.\nLast line.' },
  ]);
  // Folded: lines join with a space, a blank line is a newline; the block ends at the next key.
  assert.deepEqual(frontmatter('---\ndescription: >\n  one\n  two\n\n  three\n\n\n  four\n\nname: b\n---\n'), { description: 'one two\nthree\n\nfour', name: 'b' });
  // Literal: lines kept, blank lines inside kept, trailing blank lines dropped, deeper indent kept.
  assert.deepEqual(frontmatter('---\ndescription: |-\n  one\n\n    two\n  three\n\nname: c\n---\n'), { description: 'one\n\n  two\nthree', name: 'c' });
  // CRLF and whitespace-only blank lines.
  assert.deepEqual(frontmatter('---\r\ndescription: >\r\n  a\r\n   \r\n  b\r\n---\r\n'), { description: 'a\nb' });
});
