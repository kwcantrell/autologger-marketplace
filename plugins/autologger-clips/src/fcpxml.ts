// FCPXML 1.10 writer: one primary storyline (spine) with one asset-clip per planned clip, each
// pointing at its session's video file (asset + media-rep) with frame-exact start/duration. A title
// card is a gap carrying a connected Basic Title and a marker with the same text (OpenReel imports
// the marker; Final Cut and Resolve show the title).
import type { Plan, PlanClip, PlanMedia, PlanTitle } from './clips.ts';
import { fcpTime, frameDuration, nearestRate, secondsToFrames, type FrameRate } from './timecode.ts';

export const FCPXML_VERSION = '1.10';
export const BASIC_TITLE_UID = '.../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti';

export function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const attrs = (pairs: Record<string, string | undefined>): string =>
  Object.entries(pairs)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join('');

/** Final Cut's format name for common sizes and rates, else undefined (a custom format). */
function formatName(width: number, height: number, r: FrameRate): string | undefined {
  const rates: Record<string, string> = { '23.976': '2398', '24': '24', '25': '25', '29.97': '2997', '30': '30', '50': '50', '59.94': '5994', '60': '60' };
  const code = rates[r.label.replace(/ndf$/, '')];
  const size = width === 1920 && height === 1080 ? '1080p' : width === 1280 && height === 720 ? '720p' : width === 3840 && height === 2160 ? '2160p' : undefined;
  return code !== undefined && size !== undefined ? `FFVideoFormat${size}${code}` : undefined;
}

export interface FcpxmlOptions {
  /** Project name (the clip list's file name by default). */
  title: string;
}

export function serializeFcpxml(plan: Plan, options: FcpxmlOptions): string {
  const r = plan.rate;
  const first = plan.media.find((m) => m.probe?.width !== undefined);
  const width = first?.probe?.width ?? 1920;
  const height = first?.probe?.height ?? 1080;
  const lines: string[] = [];
  const w = (depth: number, text: string): void => {
    lines.push(`${'  '.repeat(depth)}${text}`);
  };

  // Formats: the sequence's (r1), then one per other media rate or size.
  const formats: { id: string; rate: FrameRate; width: number; height: number }[] = [{ id: 'r1', rate: r, width, height }];
  const formatOf = (m: PlanMedia): string => {
    const mr = m.probe?.fps !== undefined ? (nearestRate(m.probe.fps) ?? r) : r;
    const mw = m.probe?.width ?? width;
    const mh = m.probe?.height ?? height;
    const same = formats.find((f) => f.rate.num === mr.num && f.rate.den === mr.den && f.width === mw && f.height === mh);
    if (same) return same.id;
    const id = `f${formats.length + 1}`;
    formats.push({ id, rate: mr, width: mw, height: mh });
    return id;
  };
  const assetFormat = new Map(plan.media.map((m) => [m.key, formatOf(m)]));
  const titles = plan.items.filter((i): i is PlanTitle => i.kind === 'title');

  w(0, '<?xml version="1.0" encoding="UTF-8"?>');
  w(0, '<!DOCTYPE fcpxml>');
  w(0, `<fcpxml version="${FCPXML_VERSION}">`);
  w(1, '<resources>');
  for (const f of formats) {
    w(2, `<format${attrs({ id: f.id, name: formatName(f.width, f.height, f.rate), frameDuration: frameDuration(f.rate), width: String(f.width), height: String(f.height) })}/>`);
  }
  for (const m of plan.media) {
    const fid = assetFormat.get(m.key) as string;
    const lastUse = Math.max(...plan.items.filter((i): i is PlanClip => i.kind === 'clip' && i.media === m).map((c) => c.out_frame));
    const durationFrames = m.duration_s !== null ? secondsToFrames(m.duration_s, r) : lastUse;
    const hasAudio = m.probe ? m.probe.has_audio : true;
    w(
      2,
      `<asset${attrs({
        id: m.key,
        name: m.name,
        start: '0s',
        duration: fcpTime(Math.max(durationFrames, lastUse), r),
        hasVideo: '1',
        format: fid,
        hasAudio: hasAudio ? '1' : '0',
        videoSources: '1',
        audioSources: hasAudio ? '1' : undefined,
        audioChannels: hasAudio ? '2' : undefined,
        audioRate: hasAudio ? '48000' : undefined,
      })}>`,
    );
    w(3, `<media-rep${attrs({ kind: 'original-media', src: m.url })}/>`);
    w(3, `<metadata>`);
    w(4, `<md${attrs({ key: 'com.apple.proapps.studio.reel', value: m.session_id })}/>`);
    w(3, `</metadata>`);
    w(2, '</asset>');
  }
  if (titles.length > 0) w(2, `<effect${attrs({ id: 'rTitle', name: 'Basic Title', uid: BASIC_TITLE_UID })}/>`);
  w(1, '</resources>');
  w(1, '<library>');
  w(2, `<event${attrs({ name: 'autologger-clips' })}>`);
  w(3, `<project${attrs({ name: options.title })}>`);
  w(
    4,
    `<sequence${attrs({ format: 'r1', duration: fcpTime(plan.duration_frames, r), tcStart: '0s', tcFormat: r.dropFrame ? 'DF' : 'NDF', audioLayout: 'stereo', audioRate: '48k' })}>`,
  );
  w(5, '<spine>');
  let styleId = 0;
  for (const item of plan.items) {
    if (item.kind === 'clip') {
      w(
        6,
        `<asset-clip${attrs({
          ref: item.media.key,
          offset: fcpTime(item.record_frame, r),
          name: item.name,
          start: fcpTime(item.in_frame, r),
          duration: fcpTime(item.out_frame - item.in_frame, r),
          format: assetFormat.get(item.media.key),
          tcFormat: r.dropFrame ? 'DF' : 'NDF',
        })}/>`,
      );
    } else {
      const ts = `ts${++styleId}`;
      w(6, `<gap${attrs({ name: item.text, offset: fcpTime(item.record_frame, r), start: '0s', duration: fcpTime(item.frames, r) })}>`);
      w(7, `<title${attrs({ ref: 'rTitle', lane: '1', offset: '0s', name: item.text, start: '0s', duration: fcpTime(item.frames, r) })}>`);
      w(8, `<text><text-style${attrs({ ref: ts })}>${escapeXml(item.text)}</text-style></text>`);
      w(8, `<text-style-def${attrs({ id: ts })}>`);
      w(9, `<text-style${attrs({ font: 'Helvetica', fontSize: '72', fontColor: '1 1 1 1', alignment: 'center' })}/>`);
      w(8, '</text-style-def>');
      w(7, '</title>');
      w(7, `<marker${attrs({ start: '0s', duration: fcpTime(1, r), value: item.text })}/>`);
      w(6, '</gap>');
    }
  }
  w(5, '</spine>');
  w(4, '</sequence>');
  w(3, '</project>');
  w(2, '</event>');
  w(1, '</library>');
  w(0, '</fcpxml>');
  return `${lines.join('\n')}\n`;
}
