// Reads a video file's duration, frame rate, picture size and whether it has sound from its MP4 /
// QuickTime (ISO BMFF) header, with no ffprobe. Only the `moov` box is read, wherever it sits.
// Other containers (WebM, MKV) are not read: `media set --duration` gives their length instead.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export interface Probe {
  /** Seconds, from the movie header. */
  duration_s: number;
  /** Average frames per second of the first video track, when there is one. */
  fps?: number;
  width?: number;
  height?: number;
  has_video: boolean;
  has_audio: boolean;
}

interface Box {
  type: string;
  /** Offset of the payload and its length, within the buffer it was found in. */
  start: number;
  end: number;
}

/** The boxes in buf[from, to). */
function boxes(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) break;
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

const find = (buf: Buffer, box: Box, type: string): Box | undefined => boxes(buf, box.start, box.end).find((b) => b.type === type);

/** Reads `length` bytes at `position` of an open file. */
function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, position + done);
    if (n === 0) break;
    done += n;
  }
  return buf.subarray(0, done);
}

/** The `moov` box of the file, or undefined when the file is not ISO BMFF or has none. */
function readMoov(path: string): { buf: Buffer; box: Box } | undefined {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    let at = 0;
    for (let guard = 0; guard < 10_000 && at + 8 <= size; guard++) {
      const head = readAt(fd, at, 16);
      if (head.length < 8) return undefined;
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let header = 8;
      if (boxSize === 1) {
        if (head.length < 16) return undefined;
        boxSize = Number(head.readBigUInt64BE(8));
        header = 16;
      } else if (boxSize === 0) {
        boxSize = size - at;
      }
      if (guard === 0 && !['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip', 'pnot'].includes(type)) return undefined;
      if (boxSize < header) return undefined;
      if (type === 'moov') {
        if (boxSize > 256 * 1024 * 1024) return undefined;
        const buf = readAt(fd, at + header, boxSize - header);
        return { buf, box: { type, start: 0, end: buf.length } };
      }
      at += boxSize;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Probes an MP4/MOV file; undefined when it is not one or its header cannot be read. */
export function probeVideo(path: string): Probe | undefined {
  let moov;
  try {
    moov = readMoov(path);
  } catch {
    return undefined;
  }
  if (!moov) return undefined;
  const { buf, box } = moov;
  try {
    const mvhd = find(buf, box, 'mvhd');
    if (!mvhd) return undefined;
    const v = buf.readUInt8(mvhd.start);
    const timescale = v === 1 ? buf.readUInt32BE(mvhd.start + 20) : buf.readUInt32BE(mvhd.start + 12);
    const duration = v === 1 ? Number(buf.readBigUInt64BE(mvhd.start + 24)) : buf.readUInt32BE(mvhd.start + 16);
    if (timescale === 0) return undefined;
    const probe: Probe = { duration_s: duration / timescale, has_video: false, has_audio: false };
    for (const trak of boxes(buf, box.start, box.end).filter((b) => b.type === 'trak')) {
      const mdia = find(buf, trak, 'mdia');
      const hdlr = mdia && find(buf, mdia, 'hdlr');
      if (!mdia || !hdlr) continue;
      const handler = buf.toString('latin1', hdlr.start + 8, hdlr.start + 12);
      if (handler === 'soun') probe.has_audio = true;
      if (handler !== 'vide' || probe.has_video) continue;
      probe.has_video = true;
      const tkhd = find(buf, trak, 'tkhd');
      if (tkhd) {
        const tv = buf.readUInt8(tkhd.start);
        const sizeAt = tkhd.start + (tv === 1 ? 88 : 76);
        if (sizeAt + 8 <= tkhd.end) {
          const width = Math.round(buf.readUInt32BE(sizeAt) / 65536);
          const height = Math.round(buf.readUInt32BE(sizeAt + 4) / 65536);
          if (width > 0 && height > 0) Object.assign(probe, { width, height });
        }
      }
      const mdhd = find(buf, mdia, 'mdhd');
      const stts = (() => {
        const minf = find(buf, mdia, 'minf');
        const stbl = minf && find(buf, minf, 'stbl');
        return stbl && find(buf, stbl, 'stts');
      })();
      if (mdhd && stts) {
        const mv = buf.readUInt8(mdhd.start);
        const ts = mv === 1 ? buf.readUInt32BE(mdhd.start + 20) : buf.readUInt32BE(mdhd.start + 12);
        const entries = buf.readUInt32BE(stts.start + 4);
        let samples = 0;
        let ticks = 0;
        for (let i = 0; i < entries && stts.start + 16 + i * 8 <= stts.end; i++) {
          const count = buf.readUInt32BE(stts.start + 8 + i * 8);
          const delta = buf.readUInt32BE(stts.start + 12 + i * 8);
          samples += count;
          ticks += count * delta;
        }
        if (ts > 0 && ticks > 0 && samples > 0) probe.fps = (samples * ts) / ticks;
      }
    }
    return probe;
  } catch {
    return undefined;
  }
}
