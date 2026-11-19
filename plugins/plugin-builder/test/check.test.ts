// check: one deliberately broken fixture plugin per rule, each producing its own finding; and the
// real repo's plugins (read only) passing.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { RULES, check, checkPlugin, npxLines, relativeSpecifiers } from '../src/check.ts';
import type { Finding, Rule } from '../src/check.ts';
import { REPO, fixture, scaffoldInto } from './fixture.ts';
import type { Fixture } from './fixture.ts';

const NAME = 'good-plugin';
const PLUGIN = `plugins/${NAME}`;
const SKILL = `${PLUGIN}/skills/${NAME}/SKILL.md`;
const PREFIX = `npx --yes --offline --loglevel=error --package="\${CLAUDE_PLUGIN_ROOT}" --`;
const Q = "'"; // Q and D keep this file's own source free of the import lines it writes into fixtures
const D = '"';

const fixtures: Fixture[] = [];
after(() => fixtures.forEach((f) => f.cleanup()));

/** A fixture checkout with one template-derived plugin, `good-plugin`. */
function good(): Fixture {
  const f = fixture();
  fixtures.push(f);
  scaffoldInto(f, NAME);
  return f;
}

function edit(f: Fixture, file: string, change: (text: string) => string): void {
  const path = join(f.root, file);
  const before = readFileSync(path, 'utf8');
  const after = change(before);
  assert.notEqual(after, before, `the edit to ${file} changed nothing`);
  writeFileSync(path, after);
}

function editJson(f: Fixture, file: string, change: (value: Record<string, unknown>) => void): void {
  const path = join(f.root, file);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  change(value);
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function lineOf(f: Fixture, file: string, needle: string): number {
  const index = readFileSync(join(f.root, file), 'utf8').split('\n').findIndex((l) => l.includes(needle));
  assert.notEqual(index, -1, `${needle} not in ${file}`);
  return index + 1;
}

function rules(findings: Finding[]): Rule[] {
  return [...new Set(findings.map((x) => x.rule))].sort();
}

function only(findings: Finding[], rule: Rule): Finding {
  assert.deepEqual(rules(findings), [rule], JSON.stringify(findings, null, 2));
  const [first] = findings;
  assert.ok(first);
  assert.ok(first.message.length > 0 && first.fix.length > 0, 'every finding says what is wrong and how to fix it');
  return first;
}

test('a plugin made by the scaffold has no findings', () => {
  const f = good();
  assert.deepEqual(checkPlugin(f.root, NAME), []);
  assert.deepEqual(check(f.root, null), { plugins: [NAME], findings: [] });
});

test('check --all passes on the real repo: autologger-mcp, autologger-specs and plugin-builder (read only)', () => {
  const result = check(REPO, null);
  for (const name of ['autologger-mcp', 'autologger-specs', 'plugin-builder']) assert.ok(result.plugins.includes(name), name);
  assert.deepEqual(result.findings, []);
});

test('plugin-manifest: plugin.json name differs from the folder', () => {
  const f = good();
  editJson(f, `${PLUGIN}/.claude-plugin/plugin.json`, (v) => (v.name = 'other-name'));
  const x = only(checkPlugin(f.root, NAME), 'plugin-manifest');
  assert.equal(x.file, `${PLUGIN}/.claude-plugin/plugin.json`);
  assert.match(x.message, /"other-name"/);
  assert.match(x.fix, /"name": "good-plugin"/);
});

test('plugin-manifest: plugin.json missing', () => {
  const f = good();
  rmSync(join(f.root, PLUGIN, '.claude-plugin'), { recursive: true });
  assert.match(only(checkPlugin(f.root, NAME), 'plugin-manifest').message, /missing/);
});

test('marketplace-entry: the plugin is not listed', () => {
  const f = good();
  editJson(f, '.claude-plugin/marketplace.json', (v) => (v.plugins = []));
  const x = only(checkPlugin(f.root, NAME), 'marketplace-entry');
  assert.equal(x.file, '.claude-plugin/marketplace.json');
  assert.match(x.fix, /"source": "\.\/plugins\/good-plugin"/);
});

test('marketplace-entry: the entry has the wrong source', () => {
  const f = good();
  editJson(f, '.claude-plugin/marketplace.json', (v) => ((v.plugins as { source: string }[])[0]!.source = './good-plugin'));
  assert.match(only(checkPlugin(f.root, NAME), 'marketplace-entry').message, /"\.\/good-plugin"/);
});

test('marketplace-entry: --all flags an entry with no plugin folder', () => {
  const f = good();
  editJson(f, '.claude-plugin/marketplace.json', (v) => (v.plugins as unknown[]).push({ name: 'ghost', source: './plugins/ghost' }));
  const x = only(check(f.root, null).findings, 'marketplace-entry');
  assert.match(x.message, /no plugins\/ghost folder/);
});

test('package-json: missing', () => {
  const f = good();
  rmSync(join(f.root, PLUGIN, 'package.json'));
  assert.equal(only(checkPlugin(f.root, NAME), 'package-json').file, `${PLUGIN}/package.json`);
});

test('package-private: not private', () => {
  const f = good();
  editJson(f, `${PLUGIN}/package.json`, (v) => delete v.private);
  assert.match(only(checkPlugin(f.root, NAME), 'package-private').fix, /"private": true/);
});

test('package-type-module: commonjs', () => {
  const f = good();
  editJson(f, `${PLUGIN}/package.json`, (v) => (v.type = 'commonjs'));
  assert.match(only(checkPlugin(f.root, NAME), 'package-type-module').message, /"commonjs"/);
});

test('package-bin: the bin is a .js file', () => {
  const f = good();
  editJson(f, `${PLUGIN}/package.json`, (v) => (v.bin = { [NAME]: 'dist/cli.js' }));
  assert.match(only(checkPlugin(f.root, NAME), 'package-bin').message, /not a \.ts file/);
});

test('package-bin: the .ts bin does not exist', () => {
  const f = good();
  editJson(f, `${PLUGIN}/package.json`, (v) => (v.bin = { [NAME]: 'src/main.ts' }));
  assert.match(only(checkPlugin(f.root, NAME), 'package-bin').message, /does not exist/);
});

test('package-bin: no bin named after the plugin', () => {
  const f = good();
  editJson(f, `${PLUGIN}/package.json`, (v) => delete v.bin);
  assert.ok(rules(checkPlugin(f.root, NAME)).includes('package-bin'));
});

test('bin-shebang: the bin has no #!/usr/bin/env node line', () => {
  const f = good();
  edit(f, `${PLUGIN}/src/cli.ts`, (t) => t.replace('#!/usr/bin/env node\n', ''));
  const x = only(checkPlugin(f.root, NAME), 'bin-shebang');
  assert.deepEqual([x.file, x.line], [`${PLUGIN}/src/cli.ts`, 1]);
});

test('no-dependencies: a runtime dependency is flagged', () => {
  const f = good();
  editJson(f, `${PLUGIN}/package.json`, (v) => (v.dependencies = { 'left-pad': '1.3.0' }));
  const x = only(checkPlugin(f.root, NAME), 'no-dependencies');
  assert.match(x.message, /"dependencies" declares left-pad/);
});

test('no-dependencies: dev dependencies belong in the root package.json', () => {
  const f = good();
  editJson(f, `${PLUGIN}/package.json`, (v) => (v.devDependencies = { typescript: '7.0.2' }));
  assert.match(only(checkPlugin(f.root, NAME), 'no-dependencies').fix, /root package\.json/);
});

test('skills-present: no skills', () => {
  const f = good();
  rmSync(join(f.root, PLUGIN, 'skills'), { recursive: true });
  assert.equal(only(checkPlugin(f.root, NAME), 'skills-present').file, `${PLUGIN}/skills`);
});

test('skill-name: frontmatter name differs from the folder', () => {
  const f = good();
  edit(f, SKILL, (t) => t.replace(`name: ${NAME}\n`, 'name: something-else\n'));
  assert.match(only(checkPlugin(f.root, NAME), 'skill-name').message, /"something-else"/);
});

test('skill-command-lines: a skill with no npx line', () => {
  const f = good();
  edit(f, SKILL, (t) => t.split('\n').filter((l) => !l.startsWith('npx ')).join('\n'));
  assert.equal(only(checkPlugin(f.root, NAME), 'skill-command-lines').file, SKILL);
});

test('npx-outside-sh: an npx line outside a sh block is untested', () => {
  const f = good();
  edit(f, SKILL, (t) => `${t}\nOr run:\n\n${PREFIX} ${NAME} hello --json\n`);
  const lines = readFileSync(join(f.root, SKILL), 'utf8').split('\n');
  const x = only(checkPlugin(f.root, NAME), 'npx-outside-sh');
  assert.equal(x.line, lines.length - 1);
});

test('npx-outside-sh: an npx line in a non-sh fence is untested', () => {
  const f = good();
  edit(f, SKILL, (t) => `${t}\n\`\`\`bash\n${PREFIX} ${NAME} hello --json\n\`\`\`\n`);
  only(checkPlugin(f.root, NAME), 'npx-outside-sh');
});

test('npx-offline: a skill line without --offline', () => {
  const f = good();
  edit(f, SKILL, (t) => t.replace(`npx --yes --offline --loglevel=error --package="\${CLAUDE_PLUGIN_ROOT}" -- ${NAME} hello`, `npx --yes --loglevel=error --package="\${CLAUDE_PLUGIN_ROOT}" -- ${NAME} hello`));
  const x = only(checkPlugin(f.root, NAME), 'npx-offline');
  assert.deepEqual([x.file, x.line], [SKILL, lineOf(f, SKILL, `-- ${NAME} hello`)]);
  assert.match(x.message, /--offline/);
});

test('npx-quoted-root: a skill line with an unquoted ${CLAUDE_PLUGIN_ROOT}', () => {
  const f = good();
  edit(f, SKILL, (t) => t.replace(`--package="\${CLAUDE_PLUGIN_ROOT}" -- ${NAME} hello`, `--package=\${CLAUDE_PLUGIN_ROOT} -- ${NAME} hello`));
  const x = only(checkPlugin(f.root, NAME), 'npx-quoted-root');
  assert.equal(x.line, lineOf(f, SKILL, `-- ${NAME} hello`));
});

test('npx-bin-name: a skill line running another bin', () => {
  const f = good();
  edit(f, SKILL, (t) => t.replace(`-- ${NAME} hello`, '-- other-cli hello'));
  const x = only(checkPlugin(f.root, NAME), 'npx-bin-name');
  assert.match(x.message, /runs 'other-cli', but this plugin's bin is 'good-plugin'/);
});

test('npx-prefix: a skill line with the flags in another order', () => {
  const f = good();
  edit(f, SKILL, (t) => t.replace(`npx --yes --offline --loglevel=error --package="\${CLAUDE_PLUGIN_ROOT}" -- ${NAME} hello`, `npx --offline --yes --loglevel=error --package="\${CLAUDE_PLUGIN_ROOT}" -- ${NAME} hello`));
  const x = only(checkPlugin(f.root, NAME), 'npx-prefix');
  assert.ok(x.fix.includes(`${PREFIX} ${NAME}`));
});

test('allowed-tools: missing from the frontmatter', () => {
  const f = good();
  edit(f, SKILL, (t) => t.replace(/^allowed-tools:.*\n/m, ''));
  assert.ok(only(checkPlugin(f.root, NAME), 'allowed-tools').fix.includes(`allowed-tools: Bash(${PREFIX} ${NAME}:*)`));
});

test('allowed-tools: allowing a different prefix', () => {
  const f = good();
  edit(f, SKILL, (t) => t.replace(/^allowed-tools:.*\n/m, `allowed-tools: Bash(npx:*)\n`));
  only(checkPlugin(f.root, NAME), 'allowed-tools');
});

test('allowed-tools: per-command rules for the plugin\'s own bin are accepted', () => {
  const f = good();
  const rule = (sub: string): string => `Bash(${PREFIX} ${NAME} ${sub}:*)`;
  edit(f, SKILL, (t) => t.replace(/^allowed-tools:.*\n/m, `allowed-tools: ${rule('hello')}, ${rule('--help')}\n`));
  assert.deepEqual(rules(checkPlugin(f.root, NAME)), []);
});

test('allowed-tools: a per-command rule for another bin is not enough', () => {
  const f = good();
  edit(f, SKILL, (t) => t.replace(/^allowed-tools:.*\n/m, `allowed-tools: Bash(${PREFIX} other-cli hello:*)\n`));
  only(checkPlugin(f.root, NAME), 'allowed-tools');
});

test('tests-present: no test folder', () => {
  const f = good();
  rmSync(join(f.root, PLUGIN, 'test'), { recursive: true });
  assert.deepEqual(rules(checkPlugin(f.root, NAME)), ['e2e-test', 'tests-present']);
});

test('e2e-test: unit tests only', () => {
  const f = good();
  rmSync(join(f.root, PLUGIN, 'test', 'cli.test.ts'));
  assert.equal(only(checkPlugin(f.root, NAME), 'e2e-test').file, `${PLUGIN}/test`);
});

test('relative-imports: .js and extensionless relative imports, with line numbers', () => {
  const f = good();
  edit(f, `${PLUGIN}/src/cli.ts`, (t) => t.replace(`from ${Q}./run.ts${Q}`, `from ${Q}./run.js${Q}`));
  edit(f, `${PLUGIN}/src/run.ts`, (t) => t.replace(`from ${Q}./hello.ts${Q}`, `from ${Q}./hello${Q}`));
  const findings = checkPlugin(f.root, NAME);
  assert.deepEqual(rules(findings), ['relative-imports']);
  const byFile = Object.fromEntries(findings.map((x) => [x.file, x]));
  assert.equal(byFile[`${PLUGIN}/src/cli.ts`]?.line, lineOf(f, `${PLUGIN}/src/cli.ts`, './run.js'));
  assert.match(byFile[`${PLUGIN}/src/cli.ts`]?.fix ?? '', /\.\/run\.ts/);
  assert.match(byFile[`${PLUGIN}/src/run.ts`]?.message ?? '', /without an extension/);
});

test('relativeSpecifiers finds static, side-effect, re-export and dynamic imports', () => {
  assert.deepEqual(relativeSpecifiers(`import { a } from ${Q}./a${Q};`), ['./a']);
  assert.deepEqual(relativeSpecifiers(`export * from ${D}../b.js${D};`), ['../b.js']);
  assert.deepEqual(relativeSpecifiers(`import ${Q}./side${Q};`), ['./side']);
  assert.deepEqual(relativeSpecifiers(`const m = await import(${Q}./dyn.ts${Q});`), ['./dyn.ts']);
  assert.deepEqual(relativeSpecifiers(`import { x } from ${Q}node:fs${Q};`), []);
});

test('npxLines tracks sh fences (also indented ones) and placeholders are accepted', () => {
  const text = ['intro', '   ```sh', `   ${PREFIX} x run <name> --json`, '   ```', '```text', 'npx a', '```', 'npx b'].join('\n');
  assert.deepEqual(npxLines(text), [
    { line: 3, text: `${PREFIX} x run <name> --json`, inSh: true },
    { line: 6, text: 'npx a', inSh: false },
    { line: 8, text: 'npx b', inSh: false },
  ]);
});

test('every rule has a fixture above', () => {
  const source = readFileSync(new URL(import.meta.url), 'utf8');
  for (const rule of Object.keys(RULES)) assert.ok(source.includes(`'${rule}'`), `no test for ${rule}`);
});
