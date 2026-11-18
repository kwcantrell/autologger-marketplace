// gate: runs the checkout's own scripts/check-change.sh --only <checks>, streaming its output.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CommandError } from './repo.ts';
import type { Repo } from './repo.ts';

export const GATE_SCRIPT = 'scripts/check-change.sh';
export const DEFAULT_GATES = ['specs', 'specs-with-code'];

export interface GateCheck {
  status: string; // PASS, FAIL, WARN or SKIP
  check: string;
  message: string;
}

export interface GateResult {
  command: string[];
  exitCode: number;
  checks: GateCheck[];
}

/** check-change.sh prints `STATUS  name  message`, with any extra message lines after it. */
export function parseGateOutput(output: string): GateCheck[] {
  const checks: GateCheck[] = [];
  for (const line of output.split('\n')) {
    const m = /^(PASS|FAIL|WARN|SKIP)\s+(\S+)\s*(.*)$/.exec(line);
    if (m) checks.push({ status: m[1] ?? '', check: m[2] ?? '', message: m[3] ?? '' });
    else if (line !== '' && checks.length > 0) {
      const last = checks[checks.length - 1];
      if (last) last.message += `\n${line}`;
    }
  }
  return checks;
}

/** Runs the gate; each chunk of its stdout and stderr goes to `stream` as it arrives. */
export function gate(repo: Repo, names: readonly string[], base: string | undefined, stream: (text: string) => void): Promise<GateResult> {
  const script = join(repo.root, GATE_SCRIPT);
  if (!existsSync(script)) return Promise.reject(new CommandError(`${GATE_SCRIPT} not found in ${repo.root}`));
  const args = ['--only', (names.length ? names : DEFAULT_GATES).join(',')];
  if (base !== undefined) args.push('--base', base);
  return new Promise((resolve, reject) => {
    const child = spawn(script, args, { cwd: repo.root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      stream(chunk);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => stream(chunk));
    child.on('error', (error) => reject(new CommandError(`could not run ${GATE_SCRIPT}: ${error.message}`)));
    child.on('close', (code) => {
      resolve({
        command: [GATE_SCRIPT, ...args],
        exitCode: code ?? 1, // killed by a signal: a failure
        checks: parseGateOutput(stdout),
      });
    });
  });
}
