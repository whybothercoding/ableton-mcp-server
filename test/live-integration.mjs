// Live integration tests: run against a real Ableton Live with the AbletonMCP control surface enabled.
//
//   npm run build && node test/live-integration.mjs
//
// It needs a MIDI track with at least one device and an empty clip slot. Everything it touches is
// restored afterwards: a scratch clip is created and deleted, parameter values are snapshotted and
// put back, and only envelopes/ramps it created are cleared. Audio may briefly change while it runs.
import net from 'node:net';
import { AbletonClient } from '../dist/client/AbletonClient.js';

const client = new AbletonClient({ timeoutMs: 15000 });
const call = (type, params = {}) => client.sendCommand(type, params);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const percentile = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function near(actual, expected, tolerance, label = 'value') {
  assert(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
}
async function rejects(promise, fragment) {
  try {
    await promise;
  } catch (err) {
    assert(err.message.includes(fragment), `expected error containing "${fragment}", got "${err.message}"`);
    return;
  }
  throw new Error(`expected an error containing "${fragment}" but the call succeeded`);
}

// ---- helpers that read Live's own state (independent of the tools under test)
const paramExpr = (t, d, p) => `self._song.tracks[${t}].devices[${d}].parameters[${p}]`;
const readParam = (t, d, p) => call('eval', { code: `${paramExpr(t, d, p)}.value` });
const clipExpr = (t, c) => `self._song.tracks[${t}].clip_slots[${c}].clip`;
const hasEnvelope = (t, c, param) => call('eval', { code: `${clipExpr(t, c)}.automation_envelope(${param}) is not None` });
const envelopeAt = (t, c, param, times) =>
  call('eval', { code: `(lambda env: [env.value_at_time(x) for x in ${JSON.stringify(times)}])(${clipExpr(t, c)}.automation_envelope(${param}))` });
const mixerExpr = (t, name) => `self._song.tracks[${t}].mixer_device.${name}`;

// ---- discovery
async function discover() {
  const session = await call('get_bulk_session_structure');
  for (const track of session.tracks) {
    if (!track.is_midi_track || track.device_count < 1) continue;
    const detail = await call('get_track_info', { track_index: track.index });
    const free = detail.clip_slots.find((slot) => !slot.has_clip);
    if (!free) continue;
    for (let d = 0; d < track.device_count; d += 1) {
      const info = await call('get_device_parameters', { track_index: track.index, device_index: d });
      const candidates = info.parameters.filter(
        (p) => p.index > 0 && p.max > p.min && !/\bon\b|type|mode|sync|retrig|legato/i.test(p.name) && !Number.isInteger(p.value)
      );
      if (candidates.length >= 2) return { track: track.index, slot: free.index, device: d, params: candidates.slice(0, 2), name: info.device_name };
    }
  }
  throw new Error('need a MIDI track with a device that has two continuous parameters and a free clip slot');
}

const info = await call('get_script_info');
console.log(`Remote Script ${info.script_version}`);
const target = await discover();
const [pA, pB] = target.params;
console.log(`Using track ${target.track} / ${target.name} (${pA.name}, ${pB.name}), scratch slot ${target.slot}\n`);
const T = target.track;
const D = target.device;
const S = target.slot;
const snapshots = [pA, pB].map((p) => ({ ...p }));
await call('create_clip', { track_index: T, clip_index: S, length: 4, name: 'MCP TEST' });
const CLIP_BEATS = 4;
const sendA = { track_index: T, device_index: D, parameter_index: pA.index };

try {
  console.log('Bridge');
  await check('script reports the new version and capabilities', async () => {
    assert(info.script_version === '1.9.0', `version ${info.script_version}`);
    for (const c of ['draw_automation', 'clear_automation', 'ramp_parameter', 'cancel_ramps']) {
      assert(info.capabilities.includes(c), `missing capability ${c}`);
    }
  });
  await check('read latency is low (median < 30 ms, p95 < 80 ms)', async () => {
    const times = [];
    for (let i = 0; i < 60; i += 1) {
      const t0 = performance.now();
      await call('get_session_info');
      times.push(performance.now() - t0);
    }
    console.log(`       reads: median ${median(times).toFixed(1)} ms, p95 ${percentile(times, 0.95).toFixed(1)} ms`);
    assert(median(times) < 30, `median ${median(times).toFixed(1)} ms`);
    assert(percentile(times, 0.95) < 80, `p95 ${percentile(times, 0.95).toFixed(1)} ms`);
  });
  await check('write latency is low (median < 30 ms)', async () => {
    const times = [];
    for (let i = 0; i < 60; i += 1) {
      const t0 = performance.now();
      await call('set_device_parameter', { ...sendA, value: pA.value });
      times.push(performance.now() - t0);
    }
    console.log(`       writes: median ${median(times).toFixed(1)} ms, p95 ${percentile(times, 0.95).toFixed(1)} ms`);
    assert(median(times) < 30, `median ${median(times).toFixed(1)} ms`);
  });
  await check('200 parallel connections all succeed', async () => {
    const results = await Promise.all(Array.from({ length: 200 }, () => call('get_script_info')));
    assert(results.every((r) => r.script_version === '1.9.0'), 'a response was wrong');
  });
  await check('garbage and half-open connections do not disturb the server', async () => {
    for (const junk of ['{"type": "get_scr', '\u0000\u0001\u0002', 'not json at all', '']) {
      await new Promise((resolve) => {
        const sock = net.createConnection({ host: '127.0.0.1', port: 9877 }, () => {
          sock.write(junk);
          setTimeout(() => sock.destroy(), 30);
        });
        sock.on('close', resolve);
        sock.on('error', resolve);
      });
    }
    assert((await call('get_script_info')).script_version === '1.9.0', 'server stopped answering');
  });
  await check('bulk_set_device_parameters reports actual values and skipped items', async () => {
    const out = await call('bulk_set_device_parameters', {
      items: [
        { ...sendA, value: pA.value },
        { track_index: T, device_index: 99, parameter_index: 0, value: 1 }
      ]
    });
    assert(out.count === 1 && out.skipped.length === 1, JSON.stringify(out));
    near(out.updated[0].value, pA.value, 1e-4, 'actual value');
  });

  console.log('\ndraw_automation');
  await check('linear ramp: readback and independent envelope values match', async () => {
    const lo = pA.min + 0.2 * (pA.max - pA.min);
    const hi = pA.min + 0.9 * (pA.max - pA.min);
    const out = await call('draw_automation', {
      ...sendA, clip_index: S, points: [{ time: 0, value: lo }, { time: CLIP_BEATS, value: hi }], resolution: 0.125
    });
    assert(out.steps === 32, `steps ${out.steps}`);
    for (const row of out.readback) near(row.actual, row.expected, 1e-4 * (pA.max - pA.min), `readback @${row.time}`);
    const times = [0.05, 1, 2, 3, 3.95];
    const values = await envelopeAt(T, S, paramExpr(T, D, pA.index), times);
    times.forEach((t, i) => near(values[i], lo + (hi - lo) * (t / CLIP_BEATS), (hi - lo) / 31 + 1e-6 * (pA.max - pA.min), `value @${t}`));
    near(values.at(-1), hi, 0.03 * (hi - lo), 'end value (drawn endpoint is reached)');
  });
  await check('drawn envelope really exists on the clip', async () => {
    assert(await hasEnvelope(T, S, paramExpr(T, D, pA.index)), 'no envelope');
    assert(await call('eval', { code: `${clipExpr(T, S)}.has_envelopes` }), 'has_envelopes false');
  });
  await check('curves: smooth, ease_in and ease_out are monotonic and hit both endpoints', async () => {
    const span = pA.max - pA.min;
    for (const curve of ['smooth', 'ease_in', 'ease_out']) {
      await call('draw_automation', { ...sendA, clip_index: S, curve, points: [{ time: 0, value: pA.min + 0.1 * span }, { time: 4, value: pA.min + 0.8 * span }] });
      const times = Array.from({ length: 40 }, (_, i) => 0.05 + (i * 3.94) / 39);
      const values = await envelopeAt(T, S, paramExpr(T, D, pA.index), times);
      for (let i = 1; i < values.length; i += 1) assert(values[i] >= values[i - 1] - 1e-9, `${curve} not monotonic at ${times[i]}`);
      near(values[0], pA.min + 0.1 * span, 0.03 * span, `${curve} start`);
      near(values.at(-1), pA.min + 0.8 * span, 0.03 * span, `${curve} end`);
    }
    const mid = (await envelopeAt(T, S, paramExpr(T, D, pA.index), [2.0]))[0];
    assert(mid > pA.min + 0.1 * span, 'sanity');
  });
  await check('step curve holds each value until the next point', async () => {
    const span = pA.max - pA.min;
    await call('draw_automation', {
      ...sendA, clip_index: S, curve: 'step',
      points: [{ time: 0, value: pA.min + 0.2 * span }, { time: 2, value: pA.min + 0.7 * span }, { time: 4, value: pA.min + 0.4 * span }]
    });
    const [a, b, c] = await envelopeAt(T, S, paramExpr(T, D, pA.index), [0.5, 1.9, 2.5]);
    near(a, pA.min + 0.2 * span, 1e-3 * span, 'first hold');
    near(b, pA.min + 0.2 * span, 1e-3 * span, 'still first hold');
    near(c, pA.min + 0.7 * span, 1e-3 * span, 'second hold');
  });
  await check('merge only rewrites the drawn range', async () => {
    const span = pA.max - pA.min;
    await call('draw_automation', { ...sendA, clip_index: S, curve: 'step', points: [{ time: 0, value: pA.min + 0.9 * span }] });
    await call('draw_automation', { ...sendA, clip_index: S, curve: 'step', mode: 'merge', hold: false, points: [{ time: 1, value: pA.min + 0.1 * span }, { time: 3, value: pA.min + 0.1 * span }] });
    const [before, inside, after] = await envelopeAt(T, S, paramExpr(T, D, pA.index), [0.5, 2, 3.6]);
    near(before, pA.min + 0.9 * span, 1e-3 * span, 'before range');
    near(inside, pA.min + 0.1 * span, 1e-3 * span, 'inside range');
    near(after, pA.min + 0.9 * span, 1e-3 * span, 'after range');
  });
  await check('replace discards the previous envelope entirely', async () => {
    const span = pA.max - pA.min;
    await call('draw_automation', { ...sendA, clip_index: S, points: [{ time: 0, value: pA.min + 0.3 * span }] });
    const [v] = await envelopeAt(T, S, paramExpr(T, D, pA.index), [2]);
    near(v, pA.min + 0.3 * span, 1e-3 * span, 'flat value');
  });
  await check('two parameters on one clip are independent', async () => {
    await call('draw_automation', { ...sendA, clip_index: S, points: [{ time: 0, value: pA.min + 0.25 * (pA.max - pA.min) }] });
    await call('draw_automation', { track_index: T, device_index: D, parameter_index: pB.index, clip_index: S, points: [{ time: 0, value: pB.min + 0.75 * (pB.max - pB.min) }] });
    const [a] = await envelopeAt(T, S, paramExpr(T, D, pA.index), [2]);
    const [b] = await envelopeAt(T, S, paramExpr(T, D, pB.index), [2]);
    near(a, pA.min + 0.25 * (pA.max - pA.min), 1e-3 * (pA.max - pA.min), 'A');
    near(b, pB.min + 0.75 * (pB.max - pB.min), 1e-3 * (pB.max - pB.min), 'B');
  });
  await check('mixer volume, pan and send automation', async () => {
    await call('draw_automation', { track_index: T, clip_index: S, mixer_parameter: 'volume', points: [{ time: 0, value: 0.3 }, { time: 4, value: 0.8 }] });
    const [v0, v1] = await envelopeAt(T, S, mixerExpr(T, 'volume'), [0.1, 3.9]);
    near(v0, 0.3, 0.02, 'volume start');
    near(v1, 0.8, 0.02, 'volume end');
    await call('draw_automation', { track_index: T, clip_index: S, mixer_parameter: 'pan', points: [{ time: 0, value: -0.5 }, { time: 4, value: 0.5 }] });
    assert(await hasEnvelope(T, S, mixerExpr(T, 'panning')), 'no pan envelope');
    const sends = await call('eval', { code: `len(${mixerExpr(T, 'sends')})` });
    if (sends > 0) {
      await call('draw_automation', { track_index: T, clip_index: S, mixer_parameter: 'send:0', points: [{ time: 0, value: 0 }, { time: 4, value: 0.5 }] });
      assert(await hasEnvelope(T, S, `${mixerExpr(T, 'sends')}[0]`), 'no send envelope');
    }
  });
  await check('non-integer, unsorted and duplicate-time points are handled', async () => {
    const span = pA.max - pA.min;
    const out = await call('draw_automation', {
      ...sendA, clip_index: S, curve: 'linear',
      points: [{ time: 3.3, value: pA.min + 0.9 * span }, { time: 0.7, value: pA.min + 0.1 * span }, { time: 3.3, value: pA.min + 0.2 * span }]
    });
    assert(out.steps > 0, 'nothing drawn');
    const [early, late] = await envelopeAt(T, S, paramExpr(T, D, pA.index), [0.3, 3.8]);
    near(early, pA.min + 0.1 * span, 1e-3 * span, 'hold before first point');
    near(late, pA.min + 0.2 * span, 1e-3 * span, 'hold after last point (later duplicate wins)');
  });
  await check('a fine resolution draws many steps in one round trip', async () => {
    const t0 = performance.now();
    const out = await call('draw_automation', { ...sendA, clip_index: S, resolution: 0.01, points: [{ time: 0, value: pA.min }, { time: 4, value: pA.max }] });
    console.log(`       ${out.steps} steps in ${(performance.now() - t0).toFixed(0)} ms`);
    assert(out.steps === 400, `steps ${out.steps}`);
  });
  await check('during playback the live parameter follows the drawn envelope', async () => {
    if (!(await call('eval', { code: 'self._song.is_playing' }))) {
      console.log('       transport stopped: skipped');
      return;
    }
    const lo = pA.min + 0.1 * (pA.max - pA.min);
    const hi = pA.min + 0.9 * (pA.max - pA.min);
    await call('draw_automation', { ...sendA, clip_index: S, points: [{ time: 0, value: lo }, { time: CLIP_BEATS, value: hi }] });
    await call('set_device_parameter', { ...sendA, value: pA.min + 0.5 * (pA.max - pA.min) });
    await call('fire_clip', { track_index: T, clip_index: S });
    const seen = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 7000) {
      seen.push(await readParam(T, D, pA.index));
      await sleep(20);
    }
    await call('stop_clip', { track_index: T, clip_index: S });
    const inRange = seen.filter((v) => v >= lo - 0.02 * (pA.max - pA.min) && v <= hi + 0.02 * (pA.max - pA.min));
    assert(inRange.length >= 40, `only ${inRange.length} samples followed the envelope: the clip may not have launched`);
    assert(Math.max(...inRange) - Math.min(...inRange) > 0.6 * (hi - lo), 'parameter did not sweep across the drawn range');
    let rises = 0;
    for (let i = 1; i < inRange.length; i += 1) if (inRange[i] > inRange[i - 1] + 1e-9) rises += 1;
    assert(rises >= 20, `parameter moved upward only ${rises} times`);
  });
  await check('errors are clear and leave the envelope untouched', async () => {
    const before = await envelopeAt(T, S, paramExpr(T, D, pA.index), [1, 2, 3]);
    const cases = [
      [{ ...sendA, clip_index: S, points: [] }, 'non-empty'],
      [{ ...sendA, clip_index: S, points: [{ time: 9, value: pA.min }] }, 'outside the clip'],
      [{ ...sendA, clip_index: S, points: [{ time: 0, value: pA.max + 1000 }] }, 'outside the parameter range'],
      [{ ...sendA, clip_index: S, points: [{ time: 0, value: pA.min }], mode: 'append' }, 'mode'],
      [{ ...sendA, clip_index: S, points: [{ time: 0, value: pA.min }], curve: 'wobble' }, 'curve'],
      [{ ...sendA, clip_index: S, points: [{ time: 0, value: pA.min }], resolution: 0 }, 'resolution'],
      [{ ...sendA, clip_index: S + 1, points: [{ time: 0, value: pA.min }] }, 'empty'],
      [{ ...sendA, clip_index: 999, points: [{ time: 0, value: pA.min }] }, 'Clip index out of range'],
      [{ ...sendA, track_index: 999, clip_index: S, points: [{ time: 0, value: pA.min }] }, 'Track index out of range'],
      [{ ...sendA, device_index: 99, clip_index: S, points: [{ time: 0, value: pA.min }] }, 'Device index out of range'],
      [{ ...sendA, parameter_index: 999, clip_index: S, points: [{ time: 0, value: pA.min }] }, 'Parameter index out of range'],
      [{ ...sendA, clip_index: S, source: 'arrangement', points: [{ time: 0, value: pA.min }] }, 'Session clips'],
      [{ track_index: T, clip_index: S, mixer_parameter: 'reverb', points: [{ time: 0, value: 0 }] }, 'mixer_parameter must be']
    ];
    for (const [params, fragment] of cases) await rejects(call('draw_automation', params), fragment);
    const after = await envelopeAt(T, S, paramExpr(T, D, pA.index), [1, 2, 3]);
    before.forEach((v, i) => near(after[i], v, 1e-9, 'envelope changed by a failed call'));
  });

  console.log('\nclear_automation');
  await check('clears one parameter and reports it', async () => {
    const out = await call('clear_automation', { ...sendA, clip_index: S });
    assert(out.had_envelope === true && out.cleared === pA.name, JSON.stringify(out));
    assert(!(await hasEnvelope(T, S, paramExpr(T, D, pA.index))), 'envelope still there');
    assert(await hasEnvelope(T, S, paramExpr(T, D, pB.index)), 'the other parameter lost its envelope');
    const again = await call('clear_automation', { ...sendA, clip_index: S });
    assert(again.had_envelope === false, 'second clear should report nothing to clear');
  });
  await check('clears every envelope on the clip', async () => {
    const out = await call('clear_automation', { track_index: T, clip_index: S });
    assert(out.cleared === 'all' && out.clip_has_envelopes === false, JSON.stringify(out));
    assert(!(await call('eval', { code: `${clipExpr(T, S)}.has_envelopes` })), 'envelopes remain');
  });
  await check('clear errors', async () => {
    await rejects(call('clear_automation', { track_index: T, clip_index: S + 1 }), 'empty');
    await rejects(call('clear_automation', { track_index: T, clip_index: S, device_index: D }), 'parameter_index');
  });

  console.log('\nramp_parameter');
  const span = pA.max - pA.min;
  const rampStart = pA.min + 0.1 * span;
  const rampEnd = pA.min + 0.9 * span;
  await check('1 s ramp is smooth, monotonic, starts at "from" and lands exactly on the target', async () => {
    const started = await call('ramp_parameter', { ...sendA, from: rampStart, to: rampEnd, seconds: 1 });
    assert(started.active_ramps >= 1 && started.seconds === 1, JSON.stringify(started));
    const samples = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 1500) {
      samples.push([performance.now() - t0, await readParam(T, D, pA.index)]);
    }
    const values = samples.map((s) => s[1]);
    for (let i = 1; i < values.length; i += 1) assert(values[i] >= values[i - 1] - 1e-9, `not monotonic at ${samples[i][0].toFixed(0)} ms`);
    const distinct = new Set(values.map((v) => v.toFixed(6))).size;
    console.log(`       ${samples.length} polls, ${distinct} distinct values seen`);
    assert(distinct >= 20, `only ${distinct} distinct values: not smooth`);
    near(values[0], rampStart, 0.15 * span, 'start');
    near(values.at(-1), rampEnd, 1e-6 * span, 'final value is exactly the target');
    const halfway = samples.find((s) => s[0] >= 500);
    near(halfway[1], (rampStart + rampEnd) / 2, 0.25 * span, 'value at half time');
    const arrived = samples.find((s) => s[1] >= rampEnd - 1e-6 * span);
    assert(arrived && arrived[0] > 800 && arrived[0] < 1300, `reached the target at ${arrived ? arrived[0].toFixed(0) : 'never'} ms, expected about 1000`);
  });
  await check('commands stay fast while a ramp is running', async () => {
    await call('ramp_parameter', { ...sendA, from: rampStart, to: rampEnd, seconds: 2 });
    const times = [];
    for (let i = 0; i < 25; i += 1) {
      const t0 = performance.now();
      await call('get_session_info');
      times.push(performance.now() - t0);
    }
    assert(median(times) < 30, `median ${median(times).toFixed(1)} ms during a ramp`);
    await call('cancel_ramps');
  });
  await check('cancel_ramps freezes the parameter where it was', async () => {
    await call('ramp_parameter', { ...sendA, from: rampStart, to: rampEnd, seconds: 2 });
    await sleep(500);
    const out = await call('cancel_ramps', sendA);
    assert(out.cancelled === 1, JSON.stringify(out));
    const frozen = await readParam(T, D, pA.index);
    await sleep(400);
    near(await readParam(T, D, pA.index), frozen, 1e-9, 'moved after cancel');
    assert(frozen > rampStart && frozen < rampEnd, `frozen at ${frozen}`);
    assert((await call('cancel_ramps', sendA)).cancelled === 0, 'second cancel should find nothing');
  });
  await check('a new ramp replaces the running one on the same parameter', async () => {
    await call('ramp_parameter', { ...sendA, from: rampStart, to: rampEnd, seconds: 3 });
    await sleep(200);
    const second = await call('ramp_parameter', { ...sendA, from: rampEnd, to: rampStart, seconds: 0.4 });
    assert(second.active_ramps === 1, `active ${second.active_ramps}`);
    await sleep(800);
    near(await readParam(T, D, pA.index), rampStart, 1e-6 * span, 'settled on the second ramp target');
  });
  await check('two parameters ramp at the same time, in beats, with easing', async () => {
    const beatSeconds = 60 / (await call('get_session_info')).tempo;
    const started = await call('ramp_parameter', { ...sendA, from: rampStart, to: rampEnd, beats: 1, curve: 'ease_in' });
    near(started.seconds, beatSeconds, 1e-6, 'beats converted with tempo');
    await call('ramp_parameter', { track_index: T, device_index: D, parameter_index: pB.index, from: pB.min, to: pB.max, seconds: beatSeconds, curve: 'smooth' });
    await sleep(beatSeconds * 1000 + 400);
    near(await readParam(T, D, pA.index), rampEnd, 1e-6 * span, 'A landed');
    near(await readParam(T, D, pB.index), pB.max, 1e-6 * (pB.max - pB.min), 'B landed');
  });
  await check('mixer volume ramp', async () => {
    const original = await call('eval', { code: mixerExpr(T, 'volume') + '.value' });
    await call('ramp_parameter', { track_index: T, mixer_parameter: 'volume', from: 0.2, to: 0.6, seconds: 0.3 });
    await sleep(700);
    near(await call('eval', { code: mixerExpr(T, 'volume') + '.value' }), 0.6, 1e-6, 'volume');
    await call('eval', { code: `setattr(${mixerExpr(T, 'volume')}, 'value', ${original})` });
    near(await call('eval', { code: mixerExpr(T, 'volume') + '.value' }), original, 1e-6, 'volume restored');
  });
  await check('ramp errors', async () => {
    const cases = [
      [{ ...sendA, to: pA.max + 1000, seconds: 1 }, 'to must'],
      [{ ...sendA, to: pA.max }, 'exactly one'],
      [{ ...sendA, to: pA.max, seconds: 1, beats: 1 }, 'exactly one'],
      [{ ...sendA, to: pA.max, seconds: 0 }, 'duration'],
      [{ ...sendA, to: pA.max, seconds: 1, curve: 'step' }, 'curve'],
      [{ ...sendA, to: pA.max, seconds: 1, from: pA.min - 1000 }, 'from must'],
      [{ ...sendA, device_index: 99, to: 0, seconds: 1 }, 'Device index out of range'],
      [{ ...sendA, track_index: 999, to: 0, seconds: 1 }, 'Track index out of range']
    ];
    for (const [params, fragment] of cases) await rejects(call('ramp_parameter', params), fragment);
    assert((await call('cancel_ramps')).active_ramps === 0, 'a failed call left a ramp behind');
  });
} finally {
  console.log('\nCleanup');
  await call('cancel_ramps').catch(() => {});
  await call('clear_automation', { track_index: T, clip_index: S }).catch(() => {});
  await call('delete_clip', { track_index: T, clip_index: S }).catch(() => {});
  for (const p of snapshots) {
    await call('set_device_parameter', { track_index: T, device_index: D, parameter_index: p.index, value: p.value }).catch(() => {});
  }
  console.log('  scratch clip deleted, parameters restored');
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
