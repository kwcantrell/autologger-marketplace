// Session timecodes as autologger computes them (packages/domain/src/timecode.ts in autologger-2):
// frames are counted at the rounded frame rate, and `;` is the separator for 29.97 "drop-frame"
// (autologger's frame math is not true SMPTE drop-frame, so `01:11:20;17` at 29.97 is
// `(1×3600 + 11×60 + 20) × 30 + 17` frames). And recording takes: the internal `Recording N
// Started` / `Recording N Stopped` rows, paired as autologger's `recordedTakes` pairs them.
import type { Rec } from './copy.ts';

const TIMECODE_RE = /^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/;
const TAKE_RE = /^Recording (\d+) (Started|Stopped)$/;

/** The rate frames are counted at: the frame rate rounded (at least 1). */
export function countRate(fps: number): number {
  return Math.max(1, Math.round(Math.round(fps * 1000) / 1000));
}

export function isDropFrameRate(fps: number): boolean {
  return Math.abs(fps - 29.97) < 0.001 * 29.97;
}

export const validRate = (fps: unknown): fps is number => typeof fps === 'number' && Number.isFinite(fps) && fps > 0;

/** `HH:MM:SS:FF` / `HH:MM:SS;FF` as total frames at `fps`, or undefined when malformed or out of range. */
export function parseTimecode(text: unknown, fps: number): number | undefined {
  if (typeof text !== 'string') return undefined;
  const m = TIMECODE_RE.exec(text);
  if (m === null) return undefined;
  const [h, mi, s, f] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  const rate = countRate(fps);
  if (h > 23 || mi > 59 || s > 59 || f >= rate) return undefined;
  return ((h * 60 + mi) * 60 + s) * rate + f;
}

/** Total frames at `fps` as autologger formats them (hours wrap at 24, `;` at 29.97). */
export function formatTimecode(total: number, fps: number): string {
  const rate = countRate(fps);
  const f = total % rate;
  let t = Math.floor(total / rate);
  const s = t % 60;
  t = Math.floor(t / 60);
  const m = t % 60;
  const h = Math.floor(t / 60) % 24;
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)}${isDropFrameRate(fps) ? ';' : ':'}${p2(f)}`;
}

/**
 * Total frames at `from` converted through seconds to `to`: the frame of `to` that holds the same
 * instant (rounded down), exact when both count at the same rate.
 */
export function convertFrames(total: number, from: number, to: number): number {
  const a = countRate(from);
  const b = countRate(to);
  return a === b ? total : Math.floor((total * b) / a);
}

/** An event row's timecode as total frames at `fps` (its `timecode_total_frames`, else its `timecode`). */
export function rowFrames(row: Rec, fps: number): number | undefined {
  const tf = row.timecode_total_frames;
  if (typeof tf === 'number' && Number.isInteger(tf) && tf >= 0) return tf;
  return parseTimecode(row.timecode, fps);
}

/** A source event's frame rate: its own `frame_rate`, else the session's. */
export function eventRate(event: Rec, sessionFps: number | undefined): number | undefined {
  return validRate(event.frame_rate) ? event.frame_rate : sessionFps;
}

export interface TakeRow {
  ordinal: number;
  kind: 'started' | 'stopped';
}

/** A take row: an `internal` event whose message is `Recording N Started` or `Recording N Stopped`. */
export function takeRow(event: Rec): TakeRow | undefined {
  if (typeof event.category !== 'string' || event.category.toLowerCase() !== 'internal') return undefined;
  const m = typeof event.message === 'string' ? TAKE_RE.exec(event.message) : null;
  if (m === null) return undefined;
  return { ordinal: Number(m[1]), kind: m[2] === 'Started' ? 'started' : 'stopped' };
}

export interface TakePairs {
  /** Closed takes in the order they started: the index of the Started and of the Stopped row. */
  pairs: { started: number; stopped: number }[];
  /** Take rows that are in no closed take, by index, with the reason. */
  unpaired: Map<number, string>;
}

/**
 * The closed takes of a session's events, paired as autologger's `recordedTakes` pairs them: in
 * wall-time order (a Started before a Stopped at the same wall, then by event id), first in first
 * out per ordinal N. Rows with no timecode or an unparseable wall are in no take.
 */
export function pairTakes(events: readonly Rec[], sessionFps: number | undefined): TakePairs {
  const marks: { index: number; ord: number; kind: 'started' | 'stopped'; wall: number; id: string }[] = [];
  const unpaired = new Map<number, string>();
  events.forEach((event, index) => {
    const take = takeRow(event);
    if (take === undefined) return;
    const fps = eventRate(event, sessionFps);
    const wall = typeof event.wall_time_utc === 'string' ? Date.parse(event.wall_time_utc) : Number.NaN;
    if (fps === undefined || rowFrames(event, fps) === undefined || Number.isNaN(wall)) {
      unpaired.set(index, 'a take row with no timecode or wall time in the snapshot; a take is only copied whole');
      return;
    }
    marks.push({ index, ord: take.ordinal, kind: take.kind, wall, id: typeof event.event_id === 'string' ? event.event_id : '' });
  });
  marks.sort((a, b) => a.wall - b.wall || (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'started' ? -1 : 1));
  const open = new Map<number, number[]>();
  const pairs: TakePairs['pairs'] = [];
  for (const mark of marks) {
    const queue = open.get(mark.ord) ?? [];
    open.set(mark.ord, queue);
    if (mark.kind === 'started') {
      queue.push(mark.index);
      continue;
    }
    const started = queue.shift();
    if (started === undefined) {
      unpaired.set(mark.index, `Recording ${mark.ord} Stopped has no Recording ${mark.ord} Started before it in the snapshot; a take is only copied whole`);
    } else {
      pairs.push({ started, stopped: mark.index });
    }
  }
  for (const [ord, queue] of open) {
    for (const index of queue) unpaired.set(index, `Recording ${ord} Started has no Recording ${ord} Stopped after it in the snapshot (the take was still recording); a take is only copied closed`);
  }
  pairs.sort((a, b) => marks.findIndex((m) => m.index === a.started) - marks.findIndex((m) => m.index === b.started));
  return { pairs, unpaired };
}
