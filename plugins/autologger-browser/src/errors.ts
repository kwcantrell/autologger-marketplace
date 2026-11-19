// Errors the CLI turns into exit codes: 1 for a failed command, 2 for a usage error.

/** A command failed (exit 1). The message is shown as `autologger-browser: <message>` on stderr. */
export class CliError extends Error {
  readonly exitCode: 1 | 2 = 1;
}

/** Bad arguments or options (exit 2). */
export class UsageError extends CliError {
  override readonly exitCode = 2 as const;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
