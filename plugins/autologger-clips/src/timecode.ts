// Frame rates, frame-exact times and SMPTE timecode. Every time written to a timeline is a whole
// number of frames of the sequence rate; seconds are only used at the boundary with the clip list.
import { UsageError } from './errors.ts';

export interface FrameRate {
  /** The name `--fps` takes and the report prints: 24, 29.97, 29.97ndf, ... */
  readonly label: string;
  /** Exact rate as num/den frames per second (30000/1001 for 29.97). */
  readonly num: number;
  readonly den: number;
  /** Nominal frames per second used for timecode counting (24, 25, 30, 60...). */
  readonly timebase: number;
  /** Drop-frame timecode (29.97 and 59.94 only). */
  readonly dropFrame: boolean;
}

const rate = (label: string, num: number, den: number, timebase: number, dropFrame = false): FrameRate => ({ label, num, den, timebase, dropFrame });

/** Every rate `--fps` accepts. 29.97 and 59.94 count drop-frame timecode, as broadcast and Final Cut do by default. */
export const RATES: readonly FrameRate[] = [
  rate('23.976', 24000, 1001, 24),
  rate('24', 24, 1, 24),
  rate('25', 25, 1, 25),
  rate('29.97', 30000, 1001, 30, true),
  rate('29.97ndf', 30000, 1001, 30),
  rate('30', 30, 1, 30),
  rate('50', 50, 1, 50),
  rate('59.94', 60000, 1001, 60, true),
  rate('59.94ndf', 60000, 1001, 60),
  rate('60', 60, 1, 60),
];

export const DEFAULT_RATE = RATES.find((r) => r.label === '30') as FrameRate;

export function parseRate(value: string): FrameRate {
  const found = RATES.find((r) => r.label === value.trim().toLowerCase());
  if (!found) throw new UsageError(`--fps must be one of ${RATES.map((r) => r.label).join(', ')}; got '${value}'`);
  return found;
}

/** The standard rate nearest to a measured one (within 0.012 fps), or undefined. Drop-frame for 29.97/59.94. */
export function nearestRate(fps: number): FrameRate | undefined {
  let best: FrameRate | undefined;
  let error = Infinity;
  for (const r of RATES) {
    if (r.label.endsWith('ndf')) continue;
    const e = Math.abs(r.num / r.den - fps);
    if (e < error) {
      best = r;
      error = e;
    }
  }
  return error < 0.012 ? best : undefined;
}

export const fpsOf = (r: FrameRate): number => r.num / r.den;

/** Seconds to the nearest whole frame. */
export const secondsToFrames = (seconds: number, r: FrameRate): number => Math.round((seconds * r.num) / r.den + 1e-9);

export const framesToSeconds = (frames: number, r: FrameRate): number => (frames * r.den) / r.num;

const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));

/** FCPXML rational time for `frames` frames: "0s", "3s", "1001/30000s" (reduced). */
export function fcpTime(frames: number, r: FrameRate): string {
  if (frames === 0) return '0s';
  const n = frames * r.den;
  const g = gcd(n, r.num);
  const rn = n / g;
  const rd = r.num / g;
  return rd === 1 ? `${rn}s` : `${rn}/${rd}s`;
}

/** The duration of one frame as FCPXML time: "1001/30000s", "1/24s". */
export const frameDuration = (r: FrameRate): string => `${r.den}/${r.num}s`;

const pad = (value: number): string => String(value).padStart(2, '0');

/** SMPTE timecode of a frame count: HH:MM:SS:FF, or HH:MM:SS;FF for drop-frame. */
export function timecode(totalFrames: number, r: FrameRate): string {
  if (!Number.isInteger(totalFrames) || totalFrames < 0) throw new Error(`frame count must be a non-negative integer, got ${totalFrames}`);
  let frames = totalFrames;
  if (r.dropFrame) {
    const drop = Math.round(r.timebase / 15); // 2 at 29.97, 4 at 59.94
    const perMinute = r.timebase * 60 - drop;
    const perTenMinutes = r.timebase * 600 - drop * 9;
    const blocks = Math.floor(frames / perTenMinutes);
    const rest = frames % perTenMinutes;
    frames += drop * 9 * blocks;
    if (rest > drop) frames += drop * Math.floor((rest - drop) / perMinute);
  }
  const tb = r.timebase;
  const ff = frames % tb;
  const ss = Math.floor(frames / tb) % 60;
  const mm = Math.floor(frames / (tb * 60)) % 60;
  const hh = Math.floor(frames / (tb * 3600));
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${r.dropFrame ? ';' : ':'}${pad(ff)}`;
}
