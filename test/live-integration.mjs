// Live integration tests: run against a real Ableton Live with the AbletonMCP control surface enabled.
//
//   npm run build && node test/live-integration.mjs
//
// It needs a MIDI track with at least one device and an empty clip slot. Everything it touches is
// restored afterwards: a scratch clip is created and deleted, parameter values are snapshotted and
// put back, and only envelopes/ramps it created are cleared. Audio may briefly change while it runs.
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbletonClient } from '../dist/client/AbletonClient.js';
import { buildId, scriptVersion } from '../scripts/build-id.mjs';

const PACKAGE_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'remote-script', 'AbletonMCP');
const EXPECTED_VERSION = scriptVersion(PACKAGE_DIR);
const EXPECTED_BUILD = buildId(PACKAGE_DIR);

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
const cleanupsRegistry = []; // undo actions registered by tests that change the set, run in reverse in the finally block
await call('create_clip', { track_index: T, clip_index: S, length: 4, name: 'MCP TEST' });
const CLIP_BEATS = 4;
const sendA = { track_index: T, device_index: D, parameter_index: pA.index };

try {
  console.log('Bridge');
  await check('script reports the new version and capabilities', async () => {
    assert(info.script_version === EXPECTED_VERSION, `version ${info.script_version}, source has ${EXPECTED_VERSION}`);
    assert(info.build_id === EXPECTED_BUILD, `the script running in Live (build ${info.build_id}) differs from the source (build ${EXPECTED_BUILD}): run \`npm run deploy\` and restart Live`);
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
    assert(results.every((r) => r.script_version === EXPECTED_VERSION), 'a response was wrong');
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
    assert((await call('get_script_info')).script_version === EXPECTED_VERSION, 'server stopped answering');
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

  console.log('\nDispatcher: error codes, timing, undo');
  const rawCall = (type, params = {}) =>
    new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port: 9877 }, () => sock.write(JSON.stringify({ type, params })));
      let buffer = '';
      sock.on('data', (d) => {
        buffer += d;
        try {
          resolve(JSON.parse(buffer));
          sock.destroy();
        } catch {
          /* wait for more */
        }
      });
      sock.on('error', reject);
    });
  await check('responses carry elapsed_ms and errors carry a stable code', async () => {
    const ok = await rawCall('get_session_info');
    assert(ok.status === 'success' && typeof ok.elapsed_ms === 'number', JSON.stringify(ok).slice(0, 120));
    const cases = [
      [{ type: 'get_track_info', params: { track_index: 99 } }, 'OUT_OF_RANGE'],
      [{ type: 'nope', params: {} }, 'UNKNOWN_COMMAND'],
      [{ type: 'get_track_info', params: { track_index: 0, track_type: 'bus' } }, 'INVALID_ARGUMENT'],
      [{ type: 'eval', params: { code: '{}["missing"]' } }, 'NOT_FOUND'],
      [{ type: 'eval', params: { code: '1 + "a"' } }, 'TYPE_ERROR']
    ];
    for (const [cmd, code] of cases) {
      const r = await rawCall(cmd.type, cmd.params);
      assert(r.status === 'error' && r.code === code && typeof r.elapsed_ms === 'number', `${cmd.type}: ${JSON.stringify(r)}`);
    }
  });
  await check('the client keeps the bridge error code on the thrown error', async () => {
    try {
      await call('get_track_info', { track_index: 99 });
    } catch (err) {
      assert(err.bridgeCode === 'OUT_OF_RANGE' && err.code === 'REMOTE_ERROR', `${err.code}/${err.bridgeCode}`);
      return;
    }
    throw new Error('expected an error');
  });
  await check('eval failures are errors, not success strings', async () => {
    await rejects(call('eval', { code: 'undefined_name_xyz' }), 'undefined_name_xyz');
    assert((await call('eval', { code: '6 * 7' })) === 42, 'eval result');
  });
  await check('each writing command is exactly one undo step: undo reverts the last command only', async () => {
    const name = `self._song.tracks[${T}].clip_slots[${S}].clip.name`;
    const original = await call('eval', { code: name });
    await call('set_clip_name', { track_index: T, clip_index: S, name: 'MCP TEST UNDO 1' });
    await call('set_clip_name', { track_index: T, clip_index: S, name: 'MCP TEST UNDO 2' });
    assert((await call('eval', { code: name })) === 'MCP TEST UNDO 2', 'rename 2 not applied');
    // a read-only command in between must not add an undo entry
    await call('get_session_info');
    await call('eval', { code: 'self._song.undo()' });
    assert((await call('eval', { code: name })) === 'MCP TEST UNDO 1', 'first undo should revert only the last rename');
    await call('eval', { code: 'self._song.undo()' });
    assert((await call('eval', { code: name })) === original, 'second undo should revert the first rename');
    assert(await call('eval', { code: `self._song.tracks[${T}].clip_slots[${S}].has_clip` }), 'undo went too far: the scratch clip vanished');
  });
  await check('a failing command leaves no half-open undo step', async () => {
    const name = `self._song.tracks[${T}].clip_slots[${S}].clip.name`;
    const original = await call('eval', { code: name });
    await rejects(call('set_clip_name', { track_index: T, clip_index: 999, name: 'x' }), 'Clip index out of range');
    await call('set_clip_name', { track_index: T, clip_index: S, name: 'MCP TEST UNDO 3' });
    await call('eval', { code: 'self._song.undo()' });
    assert((await call('eval', { code: name })) === original, 'undo after a failed command should revert only the next successful one');
  });

  console.log('\nAddresses and properties');
  // Scratch tracks are tracked by Live's stable _live_ptr (names can collide and indices shift after deletes).
  const scratchPtrs = [];
  const findScratch = (ptr) => call('eval', { code: `[i for i, t in enumerate(self._song.tracks) if t._live_ptr == ${ptr}]` }).then((r) => r[0]);
  cleanupsRegistry.push(async () => {
    for (const ptr of scratchPtrs.reverse()) {
      const i = await findScratch(ptr);
      if (i !== undefined) await call('eval', { code: `self._song.delete_track(${i})` });
    }
  });
  const makeScratchTrack = async () => {
    await call('create_midi_track', { index: -1 });
    const i = (await call('eval', { code: 'len(self._song.tracks)' })) - 1;
    scratchPtrs.push(await call('eval', { code: `self._song.tracks[${i}]._live_ptr` }));
    return i;
  };
  const clipAddr = `tracks/${T}/slots/${S}/clip`;
  await check('get_properties reads song, track, scene and clip with enums as names', async () => {
    const song = await call('get_properties', { address: 'song', names: ['tempo', 'clip_trigger_quantization', 'scale_name', 'metronome'] });
    assert(typeof song.properties.tempo === 'number' && typeof song.properties.clip_trigger_quantization === 'string', JSON.stringify(song));
    const track = await call('get_properties', { address: `tracks/${T}`, names: ['name', 'mute', 'volume', 'current_monitoring_state'] });
    assert(['IN', 'AUTO', 'OFF'].includes(track.properties.current_monitoring_state), JSON.stringify(track));
    const clip = await call('get_properties', { address: clipAddr });
    assert(clip.kind === 'clip' && clip.properties.launch_mode === 'trigger', JSON.stringify(clip.properties.launch_mode));
    assert('gain' in clip.unavailable, 'audio-only properties should be reported as unavailable on a MIDI clip');
    const scene = await call('get_properties', { address: 'scenes/0', names: ['name', 'tempo_enabled'] });
    assert(scene.kind === 'scene', JSON.stringify(scene));
  });
  await check('addresses resolve by number and by name, and errors carry codes', async () => {
    const scratch = await makeScratchTrack();
    await call('set_properties', { address: `tracks/${scratch}`, properties: { name: 'MCP TEST ADDR' } });
    const byName = await call('get_properties', { address: 'tracks/name:MCP TEST ADDR', names: ['name'] });
    assert(byName.address === `tracks/${scratch}`, `canonical address ${byName.address}`);
    const scratch2 = await makeScratchTrack();
    await call('set_properties', { address: `tracks/${scratch2}`, properties: { name: 'MCP TEST ADDR' } });
    for (const [address, code] of [['tracks/name:MCP TEST ADDR', 'AMBIGUOUS'], ['tracks/name:No Such Track', 'NOT_FOUND'], ['tracks/999', 'OUT_OF_RANGE'],
      [`tracks/${T}/slots/999`, 'OUT_OF_RANGE'], ['nonsense', 'NOT_FOUND'], ['tracks/x', 'INVALID_ARGUMENT']]) {
      try {
        await call('get_properties', { address });
      } catch (err) {
        assert(err.bridgeCode === code, `${address}: expected ${code}, got ${err.bridgeCode} (${err.message})`);
        continue;
      }
      throw new Error(`${address} should have failed`);
    }
  });
  await check('set_properties on a scratch track: values, virtual mixer properties and the undo step', async () => {
    const i = await makeScratchTrack();
    const address = `tracks/${i}`;
    const out = await call('set_properties', { address, properties: { name: 'MCP TEST PROPS', mute: true, volume: 0.5, panning: -0.25 } });
    assert(out.applied.name.to === 'MCP TEST PROPS' && out.applied.mute.to === true, JSON.stringify(out));
    near(await call('eval', { code: `self._song.tracks[${i}].mixer_device.volume.value` }), 0.5, 1e-6, 'volume in Live');
    near(await call('eval', { code: `self._song.tracks[${i}].mixer_device.panning.value` }), -0.25, 1e-6, 'panning in Live');
    // One set_properties call is one undo step for everything except a TRACK rename: Live records track names as their
    // own undo entry even inside a grouped call (clip and scene renames group normally).
    await call('eval', { code: 'self._song.undo()' });
    const afterOne = await call('get_properties', { address, names: ['name', 'mute', 'volume', 'panning'] });
    assert(afterOne.properties.mute === false, `undo should revert mute: ${JSON.stringify(afterOne.properties)}`);
    near(afterOne.properties.volume, 0.85, 1e-6, 'volume after one undo');
    near(afterOne.properties.panning, 0, 1e-6, 'panning after one undo');
    if (afterOne.properties.name === 'MCP TEST PROPS') {
      await call('eval', { code: 'self._song.undo()' }); // the separate track-rename entry
      const afterTwo = await call('get_properties', { address, names: ['name'] });
      assert(afterTwo.properties.name !== 'MCP TEST PROPS', 'a second undo should revert the track rename');
    }
  });
  await check('strict typing, ranges and enum names are enforced with clear codes', async () => {
    const cases = [
      [{ address: clipAddr, properties: { muted: 1 } }, 'TYPE_ERROR'], [{ address: clipAddr, properties: { name: 5 } }, 'TYPE_ERROR'],
      [{ address: clipAddr, properties: { pitch_coarse: 1.5 } }, 'TYPE_ERROR'], [{ address: 'song', properties: { tempo: 5 } }, 'OUT_OF_RANGE'],
      [{ address: clipAddr, properties: { launch_mode: 'sideways' } }, 'INVALID_ARGUMENT'], [{ address: clipAddr, properties: { launch_mode: 1 } }, 'INVALID_ARGUMENT'],
      [{ address: clipAddr, properties: { length: 9 } }, 'INVALID_ARGUMENT'], [{ address: clipAddr, properties: { nope: 1 } }, 'NOT_FOUND'],
      [{ address: clipAddr, properties: {} }, 'INVALID_ARGUMENT']
    ];
    for (const [params, code] of cases) {
      try {
        await call('set_properties', params);
      } catch (err) {
        assert(err.bridgeCode === code, `${JSON.stringify(params)}: expected ${code}, got ${err.bridgeCode} (${err.message})`);
        continue;
      }
      throw new Error(`${JSON.stringify(params)} should have failed`);
    }
    const mode = await call('get_properties', { address: clipAddr, names: ['launch_mode', 'muted'] });
    assert(mode.properties.launch_mode === 'trigger' && mode.properties.muted === false, 'a rejected call must change nothing');
  });
  await check('clip launch settings by name; loop markers order themselves; a failing call restores everything', async () => {
    const set = await call('set_properties', { address: clipAddr, properties: { launch_mode: 'gate', launch_quantization: 'q_bar', legato: true, velocity_amount: 0.5 } });
    assert(set.applied.launch_mode.to === 'gate' && set.applied.launch_quantization.to === 'q_bar', JSON.stringify(set.applied));
    assert((await call('eval', { code: `${clipExpr(T, S)}.launch_mode` })) === 1, 'launch_mode should be 1 (gate) in Live');
    // reverse-dependency order in one call: loop_end first would fail alone
    await call('set_properties', { address: clipAddr, properties: { loop_start: 1.0, loop_end: 3.0 } });
    await call('set_properties', { address: clipAddr, properties: { loop_end: 3.5, loop_start: 2.5 } });
    const loop = await call('get_properties', { address: clipAddr, names: ['loop_start', 'loop_end'] });
    assert(loop.properties.loop_start === 2.5 && loop.properties.loop_end === 3.5, JSON.stringify(loop.properties));
    // loop_end below loop_start can never succeed: everything written before it must be restored
    const before = await call('get_properties', { address: clipAddr, names: ['name', 'muted', 'loop_start', 'loop_end'] });
    await rejects(call('set_properties', { address: clipAddr, properties: { name: 'MCP TEST ROLLBACK', muted: true, loop_end: 0.1 } }), 'LoopEnd');
    const after = await call('get_properties', { address: clipAddr, names: ['name', 'muted', 'loop_start', 'loop_end'] });
    assert(JSON.stringify(after.properties) === JSON.stringify(before.properties), `not restored: ${JSON.stringify(after.properties)} vs ${JSON.stringify(before.properties)}`);
    // the scratch clip is shared with later tests (its length follows the loop): put every setting back
    await call('set_properties', { address: clipAddr, properties: { loop_start: 0.0, loop_end: 4.0, launch_mode: 'trigger', launch_quantization: 'q_global', legato: false, velocity_amount: 0.0 } });
    const restored = await call('get_properties', { address: clipAddr, names: ['length', 'launch_mode'] });
    assert(restored.properties.length === 4 && restored.properties.launch_mode === 'trigger', JSON.stringify(restored.properties));
  });
  await check('the expect guard refuses a stale target and writes nothing', async () => {
    const i = await makeScratchTrack();
    const address = `tracks/${i}`;
    const name = (await call('get_properties', { address, names: ['name'] })).properties.name;
    try {
      await call('set_properties', { address, properties: { mute: true }, expect: { name: 'Some Other Track' } });
      throw new Error('should have been refused');
    } catch (err) {
      assert(err.bridgeCode === 'GUARD_FAILED', `${err.bridgeCode}: ${err.message}`);
    }
    assert((await call('get_properties', { address, names: ['mute'] })).properties.mute === false, 'the guarded write must not happen');
    await call('set_properties', { address, properties: { mute: true }, expect: { name } });
  });
  await check('same-value writes on your song and scene succeed and change nothing', async () => {
    const song = await call('get_properties', { address: 'song', names: ['tempo', 'groove_amount', 'clip_trigger_quantization', 'metronome', 'root_note'] });
    const out = await call('set_properties', { address: 'song', properties: song.properties });
    assert(Object.keys(out.applied).length === Object.keys(song.properties).length, 'every property should be reported as applied');
    assert(JSON.stringify((await call('get_properties', { address: 'song', names: Object.keys(song.properties) })).properties) === JSON.stringify(song.properties), 'song changed');
    const scene = (await call('get_properties', { address: 'scenes/0', names: ['name', 'tempo_enabled', 'time_signature_enabled'] })).properties;
    await call('set_properties', { address: 'scenes/0', properties: scene });
    assert(JSON.stringify((await call('get_properties', { address: 'scenes/0', names: Object.keys(scene) })).properties) === JSON.stringify(scene), 'scene changed');
  });
  await check('items set several objects in one call, and list_properties describes them', async () => {
    const a = await makeScratchTrack();
    const b = await makeScratchTrack();
    const out = await call('set_properties', { items: [{ address: `tracks/${a}`, properties: { name: 'MCP TEST A' } }, { address: `tracks/${b}`, properties: { name: 'MCP TEST B', mute: true } }] });
    assert(out.results.length === 2 && out.results[1].applied.mute.to === true, JSON.stringify(out));
    const list = await call('list_properties', { address: clipAddr });
    assert(list.kind === 'clip' && list.properties.launch_mode.values.join() === 'trigger,gate,toggle,repeat', JSON.stringify(list.properties.launch_mode));
    assert(list.properties.length.writable === false && list.properties.name.writable === true, 'writable flags');
    assert(!list.properties.warp_mode.values.includes('count'), 'the count sentinel must be hidden');
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

  console.log('\nParameter details');
  const continuous = (params) => params.find((p) => p.index > 0 && p.max > p.min && !p.is_quantized && p.is_enabled && !/\bon\b/i.test(p.name));
  await check('every parameter carries range, quantized flag, display string and enabled state', async () => {
    const out = await call('get_device_parameters', { track_index: T, device_index: D });
    const live = await call('eval', { code: `len(self._song.tracks[${T}].devices[${D}].parameters)` });
    assert(out.parameters.length === live, `${out.parameters.length} parameters listed, Live has ${live}`);
    assert(out.class_name && out.device_type && out.track_type === 'track', JSON.stringify({ c: out.class_name, t: out.device_type }));
    for (const prm of out.parameters) {
      for (const key of ['index', 'name', 'value', 'min', 'max', 'is_quantized', 'is_enabled']) assert(prm[key] !== undefined, `${prm.name} lacks ${key}`);
      assert(typeof prm.display === 'string', `${prm.name} has no display string`);
    }
  });
  await check('quantized parameters list their labels and the display matches the value', async () => {
    let found = null;
    const session = await call('get_bulk_session_structure');
    outer: for (const track of session.tracks) {
      for (let d = 0; d < track.device_count; d += 1) {
        const info = await call('get_device_parameters', { track_index: track.index, device_index: d });
        const q = info.parameters.find((prm) => prm.is_quantized && prm.value_items && prm.value_items.length > 2);
        if (q) {
          found = { track: track.index, device: d, q, info };
          break outer;
        }
      }
    }
    assert(found, 'no device with a quantized parameter in the set');
    const { q } = found;
    assert(q.value_items.length === q.max - q.min + 1, `${q.name}: ${q.value_items.length} labels for range ${q.min}..${q.max}`);
    assert(q.display === q.value_items[q.value], `${q.name}: display "${q.display}" but label "${q.value_items[q.value]}"`);
    assert(q.default === undefined, 'quantized parameters have no default');
    console.log(`       ${found.info.device_name} / ${q.name}: ${q.value_items.slice(0, 4).join(', ')}...`);
  });
  await check('continuous parameters report a default', async () => {
    const out = await call('get_device_parameters', { track_index: T, device_index: D });
    const prm = continuous(out.parameters);
    assert(typeof prm.default === 'number', `${prm.name} has no default`);
  });
  await check('get_track_detail classifies devices instead of reporting "unknown"', async () => {
    const detail = await call('get_track_info', { track_index: T });
    assert(detail.devices.length > 0 && detail.devices.every((d) => d.type !== 'unknown'), JSON.stringify(detail.devices));
    assert(detail.devices.every((d) => typeof d.can_have_chains === 'boolean'), 'can_have_chains missing');
  });
  await check('set_device_parameter reports the display string', async () => {
    const out = await call('set_device_parameter', { ...sendA, value: pA.value });
    assert(typeof out.display === 'string', JSON.stringify(out));
  });

  console.log('\nReturn and master tracks');
  const returns = await call('eval', { code: 'len(self._song.return_tracks)' });
  const master = await call('eval', { code: 'self._song.master_track.name' });
  await check('the session structure lists return tracks and the master', async () => {
    const session = await call('get_bulk_session_structure');
    assert(session.return_tracks.length === returns, `${session.return_tracks.length} vs ${returns}`);
    assert(session.master.track_type === 'master' && session.master.name === master, JSON.stringify(session.master));
    assert(session.master.index === null, 'master has no index');
  });
  await check('get_track_info works for return and master tracks', async () => {
    if (returns > 0) {
      const ret = await call('get_track_info', { track_index: 0, track_type: 'return' });
      assert(ret.track_type === 'return' && ret.index === 0 && Array.isArray(ret.devices), JSON.stringify(ret).slice(0, 200));
    }
    const m = await call('get_track_info', { track_index: 0, track_type: 'master' });
    assert(m.track_type === 'master' && m.index === null && m.name === master, JSON.stringify(m).slice(0, 200));
  });
  await check('track_type errors are clear', async () => {
    await rejects(call('get_track_info', { track_index: 99, track_type: 'return' }), 'Return track index out of range');
    await rejects(call('get_track_info', { track_index: 0, track_type: 'bus' }), 'track_type must be');
    await rejects(call('get_device_parameters', { track_index: 99, track_type: 'return', device_index: 0 }), 'Return track index out of range');
    await rejects(call('set_track_mute', { track_index: 0, track_type: 'master', mute: true }), 'master track cannot');
    await rejects(call('set_track_solo', { track_index: 0, track_type: 'master', solo: true }), 'master track cannot');
    await rejects(call('draw_automation', { track_index: 0, track_type: 'return', clip_index: 0, mixer_parameter: 'volume', points: [{ time: 0, value: 0.5 }] }), 'Only regular tracks have clips');
  });
  if (returns > 0) {
    await check('a return track device can be read, set and ramped; changes are restored', async () => {
      const dev = await call('get_device_parameters', { track_index: 0, track_type: 'return', device_index: 0 });
      const prm = continuous(dev.parameters);
      const span2 = prm.max - prm.min;
      const target2 = { track_index: 0, track_type: 'return', device_index: 0, parameter_index: prm.index };
      cleanupsRegistry.push(() => call('set_device_parameter', { ...target2, value: prm.value }));
      const set = await call('set_device_parameter', { ...target2, value: prm.min + 0.3 * span2 });
      near(set.value, prm.min + 0.3 * span2, 1e-4 * span2, 'set value');
      await call('ramp_parameter', { ...target2, from: prm.min + 0.3 * span2, to: prm.min + 0.6 * span2, seconds: 0.3 });
      await sleep(600);
      near(await call('eval', { code: `self._song.return_tracks[0].devices[0].parameters[${prm.index}].value` }), prm.min + 0.6 * span2, 1e-4 * span2, 'ramped value');
    });
    await check('return track mixer volume ramps and restores', async () => {
      const volume = 'self._song.return_tracks[0].mixer_device.volume';
      const original = await call('eval', { code: `${volume}.value` });
      cleanupsRegistry.push(() => call('eval', { code: `setattr(${volume}, 'value', ${original})` }));
      await call('ramp_parameter', { track_index: 0, track_type: 'return', mixer_parameter: 'volume', from: original, to: original * 0.5, seconds: 0.2 });
      await sleep(500);
      near(await call('eval', { code: `${volume}.value` }), original * 0.5, 1e-4, 'return volume');
      await call('eval', { code: `setattr(${volume}, 'value', ${original})` });
    });
    await check('return track name and mute round-trip', async () => {
      // Live prefixes return track names with their letter ("A-Reverb"), so writing the full name back would double it:
      // set and restore the name without the prefix.
      const original = await call('eval', { code: 'self._song.return_tracks[0].name' });
      const bare = original.replace(/^[A-Z]-/, '');
      const wasMuted = await call('eval', { code: 'self._song.return_tracks[0].mute' });
      cleanupsRegistry.push(async () => {
        await call('set_track_name', { track_index: 0, track_type: 'return', name: bare });
        await call('set_track_mute', { track_index: 0, track_type: 'return', mute: wasMuted });
      });
      await call('set_track_name', { track_index: 0, track_type: 'return', name: 'MCP TEST RETURN' });
      const renamed = await call('eval', { code: 'self._song.return_tracks[0].name' });
      assert(renamed.endsWith('MCP TEST RETURN'), `rename failed: name is "${renamed}"`);
      await call('set_track_mute', { track_index: 0, track_type: 'return', mute: !wasMuted });
      assert((await call('eval', { code: 'self._song.return_tracks[0].mute' })) === !wasMuted, 'mute failed');
      await call('set_track_mute', { track_index: 0, track_type: 'return', mute: wasMuted });
      await call('set_track_name', { track_index: 0, track_type: 'return', name: bare });
      assert((await call('eval', { code: 'self._song.return_tracks[0].name' })) === original, 'name was not restored exactly');
    });
  }
  await check('a device can be loaded onto the master track, addressed, ramped and removed', async () => {
    const before = await call('eval', { code: 'len(self._song.master_track.devices)' });
    const loaded = await call('load_browser_item', { track_index: 0, track_type: 'master', item_uri: 'query:AudioFx#Utility' });
    assert(loaded.loaded === true, JSON.stringify(loaded));
    cleanupsRegistry.push(async () => {
      for (let i = (await call('eval', { code: 'len(self._song.master_track.devices)' })) - 1; i >= before; i -= 1) {
        await call('eval', { code: `self._song.master_track.delete_device(${i})` });
      }
    });
    assert((await call('eval', { code: 'len(self._song.master_track.devices)' })) === before + 1, 'device was not added to the master');
    const idx = before;
    const dev = await call('get_device_parameters', { track_index: 0, track_type: 'master', device_index: idx });
    assert(dev.device_name === 'Utility' && dev.track_type === 'master', dev.device_name);
    const prm = continuous(dev.parameters);
    const span2 = prm.max - prm.min;
    const target2 = { track_index: 0, track_type: 'master', device_index: idx, parameter_index: prm.index };
    await call('ramp_parameter', { ...target2, from: prm.min + 0.4 * span2, to: prm.min + 0.6 * span2, seconds: 0.2 });
    await sleep(500);
    near(await call('eval', { code: `self._song.master_track.devices[${idx}].parameters[${prm.index}].value` }), prm.min + 0.6 * span2, 1e-4 * span2, 'master ramp');
    const cancelled = await call('cancel_ramps', { track_index: 0, track_type: 'master', device_index: idx, parameter_index: prm.index });
    assert(cancelled.cancelled === 0, 'the ramp had already finished');
    const info = await call('get_track_info', { track_index: 0, track_type: 'master' });
    assert(info.devices.length === before + 1 && info.devices.at(-1).name === 'Utility', JSON.stringify(info.devices));
  });
  await check('master mixer volume ramp restores', async () => {
    const volume = 'self._song.master_track.mixer_device.volume';
    const original = await call('eval', { code: `${volume}.value` });
    cleanupsRegistry.push(() => call('eval', { code: `setattr(${volume}, 'value', ${original})` }));
    await call('ramp_parameter', { track_index: 0, track_type: 'master', mixer_parameter: 'volume', from: original, to: original * 0.8, seconds: 0.2 });
    await sleep(500);
    near(await call('eval', { code: `${volume}.value` }), original * 0.8, 1e-4, 'master volume');
    await call('eval', { code: `setattr(${volume}, 'value', ${original})` });
  });
  await check('cancelling a master ramp leaves ramps on other tracks running', async () => {
    const masterVol = { track_index: 0, track_type: 'master', mixer_parameter: 'volume' };
    const volume = 'self._song.master_track.mixer_device.volume';
    const original = await call('eval', { code: `${volume}.value` });
    cleanupsRegistry.push(() => call('eval', { code: `setattr(${volume}, 'value', ${original})` }));
    await call('ramp_parameter', { ...sendA, from: rampStart, to: rampEnd, seconds: 5 });
    await call('ramp_parameter', { ...masterVol, from: original, to: original * 0.5, seconds: 5 });
    const out = await call('cancel_ramps', masterVol);
    assert(out.cancelled === 1 && out.active_ramps === 1, JSON.stringify(out));
    await call('cancel_ramps');
    await call('eval', { code: `setattr(${volume}, 'value', ${original})` });
  });

  console.log('\nRacks and device paths');
  let rackIndex = null;
  await check('a rack is discoverable: chains and their devices are listed', async () => {
    const before = await call('eval', { code: `len(self._song.tracks[${T}].devices)` });
    await call('load_browser_item', { track_index: T, item_uri: 'query:AudioFx#Audio%20Effect%20Rack' });
    rackIndex = before;
    cleanupsRegistry.push(async () => {
      for (let i = (await call('eval', { code: `len(self._song.tracks[${T}].devices)` })) - 1; i >= before; i -= 1) {
        await call('eval', { code: `self._song.tracks[${T}].delete_device(${i})` });
      }
    });
    const rack = `self._song.tracks[${T}].devices[${rackIndex}]`;
    await call('eval', { code: `str(${rack}.insert_chain(0))` });
    await call('eval', { code: `str(${rack}.chains[0].insert_device('Utility', 0))` });
    await call('eval', { code: `str(${rack}.chains[0].insert_device('Auto Filter', 1))` });
    const info = await call('get_device_parameters', { track_index: T, device_index: rackIndex });
    assert(info.device_type === 'rack' && info.can_have_chains === true, JSON.stringify({ t: info.device_type }));
    assert(info.chains.length === 1 && info.chains[0].devices.join() === 'Utility,Auto Filter', JSON.stringify(info.chains));
    assert(Array.isArray(info.return_chains), 'return_chains missing');
    const detail = await call('get_track_info', { track_index: T });
    assert(detail.devices[rackIndex].type === 'rack' && detail.devices[rackIndex].can_have_chains === true, JSON.stringify(detail.devices[rackIndex]));
  });
  const nestedPath = () => [rackIndex, 0, 1];
  const nestedTarget = () => ({ track_index: T, device_path: nestedPath(), parameter_index: 1 });
  const nestedParam = () => `self._song.tracks[${T}].devices[${rackIndex}].chains[0].devices[1].parameters[1]`;
  await check('a nested device reads, sets and reports like a top-level one', async () => {
    const dev = await call('get_device_parameters', { track_index: T, device_path: nestedPath() });
    assert(dev.device_name === 'Auto Filter' && dev.device_path.join() === nestedPath().join(), JSON.stringify({ n: dev.device_name }));
    assert(dev.parameters.length === 45 || dev.parameters.length > 20, `${dev.parameters.length} parameters`);
    const type = dev.parameters.find((prm) => prm.name === 'Filter Type');
    assert(type && type.value_items.includes('Low-pass'), 'Filter Type labels missing on a nested device');
    const out = await call('set_device_parameter', { ...nestedTarget(), value: 0.42 });
    near(await call('eval', { code: `${nestedParam()}.value` }), 0.42, 1e-4, 'nested value in Live');
    assert(typeof out.display === 'string', 'display missing');
  });
  await check('nested parameters ramp, cancel and are independent from top-level ones', async () => {
    await call('ramp_parameter', { ...nestedTarget(), from: 0.2, to: 0.8, seconds: 0.3 });
    await call('ramp_parameter', { ...sendA, from: rampStart, to: rampEnd, seconds: 5 });
    await sleep(600);
    near(await call('eval', { code: `${nestedParam()}.value` }), 0.8, 1e-4, 'nested ramp landed');
    const both = await call('cancel_ramps', nestedTarget());
    assert(both.cancelled === 0 && both.active_ramps === 1, `the top-level ramp must survive: ${JSON.stringify(both)}`);
    await call('cancel_ramps');
  });
  await check('automation can be drawn on a nested device parameter and Live stores it', async () => {
    const out = await call('draw_automation', { ...nestedTarget(), clip_index: S, points: [{ time: 0, value: 0.2 }, { time: 4, value: 0.9 }] });
    assert(out.target.device_path.join() === nestedPath().join() && out.steps > 10, JSON.stringify(out.target));
    for (const row of out.readback) near(row.actual, row.expected, 1e-4, `readback @${row.time}`);
    assert(await hasEnvelope(T, S, nestedParam()), 'no envelope on the nested parameter');
    const [start, end] = await envelopeAt(T, S, nestedParam(), [0.1, 3.95]);
    near(start, 0.2, 0.02, 'start');
    near(end, 0.9, 0.02, 'end');
    const cleared = await call('clear_automation', { ...nestedTarget(), clip_index: S });
    assert(cleared.had_envelope === true, JSON.stringify(cleared));
  });
  await check('bulk_set works with device paths and track types together', async () => {
    const out = await call('bulk_set_device_parameters', { items: [
      { track_index: T, device_path: nestedPath(), parameter_index: 1, value: 0.33 },
      { track_index: T, device_index: D, parameter_index: pA.index, value: pA.value },
      { track_index: T, device_path: [rackIndex, 7, 0], parameter_index: 1, value: 0.1 },
      { track_index: T, device_index: D, device_path: nestedPath(), parameter_index: 1, value: 0.1 }
    ] });
    assert(out.count === 2 && out.skipped.length === 2, JSON.stringify(out));
    assert(out.skipped[0].reason.includes('Chain index out of range'), out.skipped[0].reason);
    assert(out.skipped[1].reason.includes('not both'), out.skipped[1].reason);
    near(await call('eval', { code: `${nestedParam()}.value` }), 0.33, 1e-4, 'nested bulk value');
  });
  await check('drum pads are addressable in real kits, directly and nested inside an Instrument Rack', async () => {
    const session = await call('get_bulk_session_structure');
    const spare = session.tracks.find((t) => t.is_midi_track && t.device_count === 0);
    if (!spare) {
      console.log('       no empty MIDI track: skipped');
      return;
    }
    const listing = await call('get_browser_items_at_path', { path: 'drums', limit: 150 });
    const kits = listing.items.filter((item) => item.is_loadable && /Kit\.adg$/.test(item.name)).slice(0, 14);
    const wipe = async () => {
      for (let i = (await call('eval', { code: `len(self._song.tracks[${spare.index}].devices)` })) - 1; i >= 0; i -= 1) {
        await call('eval', { code: `self._song.tracks[${spare.index}].delete_device(${i})` });
      }
    };
    cleanupsRegistry.push(wipe);
    const found = { direct: null, nested: null };
    for (const kit of kits) {
      if (found.direct && found.nested) break;
      await call('load_browser_item', { track_index: spare.index, item_uri: kit.uri });
      const top = await call('get_device_parameters', { track_index: spare.index, device_index: 0 });
      if (top.device_type === 'drum_machine' && !found.direct) {
        found.direct = { kit: kit.name, prefix: [0], rack: top };
      } else if (top.device_type === 'rack' && !found.nested) {
        for (let j = 0; j < (top.chains[0]?.device_count ?? 0); j += 1) {
          const inner = await call('get_device_parameters', { track_index: spare.index, device_path: [0, 0, j] });
          if (inner.device_type === 'drum_machine') {
            found.nested = { kit: kit.name, prefix: [0, 0, j], rack: inner };
            break;
          }
        }
      }
      if ((found.direct && found.direct.kit === kit.name) || (found.nested && found.nested.kit === kit.name)) {
        const mine = found.direct?.kit === kit.name ? found.direct : found.nested;
        await exercisePads(spare.index, mine);
      }
      await wipe();
    }
    assert(found.direct || found.nested, `none of the first ${kits.length} kits contained a Drum Rack`);
    console.log(`       direct: ${found.direct ? found.direct.kit : 'none available'}; nested in an Instrument Rack: ${found.nested ? found.nested.kit : 'none available'}`);
  });
  async function exercisePads(trackIndex, { kit, prefix, rack }) {
    assert(rack.can_have_drum_pads === true && rack.drum_pads.length > 0, `${kit}: no occupied pads`);
    const pad = rack.drum_pads[0];
    const padPath = [...prefix, { pad: pad.note }, 0];
    const dev = await call('get_device_parameters', { track_index: trackIndex, device_path: padPath });
    assert(dev.parameters.length > 0 && dev.device_path.length === prefix.length + 2, `${kit}: ${dev.device_name} has ${dev.parameters.length} parameters`);
    const prm = continuous(dev.parameters);
    const span2 = prm.max - prm.min;
    let walk = `self._song.tracks[${trackIndex}].devices[${prefix[0]}]`;
    for (let i = 1; i < prefix.length; i += 2) walk += `.chains[${prefix[i]}].devices[${prefix[i + 1]}]`;
    const padParam = `${walk}.drum_pads[${pad.note}].chains[0].devices[0].parameters[${prm.index}]`;
    const original = await call('eval', { code: `${padParam}.value` });
    // Some device parameters step in whole numbers (e.g. 0..127) and Live truncates to them: allow one step there.
    const tol = Number.isInteger(prm.min) && Number.isInteger(prm.max) && span2 > 20 ? 1.001 : 1e-4 * span2;
    const set = await call('set_device_parameter', { track_index: trackIndex, device_path: padPath, parameter_index: prm.index, value: prm.min + 0.5 * span2 });
    near(await call('eval', { code: `${padParam}.value` }), set.value, 1e-9, `${kit}: tool result matches the value in Live`);
    near(set.value, prm.min + 0.5 * span2, tol, `${kit}: pad device value`);
    await call('ramp_parameter', { track_index: trackIndex, device_path: padPath, parameter_index: prm.index, from: prm.min + 0.5 * span2, to: prm.min + 0.7 * span2, seconds: 0.2 });
    await sleep(500);
    near(await call('eval', { code: `${padParam}.value` }), prm.min + 0.7 * span2, tol, `${kit}: ramped pad value`);
    await call('eval', { code: `setattr(${padParam}, 'value', ${original})` });
    const emptyNote = [...Array(128).keys()].find((n) => !rack.drum_pads.some((p) => p.note === n));
    await rejects(call('get_device_parameters', { track_index: trackIndex, device_path: [...prefix, { pad: emptyNote }, 0] }), `drum pad ${emptyNote} is empty`);
    await rejects(call('get_device_parameters', { track_index: trackIndex, device_path: [...prefix, { pad: 999 }, 0] }), 'note out of range');
    console.log(`       ${kit}: ${rack.drum_pads.length} pads, pad ${pad.note} -> ${dev.device_name}${prefix.length > 1 ? ' (nested)' : ''}`);
  }
  await check('device_path errors are precise', async () => {
    const t = { track_index: T, parameter_index: 1 };
    const cases = [
      [{ device_path: [] }, 'alternate device and chain'], [{ device_path: [rackIndex, 0] }, 'alternate device and chain'],
      [{ device_path: [99] }, 'Device index out of range at device_path[0]'], [{ device_path: [rackIndex, 9, 0] }, 'Chain index out of range at device_path[1]'],
      [{ device_path: [rackIndex, 0, 9] }, 'Device index out of range at device_path[2]'], [{ device_path: [D, 0, 0] }, 'has no chains'],
      [{ device_path: [rackIndex, { pad: 36 }, 0] }, 'has no drum pads'], [{ device_path: [rackIndex, { nope: 1 }, 0] }, "needs 'pad' or 'return'"],
      [{ device_path: [rackIndex, { return: 0 }, 0] }, 'Chain index out of range'], [{ device_path: [rackIndex, 'x', 0] }, 'integer'],
      [{ device_path: [rackIndex, 0, 1], device_index: 0 }, 'not both']
    ];
    for (const [extra, fragment] of cases) {
      await rejects(call('get_device_parameters', { track_index: T, ...extra }), fragment);
      await rejects(call('set_device_parameter', { ...t, ...extra, value: 0.1 }), fragment);
    }
    await rejects(call('ramp_parameter', { ...t, device_path: [rackIndex, 9, 0], to: 0.5, seconds: 1 }), 'Chain index out of range');
    assert((await call('cancel_ramps')).active_ramps === 0, 'a failed call left a ramp behind');
  });
} finally {
  console.log('\nCleanup');
  await call('cancel_ramps').catch(() => {});
  for (const undo of cleanupsRegistry.reverse()) await undo().catch(() => {});
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
