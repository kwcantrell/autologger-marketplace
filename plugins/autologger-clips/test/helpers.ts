// Shared test helpers: a synthetic MP4 header (no real video needed), temp dirs, run() with a fake Io.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { run, type Io } from '../src/run.ts';
import type { Runner } from '../src/runner.ts';

const box = (type: string, ...payload: Buffer[]): Buffer => {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const u32 = (...values: number[]): Buffer => {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32BE(v, i * 4));
  return b;
};

export interface Mp4Spec {
  durationS: number;
  /** Frames per second as num/den (e.g. 30000/1001). */
  fpsNum?: number;
  fpsDen?: number;
  width?: number;
  height?: number;
  audio?: boolean;
  /** Put moov after a (fake) mdat, as many cameras do. */
  moovLast?: boolean;
}

/** An MP4 file with only the header boxes probeVideo reads: enough to give a duration, rate and size. */
export function mp4(spec: Mp4Spec): Buffer {
  const movieScale = 1000;
  const mvhd = box('mvhd', u32(0, 0, 0, movieScale, Math.round(spec.durationS * movieScale)), Buffer.alloc(80));
  const num = spec.fpsNum ?? 30;
  const den = spec.fpsDen ?? 1;
  const ts = num; // media timescale: one tick per 1/num s, each frame `den` ticks
  const frames = Math.round((spec.durationS * num) / den);
  const tkhd = box('tkhd', u32(0, 0, 0, 1, 0, 0), Buffer.alloc(8 + 8 + 36), u32((spec.width ?? 1920) * 65536, (spec.height ?? 1080) * 65536));
  const video = box(
    'trak',
    tkhd,
    box(
      'mdia',
      box('mdhd', u32(0, 0, 0, ts, frames * den), Buffer.alloc(4)),
      box('hdlr', u32(0, 0), Buffer.from('vide', 'latin1'), Buffer.alloc(13)),
      box('minf', box('stbl', box('stts', u32(0, 1, frames, den)))),
    ),
  );
  const sound = box('trak', box('mdia', box('mdhd', u32(0, 0, 0, 48000, 48000), Buffer.alloc(4)), box('hdlr', u32(0, 0), Buffer.from('soun', 'latin1'), Buffer.alloc(13))));
  const moov = box('moov', mvhd, video, ...(spec.audio === false ? [] : [sound]));
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\x01isomavc1', 'latin1'));
  const mdat = box('mdat', Buffer.alloc(64));
  return Buffer.concat(spec.moovLast ? [ftyp, mdat, moov] : [ftyp, moov, mdat]);
}

/** A fresh temp dir, removed after the test file. */
export function tempDir(prefix = 'autologger-clips-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Writes an executable shell script. */
export function script(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

export interface Called {
  code: number;
  stdout: string;
  stderr: string;
}

/** Calls run() with a fake Io: env (HOME and the config dir in `home`), cwd, optional runner. */
export async function call(ctx: { env: Record<string, string | undefined>; cwd: string; runner?: Runner; readyTimeoutMs?: number }, ...argv: string[]): Promise<Called> {
  let stdout = '';
  let stderr = '';
  const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env: ctx.env, cwd: ctx.cwd };
  if (ctx.runner) io.runner = ctx.runner;
  if (ctx.readyTimeoutMs !== undefined) io.readyTimeoutMs = ctx.readyTimeoutMs;
  const code = await run(argv, io);
  return { code, stdout, stderr };
}

/** A temp home with HOME and AUTOLOGGER_CLIPS_CONFIG_DIR set, and a work dir. */
export function sandbox(): { home: string; cwd: string; env: Record<string, string | undefined> } {
  const home = tempDir();
  const cwd = join(home, 'work');
  mkdirSync(cwd, { recursive: true });
  return { home, cwd, env: { HOME: home, AUTOLOGGER_CLIPS_CONFIG_DIR: join(home, 'config'), PATH: process.env.PATH } };
}
