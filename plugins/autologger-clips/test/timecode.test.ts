import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fcpTime, frameDuration, nearestRate, parseRate, secondsToFrames, timecode } from '../src/timecode.ts';

test('29.97 is drop-frame; 29.97ndf is not; both are 30000/1001', () => {
  const df = parseRate('29.97');
  const ndf = parseRate('29.97ndf');
  assert.deepEqual([df.num, df.den, df.dropFrame, ndf.dropFrame], [30000, 1001, true, false]);
  assert.equal(frameDuration(df), '1001/30000s');
  assert.equal(frameDuration(parseRate('24')), '1/24s');
});

test('drop-frame timecode skips frame numbers 0 and 1 at each minute but every tenth', () => {
  const r = parseRate('29.97');
  assert.equal(timecode(1799, r), '00:00:59;29');
  assert.equal(timecode(1800, r), '00:01:00;02');
  assert.equal(timecode(17982, r), '00:10:00;00');
  assert.equal(timecode(107892, r), '01:00:00;00');
  assert.equal(timecode(1800, parseRate('29.97ndf')), '00:01:00:00');
  assert.equal(timecode(4 * 60 * 60 * 24 + 36, parseRate('24')), '04:00:01:12');
});

test('times are reduced rationals of whole frames', () => {
  const r = parseRate('29.97');
  assert.equal(fcpTime(0, r), '0s');
  assert.equal(fcpTime(1, r), '1001/30000s');
  assert.equal(fcpTime(30, r), '1001/1000s');
  assert.equal(fcpTime(17982, r), '2999997/5000s');
  assert.equal(fcpTime(48, parseRate('24')), '2s');
  assert.equal(fcpTime(246, parseRate('24')), '41/4s');
  assert.equal(secondsToFrames(600, r), 17982);
  assert.equal(secondsToFrames(10.25, parseRate('24')), 246);
});

test('nearestRate maps measured rates to standard ones', () => {
  assert.equal(nearestRate(29.97002997)?.label, '29.97');
  assert.equal(nearestRate(25.0)?.label, '25');
  assert.equal(nearestRate(23.976)?.label, '23.976');
  assert.equal(nearestRate(17), undefined);
});

test('--fps rejects unknown rates as a usage error', () => {
  assert.throws(() => parseRate('29'), /--fps must be one of 23\.976, 24, 25, 29\.97, 29\.97ndf, 30/);
});
