import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { analyzeAudioFile, parseLoudnessCurve } from '../../src/audio/analyzer.js';

// Lines as ffmpeg 9 prints them with ebur128=framelog=info (captured from a real 7 s, -27.8 LUFS tone)
const FRAMES = [
  '[Parsed_ebur128_0 @ 0x7905008d80] t: 0.0999773  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU  FTPK: -24.1 dBFS  TPK: -24.1 dBFS',
  '[Parsed_ebur128_0 @ 0x7905008d80] t: 2.699977   TARGET:-23 LUFS    M: -27.8 S:-120.7     I: -27.8 LUFS       LRA:   0.0 LU  FTPK: -24.1 dBFS  TPK: -24.1 dBFS',
  '[Parsed_ebur128_0 @ 0x7905008d80] t: 3.299977   TARGET:-23 LUFS    M: -26.0 S: -27.1     I: -27.8 LUFS       LRA:   1.5 LU  FTPK: -24.1 dBFS  TPK: -24.1 dBFS',
  '[Parsed_ebur128_0 @ 0x7905008d80] t: 6.999977   TARGET:-23 LUFS    M: -27.8 S: -27.8     I: -27.8 LUFS       LRA:   2.0 LU  FTPK: -24.1 dBFS  TPK: -24.1 dBFS'
].join('\n');

test('the loudness curve reads ffmpeg frame lines: the floor is not a measurement, the maxima cover every frame, the range is the last one', () => {
  const curve = parseLoudnessCurve(`${FRAMES}\n[Parsed_ebur128_0 @ 0x1] Summary:\n  I: -27.8 LUFS`)!;
  assert.deepEqual(curve.points.map((p) => p.time_seconds), [0.1, 2.7, 3.3, 7]);
  assert.deepEqual(curve.points[0], { time_seconds: 0.1, momentary_lufs: null, short_term_lufs: null });
  assert.deepEqual(curve.points[2], { time_seconds: 3.3, momentary_lufs: -26, short_term_lufs: -27.1 });
  assert.equal(curve.max_momentary_lufs, -26);
  assert.equal(curve.max_short_term_lufs, -27.1);
  assert.equal(curve.loudness_range_lu, 2);
  assert.equal(parseLoudnessCurve('no frames here'), null);
});

test('the curve is thinned to at most maxPoints and always ends on the last frame', () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `[Parsed_ebur128_0 @ 0x1] t: ${((i + 1) / 10).toFixed(1)}  TARGET:-23 LUFS    M: -${20 + (i % 7)}.0 S: -22.0     I: -23.0 LUFS       LRA:   3.0 LU  FTPK: -9.0 dBFS  TPK: -9.0 dBFS`).join('\n');
  const curve = parseLoudnessCurve(lines, 50)!;
  assert.ok(curve.points.length <= 51 && curve.points.length >= 25, `${curve.points.length} points`);
  assert.equal(curve.points.at(-1)!.time_seconds, 100);
  assert.equal(curve.max_momentary_lufs, -20);                         // found among the frames that thinning dropped too
  assert.deepEqual(curve.points.map((p) => p.time_seconds), [...curve.points.map((p) => p.time_seconds)].sort((a, b) => a - b));
});

const ffmpeg = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version']);
test('the real analyzer returns the curve only when asked, and the integrated loudness is the same either way', { skip: ffmpeg.status !== 0 && 'ffmpeg is not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-loudness-'));
  const wav = path.join(dir, 'tone.wav');
  try {
    const made = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7', '-af', 'volume=0.5', wav]);
    assert.equal(made.status, 0, String(made.stderr));
    const plain: any = await analyzeAudioFile(wav);
    const curved: any = await analyzeAudioFile(wav, { curve: true, maxPoints: 20 });
    assert.equal(plain.loudness_over_time, undefined);
    assert.ok(Math.abs(plain.integrated_loudness_lufs + 27.8) < 0.2, `integrated ${plain.integrated_loudness_lufs}`);
    assert.equal(curved.integrated_loudness_lufs, plain.integrated_loudness_lufs);
    assert.equal(curved.true_peak_dbtp, plain.true_peak_dbtp);
    const over = curved.loudness_over_time;
    assert.ok(over.points.length >= 2 && over.points.length <= 21, `${over.points.length} points`);
    assert.ok(Math.abs(over.max_short_term_lufs + 27.8) < 0.3 && Math.abs(over.max_momentary_lufs + 27.8) < 0.3, JSON.stringify(over).slice(0, 200));
    assert.equal(over.points[0].short_term_lufs, null, 'a short-term value needs 3 s of audio');
    assert.equal(over.loudness_range_lu, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
