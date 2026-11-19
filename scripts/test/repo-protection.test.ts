import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CI_CHECK, CI_WORKFLOW } from '../harden-repo.ts';

// Line-based checks of the repo protection files, so a change that breaks them fails `npm test`
// (there is no YAML parser among the dev dependencies, and none is added for this).
const repo = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string): string => readFileSync(join(repo, path), 'utf8');
const workflows = readdirSync(join(repo, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f));

test('every action in every workflow is pinned to a full commit SHA with its tag in a comment', () => {
  assert.ok(workflows.length > 0);
  for (const file of workflows) {
    const uses = read(join('.github', 'workflows', file))
      .split('\n')
      .filter((l) => /^\s*-?\s*uses:/.test(l));
    assert.ok(uses.length > 0, `${file} has no uses:`);
    for (const line of uses) {
      assert.match(line, /^\s*-?\s*uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/, `${file}: not SHA-pinned with a tag comment: ${line.trim()}`);
    }
  }
});

test('the CI workflow runs on main, reads only, and its job id is the required check name', () => {
  const ci = read(CI_WORKFLOW);
  assert.match(ci, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {4}branches: \[main\]\n/m);
  assert.match(ci, /^permissions:\n {2}contents: read\n\n/m);
  // No other permissions block anywhere (no job asks for more).
  assert.equal(ci.match(/permissions:/g)?.length, 1);
  assert.match(ci, new RegExp(`^jobs:\\n {2}${CI_CHECK}:\\n`, 'm'));
  assert.doesNotMatch(ci, /^ {4}name:/m, 'a job name would replace the job id as the check name');
  assert.match(ci, /node-version: 24\n/);
  for (const step of ['npm ci', 'npm run typecheck', 'npm test', 'node plugins/plugin-builder/src/cli.ts check --all']) {
    assert.match(ci, new RegExp(`^ {8}run: ${step.replace(/[.]/g, '\\.')}$`, 'm'), `missing step: ${step}`);
  }
});

test('Dependabot updates npm and github-actions at / weekly, one grouped PR each', () => {
  const dependabot = read('.github/dependabot.yml');
  for (const ecosystem of ['npm', 'github-actions']) {
    const block = new RegExp(
      `- package-ecosystem: ${ecosystem}\\n {4}directory: /\\n {4}schedule:\\n {6}interval: weekly\\n {4}groups:\\n {6}[\\w-]+:\\n {8}patterns: \\["\\*"\\]`,
    );
    assert.match(dependabot, block, `no weekly grouped entry for ${ecosystem}`);
  }
});

test('CODEOWNERS names the maintainer for everything, and SECURITY.md routes reports privately', () => {
  assert.match(read('.github/CODEOWNERS'), /^\* @kwcantrell$/m);
  const security = read('SECURITY.md');
  assert.match(security, /private vulnerability reporting/);
  assert.match(security, /security\/advisories\/new/);
  assert.match(security, /Never open a public issue/);
  assert.match(security, /No secret ever belongs in an issue/);
  assert.match(security, /`autologger-mcp`/);
  assert.match(security, /`autologger-dev`/);
  assert.match(read('README.md'), /SECURITY\.md/);
});
