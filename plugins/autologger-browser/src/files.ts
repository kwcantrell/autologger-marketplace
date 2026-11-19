// File operations on this plugin's own folder: directories are created mode 700 and never followed
// through a symlink, and the launcher is replaced atomically.
import { randomBytes } from 'node:crypto';
import { chmodSync, type Stats, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CliError } from './errors.ts';

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Makes sure `path` is a real directory (not a symlink) with mode 700, creating it when missing.
 * The parent must already exist.
 */
export function ensurePrivateDir(path: string): void {
  const stat = lstatOrNull(path);
  if (stat === null) {
    mkdirSync(path, { mode: 0o700 });
  } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new CliError(`refusing to use ${path}: it is ${stat.isSymbolicLink() ? 'a symlink' : 'not a directory'}; this plugin only uses a real directory there`);
  }
  chmodSync(path, 0o700);
}

/**
 * `mkdir -p` one level at a time: creates each missing directory of `path` with mode 700, and
 * throws when an existing component is not a directory. Not `mkdirSync(path, { recursive: true })`:
 * on Node 24 that never returns when mkdir keeps failing with ENOENT although the parent exists (as
 * under /proc), so setup would hang; here that ENOENT is thrown. An existing component may be a
 * symlink to a directory (a symlinked HOME is normal); this plugin's own folders below are checked
 * by ensurePrivateDir, which refuses symlinks.
 */
export function ensureDirs(path: string): void {
  const mkdir = (dir: string): void => {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stat: Stats;
      try {
        stat = statSync(dir);
      } catch {
        throw new CliError(`refusing to use ${dir}: it is a broken symlink, not a directory`);
      }
      if (!stat.isDirectory()) throw new CliError(`refusing to use ${dir}: it is not a directory`);
    }
  };
  try {
    mkdir(path);
  } catch (error) {
    const parent = dirname(path);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path) throw error;
    ensureDirs(parent);
    mkdir(path);
  }
}

/** True when `path` is a regular file holding exactly `text`. */
export function fileHolds(path: string, text: string): boolean {
  const stat = lstatOrNull(path);
  if (stat === null || !stat.isFile()) return false;
  return readFileSync(path, 'utf8') === text;
}

/** Replaces `path` with `text` (mode `mode`) through a temp file and rename; refuses a symlink or directory there. */
export function writeFileAtomic(path: string, text: string, mode: number): void {
  const existing = lstatOrNull(path);
  if (existing !== null && !existing.isFile()) throw new CliError(`refusing to write ${path}: it is not a regular file`);
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  let renamed = false;
  try {
    try {
      fchmodSync(fd, mode);
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        unlinkSync(temp);
      } catch {
        // Already gone.
      }
    }
  }
}

/** Makes `link` a symlink to `target` (relative), unless it already is one; refuses anything else there. */
export function ensureSymlink(link: string, target: string): void {
  const stat = lstatOrNull(link);
  if (stat === null) {
    symlinkSync(target, link);
    return;
  }
  if (stat.isSymbolicLink() && readlinkSync(link) === target) return;
  throw new CliError(`refusing to use ${link}: it is not the symlink to ${target} that setup makes; run reset for this slot and setup again`);
}
