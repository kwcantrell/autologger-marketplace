// timeline and compile: clip list + media map -> an FCPXML 1.10 or OTIO file, and a report of what
// was merged, clamped and dropped.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { buildPlan, parseClipList, type Plan } from './clips.ts';
import { CliError, UsageError } from './errors.ts';
import { serializeFcpxml } from './fcpxml.ts';
import { loadMap, type Env } from './media.ts';
import { serializeOtio } from './otio.ts';
import { probeVideo } from './probe.ts';
import { DEFAULT_RATE, fcpTime, nearestRate, timecode, type FrameRate } from './timecode.ts';

export type Format = 'fcpxml' | 'otio';

export function formatOf(out: string): Format {
  const ext = extname(out).toLowerCase();
  if (ext === '.fcpxml') return 'fcpxml';
  if (ext === '.otio') return 'otio';
  throw new UsageError(`--out must end in .fcpxml or .otio, got '${out}'`);
}

export interface BuildOptions {
  clips: string;
  out: string;
  /** --fps, or undefined for the first clip's video rate (else 30). */
  rate?: FrameRate;
  pad: number;
  order: 'list' | 'date';
  titleCards: boolean;
  titleSeconds: number;
  title?: string;
  cwd: string;
  env: Env;
}

export interface BuildReport {
  out: string;
  format: Format;
  fps: string;
  frame_duration: string;
  drop_frame: boolean;
  duration_frames: number;
  duration: string;
  duration_tc: string;
  clips: {
    position: number;
    from: number[];
    session_id: string;
    name: string;
    file: string;
    session_start_s: number;
    session_end_s: number;
    video_in_s: number;
    video_out_s: number;
    source_in: string;
    source_out: string;
    record_in: string;
    source_in_tc: string;
    source_out_tc: string;
    record_in_tc: string;
  }[];
  title_cards: { position: number; session_id: string; text: string; record_in_tc: string }[];
  merged: Plan['merged'];
  clamped: Plan['clamped'];
  dropped: Plan['dropped'];
  warnings: string[];
  /** For the web editor: import these media files first (it relinks by file name), then the timeline. */
  media_files: string[];
}

export function buildTimeline(options: BuildOptions): BuildReport {
  const format = formatOf(options.out);
  const clipsPath = resolve(options.cwd, options.clips);
  if (!existsSync(clipsPath)) throw new UsageError(`--clips file ${clipsPath} does not exist`);
  const clips = parseClipList(readFileSync(clipsPath, 'utf8'), basename(clipsPath));
  const map = loadMap(options.env);
  const probeCache = new Map<string, ReturnType<typeof probeVideo>>();
  const probe = (path: string): ReturnType<typeof probeVideo> => {
    if (!probeCache.has(path)) probeCache.set(path, existsSync(path) ? probeVideo(path) : undefined);
    return probeCache.get(path);
  };
  const missingFiles = [...new Set(clips.map((c) => c.session_id))]
    .map((s) => map.sessions[s])
    .filter((e) => e !== undefined && !existsSync(e.path));
  if (missingFiles.length > 0) {
    throw new CliError(`mapped video file${missingFiles.length > 1 ? 's' : ''} missing: ${missingFiles.map((e) => `${e?.session_id} -> ${e?.path}`).join(', ')}; map the session again with media set or media fetch`);
  }
  let rate = options.rate;
  const warnings: string[] = [];
  if (rate === undefined) {
    const first = map.sessions[clips[0]?.session_id ?? ''];
    const fps = first ? probe(first.path)?.fps : undefined;
    rate = fps !== undefined ? (nearestRate(fps) ?? DEFAULT_RATE) : DEFAULT_RATE;
    if (fps === undefined) warnings.push(`the first clip's video frame rate is unknown; the timeline uses ${rate.label} fps (pass --fps to choose)`);
  }
  const plan = buildPlan(clips, map.sessions, { rate, pad: options.pad, order: options.order, titleCards: options.titleCards, titleSeconds: options.titleSeconds, probe });
  const out = resolve(options.cwd, options.out);
  const title = options.title ?? basename(clipsPath, extname(clipsPath));
  const text = format === 'fcpxml' ? serializeFcpxml(plan, { title }) : serializeOtio(plan, { title });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);

  const r = plan.rate;
  const report: BuildReport = {
    out,
    format,
    fps: r.label,
    frame_duration: `${r.den}/${r.num}s`,
    drop_frame: r.dropFrame,
    duration_frames: plan.duration_frames,
    duration: fcpTime(plan.duration_frames, r),
    duration_tc: timecode(plan.duration_frames, r),
    clips: [],
    title_cards: [],
    merged: plan.merged,
    clamped: plan.clamped,
    dropped: plan.dropped,
    warnings: [...warnings, ...plan.warnings],
    media_files: plan.media.map((m) => m.path),
  };
  plan.items.forEach((item, i) => {
    if (item.kind === 'title') {
      report.title_cards.push({ position: i + 1, session_id: item.session_id, text: item.text, record_in_tc: timecode(item.record_frame, r) });
      return;
    }
    report.clips.push({
      position: i + 1,
      from: item.from,
      session_id: item.session_id,
      name: item.name,
      file: item.media.path,
      session_start_s: item.session_start_s,
      session_end_s: item.session_end_s,
      video_in_s: item.video_in_s,
      video_out_s: item.video_out_s,
      source_in: fcpTime(item.in_frame, r),
      source_out: fcpTime(item.out_frame, r),
      record_in: fcpTime(item.record_frame, r),
      source_in_tc: timecode(item.in_frame, r),
      source_out_tc: timecode(item.out_frame, r),
      record_in_tc: timecode(item.record_frame, r),
    });
  });
  return report;
}

export function summary(report: BuildReport): string {
  const lines = [
    `Wrote ${report.out} (${report.format}, ${report.fps} fps, ${report.clips.length} clip${report.clips.length === 1 ? '' : 's'}${report.title_cards.length ? `, ${report.title_cards.length} title cards` : ''}, ${report.duration_tc}).`,
  ];
  for (const c of report.clips) lines.push(`  ${c.record_in_tc}  ${c.session_id} ${c.source_in_tc}-${c.source_out_tc}  ${c.name}`);
  for (const m of report.merged) lines.push(`merged clips ${m.from.join(', ')} (session ${m.session_id})`);
  for (const c of report.clamped) lines.push(`clamped clip ${c.from.join(', ')} (session ${c.session_id}) to video ${c.kept_video_s[0]}-${c.kept_video_s[1]} s`);
  for (const d of report.dropped) lines.push(`dropped clip ${d.from.join(', ')} (session ${d.session_id}): ${d.reason}`);
  for (const w of report.warnings) lines.push(`warning: ${w}`);
  return `${lines.join('\n')}\n`;
}
