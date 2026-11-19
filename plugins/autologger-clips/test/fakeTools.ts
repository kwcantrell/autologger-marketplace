// Fake git and pnpm on PATH for the editor tests (unit and end to end): no network, no real install.
// `pnpm dev` starts a tiny HTTP server on the port it is given, under a shell named pnpm (so the
// process this CLI records really is "pnpm").
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { script } from './helpers.ts';

export const FAKE_SHA = '0123456789abcdef0123456789abcdef01234567';

export function fakeTools(bin: string): { log: string } {
  mkdirSync(bin, { recursive: true });
  const log = join(bin, 'calls.log');
  script(
    bin,
    'git',
    `echo "git $*" >> "${log}"
case "$1" in
  --version) echo "git version 2.43.0" ;;
  clone) for last; do :; done; mkdir -p "$last" ;;
  -C)
    dir="$2"
    case "$3 $4 $5 $6" in
      *checkout*) for last; do :; done; echo "$last" > "$dir/.ref" ;;
      "rev-parse HEAD"*) ref=$(cat "$dir/.ref"); case "$ref" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) echo "$ref" ;; *) echo "${FAKE_SHA}" ;; esac ;;
    esac ;;
  *) exit 1 ;;
esac`,
  );
  const server = join(bin, 'fake-dev-server.mjs');
  writeFileSync(
    server,
    `import { createServer } from 'node:http';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<title>OpenReel</title>')).listen(port, '127.0.0.1');
`,
  );
  script(
    bin,
    'pnpm',
    `echo "pnpm $* (in $PWD)" >> "${log}"
case "$1" in
  --version) echo "9.15.0" ;;
  install) [ -n "$FAKE_PNPM_INSTALL_FAIL" ] && { echo "ERR_PNPM_FAKE" >&2; exit 1; }; echo "Packages: +1234"; mkdir -p node_modules ;;
  dev) [ -n "$FAKE_PNPM_DEV_FAIL" ] && { echo "vite: port in use" >&2; exit 3; }; node "${server}" "$@" ;;
  *) exit 1 ;;
esac`,
  );
  return { log };
}
