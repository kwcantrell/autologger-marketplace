// Fixture autologger checkouts for the tests: a temp dir, `git init`, a small lifecycle.yaml with
// spec_paths, specs and source files, committed on `main`, with HEAD on a `work` branch.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const LIFECYCLE = `# fixture lifecycle config
schema: spec-driven
context: 'a multi-line

  quoted value

  '
lifecycle:
  commands:
    test: npm test
    lint: ''
  test_globs:
  - '**/test/**'
  - '**/*.test.*'
  managed_paths:
  - scripts/check-change.sh
  - src/generated.ts
  spec_paths:
    alpha:
    - src/alpha/**
    - src/shared.ts
    beta:
    # a comment inside the list
    - "src/beta*.ts"
    - src/shared.ts
`;

export const GOOD_SPEC = (name: string) => `# ${name} Specification

## Purpose
What ${name} does.

## Requirements

### Requirement: It works

The system SHALL work.

#### Scenario: Working

- **WHEN** it runs
- **THEN** it works
`;

// Prints its arguments as a PASS line (or a FAIL line), and exits with $FAKE_GATE_EXIT.
export const FAKE_GATE = `#!/bin/sh
echo "args: $*" >&2
if [ "\${FAKE_GATE_EXIT:-0}" = 0 ]; then
  echo "PASS  specs            fake gate ok"
else
  echo "FAIL  specs            fake gate failed"
  echo "docs/specs/alpha.md: missing something"
fi
exit "\${FAKE_GATE_EXIT:-0}"
`;

export const FILES: Record<string, string> = {
  'scripts/lifecycle.yaml': LIFECYCLE,
  'scripts/check-change.sh': FAKE_GATE,
  'docs/specs/README.md': '# Specs\n\nNot a spec.\n',
  'docs/specs/alpha.md': GOOD_SPEC('alpha'),
  'docs/specs/beta.md': GOOD_SPEC('beta'),
  'src/alpha/a.ts': 'export const a = 1;\n',
  'src/alpha/deep/b.ts': 'export const b = 1;\n',
  'src/alpha/test/a.test.ts': 'test\n',
  'src/beta1.ts': 'export const beta = 1;\n',
  'src/shared.ts': 'export const shared = 1;\n',
  'src/generated.ts': 'export const generated = 1;\n',
  'src/other.ts': 'export const other = 1;\n',
};

export interface Fixture {
  root: string;
  write: (path: string, text: string) => void;
  git: (...args: string[]) => string;
  cleanup: () => void;
}

export function gitIn(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A committed fixture checkout on branch `work`, branched from `main`. `files` overrides FILES (null removes). */
export function fixture(files: Record<string, string | null> = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autologger-specs-fixture-')));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const [path, text] of Object.entries({ ...FILES, ...files })) if (text !== null) write(path, text);
  if (existsSync(join(root, 'scripts/check-change.sh'))) chmodSync(join(root, 'scripts/check-change.sh'), 0o755);
  gitIn(root, 'init', '-q', '-b', 'main');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-qm', 'fixture');
  gitIn(root, 'checkout', '-q', '-b', 'work');
  return {
    root,
    write,
    git: (...args) => gitIn(root, ...args),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
