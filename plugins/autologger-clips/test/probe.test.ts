import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { probeVideo } from '../src/probe.ts';
import { mp4, tempDir } from './helpers.ts';

const dir = tempDir();

test('reads duration, rate, size and sound from an MP4 header', () => {
  const file = join(dir, 'a.mp4');
  writeFileSync(file, mp4({ durationS: 90, fpsNum: 30000, fpsDen: 1001, width: 1280, height: 720 }));
  const p = probeVideo(file);
  assert.equal(p?.duration_s, 90);
  assert.ok(Math.abs((p?.fps ?? 0) - 29.97003) < 0.001, String(p?.fps));
  assert.deepEqual([p?.width, p?.height, p?.has_video, p?.has_audio], [1280, 720, true, true]);
});

test('finds moov after mdat, and a file with no sound', () => {
  const file = join(dir, 'b.mov');
  writeFileSync(file, mp4({ durationS: 12.5, fpsNum: 24, audio: false, moovLast: true }));
  const p = probeVideo(file);
  assert.deepEqual([p?.duration_s, p?.fps, p?.has_audio], [12.5, 24, false]);
});

test('anything else is undefined, not an error', () => {
  const file = join(dir, 'c.webm');
  writeFileSync(file, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]));
  assert.equal(probeVideo(file), undefined);
  writeFileSync(join(dir, 'empty.mp4'), '');
  assert.equal(probeVideo(join(dir, 'empty.mp4')), undefined);
});
