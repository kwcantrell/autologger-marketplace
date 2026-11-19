// check: a plugin against the statically checkable parts of CLAUDE.md's "Plugin layout" and
// "The CLI convention". Every finding names the file (and line), the rule, and how to fix it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CommandError, MARKETPLACE_PATH, marketplaceEntries } from './repo.ts';

export const PREFIX = 'npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" --';
export const SHEBANG = '#!/usr/bin/env node';

/** Every rule `check` applies, with the one-line description `--help` and the README show. */
export const RULES = {
  'plugin-manifest': '.claude-plugin/plugin.json exists, is JSON, and its name is the folder name',
  'marketplace-entry': 'marketplace.json lists the plugin with source ./plugins/<name>',
  'package-json': 'package.json exists and is a JSON object',
  'package-private': 'package.json has "private": true',
  'package-type-module': 'package.json has "type": "module"',
  'package-bin': 'package.json "bin" maps the plugin name to a .ts file that exists',
  'bin-shebang': `the bin file starts with ${SHEBANG}`,
  'no-dependencies': 'package.json declares no dependencies of any kind',
  'skills-present': 'skills/<skill>/SKILL.md exists for at least one skill',
  'skill-name': "a skill's frontmatter name is its folder name",
  'skill-command-lines': 'every SKILL.md has at least one npx line in a ```sh block',
  'npx-outside-sh': 'every npx line of a SKILL.md is in a ```sh block (the e2e test runs only those)',
  'npx-offline': 'every skill npx line has --offline',
  'npx-quoted-root': 'every skill npx line passes --package="${CLAUDE_PLUGIN_ROOT}" in double quotes',
  'npx-bin-name': "every skill npx line runs the plugin's own bin",
  'npx-prefix': 'every skill npx line starts with the exact required prefix',
  'npx-chained': 'every skill npx line is one CLI call with plain arguments: no ; & | ` < > $( after the prefix (except <placeholder>s standing alone or filling a quote pair, and a trailing < <placeholder> stdin redirect; \\-continued lines are checked joined)',
  'allowed-tools': 'the skill frontmatter allowed-tools has Bash(<prefix> <bin>:*), or Bash(<prefix> <bin> <command>:*) rules',
  'tests-present': 'test/ has at least one *.test.ts',
  'e2e-test': 'a test runs the SKILL.md command lines through npx',
  'relative-imports': 'relative imports in src/ and test/ use the .ts extension',
  'hooks-cli': "hooks/hooks.json, if present, is valid Claude Code hooks JSON and every command hook runs the plugin's own CLI, unchained; plugin.json declares no hooks",
} as const;

export type Rule = keyof typeof RULES;

export interface Finding {
  plugin: string;
  /** Path relative to the checkout root. */
  file: string;
  line?: number;
  rule: Rule;
  message: string;
  fix: string;
}

export interface CheckResult {
  plugins: string[];
  findings: Finding[];
}

export function formatFinding(f: Finding): string {
  return `${f.file}${f.line === undefined ? '' : `:${f.line}`}: [${f.rule}] ${f.message}\n  fix: ${f.fix}`;
}

function readJson(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Files under `dir` (recursive, skipping node_modules), as paths relative to `dir`. */
function walk(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name)).map((p) => `${entry.name}/${p}`));
    else if (entry.isFile()) out.push(entry.name);
  }
  return out.sort();
}

/** The plugin folders under plugins/ (directories only, sorted). */
export function pluginNames(root: string): string[] {
  const dir = join(root, 'plugins');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Checks one plugin folder, plugins/<name>. */
export function checkPlugin(root: string, name: string): Finding[] {
  const dir = join(root, 'plugins', name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new CommandError(`plugins/${name} does not exist`);
  const rel = `plugins/${name}`;
  const findings: Finding[] = [];
  const add = (file: string, rule: Rule, message: string, fix: string, line?: number) =>
    findings.push({ plugin: name, file, ...(line === undefined ? {} : { line }), rule, message, fix });

  // .claude-plugin/plugin.json
  const manifestFile = `${rel}/.claude-plugin/plugin.json`;
  const manifestPath = join(root, manifestFile);
  if (!existsSync(manifestPath)) {
    add(manifestFile, 'plugin-manifest', 'missing', `create it with "name": "${name}", "version" and "description" (see templates/plugin)`);
  } else {
    const manifest = readJson(manifestPath);
    if (!manifest.ok || !isObject(manifest.value)) {
      add(manifestFile, 'plugin-manifest', `not a JSON object${manifest.ok ? '' : `: ${manifest.error}`}`, 'make it a JSON object with name, version and description');
    } else if (manifest.value.name !== name) {
      add(manifestFile, 'plugin-manifest', `name is ${JSON.stringify(manifest.value.name)}, but the folder is plugins/${name}`, `set "name": "${name}" (or rename the folder to match)`);
    }
    if (manifest.ok && isObject(manifest.value) && manifest.value.hooks !== undefined) {
      checkManifestHooks(manifestFile, readFileSync(manifestPath, 'utf8'), manifest.value.hooks, add);
    }
  }

  // marketplace.json entry
  const entries = marketplaceEntries(root).filter((e) => e.name === name);
  if (entries.length === 0) {
    add(MARKETPLACE_PATH, 'marketplace-entry', `no plugin entry named '${name}', so the plugin never loads`, `add {"name": "${name}", "source": "./plugins/${name}", "description": "..."} to "plugins"`);
  } else {
    for (const entry of entries) {
      if (entry.source !== `./plugins/${name}`) {
        add(MARKETPLACE_PATH, 'marketplace-entry', `the '${name}' entry has source ${JSON.stringify(entry.source)}`, `set "source": "./plugins/${name}"`);
      }
    }
  }

  // package.json
  const pkgFile = `${rel}/package.json`;
  const pkgRead = existsSync(join(root, pkgFile)) ? readJson(join(root, pkgFile)) : null;
  let bin = name;
  let binTarget = 'src/cli.ts';
  if (pkgRead === null || !pkgRead.ok || !isObject(pkgRead.value)) {
    add(
      pkgFile,
      'package-json',
      pkgRead === null ? 'missing' : `not a JSON object${pkgRead.ok ? '' : `: ${pkgRead.error}`}`,
      `create it like templates/plugin/package.json: private, "type": "module", "bin": {"${name}": "src/cli.ts"}`,
    );
  } else {
    const pkg = pkgRead.value;
    if (pkg.private !== true) add(pkgFile, 'package-private', `"private" is ${JSON.stringify(pkg.private) ?? 'missing'}`, 'set "private": true; plugins are never published to npm');
    if (pkg.type !== 'module') add(pkgFile, 'package-type-module', `"type" is ${JSON.stringify(pkg.type) ?? 'missing'}`, 'set "type": "module" so Node runs the .ts source as ES modules');
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
      const deps = pkg[key];
      const names = isObject(deps) ? Object.keys(deps) : Array.isArray(deps) ? deps.map(String) : deps === undefined ? [] : [String(deps)];
      if (names.length === 0) continue;
      add(
        pkgFile,
        'no-dependencies',
        `"${key}" declares ${names.join(', ')}; a plugin's npx run is --offline from a fresh copy with no node_modules, so it cannot install them`,
        key === 'devDependencies'
          ? 'move type-only dev dependencies to the root package.json and remove this field'
          : `remove "${key}" and use Node's standard library instead (see "Dependencies" in CLAUDE.md)`,
      );
    }
    const binField = pkg.bin;
    const target = isObject(binField) ? binField[name] : undefined;
    if (!isObject(binField) || typeof target !== 'string') {
      const keys = isObject(binField) ? Object.keys(binField) : [];
      if (keys.length === 1 && keys[0] !== undefined) bin = keys[0];
      add(pkgFile, 'package-bin', `"bin" has no entry named '${name}' (got ${JSON.stringify(binField) ?? 'nothing'})`, `set "bin": {"${name}": "src/cli.ts"}`);
    } else if (!target.endsWith('.ts')) {
      add(pkgFile, 'package-bin', `bin '${name}' points at ${target}, not a .ts file`, `point it at the TypeScript entry, "src/cli.ts"; nothing compiled is committed`);
    } else if (target.split(/[\\/]/).includes('..') || !existsSync(join(dir, target)) || !statSync(join(dir, target)).isFile()) {
      add(pkgFile, 'package-bin', `bin '${name}' points at ${target}, which does not exist in the plugin`, `create ${rel}/${target} or point "bin" at the plugin's src/cli.ts`);
    } else {
      binTarget = target.replace(/^\.\//, '');
      const first = readFileSync(join(dir, target), 'utf8').split('\n', 1)[0] ?? '';
      if (first.trim() !== SHEBANG) {
        add(`${rel}/${target}`, 'bin-shebang', `first line is ${JSON.stringify(first)}; npx runs the bin as an executable script`, `make the first line exactly ${SHEBANG}`, 1);
      }
    }
  }

  checkSkills(root, rel, bin, add);
  checkHooks(root, rel, bin, binTarget, add);

  // tests
  const testFiles = walk(join(dir, 'test')).filter((f) => f.endsWith('.test.ts'));
  if (testFiles.length === 0) {
    add(`${rel}/test`, 'tests-present', 'no test/*.test.ts, so the root npm test runs nothing for this plugin', 'add unit tests that call run() with a fake Io, like templates/plugin/test/run.test.ts');
  }
  const e2e = testFiles.some((f) => {
    const text = readFileSync(join(dir, 'test', f), 'utf8');
    return text.includes('SKILL.md') && text.includes('CLAUDE_PLUGIN_ROOT') && text.includes('npx') && /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\b/.test(text);
  });
  if (!e2e) {
    add(
      `${rel}/test`,
      'e2e-test',
      'no test reads the SKILL.md command lines and runs them through npx with CLAUDE_PLUGIN_ROOT set',
      'start from templates/plugin/test/cli.test.ts: copy the plugin to a temp dir and run every ```sh npx line of every skill from an unrelated cwd, offline',
    );
  }

  // relative imports
  for (const sub of ['src', 'test']) {
    for (const f of walk(join(dir, sub)).filter((p) => /\.(ts|mts|cts)$/.test(p))) {
      const file = `${rel}/${sub}/${f}`;
      readFileSync(join(root, file), 'utf8')
        .split('\n')
        .forEach((text, index) => {
          const trimmed = text.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
          for (const spec of relativeSpecifiers(text)) {
            if (spec.endsWith('.ts') || spec.endsWith('.json')) continue;
            const js = /\.(m|c)?js$/.test(spec);
            add(
              file,
              'relative-imports',
              js ? `imports '${spec}': there is no compiled .js, Node runs the .ts source` : `imports '${spec}' without an extension, which Node's ES module loader cannot resolve`,
              `import '${js ? spec.replace(/\.(m|c)?js$/, '.ts') : `${spec}.ts`}' instead`,
              index + 1,
            );
          }
        });
    }
  }
  return findings;
}

const IMPORT_PATTERNS = [
  /\bfrom\s*(['"])(\.{1,2}\/[^'"]*)\1/g,
  /^\s*import\s*(['"])(\.{1,2}\/[^'"]*)\1/g,
  /\bimport\s*\(\s*(['"])(\.{1,2}\/[^'"]*)\1/g,
];

/** Relative module specifiers (`./x`, `../x`) imported or re-exported on one source line. */
export function relativeSpecifiers(line: string): string[] {
  return IMPORT_PATTERNS.flatMap((re) => [...line.matchAll(re)].map((m) => m[2] ?? ''));
}

interface SkillLine {
  line: number;
  text: string;
  inSh: boolean;
}

/** Whether a trimmed line ends in an unescaped `\` (an odd number of them), so the shell continues it. */
function continues(trimmed: string): boolean {
  return (/\\+$/.exec(trimmed)?.[0].length ?? 0) % 2 === 1;
}

/**
 * Trimmed lines starting with `npx `, and whether each is inside a ```sh fence. Every such physical
 * line is reported at its own line number, whether or not an earlier line continues into it, so a
 * continuation can never hide an npx line. Inside a ```sh fence, an npx line ending in `\` (trailing
 * spaces ignored) is joined with the lines that continue it the way the shell does: the `\` and the
 * newline are removed with nothing in their place, and the next line keeps its leading whitespace.
 * A line starting with `#` is a comment and continues nothing.
 */
export function npxLines(text: string): SkillLine[] {
  const out: SkillLine[] = [];
  const raw = text.split('\n');
  let fence: string | null = null;
  raw.forEach((line, index) => {
    const trimmed = line.trim();
    const open = /^```\s*(\S*)/.exec(trimmed);
    if (open) {
      fence = fence === null ? (open[1] ?? '') : null;
      return;
    }
    if (!trimmed.startsWith('npx ')) return;
    let command = trimmed;
    if (fence === 'sh') {
      let physical = trimmed;
      for (let next = index + 1; !physical.startsWith('#') && continues(command) && next < raw.length; next++) {
        const following = raw[next] ?? '';
        if (/^```/.test(following.trim())) break;
        command = `${command.slice(0, -1)}${following.trimEnd()}`;
        physical = following.trim();
      }
    }
    out.push({ line: index + 1, text: command.trim(), inSh: fence === 'sh' });
  });
  return out;
}

function frontmatter(text: string): { body: string; fields: Map<string, string> } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(text);
  if (!m) return null;
  const body = m[1] ?? '';
  const fields = new Map<string, string>();
  for (const line of body.split('\n')) {
    const f = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (f && f[1] !== undefined) fields.set(f[1], (f[2] ?? '').trim());
  }
  return { body, fields };
}

type Add = (file: string, rule: Rule, message: string, fix: string, line?: number) => void;

/**
 * Whether a skill frontmatter pre-approves the CLI: the whole CLI (`Bash(<prefix> <bin>:*)`), or one
 * or more of its commands (`Bash(<prefix> <bin> <command>:*)`), so a skill can leave commands that
 * act on the machine to a permission prompt.
 */
function allowsCli(frontmatterBody: string, exact: string): boolean {
  if (frontmatterBody.includes(`Bash(${exact}:*)`)) return true;
  const escaped = exact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`Bash\\(${escaped} [^)\\s][^)]*:\\*\\)`).test(frontmatterBody);
}

function checkSkills(root: string, rel: string, bin: string, add: Add): void {
  const skillsDir = join(root, rel, 'skills');
  const skills = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md'))).map((e) => e.name).sort()
    : [];
  if (skills.length === 0) {
    add(`${rel}/skills`, 'skills-present', 'no skills/<skill>/SKILL.md; a plugin\'s skills are how Claude reaches its CLI', `add skills/${bin}/SKILL.md like templates/plugin/skills/plugin-template/SKILL.md`);
    return;
  }
  const exact = `${PREFIX} ${bin}`;
  const allowed = `Bash(${exact}:*)`;
  for (const skill of skills) {
    const file = `${rel}/skills/${skill}/SKILL.md`;
    const text = readFileSync(join(root, file), 'utf8');
    const fm = frontmatter(text);
    const fmName = fm?.fields.get('name');
    if (fmName !== skill) {
      add(file, 'skill-name', fm === null ? 'no --- frontmatter block' : `frontmatter name is ${JSON.stringify(fmName ?? null)}, but the folder is ${skill}`, `start the file with ---, name: ${skill}, description: ..., allowed-tools: ..., ---`, 1);
    }
    if (fm === null || !fm.fields.has('allowed-tools') || !allowsCli(fm.body, exact)) {
      add(file, 'allowed-tools', `allowed-tools does not allow the CLI prefix, so every command line prompts for permission`, `set allowed-tools: ${allowed}`, 1);
    }
    const lines = npxLines(text);
    if (!lines.some((l) => l.inSh)) {
      add(file, 'skill-command-lines', 'no npx command line in a ```sh block; skills must call the CLI', `add a \`\`\`sh block with a line starting "${exact} "`);
    }
    for (const l of lines) {
      if (!l.inSh) {
        add(file, 'npx-outside-sh', 'npx line outside a ```sh block; the e2e test runs only ```sh lines, so this one is untested', 'put it in a ```sh fenced block', l.line);
      }
      if (l.text === exact || l.text.startsWith(`${exact} `)) {
        const chained = skillLineMeta(l.text.slice(exact.length));
        if (chained !== null) {
          add(
            file,
            'npx-chained',
            `chains ${JSON.stringify(chained)} after the CLI call; a skill command line is one CLI call with plain arguments (the e2e test runs it and allowed-tools pre-approves its prefix)`,
            `make it one CLI call per line, "${exact} <command> [args] --json", and put any extra logic in the CLI`,
            l.line,
          );
        }
        continue;
      }
      if (l.text.startsWith(`${PREFIX} `)) {
        const called = l.text.slice(PREFIX.length + 1).split(/\s+/, 1)[0] ?? '';
        add(file, 'npx-bin-name', `runs '${called}', but this plugin's bin is '${bin}'`, `use "${exact} ..."`, l.line);
        continue;
      }
      let specific = false;
      if (!/(^|\s)--offline(\s|$)/.test(l.text)) {
        specific = true;
        add(file, 'npx-offline', 'missing --offline: with an empty CLAUDE_PLUGIN_ROOT, npx would fetch and run the registry package "undefined"', `use the exact prefix "${PREFIX} ${bin}"`, l.line);
      }
      if (!l.text.includes('--package="${CLAUDE_PLUGIN_ROOT}"')) {
        specific = true;
        add(file, 'npx-quoted-root', '--package is not "${CLAUDE_PLUGIN_ROOT}" in double quotes; the plugin path may contain spaces', `use --package="\${CLAUDE_PLUGIN_ROOT}" exactly, in the prefix "${PREFIX} ${bin}"`, l.line);
      }
      if (!specific) {
        add(file, 'npx-prefix', `does not start with the required prefix "${exact}"`, `rewrite it as "${exact} <command> [args] --json" (the flags, their order and the -- are part of the convention)`, l.line);
      }
    }
  }
}

/**
 * A `hooks` field in plugin.json (an inline hooks object, a path to a hooks file, or an array of
 * paths) is always flagged rather than resolved: the convention keeps a plugin's hooks in exactly
 * one place, hooks/hooks.json, which Claude Code loads on its own and `checkHooks` validates.
 */
function checkManifestHooks(file: string, text: string, hooks: unknown, add: Add): void {
  const line = topLevelKeyLine(text, 'hooks');
  const finding = (message: string, fix: string) => add(file, 'hooks-cli', message, fix, line);
  let paths: string[] | null;
  if (typeof hooks === 'string') {
    paths = [hooks];
  } else if (Array.isArray(hooks) && hooks.length > 0 && hooks.every((h) => typeof h === 'string')) {
    paths = hooks as string[];
  } else {
    paths = null;
  }
  if (paths !== null) {
    const isDefault = (p: string) => p.replace(/^(\$\{CLAUDE_PLUGIN_ROOT\}\/|\.\/)/, '') === 'hooks/hooks.json';
    const others = paths.filter((p) => !isDefault(p));
    finding(
      `"hooks" declares hook files (${paths.map((p) => JSON.stringify(p)).join(', ')}); plugin-builder checks hooks only in hooks/hooks.json`,
      others.length === 0
        ? 'remove the "hooks" field; Claude Code loads hooks/hooks.json without it'
        : `move the hooks from ${others.join(', ')} into hooks/hooks.json and remove the "hooks" field`,
    );
  } else if (isObject(hooks)) {
    finding(
      '"hooks" declares hooks inline; plugin-builder checks hooks only in hooks/hooks.json',
      'move this object to hooks/hooks.json (as {"description": "...", "hooks": {<Event>: [...]}}) and remove the "hooks" field',
    );
  } else {
    finding(`"hooks" is ${JSON.stringify(hooks)}, not a hooks object or hook file paths`, 'remove the "hooks" field and put the plugin\'s hooks in hooks/hooks.json');
  }
}

/**
 * The 1-based line of `key` as a key of the top-level object of the JSON `text`, skipping nested
 * objects and string contents, or undefined when there is none.
 */
export function topLevelKeyLine(text: string, key: string): number | undefined {
  const quoted = JSON.stringify(key);
  let depth = 0;
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') line++;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (depth === 1 && text.slice(i, end + 1) === quoted && /^\s*:/.test(text.slice(end + 1))) return line;
      i = end;
    }
  }
  return undefined;
}

/**
 * Claude Code's hook event names (the keys of "hooks" in hooks/hooks.json), taken from Claude Code
 * 2.1.328 (`claude --version`) on 2026-11-19. A newer event is flagged until it is added here.
 */
export const HOOK_EVENTS: readonly string[] = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Notification', 'UserPromptSubmit', 'UserPromptExpansion',
  'SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact',
  'PreModelSwitch', 'PostModelSwitch', 'PermissionRequest', 'PermissionDenied', 'Setup', 'TeammateIdle', 'TaskCreated',
  'TaskCompleted', 'Elicitation', 'ElicitationResult', 'ConfigChange', 'WorktreeCreate', 'WorktreeRemove',
  'InstructionsLoaded', 'CwdChanged', 'FileChanged', 'DirectoryAdded', 'MessageDisplay',
];

/** Shell metacharacters that would chain, substitute or redirect another command after a CLI call. */
const SHELL_META = /[;&|`<>\n\r]|\$\(/;

/**
 * The first shell metacharacter in `rest` (what follows the npx prefix and bin of a command line),
 * or null when only plain arguments follow. Shared by `hooks-cli` and `npx-chained`.
 */
export function shellMeta(rest: string): string | null {
  return SHELL_META.exec(rest)?.[0] ?? null;
}

/** A skill line's `<placeholder>`: a letter, then letters, digits, `_`, `-`, `.` or spaces. */
const PLACEHOLDER = '<[A-Za-z][\\w .-]*>';

/** What may stand next to a quoted placeholder: whitespace, a line edge or JSON punctuation. */
const QUOTE_EDGE = '[\\s{}\\[\\],:]';

/** A placeholder that is a whole word (whitespace or a line edge on both sides). */
const STANDALONE = new RegExp(`(?<=^|\\s)${PLACEHOLDER}(?=\\s|$)`, 'g');

/** A placeholder filling one quote pair, `"<x>"` or `'<x>'`, with a QUOTE_EDGE or line edge outside it. */
const QUOTED = new RegExp(`(?<=(?:^|${QUOTE_EDGE})(["']))${PLACEHOLDER}(?=\\1(?:$|${QUOTE_EDGE}))`, 'g');

/** One trailing ` < <placeholder>` stdin redirect (at least one space between `<` and the placeholder). */
const STDIN_REDIRECT = new RegExp(`\\s<\\s+${PLACEHOLDER}$`);

/**
 * The shell quoting state just before each character of `text`: `''` outside quotes, `"'"` inside
 * single quotes, `'"'` inside double quotes.
 */
function quoteStates(text: string): string[] {
  const states: string[] = [];
  let state = '';
  for (let i = 0; i < text.length; i++) {
    states.push(state);
    const c = text[i];
    if (state === "'") {
      if (c === "'") state = '';
    } else if (c === '\\') {
      states.push(state);
      i++;
    } else if (state === '"') {
      if (c === '"') state = '';
    } else if (c === "'" || c === '"') {
      state = c;
    }
  }
  return states;
}

/**
 * `shellMeta` for a skill command line, with exceptions the skills rely on and nothing more. Claude
 * fills `<placeholder>`s in before a line runs, so a placeholder is not read as a redirect when it is
 * a whole word (whitespace or a line edge on both sides), or when it fills one quote pair, `"<x>"` or
 * `'<x>'`, that is a real shell quote or a `"…"` string inside a single-quoted (JSON) argument, with
 * whitespace, a line edge or JSON punctuation (`{}[],:`) outside the quotes. A placeholder glued to
 * other text (`<a>/tmp`, `<a><b>`, `<<a>`, `"<a>/tmp"`, `'<a>'x`) is still checked. One trailing
 * ` < <placeholder>` that redirects a file the user named into the CLI's stdin (autologger-mcp's
 * `import-tokens`, which must never take its secret as an argument) is allowed; it runs no other
 * command. Pipes, a `<` mid-line, or a `<` from a literal path are still flagged.
 */
export function skillLineMeta(rest: string): string | null {
  const line = rest.replace(STDIN_REDIRECT, '');
  const states = quoteStates(line);
  const spans: Array<[number, number]> = [];
  for (const m of line.matchAll(STANDALONE)) spans.push([m.index, m.index + m[0].length]);
  for (const m of line.matchAll(QUOTED)) {
    const quote = m[1];
    const before = states[m.index - 1];
    // a real opening quote, or a "…" string inside single quotes (where the placeholder is literal)
    if (before === '' || (quote === '"' && before === "'")) spans.push([m.index, m.index + m[0].length]);
  }
  let kept = '';
  let at = 0;
  for (const [from, to] of spans.sort((a, b) => a[0] - b[0])) {
    if (from < at) continue;
    kept += line.slice(at, from);
    at = to;
  }
  return shellMeta(kept + line.slice(at));
}

/** Claude Code's hook handler types. Only `command` hooks run a program, so only they must run the CLI. */
export const HOOK_TYPES: readonly string[] = ['command', 'prompt', 'agent', 'http', 'mcp_tool'];

/**
 * hooks/hooks.json: `{"description"?, "hooks": {<Event>: [{"matcher"?, "hooks": [<hook>...]}]}}`.
 * A command hook must run the plugin's own CLI, either in exec form (`"command": "node"`,
 * `"args": ["${CLAUDE_PLUGIN_ROOT}/<bin file>", ...]`, so the path never reaches a shell), or as a
 * shell command that is the convention's npx prefix and the plugin's bin followed only by plain
 * arguments (no `shellMeta` character, so nothing is chained, substituted or redirected), or the
 * same npx words in exec form. Any other command would put logic outside the tested CLI.
 */
function checkHooks(root: string, rel: string, bin: string, binTarget: string, add: Add): void {
  const file = `${rel}/hooks/hooks.json`;
  const path = join(root, file);
  if (!existsSync(path)) return;
  const nodeArg = `\${CLAUDE_PLUGIN_ROOT}/${binTarget}`;
  const exact = `${PREFIX} ${bin}`;
  const execForm = `{"type": "command", "command": "node", "args": ["${nodeArg}", "<command>"]}`;
  const finding = (message: string, fix: string, line?: number) => add(file, 'hooks-cli', message, fix, line);
  const read = readJson(path);
  if (!read.ok) {
    const line = /line (\d+)/.exec(read.error)?.[1];
    finding(`not valid JSON: ${read.error}`, 'fix the JSON syntax; Claude Code does not load a plugin hooks file it cannot parse', line === undefined ? undefined : Number(line));
    return;
  }
  const doc = read.value;
  if (!isObject(doc) || !isObject(doc.hooks)) {
    finding('has no "hooks" object', `make it {"description": "...", "hooks": {"<Event>": [{"hooks": [${execForm}]}]}}`);
    return;
  }
  if (doc.description !== undefined && typeof doc.description !== 'string') finding('"description" is not a string', 'make "description" one sentence of text, or remove it');
  for (const [event, groups] of Object.entries(doc.hooks)) {
    const at = `hooks.${event}`;
    if (!HOOK_EVENTS.includes(event)) {
      finding(`${at}: '${event}' is not a Claude Code hook event`, `use one of ${HOOK_EVENTS.join(', ')} (names are case-sensitive)`);
      continue;
    }
    if (!Array.isArray(groups) || groups.length === 0) {
      finding(`${at} is not a non-empty array of matcher groups`, `make it [{"matcher": "<tool pattern, optional>", "hooks": [${execForm}]}]`);
      continue;
    }
    groups.forEach((group: unknown, g) => {
      const gat = `${at}[${g}]`;
      if (!isObject(group) || !Array.isArray(group.hooks) || group.hooks.length === 0) {
        finding(`${gat} has no non-empty "hooks" array`, `make it {"matcher": "<optional>", "hooks": [${execForm}]}`);
        return;
      }
      if (group.matcher !== undefined && typeof group.matcher !== 'string') finding(`${gat}.matcher is not a string`, 'make "matcher" a string (a tool name or pattern), or remove it to match everything');
      group.hooks.forEach((hook: unknown, h) => {
        const hat = `${gat}.hooks[${h}]`;
        if (!isObject(hook) || typeof hook.type !== 'string' || !HOOK_TYPES.includes(hook.type)) {
          const type = isObject(hook) ? JSON.stringify(hook.type) ?? 'missing' : 'not an object';
          finding(`${hat}: "type" is ${type}`, `use a hook object with "type" one of ${HOOK_TYPES.join(', ')}; a command hook looks like ${execForm}`);
          return;
        }
        if (hook.timeout !== undefined && !(typeof hook.timeout === 'number' && hook.timeout > 0)) finding(`${hat}.timeout is ${JSON.stringify(hook.timeout)}`, 'make "timeout" a positive number of seconds, or remove it');
        for (const key of ['async', 'once'] as const) {
          if (hook[key] !== undefined && typeof hook[key] !== 'boolean') finding(`${hat}.${key} is ${JSON.stringify(hook[key])}`, `make "${key}" true or false, or remove it`);
        }
        if (hook.type !== 'command') return;
        const command = hook.command;
        const args = hook.args;
        if (typeof command !== 'string' || command.trim() === '') {
          finding(`${hat}: a command hook with no "command" string`, `make it ${execForm}`);
          return;
        }
        if (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === 'string'))) {
          finding(`${hat}.args is not an array of strings`, `make it ${execForm}`);
          return;
        }
        const argv = (args ?? []) as string[];
        const prefixWords = [...PREFIX.split(' ').slice(1).map((w) => w.replace(/"/g, '')), bin];
        const runsCli =
          args !== undefined
            ? (command === 'node' && argv[0] === nodeArg) || (command === 'npx' && prefixWords.every((w, i) => argv[i] === w))
            : command === exact || command.startsWith(`${exact} `);
        const chained = args === undefined && runsCli ? shellMeta(command.slice(exact.length)) : null;
        if (chained !== null) {
          finding(
            `${hat} chains ${JSON.stringify(chained)} after the CLI call in a shell command; only the npx prefix, the plugin's bin, its command and plain arguments are allowed`,
            `put the extra logic in the CLI and use exec form, which runs no shell: ${execForm}`,
          );
          return;
        }
        if (runsCli) return;
        const shown = args === undefined ? JSON.stringify(command) : JSON.stringify([command, ...argv]);
        finding(
          `${hat} runs ${shown}, not the plugin's own CLI; hook logic belongs in the tested CLI`,
          args === undefined && /^node\s/.test(command)
            ? `use exec form so the plugin path never reaches a shell: ${execForm}`
            : `add a CLI command for it and run it as ${execForm} (or "command": "${exact} <command>")`,
        );
      });
    });
  }
}

/** Checks the named plugins, or every plugin folder plus every marketplace entry when `names` is null. */
export function check(root: string, names: readonly string[] | null): CheckResult {
  const plugins = names === null ? pluginNames(root) : [...names];
  const findings = plugins.flatMap((name) => checkPlugin(root, name));
  if (names === null) {
    for (const entry of marketplaceEntries(root)) {
      const listed = typeof entry.name === 'string' ? entry.name : JSON.stringify(entry.name);
      if (!plugins.includes(listed)) {
        findings.push({
          plugin: listed,
          file: MARKETPLACE_PATH,
          rule: 'marketplace-entry',
          message: `lists '${listed}', but there is no plugins/${listed} folder`,
          fix: `remove the entry or create the plugin with plugin-builder new ${listed}`,
        });
      }
    }
  }
  return { plugins, findings };
}
