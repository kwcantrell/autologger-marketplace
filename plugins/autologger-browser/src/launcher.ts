// The Chromium the launcher runs, and the launcher itself: a /bin/sh script passed to agent-browser
// as --executable-path whose only job is to point Chromium at the slot's private NSS database. It
// sets HOME and XDG_DATA_HOME for the Chromium process to the slot's own home folder (Chromium on
// Linux opens $XDG_DATA_HOME/pki/nssdb, or $HOME/.pki/nssdb when that exists) and execs the real
// Chromium with agent-browser's arguments unchanged. No flag is added, so certificate verification
// stays on; only Chromium started through this file sees the dev CA.
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { type Env, homeDir, type SlotPaths, shellQuote } from './slot.ts';

/** Executable names tried on PATH, in order, when AGENT_BROWSER_EXECUTABLE_PATH does not name one. */
export const CHROMIUM_NAMES = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome'] as const;

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real Chromium: AGENT_BROWSER_EXECUTABLE_PATH (what agent-browser itself would launch) when it
 * is an absolute executable that is not one of this plugin's launchers, else the first of
 * CHROMIUM_NAMES on PATH; null when there is none.
 */
export function findChromium(env: Env, launchers: readonly string[] = []): string | null {
  const configured = env.AGENT_BROWSER_EXECUTABLE_PATH;
  if (configured !== undefined && isAbsolute(configured) && !launchers.includes(configured) && !configured.endsWith('/chromium-launcher.sh') && isExecutable(configured)) {
    return configured;
  }
  for (const name of CHROMIUM_NAMES) {
    for (const dir of (env.PATH ?? '').split(delimiter)) {
      if (dir === '' || !isAbsolute(dir)) continue;
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** The launcher's text for the slot. */
export function launcherScript(paths: SlotPaths, chromium: string, env: Env): string {
  const xauthority = join(homeDir(env), '.Xauthority');
  return [
    '#!/bin/sh',
    `# Written by autologger-browser setup for dev slot ${paths.slot}; autologger-browser reset removes it.`,
    '# Its only job: run Chromium with HOME and XDG_DATA_HOME pointing at this slot\'s own folder, so',
    "# Chromium uses this slot's private NSS database (which trusts the autologger dev CA) instead of",
    "# the user's. Arguments are passed to Chromium unchanged; nothing turns certificate checks off.",
    '# With HOME changed, X11 would look for ~/.Xauthority in the wrong place, so keep the real one.',
    `if [ -z "\${XAUTHORITY:-}" ] && [ -f ${shellQuote(xauthority)} ]; then XAUTHORITY=${shellQuote(xauthority)}; export XAUTHORITY; fi`,
    `HOME=${shellQuote(paths.home)}`,
    `XDG_DATA_HOME=${shellQuote(join(paths.home, '.local', 'share'))}`,
    'export HOME XDG_DATA_HOME',
    `exec ${shellQuote(chromium)} "$@"`,
    '',
  ].join('\n');
}
