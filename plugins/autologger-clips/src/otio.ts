// OpenTimelineIO (.otio JSON) writer: Timeline.1 > Stack.1 > a video Track.1 and its audio Track.1,
// each a run of Clip.2 (ExternalReference.1 to the session's video file) and Gap.1 items. Times are
// RationalTime.1 frame counts at the sequence rate. A title card is a Gap named after the session
// plus a timeline marker (OTIO has no text item; OpenReel imports the marker). OpenReel's own link
// metadata (`metadata.openreel.linkId` / `linkedAudioOf`) makes it fold the audio back into each clip.
import type { Plan, PlanClip } from './clips.ts';
import { fpsOf, secondsToFrames } from './timecode.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export interface OtioOptions {
  title: string;
}

export function serializeOtio(plan: Plan, options: OtioOptions): string {
  const fps = fpsOf(plan.rate);
  const rt = (value: number): JsonObject => ({ OTIO_SCHEMA: 'RationalTime.1', rate: fps, value });
  const range = (start: number, duration: number): JsonObject => ({ OTIO_SCHEMA: 'TimeRange.1', duration: rt(duration), start_time: rt(start) });

  const clipJson = (c: PlanClip, n: number): JsonObject => {
    const m = c.media;
    const available = m.duration_s !== null ? range(0, secondsToFrames(m.duration_s, plan.rate)) : null;
    return {
      OTIO_SCHEMA: 'Clip.2',
      name: c.name,
      source_range: range(c.in_frame, c.out_frame - c.in_frame),
      media_references: {
        DEFAULT_MEDIA: {
          OTIO_SCHEMA: 'ExternalReference.1',
          name: m.name,
          target_url: m.url,
          available_range: available,
          available_image_bounds: null,
          metadata: {},
        },
      },
      active_media_reference_key: 'DEFAULT_MEDIA',
      effects: [],
      markers: [],
      enabled: true,
      metadata: {
        autologger_clips: { session_id: c.session_id, session_start_s: c.session_start_s, session_end_s: c.session_end_s, from: c.from },
        openreel: { linkId: `link-${n}` },
      },
    };
  };
  const gapJson = (name: string, frames: number): JsonObject => ({
    OTIO_SCHEMA: 'Gap.1',
    name,
    source_range: range(0, frames),
    effects: [],
    markers: [],
    enabled: true,
    metadata: {},
  });
  const track = (name: string, kind: 'Video' | 'Audio', withAudioOnly: boolean): JsonObject => {
    const children: Json[] = [];
    let n = 0;
    for (const item of plan.items) {
      if (item.kind === 'title') {
        children.push(gapJson(item.text, item.frames));
        continue;
      }
      n++;
      if (withAudioOnly && item.media.probe !== null && !item.media.probe.has_audio) {
        children.push(gapJson('', item.out_frame - item.in_frame));
        continue;
      }
      children.push(clipJson(item, n));
    }
    return {
      OTIO_SCHEMA: 'Track.1',
      name,
      kind,
      children,
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      metadata: kind === 'Audio' ? { openreel: { linkedAudioOf: 'V1' } } : {},
    };
  };
  const markers: Json[] = plan.items
    .filter((i) => i.kind === 'title')
    .map((t) => ({
      OTIO_SCHEMA: 'Marker.2',
      name: t.kind === 'title' ? t.text : '',
      color: 'RED',
      comment: '',
      marked_range: range(t.record_frame, 0),
      metadata: {},
    }));
  const root: JsonObject = {
    OTIO_SCHEMA: 'Timeline.1',
    name: options.title,
    global_start_time: rt(0),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [track('V1', 'Video', false), track('A1', 'Audio', true)],
      source_range: null,
      effects: [],
      markers,
      enabled: true,
      metadata: {},
    },
    metadata: {
      autologger_clips: { fps: plan.rate.label },
      openreel: { rate: { timebase: plan.rate.timebase, ntsc: plan.rate.den === 1001, dropFrame: plan.rate.dropFrame } },
    },
  };
  return `${JSON.stringify(root, null, 2)}\n`;
}
