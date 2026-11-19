// The clip list (session time ranges the agent picked) and the plan built from it: padding, merging
// of overlapping or adjacent ranges in one session, session time to video time, clamping to the
// video's length, frame snapping, ordering and title cards. Writers (FCPXML, OTIO) only lay it out.
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliError } from './errors.ts';
import { SESSION_ID, type MediaEntry } from './media.ts';
import type { Probe } from './probe.ts';
import { fpsOf, secondsToFrames, type FrameRate } from './timecode.ts';

/** One entry of the clip list file (see schema/clip-list.schema.json). Other fields are ignored. */
export interface ClipInput {
  session_id: string;
  /** Session time in seconds. */
  start_s: number;
  end_s: number;
  label?: string;
  /** ISO date (or date-time) of the session, for compile's date order. */
  session_date?: string;
  session_title?: string;
}

export const MAX_CLIPS = 10_000;
export const MAX_LABEL = 200;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Text that is safe in XML 1.0 and short: control characters removed, whitespace collapsed. */
export function cleanText(text: string, max = MAX_LABEL): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f￾￿]|[\ud800-\udfff]/gu, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Parses and checks a clip list. Its text is data: nothing in it is run or followed. */
export function parseClipList(text: string, file: string): ClipInput[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new CliError(`${file} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (isObject(data) && Array.isArray(data.clips)) data = data.clips;
  if (!Array.isArray(data)) throw new CliError(`${file} must be a JSON array of clips ({session_id, start_s, end_s, label?})`);
  if (data.length === 0) throw new CliError(`${file} has no clips`);
  if (data.length > MAX_CLIPS) throw new CliError(`${file} has ${data.length} clips; at most ${MAX_CLIPS}`);
  return data.map((raw, i) => {
    const where = `${file}: clip ${i + 1}`;
    if (!isObject(raw)) throw new CliError(`${where} is not an object`);
    const { session_id: id, start_s: start, end_s: end, label, session_date: date, session_title: title } = raw;
    if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new CliError(`${where}: session_id must be a session id string`);
    if (typeof start !== 'number' || !Number.isFinite(start)) throw new CliError(`${where}: start_s must be a number of seconds`);
    if (typeof end !== 'number' || !Number.isFinite(end)) throw new CliError(`${where}: end_s must be a number of seconds`);
    if (end <= start) throw new CliError(`${where}: end_s (${end}) must be after start_s (${start})`);
    if (label !== undefined && label !== null && typeof label !== 'string') throw new CliError(`${where}: label must be a string`);
    if (date !== undefined && date !== null && (typeof date !== 'string' || Number.isNaN(Date.parse(date)))) {
      throw new CliError(`${where}: session_date must be an ISO date string`);
    }
    if (title !== undefined && title !== null && typeof title !== 'string') throw new CliError(`${where}: session_title must be a string`);
    const clip: ClipInput = { session_id: id, start_s: start, end_s: end };
    if (typeof label === 'string' && cleanText(label) !== '') clip.label = cleanText(label);
    if (typeof date === 'string') clip.session_date = date;
    if (typeof title === 'string' && cleanText(title) !== '') clip.session_title = cleanText(title);
    return clip;
  });
}

export interface PlanMedia {
  /** Resource id in the timeline file: r2, r3, ... */
  key: string;
  session_id: string;
  path: string;
  /** file:// URL of the path. */
  url: string;
  /** File name, which OpenReel's web editor relinks by. */
  name: string;
  offset_s: number;
  /** Video length in seconds, or null when unknown (no clamping at the end then). */
  duration_s: number | null;
  probe: Probe | null;
}

export interface PlanClip {
  kind: 'clip';
  /** 1-based input positions this clip came from (several when merged). */
  from: number[];
  session_id: string;
  name: string;
  media: PlanMedia;
  /** Session range after padding and merging. */
  session_start_s: number;
  session_end_s: number;
  /** Video range in seconds, after clamping (before frame snapping). */
  video_in_s: number;
  video_out_s: number;
  /** Source in/out (exclusive) in frames of the sequence rate. */
  in_frame: number;
  out_frame: number;
  /** Where the clip starts on the timeline, in frames. */
  record_frame: number;
}

export interface PlanTitle {
  kind: 'title';
  session_id: string;
  text: string;
  record_frame: number;
  frames: number;
}

export type PlanItem = PlanClip | PlanTitle;

export interface Plan {
  rate: FrameRate;
  items: PlanItem[];
  media: PlanMedia[];
  duration_frames: number;
  merged: { from: number[]; session_id: string; session_start_s: number; session_end_s: number }[];
  clamped: { from: number[]; session_id: string; requested_video_s: [number, number]; kept_video_s: [number, number] }[];
  dropped: { from: number[]; session_id: string; requested_video_s: [number, number]; reason: string }[];
  warnings: string[];
}

export interface PlanOptions {
  rate: FrameRate;
  /** Seconds added before and after every range, before merging. */
  pad: number;
  order: 'list' | 'date';
  titleCards: boolean;
  titleSeconds: number;
  probe: (path: string) => Probe | undefined;
}

interface Range {
  from: number[];
  session_id: string;
  start: number;
  end: number;
  labels: string[];
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export function buildPlan(clips: readonly ClipInput[], entries: Readonly<Record<string, MediaEntry>>, options: PlanOptions): Plan {
  const { rate } = options;
  const sessions = [...new Set(clips.map((c) => c.session_id))];
  const missing = sessions.filter((s) => entries[s] === undefined);
  if (missing.length > 0) {
    throw new CliError(
      `no video is mapped for session${missing.length > 1 ? 's' : ''} ${missing.join(', ')}; map one with \`media set <session_id> <video file>\` (or \`media fetch\` for a YouTube import), then run this again`,
    );
  }

  const warnings: string[] = [];
  const media = new Map<string, PlanMedia>();
  sessions.forEach((s, i) => {
    const entry = entries[s] as MediaEntry;
    const probe = options.probe(entry.path) ?? null;
    const duration = entry.duration_s ?? probe?.duration_s ?? null;
    if (duration === null) warnings.push(`the length of ${entry.path} (session ${s}) is unknown (not an MP4/MOV header this CLI reads, and no --duration was given to media set); ranges are not clamped at its end`);
    media.set(s, { key: `r${i + 2}`, session_id: s, path: entry.path, url: pathToFileURL(entry.path).href, name: basename(entry.path), offset_s: entry.offset_s, duration_s: duration, probe });
  });

  // Pad, then merge overlapping or adjacent ranges (closer than half a frame) within each session.
  const halfFrame = 0.5 / fpsOf(rate);
  const merged: Range[] = [];
  const mergedReport: Plan['merged'] = [];
  for (const s of sessions) {
    const own = clips
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.session_id === s)
      .map(({ c, i }): Range => ({ from: [i + 1], session_id: s, start: c.start_s - options.pad, end: c.end_s + options.pad, labels: c.label ? [c.label] : [] }))
      .sort((a, b) => a.start - b.start || a.from[0]! - b.from[0]!);
    let current: Range | undefined;
    for (const r of own) {
      if (current && r.start <= current.end + halfFrame) {
        current.end = Math.max(current.end, r.end);
        current.from.push(...r.from);
        for (const l of r.labels) if (!current.labels.includes(l)) current.labels.push(l);
      } else {
        if (current) merged.push(current);
        current = { ...r, from: [...r.from], labels: [...r.labels] };
      }
    }
    if (current) merged.push(current);
  }
  for (const r of merged) {
    r.from.sort((a, b) => a - b);
    if (r.from.length > 1) mergedReport.push({ from: r.from, session_id: r.session_id, session_start_s: round6(r.start), session_end_s: round6(r.end) });
  }

  // Order: list order (a merged clip takes the place of its first entry), or session date then time.
  if (options.order === 'list') {
    merged.sort((a, b) => a.from[0]! - b.from[0]!);
  } else {
    const dateOf = new Map<string, number>();
    const titleOf = new Map<string, string>();
    for (const c of clips) {
      if (c.session_date !== undefined && !dateOf.has(c.session_id)) dateOf.set(c.session_id, Date.parse(c.session_date));
      if (c.session_title !== undefined && !titleOf.has(c.session_id)) titleOf.set(c.session_id, c.session_title);
    }
    const undated = sessions.filter((s) => !dateOf.has(s));
    if (undated.length > 0) {
      throw new CliError(`session${undated.length > 1 ? 's' : ''} ${undated.join(', ')} ha${undated.length > 1 ? 've' : 's'} no session_date in the clip list; add session_date (the moments' session_date) or use --order list`);
    }
    const firstSeen = (s: string): number => sessions.indexOf(s);
    merged.sort((a, b) => dateOf.get(a.session_id)! - dateOf.get(b.session_id)! || firstSeen(a.session_id) - firstSeen(b.session_id) || a.start - b.start);
  }

  const titleText = (s: string): string => {
    const title = clips.find((c) => c.session_id === s && c.session_title !== undefined)?.session_title ?? s;
    const date = clips.find((c) => c.session_id === s && c.session_date !== undefined)?.session_date;
    return cleanText(date !== undefined ? `${title} (${date.slice(0, 10)})` : title);
  };

  const items: PlanItem[] = [];
  const clamped: Plan['clamped'] = [];
  const dropped: Plan['dropped'] = [];
  const titleFrames = Math.max(1, secondsToFrames(options.titleSeconds, rate));
  let cursor = 0;
  let lastSession: string | undefined;
  for (const r of merged) {
    const m = media.get(r.session_id) as PlanMedia;
    const wantIn = r.start - m.offset_s;
    const wantOut = r.end - m.offset_s;
    const max = m.duration_s ?? Infinity;
    const vin = Math.max(0, wantIn);
    const vout = Math.min(max, wantOut);
    const requested: [number, number] = [round6(wantIn), round6(wantOut)];
    if (vout <= vin) {
      dropped.push({ from: r.from, session_id: r.session_id, requested_video_s: requested, reason: wantOut <= 0 ? 'ends before the video starts' : 'starts after the video ends' });
      continue;
    }
    if (vin !== wantIn || vout !== wantOut) clamped.push({ from: r.from, session_id: r.session_id, requested_video_s: requested, kept_video_s: [round6(vin), round6(vout)] });
    let inF = secondsToFrames(vin, rate);
    let outF = secondsToFrames(vout, rate);
    const maxF = m.duration_s === null ? Infinity : Math.floor((m.duration_s * rate.num) / rate.den + 1e-9);
    if (outF > maxF) outF = maxF;
    if (outF <= inF) {
      if (inF + 1 <= maxF) outF = inF + 1;
      else inF = outF - 1;
    }
    if (options.titleCards && r.session_id !== lastSession) {
      items.push({ kind: 'title', session_id: r.session_id, text: titleText(r.session_id), record_frame: cursor, frames: titleFrames });
      cursor += titleFrames;
    }
    lastSession = r.session_id;
    items.push({
      kind: 'clip',
      from: r.from,
      session_id: r.session_id,
      name: r.labels.length > 0 ? cleanText(r.labels.join(' / ')) : `${r.session_id} ${formatClock(r.start)}`,
      media: m,
      session_start_s: round6(r.start),
      session_end_s: round6(r.end),
      video_in_s: round6(vin),
      video_out_s: round6(vout),
      in_frame: inF,
      out_frame: outF,
      record_frame: cursor,
    });
    cursor += outF - inF;
  }
  if (!items.some((i) => i.kind === 'clip')) throw new CliError('no clip is left: every range falls outside its video (see the offsets with media list)');
  const used = new Set(items.filter((i): i is PlanClip => i.kind === 'clip').map((c) => c.session_id));
  return { rate, items, media: [...media.values()].filter((m) => used.has(m.session_id)), duration_frames: cursor, merged: mergedReport, clamped, dropped, warnings };
}

/** 754.5 -> "12:34.5" (for default clip names). */
function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = round6(s % 60);
  const ss = `${rest < 10 ? '0' : ''}${rest}`;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
