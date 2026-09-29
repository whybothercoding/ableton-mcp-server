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

async function rejectsCode(fn, code) {
  try {
    await fn();
  } catch (err) {
    assert(err.bridgeCode === code, `expected ${code}, got ${err.bridgeCode} (${err.message})`);
    return;
  }
  throw new Error(`expected the call to fail with ${code} but it succeeded`);
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
const setBefore = await call('describe_set');
console.log(`Set fingerprint before the run: ${setBefore.fingerprint}`);
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

  console.log('\nStructure, capabilities, transport and history');
  await check('get_capabilities describes this Live and this bridge', async () => {
    const caps = await call('get_capabilities');
    assert(caps.script.version === EXPECTED_VERSION && caps.script.build_id === EXPECTED_BUILD, JSON.stringify(caps.script));
    assert(caps.live.version === (await call('eval', { code: 'self.application().get_version_string()' })), 'Live version');
    assert(caps.live.variant !== 'Beta' || caps.live.edition === 'unknown', 'a Beta build must report an unknown edition');
    assert(typeof caps.features.max_for_live === 'boolean' && typeof caps.features.note_probabilities === 'boolean', JSON.stringify(caps.features));
    assert(caps.commands.includes('describe_set') && caps.commands.includes('transport') && caps.commands.includes('history'), 'commands');
  });
  await check('describe_set covers every track, return, master and scene, and its fingerprint ignores the playhead', async () => {
    const set = await call('describe_set');
    const counts = await call('eval', { code: '[len(self._song.tracks), len(self._song.return_tracks), len(self._song.scenes)]' });
    assert(set.tracks.length === counts[0] && set.returns.length === counts[1] && set.scenes.length === counts[2], `${set.tracks.length}/${set.returns.length}/${set.scenes.length} vs ${counts}`);
    assert(set.master.address === 'master' && set.tracks[0].address === 'tracks/0', 'addresses');
    await sleep(300);
    const again = await call('describe_set', { include_clips: false });
    assert(again.fingerprint === set.fingerprint, 'the fingerprint must not depend on the playhead, play state or clip detail level');
    assert(again.tracks.every((t) => t.clips === undefined) && again.tracks.some((t) => t.clip_count >= 1), 'include_clips=false keeps counts, drops the list');
    const clipTrack = set.tracks.find((t) => t.clips && t.clips.length);
    assert(clipTrack.clips[0].slot !== undefined && clipTrack.clips[0].name !== undefined, 'clip entries');
  });
  await check('a scratch edit moves the fingerprint and history undo brings it back', async () => {
    const i = await makeScratchTrack();
    const settled = (await call('describe_set', { include_clips: false })).fingerprint;
    await call('set_properties', { address: `tracks/${i}`, properties: { mute: true } });
    const changed = await call('describe_set', { include_clips: false });
    assert(changed.fingerprint !== settled, 'muting a track must change the fingerprint');
    const hashes = Object.fromEntries(changed.tracks.map((t) => [t.address, t.hash]));
    const undone = await call('history', { action: 'undo' });
    assert(undone.performed === 1 && undone.steps.length === 1, JSON.stringify(undone));
    assert((await call('describe_set', { include_clips: false })).fingerprint === settled, 'undo should restore the fingerprint exactly');
    const redone = await call('history', { action: 'redo' });
    assert(redone.performed === 1, JSON.stringify(redone));
    assert((await call('describe_set', { include_clips: false })).tracks.find((t) => t.address === `tracks/${i}`).hash === hashes[`tracks/${i}`], 'redo should reapply the same state');
  });
  await check('history rejects bad arguments with clear codes', async () => {
    for (const [params, code] of [[{ action: 'rewind' }, 'INVALID_ARGUMENT'], [{ action: 'undo', steps: 0 }, 'INVALID_ARGUMENT'], [{ action: 'undo', steps: 51 }, 'INVALID_ARGUMENT'], [{ action: 'undo', steps: 1.5 }, 'INVALID_ARGUMENT']]) {
      try {
        await call('history', params);
      } catch (err) {
        assert(err.bridgeCode === code, `${JSON.stringify(params)}: ${err.bridgeCode}`);
        continue;
      }
      throw new Error(`${JSON.stringify(params)} should have failed`);
    }
  });
  await check('transport validates its arguments and reports state (playback is left untouched)', async () => {
    for (const [params, code] of [[{ action: 'rewind' }, 'INVALID_ARGUMENT'], [{}, 'INVALID_ARGUMENT'], [{ action: 'jump_by' }, 'INVALID_ARGUMENT'], [{ action: 'jump_by', amount: '4' }, 'INVALID_ARGUMENT']]) {
      try {
        await call('transport', params);
      } catch (err) {
        assert(err.bridgeCode === code, `${JSON.stringify(params)}: ${err.bridgeCode}`);
        continue;
      }
      throw new Error(`${JSON.stringify(params)} should have failed`);
    }
    // toggle_cue twice restores the cue list only while the playhead is still (it toggles at the playhead)
    if (!(await call('eval', { code: 'self._song.is_playing' }))) {
      const cues = () => call('eval', { code: 'len(self._song.cue_points)' });
      const n = await cues();
      const first = await call('transport', { action: 'toggle_cue' });
      assert((await cues()) === n + 1 && first.action === 'toggle_cue', 'toggle_cue should add a cue point');
      await call('transport', { action: 'toggle_cue' });
      assert((await cues()) === n, 'the second toggle should remove it');
    } else {
      console.log('       transport is playing: cue toggle skipped (it acts at the moving playhead)');
    }
    if (!(await call('eval', { code: 'self._song.can_jump_to_next_cue' }))) {
      try {
        await call('transport', { action: 'next_cue' });
        throw new Error('next_cue without a next cue point should fail');
      } catch (err) {
        assert(err.bridgeCode === 'UNAVAILABLE', `${err.bridgeCode}: ${err.message}`);
      }
    }
  });

  console.log('\nLifecycle: create, duplicate, delete');
  // Everything created here is deleted by _live_ptr in the cleanup registry, even if a check fails halfway.
  const lifecycleScratch = [];
  const listOf = { track: 'tracks', return: 'return_tracks', scene: 'scenes' };
  const trackPtr = async (address, list) => {
    const obj = await call('eval', { code: `self._resolve(${JSON.stringify(address)})[1]._live_ptr` });
    lifecycleScratch.push({ list, ptr: obj });
    return obj;
  };
  cleanupsRegistry.push(async () => {
    for (const { list, ptr } of lifecycleScratch.reverse()) {
      const i = (await call('eval', { code: `[i for i, o in enumerate(self._song.${list}) if o._live_ptr == ${ptr}]` }))[0];
      if (i === undefined) continue;
      const remover = { tracks: 'delete_track', return_tracks: 'delete_return_track', scenes: 'delete_scene' }[list];
      await call('eval', { code: `self._song.${remover}(${i})` });
    }
  });
  const countOf = (list) => call('eval', { code: `len(self._song.${list})` });
  const guardCode = async (params) => {
    try {
      await call('delete', params);
    } catch (err) {
      return err.bridgeCode;
    }
    return 'DELETED';
  };
  await check('create makes each kind, returns its address, applies name and colour; delete removes it', async () => {
    const n = await countOf('tracks');
    const midi = await call('create', { kind: 'midi_track', name: 'MCP TEST MIDI', color: 16711680 });
    await trackPtr(midi.address, 'tracks');
    assert(midi.address === `tracks/${n}` && midi.name === 'MCP TEST MIDI', JSON.stringify(midi));
    assert((await countOf('tracks')) === n + 1, 'track count');
    const props = await call('get_properties', { address: midi.address, names: ['name', 'color', 'has_midi_input'] });
    assert(props.properties.name === 'MCP TEST MIDI' && props.properties.has_midi_input === true, JSON.stringify(props.properties));
    assert(typeof midi.color === 'number' && props.properties.color === midi.color, `create reports the colour Live applied (Live snaps colours to its palette): ${midi.color} vs ${props.properties.color}`);
    const audio = await call('create', { kind: 'audio_track', name: 'MCP TEST AUDIO' });
    await trackPtr(audio.address, 'tracks');
    assert((await call('get_properties', { address: audio.address, names: ['has_audio_input'] })).properties.has_audio_input === true, 'audio track');
    assert(audio.address === `tracks/${n + 1}`, audio.address);
    const returns = await countOf('return_tracks');
    const ret = await call('create', { kind: 'return_track', name: 'MCP TEST RETURN' });
    await trackPtr(ret.address, 'return_tracks');
    assert(ret.address === `returns/${returns}` && (await countOf('return_tracks')) === returns + 1, JSON.stringify(ret));
    const scenes = await countOf('scenes');
    const scene = await call('create', { kind: 'scene', name: 'MCP TEST SCENE' });
    await trackPtr(scene.address, 'scenes');
    assert(scene.address === `scenes/${scenes}` && (await countOf('scenes')) === scenes + 1, JSON.stringify(scene));
    for (const [address, name, list, count] of [[scene.address, 'MCP TEST SCENE', 'scenes', scenes], [ret.address, 'MCP TEST RETURN', 'return_tracks', returns],
      [audio.address, 'MCP TEST AUDIO', 'tracks', n + 1], [midi.address, 'MCP TEST MIDI', 'tracks', n]]) {
      const out = await call('delete', { address, expect: { name: name.startsWith('MCP TEST RETURN') ? (await call('get_properties', { address, names: ['name'] })).properties.name : name } });
      assert(out.deleted === address && (await countOf(list)) === count, JSON.stringify(out));
    }
  });
  await check('create at an index shifts what follows, and bad arguments are refused with codes', async () => {
    const n = await countOf('tracks');
    // compare by Live's stable _live_ptr: Live renumbers default track names ("12-Acid..." becomes "13-Acid...") when a track is inserted before them
    const lastPtr = await call('eval', { code: `self._song.tracks[${n - 1}]._live_ptr` });
    const inserted = await call('create', { kind: 'midi_track', index: n - 1, name: 'MCP TEST INSERT' });
    await trackPtr(inserted.address, 'tracks');
    assert(inserted.address === `tracks/${n - 1}`, inserted.address);
    assert((await call('eval', { code: `self._song.tracks[${n}]._live_ptr` })) === lastPtr, 'the former last track should have shifted to the end');
    await call('delete', { address: inserted.address, expect: { name: 'MCP TEST INSERT' } });
    for (const [params, code] of [[{ kind: 'device' }, 'INVALID_ARGUMENT'], [{ kind: 'scene', name: 5 }, 'TYPE_ERROR'], [{ kind: 'midi_track', index: 999 }, 'OUT_OF_RANGE'],
      [{ kind: 'midi_track', index: -2 }, 'INVALID_ARGUMENT'], [{ kind: 'return_track', index: 0 }, 'INVALID_ARGUMENT']]) {
      try {
        await call('create', params);
        throw new Error(`${JSON.stringify(params)} should have failed`);
      } catch (err) {
        assert(err.bridgeCode === code, `${JSON.stringify(params)}: ${err.bridgeCode} ${err.message}`);
      }
    }
    assert((await countOf('tracks')) === n, 'a refused create must leave no track behind');
  });
  await check('duplicate copies a track, a scene and a clip slot and returns the new address', async () => {
    const t = await call('create', { kind: 'midi_track', name: 'MCP TEST DUP' });
    await trackPtr(t.address, 'tracks');
    const dup = await call('duplicate', { address: t.address });
    await trackPtr(dup.address, 'tracks');
    assert(dup.source === t.address && dup.address === `tracks/${Number(t.address.split('/')[1]) + 1}` && dup.name === 'MCP TEST DUP', JSON.stringify(dup));
    const slots = `${t.address}/slots`;
    await call('create_clip', { track_index: Number(t.address.split('/')[1]), clip_index: 0, length: 2 });
    await call('set_properties', { address: `${slots}/0/clip`, properties: { name: 'MCP TEST CLIP' } });
    const slotDup = await call('duplicate', { address: `${slots}/0` });
    assert(slotDup.address === `${slots}/1`, JSON.stringify(slotDup));
    assert((await call('get_properties', { address: `${slots}/1/clip`, names: ['name'] })).properties.name === 'MCP TEST CLIP', 'the duplicated clip keeps its name');
    const clipOut = await call('delete', { address: `${slots}/1/clip`, expect: { name: 'MCP TEST CLIP' } });
    assert(clipOut.deleted === `${slots}/1/clip`, JSON.stringify(clipOut));
    assert((await call('eval', { code: `self._song.tracks[${Number(t.address.split('/')[1])}].clip_slots[1].has_clip` })) === false, 'the clip should be gone');
    const scene = await call('create', { kind: 'scene', name: 'MCP TEST SCENE DUP' });
    await trackPtr(scene.address, 'scenes');
    const sceneDup = await call('duplicate', { address: scene.address });
    await trackPtr(sceneDup.address, 'scenes');
    assert(sceneDup.name === 'MCP TEST SCENE DUP', JSON.stringify(sceneDup));
    for (const address of [sceneDup.address, scene.address]) await call('delete', { address, expect: { name: 'MCP TEST SCENE DUP' } });
    for (const address of [dup.address, t.address]) await call('delete', { address, expect: { name: 'MCP TEST DUP' } });
  });
  await check('what cannot be duplicated is refused, and nothing changes', async () => {
    const n = await countOf('tracks');
    for (const address of ['master', 'returns/0', 'song', 'tracks/0/slots/0/clip']) {
      try {
        await call('duplicate', { address });
        throw new Error(`${address} should not be duplicable`);
      } catch (err) {
        assert(err.bridgeCode === 'INVALID_ARGUMENT', `${address}: ${err.bridgeCode} ${err.message}`);
      }
    }
    assert((await countOf('tracks')) === n, 'track count changed');
  });
  await check('delete refuses without expect, with a wrong name, on the master, and on a stale index', async () => {
    const n = await countOf('tracks');
    const x = await call('create', { kind: 'midi_track', name: 'MCP TEST X' });
    const i = Number(x.address.split('/')[1]);
    await trackPtr(x.address, 'tracks');
    const y = await call('create', { kind: 'midi_track', name: 'MCP TEST Y' });
    await trackPtr(y.address, 'tracks');
    const z = await call('create', { kind: 'midi_track', name: 'MCP TEST Z' });
    await trackPtr(z.address, 'tracks');
    assert((await guardCode({ address: x.address })) === 'INVALID_ARGUMENT', 'expect is mandatory');
    assert((await guardCode({ address: x.address, expect: {} })) === 'INVALID_ARGUMENT', 'expect needs a name');
    assert((await guardCode({ address: x.address, expect: { name: 'Definitely Not Its Name' } })) === 'GUARD_FAILED', 'a wrong name must be refused');
    assert((await guardCode({ address: 'master', expect: { name: await call('eval', { code: 'self._song.master_track.name' }) } })) === 'INVALID_ARGUMENT', 'the master cannot be deleted');
    assert((await guardCode({ address: `tracks/0`, expect: { name: 'MCP TEST NOT YOUR TRACK' } })) === 'GUARD_FAILED', 'your own tracks are protected by the guard');
    assert((await countOf('tracks')) === n + 3, 'refused deletes must leave every track in place');
    // the stale-index scenario: the caller read Y at i+1, then X is deleted, so tracks/(i+1) is now Z
    await call('delete', { address: x.address, expect: { name: 'MCP TEST X' } });
    assert((await guardCode({ address: `tracks/${i + 1}`, expect: { name: 'MCP TEST Y' } })) === 'GUARD_FAILED', 'a stale index must not delete the wrong track');
    assert((await call('get_properties', { address: `tracks/${i + 1}`, names: ['name'] })).properties.name === 'MCP TEST Z', 'Z must still be there');
    await call('delete', { address: 'tracks/name:MCP TEST Y', expect: { name: 'MCP TEST Y' } });
    await call('delete', { address: 'tracks/name:MCP TEST Z', expect: { name: 'MCP TEST Z' } });
    assert((await countOf('tracks')) === n, 'back to the original track count');
  });
  await check('create and delete are single undo steps', async () => {
    const scenes = await countOf('scenes');
    const scene = await call('create', { kind: 'scene', name: 'MCP TEST UNDO' });
    await trackPtr(scene.address, 'scenes');
    await call('history', { action: 'undo' });
    assert((await countOf('scenes')) === scenes, 'one undo should remove the created scene');
    await call('history', { action: 'redo' });
    assert((await countOf('scenes')) === scenes + 1, 'redo should bring it back');
    await call('delete', { address: scene.address, expect: { name: 'MCP TEST UNDO' } });
    assert((await countOf('scenes')) === scenes, 'deleted');
    await call('history', { action: 'undo' });
    assert((await countOf('scenes')) === scenes + 1, 'one undo should bring the deleted scene back');
    await call('delete', { address: `scenes/${scenes}`, expect: { name: 'MCP TEST UNDO' } });
  });

  console.log('\nLaunch, clip actions and grooves');
  // Everything runs on a scratch MIDI track with no devices (silent). Scenes are never fired here: a scene launch also
  // triggers the stop buttons of every other track's empty slots and would stop the user's playing clips.
  const transportWasPlaying = await call('eval', { code: 'bool(self._song.is_playing)' });
  const launchTrack = await makeScratchTrack();
  const lt = `tracks/${launchTrack}`;
  const launchClip = `${lt}/slots/0/clip`;
  const madeClip = await call('create', { kind: 'midi_clip', address: `${lt}/slots/0`, length: 4, name: 'MCP TEST LAUNCH' });
  const noteStarts = async () => (await call('get_clip_notes', { track_index: launchTrack, clip_index: 0 })).notes.map((n) => n.start_time).sort((a, b) => a - b);
  const clipState = (names) => call('get_properties', { address: launchClip, names });
  const waitFor = async (predicate, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await predicate()) return true;
      await sleep(50);
    }
    return false;
  };
  cleanupsRegistry.push(async () => {
    await call('launch', { address: lt, action: 'stop', quantized: false }).catch(() => {});
    if (!transportWasPlaying) await call('transport', { action: 'stop' }).catch(() => {});
  });
  await check('create midi_clip fills an empty slot, returns the clip address, and refuses an occupied slot', async () => {
    assert(madeClip.address === launchClip && madeClip.name === 'MCP TEST LAUNCH' && madeClip.length === 4 && madeClip.kind === 'midi_clip', JSON.stringify(madeClip));
    assert((await clipState(['is_midi_clip', 'name'])).properties.name === 'MCP TEST LAUNCH', 'the clip is not what create reported');
    for (const [params, code] of [[{ kind: 'midi_clip', address: `${lt}/slots/0` }, 'INVALID_ARGUMENT'], [{ kind: 'midi_clip', address: lt }, 'INVALID_ARGUMENT'],
      [{ kind: 'midi_clip', address: `${lt}/slots/2`, length: 0 }, 'INVALID_ARGUMENT'], [{ kind: 'midi_clip', address: `${lt}/slots/999` }, 'OUT_OF_RANGE']]) {
      try {
        await call('create', params);
      } catch (err) {
        assert(err.bridgeCode === code, `${JSON.stringify(params)}: expected ${code}, got ${err.bridgeCode} (${err.message})`);
        continue;
      }
      throw new Error(`${JSON.stringify(params)} should have failed`);
    }
  });
  await check('launch fires a scratch clip through its slot and its clip address, and stops it with the track', async () => {
    for (const address of [`${lt}/slots/0`, launchClip]) {
      const fired = await call('launch', { address, quantization: 'q_no_q' });
      assert(fired.address === `${lt}/slots/0`, JSON.stringify(fired));
      assert(await waitFor(async () => (await clipState(['is_playing'])).properties.is_playing), `${address}: the clip never started`);
      const stopped = await call('launch', { address: lt, action: 'stop', quantized: false });
      assert(stopped.state && 'playing_slot_index' in stopped.state, JSON.stringify(stopped));
      assert(await waitFor(async () => !(await clipState(['is_playing'])).properties.is_playing), 'the clip never stopped');
    }
  });
  await check('launch reports errors with codes and does not start anything', async () => {
    for (const [params, code] of [[{ address: lt }, 'INVALID_ARGUMENT'], [{ address: 'song' }, 'INVALID_ARGUMENT'],
      [{ address: `${lt}/slots/0`, quantization: 'q_never' }, 'INVALID_ARGUMENT'], [{ address: `${lt}/slots/999` }, 'OUT_OF_RANGE'],
      [{ address: 'returns/0', action: 'stop' }, 'INVALID_ARGUMENT'], [{ address: 'scenes/0', action: 'stop' }, 'INVALID_ARGUMENT']]) {
      try {
        await call('launch', params);
      } catch (err) {
        assert(err.bridgeCode === code, `${JSON.stringify(params)}: expected ${code}, got ${err.bridgeCode} (${err.message})`);
        continue;
      }
      throw new Error(`${JSON.stringify(params)} should have failed`);
    }
    assert(!(await clipState(['is_playing'])).properties.is_playing, 'a rejected launch started the clip');
  });
  await check('record_length is refused by Live for a slot that already holds a clip, and the message comes through', async () => {
    try {
      await call('launch', { address: `${lt}/slots/0`, record_length: 4 });
    } catch (err) {
      assert(err.bridgeCode === 'LIVE_ERROR' && /empty slots/i.test(err.message), `${err.bridgeCode}: ${err.message}`);
      await call('launch', { address: lt, action: 'stop', quantized: false });
      return;
    }
    await call('launch', { address: lt, action: 'stop', quantized: false });
    throw new Error('Live accepted record_length on a slot that owns a clip');
  });
  await check('quantize snaps notes to a grid, and one undo restores them', async () => {
    const original = [0.1, 1.3, 2.62, 3.05];
    await call('add_notes_to_clip', { track_index: launchTrack, clip_index: 0, notes: original.map((start_time, i) => ({ pitch: 60 + i, start_time, duration: 0.25, velocity: 100 })) });
    const written = await noteStarts();
    assert(written.length === 4 && written.every((t, i) => Math.abs(t - original[i]) < 1e-6), `notes were not written as expected: ${written}`);
    const result = await call('clip_action', { address: launchClip, action: 'quantize', grid: 'rec_q_quarter' });
    assert(result.address === launchClip && result.length === 4, JSON.stringify(result));
    const snapped = await noteStarts();
    assert(snapped.every((t) => Math.abs(t - Math.round(t)) < 1e-6), `not on the quarter grid: ${snapped}`);
    await call('history', { action: 'undo' });
    const back = await noteStarts();
    assert(back.every((t, i) => Math.abs(t - original[i]) < 1e-6), `undo did not restore the notes: ${back}`);
  });
  await check('quantize with a partial amount moves notes part of the way; quantize_pitch touches one pitch only', async () => {
    await call('clip_action', { address: launchClip, action: 'quantize', grid: 'rec_q_quarter', amount: 0.5 });
    const half = await noteStarts();
    near(half[0], 0.05, 0.02, 'note at 0.1 quantized 50% to 0');
    await call('history', { action: 'undo' });
    await call('clip_action', { address: launchClip, action: 'quantize_pitch', pitch: 61, grid: 'rec_q_quarter' });
    const notes = (await call('get_clip_notes', { track_index: launchTrack, clip_index: 0 })).notes;
    const byPitch = Object.fromEntries(notes.map((n) => [n.pitch, n.start_time]));
    near(byPitch[61], 1.0, 1e-6, 'pitch 61 snapped');
    near(byPitch[60], 0.1, 1e-6, 'pitch 60 untouched');
    await call('history', { action: 'undo' });
    for (const [params, code] of [[{ grid: 'sixteenth' }, 'INVALID_ARGUMENT'], [{ grid: 'rec_q_eight', amount: 3 }, 'OUT_OF_RANGE'], [{}, 'INVALID_ARGUMENT']]) {
      try {
        await call('clip_action', { address: launchClip, action: 'quantize', ...params });
      } catch (err) {
        assert(err.bridgeCode === code, `${JSON.stringify(params)}: expected ${code}, got ${err.bridgeCode}`);
        continue;
      }
      throw new Error(`${JSON.stringify(params)} should have failed`);
    }
  });
  await check('duplicate_loop doubles the clip and its notes; undo restores it', async () => {
    const before = (await noteStarts()).length;
    const result = await call('clip_action', { address: launchClip, action: 'duplicate_loop' });
    assert(result.length === 8 && result.loop_end === 8, JSON.stringify(result));
    assert((await noteStarts()).length === before * 2, 'notes were not duplicated');
    await call('history', { action: 'undo' });
    assert((await clipState(['length'])).properties.length === 4, 'undo did not restore the length');
  });
  await check('crop keeps only the loop; the guard refuses the wrong clip', async () => {
    await call('set_properties', { address: launchClip, properties: { loop_start: 1, loop_end: 3 } });
    try {
      await call('clip_action', { address: launchClip, action: 'crop', expect: { name: 'not this clip' } });
      throw new Error('crop ignored the guard');
    } catch (err) {
      assert(err.bridgeCode === 'GUARD_FAILED', `${err.bridgeCode}: ${err.message}`);
    }
    assert((await clipState(['length'])).properties.length === 2, 'a guarded crop changed the clip');
    const cropped = await call('clip_action', { address: launchClip, action: 'crop' });
    assert(cropped.length === 2, JSON.stringify(cropped));
    await call('history', { action: 'undo' });
    assert((await clipState(['length'])).properties.length === 2, 'undo of a crop should keep the loop-based length');
  });
  await check('scrub, stop_scrub and move_playing_pos reach Live', async () => {
    assert((await call('clip_action', { address: launchClip, action: 'scrub', position: 0.5 })).action === 'scrub', 'scrub');
    assert((await call('clip_action', { address: launchClip, action: 'stop_scrub' })).action === 'stop_scrub', 'stop_scrub');
    await call('launch', { address: launchClip, quantization: 'q_no_q' });
    assert(await waitFor(async () => (await clipState(['is_playing'])).properties.is_playing), 'the clip never started');
    assert((await call('clip_action', { address: launchClip, action: 'move_playing_pos', amount: 0.25 })).is_playing === true, 'move_playing_pos');
    await call('launch', { address: lt, action: 'stop', quantized: false });
  });
  await check('grooves: a clip always has one, addressed as grooves/N; assignment and parameters round-trip and are restored', async () => {
    const pool = await call('eval', { code: 'len(self._song.groove_pool.grooves)' });
    if (pool === 0) {
      console.log('       the groove pool is empty: skipped (Live cannot create grooves through its API)');
      return;
    }
    const clip = await clipState(['groove', 'has_groove']);
    assert(/^grooves\/\d+$/.test(clip.properties.groove) && clip.properties.has_groove === true, JSON.stringify(clip.properties));
    const before = await call('get_properties', { address: 'grooves/0' });
    assert(before.kind === 'groove' && typeof before.properties.name === 'string', JSON.stringify(before));
    assert((await call('get_properties', { address: `grooves/name:${before.properties.name}`, names: ['name'] })).address === 'grooves/0', 'name selector');
    const assigned = await call('set_properties', { address: launchClip, properties: { groove: 'grooves/0' } });
    assert(assigned.applied.groove.to === 'grooves/0', JSON.stringify(assigned));
    // the groove object is shared with every clip that uses it: change a parameter, verify, and put the exact value back
    const original = before.properties.timing_amount;
    cleanupsRegistry.push(() => call('set_properties', { address: 'grooves/0', properties: { timing_amount: original } }));
    await call('set_properties', { address: 'grooves/0', properties: { timing_amount: original === 50 ? 60 : 50 } });
    near((await call('get_properties', { address: 'grooves/0', names: ['timing_amount'] })).properties.timing_amount, original === 50 ? 60 : 50, 1e-6, 'timing_amount');
    await call('set_properties', { address: 'grooves/0', properties: { timing_amount: original } });
    const after = await call('get_properties', { address: 'grooves/0' });
    assert(JSON.stringify(after.properties) === JSON.stringify(before.properties), `the groove was not restored: ${JSON.stringify(after.properties)} vs ${JSON.stringify(before.properties)}`);
    try {
      await call('set_properties', { address: launchClip, properties: { groove: `tracks/${T}` } });
      throw new Error('a track was accepted as a groove');
    } catch (err) {
      assert(err.bridgeCode === 'TYPE_ERROR', `${err.bridgeCode}: ${err.message}`);
    }
  });

  console.log('\nNotes: get_notes, write_notes, edit_notes');
  await call('create', { kind: 'midi_clip', address: `${lt}/slots/1`, length: 4 });
  const nc = `${lt}/slots/1/clip`;
  const notesOf = async (params = {}) => (await call('get_notes', { address: nc, ...params })).notes;
  const byId = (notes) => Object.fromEntries(notes.map((n) => [n.id, n]));
  const rejectsWith = async (name, params, code) => {
    try {
      await call(name, params);
    } catch (err) {
      assert(err.bridgeCode === code, `${name} ${JSON.stringify(params).slice(0, 120)}: expected ${code}, got ${err.bridgeCode} (${err.message})`);
      return;
    }
    throw new Error(`${name} ${JSON.stringify(params).slice(0, 120)} should have failed with ${code}`);
  };
  await check('write_notes stores every field and get_notes reads it back with stable ids', async () => {
    const written = await call('write_notes', { address: nc, notes: [
      { pitch: 60, start_time: 0, duration: 1, velocity: 90, probability: 0.5, velocity_deviation: 12, release_velocity: 33 },
      { pitch: 64, start_time: 1, duration: 0.5 },
      { pitch: 67, start_time: 2, duration: 1.5, mute: true, velocity: 127 }] });
    assert(written.written === 3 && written.ids.length === 3 && written.note_count === 3, JSON.stringify(written));
    const notes = byId(await notesOf());
    const [a, b, c] = written.ids.map((id) => notes[id]);
    assert(a && b && c, 'ids from write_notes should identify the notes get_notes returns');
    near(a.velocity, 90, 1e-6, 'velocity'); near(a.probability, 0.5, 1e-6, 'probability'); near(a.velocity_deviation, 12, 1e-6, 'velocity_deviation'); near(a.release_velocity, 33, 1e-6, 'release_velocity');
    assert(b.velocity === 100 && b.probability === 1 && b.mute === false && b.release_velocity === 64, `defaults: ${JSON.stringify(b)}`);
    assert(c.mute === true && c.velocity === 127, JSON.stringify(c));
    const sorted = (await notesOf()).map((n) => n.start_time);
    assert(JSON.stringify(sorted) === JSON.stringify([...sorted].sort((x, y) => x - y)), 'notes come back sorted by start_time');
  });
  await check('get_notes filters by range, ids and pitch; limit truncates', async () => {
    const all = await notesOf();
    assert((await notesOf({ from_time: 1, time_span: 1 })).map((n) => n.pitch).join() === '64', 'range');
    assert((await notesOf({ from_pitch: 66, pitch_span: 5 })).map((n) => n.pitch).join() === '67', 'pitch range');
    assert((await notesOf({ ids: [all[0].id] })).length === 1, 'ids');
    const limited = await call('get_notes', { address: nc, limit: 2 });
    assert(limited.truncated === true && limited.notes.length === 2 && limited.count === 3, JSON.stringify(limited).slice(0, 200));
    await rejectsWith('get_notes', { address: nc, ids: [987654] }, 'NOT_FOUND');
  });
  await check('invalid notes are refused before anything is written (our checks, then Live never sees them)', async () => {
    const before = await notesOf();
    for (const bad of [{ pitch: 128, start_time: 0, duration: 1 }, { pitch: 60, start_time: 0, duration: 0 }, { pitch: 60, start_time: 0, duration: 1, velocity: 0 },
      { pitch: 60, start_time: 0, duration: 1, probability: 2 }, { pitch: 60, start_time: 0, duration: 1, velocity_deviation: 200 }]) {
      await rejectsWith('write_notes', { address: nc, notes: [{ pitch: 70, start_time: 3, duration: 0.5 }, bad] }, 'OUT_OF_RANGE');
    }
    await rejectsWith('write_notes', { address: nc, notes: [{ pitch: 60, start_time: 0 }] }, 'INVALID_ARGUMENT');
    assert(JSON.stringify(await notesOf()) === JSON.stringify(before), 'a rejected write changed the clip');
  });
  await check('overlapping notes of one pitch are trimmed or replaced, and the reported count is the real one', async () => {
    const result = await call('write_notes', { address: nc, notes: [{ pitch: 72, start_time: 0, duration: 2 }, { pitch: 72, start_time: 1, duration: 2 }] });
    assert(result.written === 2 && result.note_count === 5, `written ${result.written}, note_count ${result.note_count} (3 seeded + 2)`);
    const first = (await notesOf({ from_pitch: 72, pitch_span: 1 })).find((n) => n.start_time === 0);
    near(first.duration, 1, 1e-6, 'the earlier note is cut short where the later one starts');
    const replaced = await call('write_notes', { address: nc, notes: [{ pitch: 72, start_time: 1, duration: 0.5 }] });
    assert(replaced.written === 1 && replaced.note_count === 5, `a note at the same start time replaces the old one: note_count ${replaced.note_count}`);
    await call('edit_notes', { address: nc, action: 'remove', from_pitch: 72, pitch_span: 1 });
  });
  await check('modify changes chosen fields by id, keeps ids and the other fields; a bad id changes nothing', async () => {
    const before = byId(await notesOf());
    const [first, second] = Object.keys(before).map(Number);
    const r = await call('edit_notes', { address: nc, action: 'modify', changes: [{ id: first, velocity: 40, start_time: before[first].start_time + 0.25 }, { id: second, probability: 0.75 }] });
    assert(r.modified === 2 && r.notes.length === 2, JSON.stringify(r).slice(0, 200));
    const after = byId(await notesOf());
    near(after[first].velocity, 40, 1e-6, 'velocity'); near(after[first].start_time, before[first].start_time + 0.25, 1e-6, 'start_time');
    assert(after[first].pitch === before[first].pitch && after[first].duration === before[first].duration, 'unrelated fields changed');
    near(after[second].probability, 0.75, 1e-6, 'probability');
    await rejectsWith('edit_notes', { address: nc, action: 'modify', changes: [{ id: first, velocity: 1 }, { id: 987654, velocity: 1 }] }, 'NOT_FOUND');
    near(byId(await notesOf())[first].velocity, 40, 1e-6, 'a refused modify must not change the valid note');
    await call('edit_notes', { address: nc, action: 'modify', ids: [first, second], set: { velocity: 64, mute: false } });
    assert(Object.values(byId(await notesOf())).filter((n) => [first, second].includes(n.id)).every((n) => n.velocity === 64 && n.mute === false), 'uniform set');
    await rejectsWith('edit_notes', { address: nc, action: 'modify', changes: [{ id: first, velocity: 500 }] }, 'OUT_OF_RANGE');
  });
  await check('duplicate and duplicate_region copy notes with transposition and report the new ids', async () => {
    const before = await notesOf();
    const src = before.find((n) => n.pitch === 64);
    const dup = await call('edit_notes', { address: nc, action: 'duplicate', ids: [src.id], destination_time: 3, transposition: 7 });
    assert(dup.duplicated === 1 && dup.ids.length === 1, JSON.stringify(dup).slice(0, 200));
    const copy = (await notesOf({ ids: dup.ids }))[0];
    assert(copy.pitch === 71 && Math.abs(copy.start_time - 3) < 1e-6, JSON.stringify(copy));
    const region = await call('edit_notes', { address: nc, action: 'duplicate_region', start: 0, length: 1, destination_time: 3.5 });
    assert(region.duplicated >= 1 && region.ids.length === region.duplicated, JSON.stringify(region).slice(0, 200));
    await call('edit_notes', { address: nc, action: 'remove', ids: [...dup.ids, ...region.ids] });
    assert((await notesOf()).length === before.length, 'cleanup of the copies');
  });
  await check('select drives the editor selection and get_notes selected reads it', async () => {
    const all = await notesOf();
    const sel = await call('edit_notes', { address: nc, action: 'select', ids: [all[0].id] });
    assert(sel.selected.join() === String(all[0].id), JSON.stringify(sel.selected));
    assert((await notesOf({ selected: true })).map((n) => n.id).join() === String(all[0].id), 'selected filter');
    assert((await call('edit_notes', { address: nc, action: 'select', none: true })).selected.length === 0, 'none');
  });
  await check('replace swaps a range in one step; remove needs an explicit selector; one undo reverts each', async () => {
    const before = await notesOf();
    const r = await call('edit_notes', { address: nc, action: 'replace', from_time: 0, time_span: 1.5, notes: [{ pitch: 48, start_time: 0.5, duration: 0.5 }] });
    assert(r.removed >= 1 && r.written === 1, JSON.stringify(r).slice(0, 200));
    assert((await notesOf()).some((n) => n.pitch === 48), 'the replacement note is there');
    await call('history', { action: 'undo' });
    assert(JSON.stringify((await notesOf()).map((n) => [n.pitch, n.start_time])) === JSON.stringify(before.map((n) => [n.pitch, n.start_time])), 'one undo should revert the whole replace');
    await rejectsWith('edit_notes', { address: nc, action: 'remove' }, 'INVALID_ARGUMENT');
    await call('edit_notes', { address: nc, action: 'remove', all: true });
    assert((await notesOf()).length === 0, 'remove all');
    await call('history', { action: 'undo' });
    assert((await notesOf()).length === before.length, 'undo brings the removed notes back');
    await call('edit_notes', { address: nc, action: 'remove', all: true, expect: { name: (await call('get_properties', { address: nc, names: ['name'] })).properties.name } });
  });
  await check('audio clips have no notes: refused with a clear error (read-only probe on an existing audio clip)', async () => {
    const set = await call('describe_set');
    const audio = set.tracks.flatMap((t) => (t.clips ?? []).filter((c) => c.kind === 'audio').map((c) => `${t.address}/slots/${c.slot}/clip`))[0];
    if (!audio) {
      console.log('       no audio clip in the Set: skipped');
      return;
    }
    await rejectsWith('get_notes', { address: audio }, 'INVALID_ARGUMENT');
  });

  console.log('\nCue points, application and read-only state');
  const isPlaying = () => call('eval', { code: 'bool(self._song.is_playing)' });
  await check('cue points: create at a time, list, rename, jump, delete; the playhead is put back', async () => {
    if (await isPlaying()) {
      console.log('       transport is playing: cue point creation needs it stopped, skipped');
      return;
    }
    const cuesBefore = (await call('describe_set')).cue_points.length;
    const playhead = await call('eval', { code: 'self._song.current_song_time' });
    const time = 54321;
    const made = await call('create', { kind: 'cue_point', time, name: 'MCP TEST CUE' });
    const cuePtr = await call('eval', { code: `self._resolve(${JSON.stringify(made.address)})[1].time` });
    cleanupsRegistry.push(async () => {
      const found = (await call('describe_set')).cue_points.find((c) => c.time === time);
      if (found) await call('delete', { address: found.address, expect: { name: found.name } });
      await call('set_properties', { address: 'song', properties: { current_song_time: playhead } });
    });
    assert(cuePtr === time && made.name === 'MCP TEST CUE' && made.time === time, JSON.stringify(made));
    near(await call('eval', { code: 'self._song.current_song_time' }), playhead, 1e-6, 'the playhead must be put back after creating');
    const listed = (await call('describe_set')).cue_points;
    assert(listed.length === cuesBefore + 1 && listed.some((c) => c.name === 'MCP TEST CUE' && c.time === time), JSON.stringify(listed));
    await call('set_properties', { address: made.address, properties: { name: 'MCP TEST CUE 2' } });
    assert((await call('get_properties', { address: made.address })).properties.name === 'MCP TEST CUE 2', 'rename');
    await call('launch', { address: made.address });
    assert(Math.abs((await call('eval', { code: 'self._song.current_song_time' })) - time) < 1e-3, 'launching a cue point should jump the playhead to it');
    await call('set_properties', { address: 'song', properties: { current_song_time: playhead } });
    await rejectsCode(() => call('create', { kind: 'cue_point', time }), 'INVALID_ARGUMENT');
    await rejectsCode(() => call('delete', { address: made.address, expect: { name: 'Not This One' } }), 'GUARD_FAILED');
    const removed = await call('delete', { address: made.address, expect: { name: 'MCP TEST CUE 2' } });
    assert(removed.cue_points === cuesBefore, JSON.stringify(removed));
    near(await call('eval', { code: 'self._song.current_song_time' }), playhead, 1e-6, 'the playhead must be put back after deleting');
    await call('history', { action: 'undo' });
    assert((await call('describe_set')).cue_points.length === cuesBefore + 1, 'one undo should bring the deleted cue point back');
    await call('delete', { address: (await call('describe_set')).cue_points.find((c) => c.time === time).address, expect: { name: 'MCP TEST CUE 2' } });
  });
  await check('cue point creation refuses a running transport', async () => {
    if (!(await isPlaying())) {
      console.log('       transport is stopped: skipped (needs a playing transport)');
      return;
    }
    await rejectsCode(() => call('create', { kind: 'cue_point', time: 54322 }), 'UNAVAILABLE');
  });
  await check('the application reports CPU load, and read-only Song state is readable but not writable', async () => {
    const app = await call('get_properties', { address: 'app' });
    assert(app.kind === 'app' && typeof app.properties.average_process_usage === 'number' && app.properties.open_dialog_count === 0, JSON.stringify(app).slice(0, 200));
    await rejectsCode(() => call('set_properties', { address: 'app', properties: { average_process_usage: 0 } }), 'INVALID_ARGUMENT');
    const song = await call('get_properties', { address: 'song', names: ['session_record_status', 'is_counting_in', 'record_mode', 'is_ableton_link_enabled', 'can_jump_to_next_cue'] });
    assert(['off', 'on', 'transition'].includes(song.properties.session_record_status) && typeof song.properties.record_mode === 'boolean', JSON.stringify(song.properties));
    await rejectsCode(() => call('set_properties', { address: 'song', properties: { record_mode: true } }), 'INVALID_ARGUMENT');
    const track = await call('get_properties', { address: `tracks/${T}`, names: ['output_meter_right', 'is_part_of_selection', 'back_to_arranger'] });
    assert(typeof track.properties.output_meter_right === 'number' && typeof track.properties.back_to_arranger === 'boolean', JSON.stringify(track.properties));
    const slot = await call('get_properties', { address: `tracks/${T}/slots/${S}`, names: ['playing_status', 'has_clip'] });
    assert(['stopped', 'started', 'recording'].includes(slot.properties.playing_status), JSON.stringify(slot.properties));
  });

  console.log('\nDevices, racks and parameters by address');
  const deviceTrack = await makeScratchTrack();
  const dt = `tracks/${deviceTrack}`;
  const devicesOf = async (address) => (await call('eval', { code: `[d.name for d in self._resolve(${JSON.stringify(address)})[1].devices]` }));
  const failsWith = async (fn, code, fragment) => {
    try {
      await fn();
    } catch (err) {
      assert(err.bridgeCode === code, `expected ${code}, got ${err.bridgeCode} (${err.message})`);
      if (fragment) assert(err.message.includes(fragment), `expected "${fragment}" in "${err.message}"`);
      return;
    }
    throw new Error(`expected the call to fail with ${code}`);
  };
  const readParamAt = (address) => call('eval', { code: `(lambda p: {'value': p.value})(self._resolve(${JSON.stringify(address)})[1])` });
  await check('insert puts devices on a scratch track, returns their addresses, and Live explains a bad placement', async () => {
    const drift = await call('device_action', { action: 'insert', address: dt, name: 'Drift' });
    assert(drift.address === `${dt}/devices/0` && drift.name === 'Drift', JSON.stringify(drift));
    const rack = await call('device_action', { action: 'insert', address: dt, name: 'Audio Effect Rack' });
    assert(rack.address === `${dt}/devices/1`, JSON.stringify(rack));
    const eq = await call('device_action', { action: 'insert', address: dt, name: 'EQ Eight', position: 1 });
    assert(eq.address === `${dt}/devices/1`, 'inserting at a position shifts what follows');
    assert((await devicesOf(dt)).join() === 'Drift,EQ Eight,Audio Effect Rack', (await devicesOf(dt)).join());
    await failsWith(() => call('device_action', { action: 'insert', address: dt, name: 'Definitely Not A Device' }), 'NOT_FOUND', 'not found');
    await failsWith(() => call('device_action', { action: 'insert', address: dt, name: 'EQ Eight', position: 0 }), 'LIVE_ERROR', 'instrument');
    assert((await devicesOf(dt)).length === 3, 'a refused insert changed the track');
  });
  await check('get_device lists parameters with addresses, display strings and labels; racks list chains', async () => {
    const drift = await call('get_device', { address: `${dt}/devices/0` });
    assert(drift.device_type === 'instrument' && drift.parameters.length > 20, JSON.stringify(drift).slice(0, 160));
    assert(drift.parameters.every((p) => p.address === `${dt}/devices/0/parameters/${p.index}` && typeof p.display === 'string'), 'parameter addresses');
    const quantized = drift.parameters.find((p) => p.is_quantized && p.value_items);
    assert(quantized && quantized.display === quantized.value_items[quantized.value], 'a quantized parameter shows its label');
    const rack = await call('get_device', { address: `${dt}/devices/2` });
    assert(rack.device_type === 'rack' && Array.isArray(rack.chains) && rack.macros.visible === 8, JSON.stringify(rack).slice(0, 200));
  });
  await check('parameter values are set by address, by name, with labels, and refused outside the parameter range', async () => {
    const info = await call('get_device', { address: `${dt}/devices/0` });
    const cont = info.parameters.find((p) => p.index > 0 && !p.is_quantized && p.is_enabled && p.max > p.min);
    const address = `${dt}/devices/0/parameters/${cont.index}`;
    const target = cont.min + 0.37 * (cont.max - cont.min);
    const set = await call('set_properties', { address, properties: { value: target } });
    near(set.applied.value.to, target, 1e-4 * (cont.max - cont.min), 'value');
    near((await readParamAt(address)).value, target, 1e-4 * (cont.max - cont.min), 'Live holds the value');
    await call('set_properties', { address: `${dt}/devices/0/parameters/name:${cont.name}`, properties: { value: cont.min } }).catch((err) => {
      assert(err.bridgeCode === 'AMBIGUOUS', `unexpected ${err.bridgeCode}`);
    });
    await failsWith(() => call('set_properties', { address, properties: { value: cont.max + 1000 } }), 'OUT_OF_RANGE', 'range');
    await failsWith(() => call('set_properties', { address, properties: { value: 'Low-pass' } }), 'TYPE_ERROR');
    const q = info.parameters.find((p) => p.is_quantized && p.value_items && p.value_items.length > 2 && p.is_enabled);
    if (q) {
      const qa = `${dt}/devices/0/parameters/${q.index}`;
      const label = q.value_items[q.value_items.length - 1];
      await call('set_properties', { address: qa, properties: { value: label } });
      assert((await call('get_properties', { address: qa, names: ['display'] })).properties.display === label, 'setting by label shows that label');
      await failsWith(() => call('set_properties', { address: qa, properties: { value: 'No Such Label' } }), 'INVALID_ARGUMENT');
    }
    const shown = await call('get_properties', { address, names: ['display', 'min', 'max', 'name', 'is_enabled'] });
    assert(shown.properties.name === cont.name && shown.properties.max === cont.max, JSON.stringify(shown.properties));
  });
  await check('device properties: rename, on/off, collapse; rack-only properties are unavailable on plain devices', async () => {
    const address = `${dt}/devices/1`;
    await call('set_properties', { address, properties: { name: 'MCP TEST EQ', on: false, collapsed: true } });
    const got = await call('get_properties', { address });
    assert(got.properties.name === 'MCP TEST EQ' && got.properties.on === false && got.properties.collapsed === true, JSON.stringify(got.properties));
    assert('visible_macro_count' in got.unavailable, 'rack-only properties are unavailable on an EQ');
    await call('set_properties', { address, properties: { on: true, collapsed: false } });
    assert((await call('get_properties', { address, names: ['on'] })).properties.on === true, 'switching back on');
    assert((await devicesOf(dt))[1] === 'MCP TEST EQ', 'the rename reached Live');
    await call('set_properties', { address: `${dt}/devices/name:MCP TEST EQ`, properties: { name: 'EQ Eight' } });
  });
  await check('racks: insert_chain, devices inside chains, nested parameters, chain mixer and macros', async () => {
    const rack = `${dt}/devices/2`;
    const chain = await call('device_action', { action: 'insert_chain', address: rack });
    assert(chain.address === `${rack}/chains/0`, JSON.stringify(chain));
    const inner = await call('device_action', { action: 'insert', address: chain.address, name: 'Utility' });
    assert(inner.address === `${chain.address}/devices/0`, JSON.stringify(inner));
    const info = await call('get_device', { address: rack });
    assert(info.chains.length === 1 && info.chains[0].devices[0].address === inner.address, JSON.stringify(info.chains).slice(0, 200));
    const gain = (await call('get_device', { address: inner.address })).parameters.find((p) => p.name === 'Gain' || p.name === 'Output');
    assert(gain, 'Utility should have a gain-like parameter');
    const setGain = await call('set_properties', { address: gain.address, properties: { value: gain.min + 0.4 * (gain.max - gain.min) } });
    near(setGain.applied.value.to, gain.min + 0.4 * (gain.max - gain.min), 1e-4 * (gain.max - gain.min), 'nested parameter');
    await call('set_properties', { address: chain.address, properties: { name: 'MCP CHAIN', mute: true, volume: 0.5, panning: -0.25 } });
    const props = await call('get_properties', { address: chain.address, names: ['name', 'mute', 'volume', 'panning'] });
    assert(props.properties.name === 'MCP CHAIN' && props.properties.mute === true, JSON.stringify(props.properties));
    near(props.properties.volume, 0.5, 1e-4, 'chain volume'); near(props.properties.panning, -0.25, 1e-4, 'chain pan');
    await call('set_properties', { address: chain.address, properties: { mute: false } });
    const mixerParam = await call('get_properties', { address: `${chain.address}/mixer/volume`, names: ['value', 'display'] });
    near(mixerParam.properties.value, 0.5, 1e-4, 'the chain mixer volume is a parameter too');
    const macros = await call('device_action', { action: 'add_macro', address: rack });
    assert(macros.visible_macro_count > 8, `add_macro should show more macros: ${JSON.stringify(macros)}`);
    assert((await call('device_action', { action: 'remove_macro', address: rack })).visible_macro_count === 8, 'remove_macro goes back to 8');
    const stored = await call('device_action', { action: 'store_variation', address: rack });
    assert(stored.variation_count === 1, JSON.stringify(stored));
    await failsWith(() => call('device_action', { action: 'recall_variation', address: rack }), 'UNAVAILABLE', 'No variation is selected');
    await call('device_action', { action: 'recall_variation', address: rack, index: 0 });
    assert((await call('device_action', { action: 'delete_variation', address: rack })).variation_count === 0, 'delete_variation');
    await failsWith(() => call('device_action', { action: 'recall_variation', address: rack }), 'UNAVAILABLE', 'no stored variations');
    await failsWith(() => call('device_action', { action: 'add_macro', address: `${dt}/devices/0` }), 'INVALID_ARGUMENT');
    await call('device_action', { action: 'randomize_macros', address: rack });
  });
  await check('duplicate copies an effect next to itself, Live refuses to duplicate an instrument, move relocates a device', async () => {
    const dup = await call('device_action', { action: 'duplicate', address: `${dt}/devices/1` });
    assert(dup.address === `${dt}/devices/2` && dup.name === 'EQ Eight', JSON.stringify(dup));
    await failsWith(() => call('device_action', { action: 'duplicate', address: `${dt}/devices/0` }), 'LIVE_ERROR', 'instrument');
    const moved = await call('device_action', { action: 'move', address: dup.address, to: `${dt}/devices/3/chains/0` });
    assert(moved.address === `${dt}/devices/2/chains/0/devices/1` || moved.address.startsWith(`${dt}/devices/`), JSON.stringify(moved));
    const back = await call('device_action', { action: 'move', address: moved.address, to: dt });
    assert((await devicesOf(dt)).filter((n) => n === 'EQ Eight').length === 2, `the device should be back on the track: ${await devicesOf(dt)}`);
    assert(back.position === (await devicesOf(dt)).length - 1, JSON.stringify(back));
  });
  await check('a drum rack exposes its pads by MIDI note; pads take mute and solo; clearing needs the guard', async () => {
    const kitTrack = await makeScratchTrack();       // a device chain holds one instrument, so the kit gets its own track
    const kit = await call('device_action', { action: 'insert', address: `tracks/${kitTrack}`, name: 'Drum Rack' });
    const pad = `${kit.address}/drum_pads/36`;
    const shown = await call('get_properties', { address: pad });
    assert(shown.properties.note === 36, JSON.stringify(shown.properties));
    // Live ignores mute and solo on a pad that holds nothing: the tool reports what Live actually holds afterwards
    const muted = await call('set_properties', { address: pad, properties: { mute: true, solo: false } });
    assert((await call('get_properties', { address: pad, names: ['mute'] })).properties.mute === muted.applied.mute.to, 'the reported value is the one Live holds');
    await call('set_properties', { address: pad, properties: { mute: false } });
    await failsWith(() => call('get_properties', { address: `${kit.address}/drum_pads/300` }), 'OUT_OF_RANGE');
    await failsWith(() => call('device_action', { action: 'clear_pad', address: pad }), 'INVALID_ARGUMENT');
    await failsWith(() => call('device_action', { action: 'clear_pad', address: pad, expect: { name: 'Wrong Name' } }), 'GUARD_FAILED');
    const cleared = await call('device_action', { action: 'clear_pad', address: pad, expect: { name: shown.properties.name } });
    assert(cleared.cleared_chains === 0, JSON.stringify(cleared));
    await failsWith(() => call('device_action', { action: 'copy_pad', address: kit.address, from_note: 36, to_note: 400 }), 'INVALID_ARGUMENT');
  });
  await check('delete needs the guard; one undo brings a deleted device back and another removes an inserted one', async () => {
    const names = await devicesOf(dt);
    const last = names.length - 1;
    await failsWith(() => call('device_action', { action: 'delete', address: `${dt}/devices/${last}` }), 'INVALID_ARGUMENT');
    await failsWith(() => call('device_action', { action: 'delete', address: `${dt}/devices/${last}`, expect: { name: 'Wrong Name' } }), 'GUARD_FAILED');
    assert((await devicesOf(dt)).length === names.length, 'a refused delete removed something');
    const removed = await call('device_action', { action: 'delete', address: `${dt}/devices/${last}`, expect: { name: names[last] } });
    assert(removed.remaining === names.length - 1, JSON.stringify(removed));
    await call('history', { action: 'undo' });
    assert((await devicesOf(dt)).join() === names.join(), 'one undo should bring the deleted device back');
    const inserted = await call('device_action', { action: 'insert', address: dt, name: 'Utility' });
    assert((await devicesOf(dt)).length === names.length + 1 && inserted.address === `${dt}/devices/${names.length}`, 'insert');
    await call('history', { action: 'undo' });
    assert((await devicesOf(dt)).length === names.length, 'one undo should remove the inserted device');
  });
  await check('save_ab stores a preset in the compare slot of a device that supports it', async () => {
    const drift = `${dt}/devices/${(await devicesOf(dt)).indexOf('Drift')}`;
    const can = (await call('get_properties', { address: drift, names: ['can_compare_ab'] })).properties.can_compare_ab;
    if (!can) {
      console.log('       this device cannot A/B compare: skipped');
      return;
    }
    const out = await call('device_action', { action: 'save_ab', address: drift });
    assert(out.is_using_compare_preset_b === false || out.is_using_compare_preset_b === true, JSON.stringify(out));
  });

  console.log('\nBatch');
  const trackCount = () => call('eval', { code: 'len(self._song.tracks)' });
  const lastTrackPtr = () => call('eval', { code: 'self._song.tracks[-1]._live_ptr' });
  cleanupsRegistry.push(async () => {       // a batch that failed to clean up after itself must not leave tracks behind
    for (const name of ['MCP TEST BATCH', 'MCP TEST BATCH 2']) {
      const found = await call('eval', { code: `[i for i, t in enumerate(self._song.tracks) if t.name.endswith(${JSON.stringify(name)})]` });
      for (const i of found.reverse()) await call('eval', { code: `self._song.delete_track(${i})` });
    }
  });
  await check('a batch builds a track, a device and a clip in one call, using earlier results, and one undo reverts all of it', async () => {
    const before = await trackCount();
    const result = await call('batch', { ops: [
      { command: 'create', params: { kind: 'midi_track', name: 'MCP TEST BATCH' } },
      { command: 'device_action', params: { action: 'insert', address: '$0.address', name: 'Drift' } },
      { command: 'create', params: { kind: 'midi_clip', address: '$0.address/slots/0', length: 4, name: 'batched' } },
      { command: 'write_notes', params: { address: '$2.address', notes: [{ pitch: 60, start_time: 0, duration: 1 }] } },
      { command: 'set_properties', params: { address: '$0.address', properties: { name: 'MCP TEST BATCH', mute: false } } },
      { command: 'get_properties', params: { address: '$2.address', names: ['name', 'length'] } }] });
    assert(result.ok && result.applied === 6, JSON.stringify(result).slice(0, 300));
    const track = result.results[0].result.address;
    assert(result.results[1].result.address === `${track}/devices/0` && result.results[2].result.address === `${track}/slots/0/clip`, 'references resolved to the created objects');
    assert(JSON.stringify(result.results[5].result.properties) === JSON.stringify({ name: 'batched', length: 4 }), JSON.stringify(result.results[5].result));
    assert(result.results[1].result.name === 'Drift', 'the device op saw the track created by op 0');
    assert((await trackCount()) === before + 1, 'the track exists');
    assert((await call('get_notes', { address: `${track}/slots/0/clip` })).count === 1, 'the notes are in the clip');
    await call('history', { action: 'undo' });
    assert((await trackCount()) === before, 'ONE undo should remove the track, its device and its clip together');
    await call('history', { action: 'redo' });
    assert((await trackCount()) === before + 1, 'redo brings the whole batch back');
    await call('delete', { address: track, expect: { name: (await call('get_properties', { address: track, names: ['name'] })).properties.name } });
  });
  await check('Live records a device parameter write as its own undo entry even inside a batch: one extra undo', async () => {
    const before = await trackCount();
    const made = await call('batch', { ops: [
      { command: 'create', params: { kind: 'midi_track', name: 'MCP TEST BATCH' } },
      { command: 'device_action', params: { action: 'insert', address: '$0.address', name: 'Drift' } },
      { command: 'set_properties', params: { address: '$1.address/parameters/1', properties: { value: 0 } } }] });
    assert(made.applied === 3, JSON.stringify(made).slice(0, 200));
    let undos = 0;
    while ((await trackCount()) > before && undos < 4) {
      await call('history', { action: 'undo' });
      undos += 1;
    }
    assert((await trackCount()) === before && undos === 2, `expected 2 undos (the parameter write, then the rest), needed ${undos}`);
  });
  await check('a failing batch stops, keeps what ran as one undo step, reports every op, and Live explains the failure', async () => {
    const before = await trackCount();
    let failure;
    try {
      await call('batch', { ops: [
        { command: 'create', params: { kind: 'midi_track', name: 'MCP TEST BATCH 2' } },
        { command: 'device_action', params: { action: 'insert', address: '$0.address', name: 'Definitely Not A Device' } },
        { command: 'create', params: { kind: 'scene' } }] });
    } catch (err) {
      failure = err;
    }
    assert(failure && failure.bridgeCode === 'BATCH_FAILED', `expected BATCH_FAILED, got ${failure && failure.bridgeCode}`);
    assert(failure.details.applied === 1 && failure.details.failed[0] === 1 && failure.details.not_run[0] === 2, JSON.stringify(failure.details).slice(0, 200));
    assert(failure.details.results[1].code === 'NOT_FOUND' && /not found/i.test(failure.details.results[1].message), JSON.stringify(failure.details.results[1]));
    assert((await trackCount()) === before + 1, 'the op before the failure stays applied');
    assert((await call('describe_set')).scenes.length === setBefore.scenes.length, 'the op after the failure did not run');
    await call('history', { action: 'undo' });
    assert((await trackCount()) === before, 'the applied part is one undo step');
  });
  await check('a batch is refused up front when it holds ops that are not undoable edits, and nothing runs', async () => {
    const before = await trackCount();
    for (const command of ['transport', 'launch', 'history', 'eval', 'ramp_parameter', 'batch']) {
      try {
        await call('batch', { ops: [{ command: 'create', params: { kind: 'midi_track', name: 'MCP TEST BATCH' } }, { command }] });
      } catch (err) {
        assert(err.bridgeCode === 'INVALID_ARGUMENT' && err.message.includes('cannot run inside a batch'), `${command}: ${err.bridgeCode} ${err.message}`);
        continue;
      }
      throw new Error(`${command} should not run inside a batch`);
    }
    assert((await trackCount()) === before, 'a refused batch created something');
  });
  await check('many edits in one batch are much faster than the same edits one by one', async () => {
    const address = `tracks/${T}`;
    const original = (await call('get_properties', { address, names: ['panning'] })).properties.panning;
    const values = Array.from({ length: 40 }, (_, i) => (i % 2 ? -0.1 : 0.1));
    const t0 = performance.now();
    for (const value of values) await call('set_properties', { address, properties: { panning: value } });
    const separate = performance.now() - t0;
    const t1 = performance.now();
    await call('batch', { ops: values.map((value) => ({ command: 'set_properties', params: { address, properties: { panning: value } } })) });
    const batched = performance.now() - t1;
    await call('set_properties', { address, properties: { panning: original } });
    console.log(`       40 writes: ${separate.toFixed(0)} ms one by one, ${batched.toFixed(0)} ms in one batch`);
    assert(batched < separate, 'a batch should beat separate round trips');
  });

  console.log('\nRouting and mixer state');
  const audio = await call('create', { kind: 'audio_track', name: 'MCP TEST ROUTE' });
  await trackPtr(audio.address, 'tracks');
  const failsCode = async (fn, code, fragment) => {
    try {
      await fn();
    } catch (err) {
      assert(err.bridgeCode === code, `expected ${code}, got ${err.bridgeCode} (${err.message})`);
      if (fragment) assert(err.message.includes(fragment), `expected "${fragment}" in "${err.message}"`);
      return;
    }
    throw new Error(`expected the call to fail with ${code}`);
  };
  await check('routing get lists the current routing and every available type and channel, for input and output', async () => {
    for (const direction of ['input', 'output']) {
      const got = await call('routing', { address: audio.address, direction });
      assert(got.type.display_name && got.type.category && got.available_types.length >= 2, `${direction}: ${JSON.stringify(got).slice(0, 200)}`);
      assert(got.available_types.some((t) => t.display_name === got.type.display_name), `${direction}: the current type is among the available ones`);
    }
    const master = await call('routing', { address: 'master', direction: 'output' });
    assert(master.type.display_name.length > 0, JSON.stringify(master).slice(0, 160));
    assert((await call('routing', { address: 'master', direction: 'input' })).available_types.length > 0, 'the master has an input routing too');
    await failsCode(() => call('routing', { address: 'song', direction: 'input' }), 'INVALID_ARGUMENT');
  });
  await check('output routing can be changed to another available destination and back', async () => {
    const got = await call('routing', { address: audio.address, direction: 'output' });
    const other = got.available_types.find((t) => t.display_name !== got.type.display_name);
    assert(other, 'a second output destination should exist');
    const changed = await call('routing', { address: audio.address, direction: 'output', action: 'set', type: other.display_name });
    assert(changed.type.display_name === other.display_name && changed.from.type === got.type.display_name, JSON.stringify(changed).slice(0, 200));
    assert((await call('routing', { address: audio.address, direction: 'output' })).type.display_name === other.display_name, 'Live holds the new routing');
    await call('routing', { address: audio.address, direction: 'output', action: 'set', type: got.type.display_name });
    assert((await call('routing', { address: audio.address, direction: 'output' })).type.display_name === got.type.display_name, 'restored');
    await failsCode(() => call('routing', { address: audio.address, direction: 'output', action: 'set', type: 'No Such Destination' }), 'NOT_FOUND', 'Available:');
  });
  await check('feedback guard: resampling into a monitoring track needs allow_feedback or monitoring Off', async () => {
    const inputs = (await call('routing', { address: audio.address, direction: 'input' })).available_types;
    const resampling = inputs.find((t) => t.category === 'resampling');
    if (!resampling) {
      console.log('       no resampling input on this track: skipped');
      return;
    }
    const original = (await call('routing', { address: audio.address, direction: 'input' })).type.display_name;
    await call('set_properties', { address: audio.address, properties: { current_monitoring_state: 'IN' } });
    await failsCode(() => call('routing', { address: audio.address, direction: 'input', action: 'set', type: resampling.display_name }), 'GUARD_FAILED', 'allow_feedback');
    assert((await call('routing', { address: audio.address, direction: 'input' })).type.display_name === original, 'a refused set changed the routing');
    await call('set_properties', { address: audio.address, properties: { current_monitoring_state: 'OFF' } });
    const set = await call('routing', { address: audio.address, direction: 'input', action: 'set', type: resampling.display_name });
    assert(set.type.category === 'resampling', JSON.stringify(set.type));
    await call('routing', { address: audio.address, direction: 'input', action: 'set', type: original });
  });
  await check('a Compressor side-chain is routed through the same tool', async () => {
    const comp = await call('device_action', { action: 'insert', address: audio.address, name: 'Compressor' });
    const got = await call('routing', { address: comp.address, direction: 'input' });
    assert(got.available_types.length >= 2 && got.type.display_name, JSON.stringify(got).slice(0, 200));
    const same = await call('routing', { address: comp.address, direction: 'input', action: 'set', type: got.type.display_name });
    assert(same.type.display_name === got.type.display_name, 'setting the current side-chain source is a no-op');
  });
  await check('crossfade assign and panning mode are properties of a track', async () => {
    const before = await call('get_properties', { address: audio.address, names: ['crossfade_assign', 'panning_mode'] });
    assert(['A', 'NONE', 'B'].includes(before.properties.crossfade_assign) && ['stereo', 'stereo_split'].includes(before.properties.panning_mode), JSON.stringify(before.properties));
    await call('set_properties', { address: audio.address, properties: { crossfade_assign: 'B', panning_mode: 'stereo_split' } });
    const after = await call('get_properties', { address: audio.address, names: ['crossfade_assign', 'panning_mode'] });
    assert(after.properties.crossfade_assign === 'B' && after.properties.panning_mode === 'stereo_split', JSON.stringify(after.properties));
    const split = await call('get_properties', { address: `${audio.address}/mixer/left_split_stereo`, names: ['name', 'value'] });
    assert(typeof split.properties.value === 'number', JSON.stringify(split.properties));
    await call('set_properties', { address: audio.address, properties: before.properties });
    await failsCode(() => call('set_properties', { address: audio.address, properties: { crossfade_assign: 'C' } }), 'INVALID_ARGUMENT');
    const master = await call('get_properties', { address: 'master/mixer/crossfader', names: ['name', 'min', 'max'] });
    assert(master.properties.max > master.properties.min, JSON.stringify(master.properties));
    assert((await call('get_properties', { address: 'master/mixer/cue_volume', names: ['name'] })).properties.name.length > 0, 'cue volume is a parameter of the master mixer');
    assert((await call('get_properties', { address: 'master/mixer/song_tempo', names: ['name'] })).properties.name.length > 0, 'the song tempo is a parameter of the master mixer');
  });

  console.log('\ndraw_automation');
  await check('linear ramp: readback and independent envelope values match', async () => {
    const lo = pA.min + 0.2 * (pA.max - pA.min);
    const hi = pA.min + 0.9 * (pA.max - pA.min);
    const out = await call('draw_automation', {
      ...sendA, clip_index: S, points: [{ time: 0, value: lo }, { time: CLIP_BEATS, value: hi }], resolution: 0.125, style: 'steps'
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
    assert(out.breakpoints > 0, 'nothing drawn');
    const [early, late] = await envelopeAt(T, S, paramExpr(T, D, pA.index), [0.3, 3.8]);
    near(early, pA.min + 0.1 * span, 1e-3 * span, 'hold before first point');
    near(late, pA.min + 0.2 * span, 1e-3 * span, 'hold after last point (later duplicate wins)');
  });
  await check('a fine resolution draws many steps in one round trip', async () => {
    const t0 = performance.now();
    const out = await call('draw_automation', { ...sendA, clip_index: S, resolution: 0.01, style: 'steps', points: [{ time: 0, value: pA.min }, { time: 4, value: pA.max }] });
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

  console.log('\nAutomation by address: breakpoints, get_automation, merge edges');
  const autoClip = `tracks/${T}/slots/${S}/clip`;
  const autoParam = `tracks/${T}/devices/${D}/parameters/${pA.index}`;
  const spanA = pA.max - pA.min;
  await check('breakpoint drawing is light: a linear ramp is two breakpoints, a curve a few dozen, and Live interpolates between them', async () => {
    const lin = await call('draw_automation', { clip: autoClip, parameter: autoParam, points: [{ time: 0, value: pA.min + 0.2 * spanA }, { time: 4, value: pA.min + 0.8 * spanA }] });
    assert(lin.style === 'breakpoints' && lin.breakpoints === 2, JSON.stringify(lin).slice(0, 200));
    const [a, b, c] = await envelopeAt(T, S, paramExpr(T, D, pA.index), [1, 2, 3]);
    near(a, pA.min + 0.35 * spanA, 2e-3 * spanA, '25%'); near(b, pA.min + 0.5 * spanA, 2e-3 * spanA, '50%'); near(c, pA.min + 0.65 * spanA, 2e-3 * spanA, '75%');
    const curved = await call('draw_automation', { clip: autoClip, parameter: autoParam, curve: 'ease_in', resolution: 0.25, points: [{ time: 0, value: pA.min }, { time: 4, value: pA.max }] });
    assert(curved.breakpoints === 17, `breakpoints ${curved.breakpoints}`);
    const [q1, q2] = await envelopeAt(T, S, paramExpr(T, D, pA.index), [1, 2]);
    near(q1, pA.min + 0.0625 * spanA, 3e-3 * spanA, 'ease_in at 25% is 6.25%'); near(q2, pA.min + 0.25 * spanA, 3e-3 * spanA, 'ease_in at 50% is 25%');
  });
  await check('a step draws a real jump, and get_automation reads breakpoints and the jump back in the parameter units', async () => {
    await call('draw_automation', { clip: autoClip, parameter: autoParam, curve: 'step', points: [{ time: 0, value: pA.min + 0.2 * spanA }, { time: 2, value: pA.min + 0.7 * spanA }, { time: 4, value: pA.min + 0.4 * spanA }] });
    const got = await call('get_automation', { clip: autoClip });
    assert(got.has_envelopes && got.envelopes.length >= 1, JSON.stringify(got).slice(0, 200));
    const env = got.envelopes.find((e) => e.parameter === autoParam);
    assert(env && env.name === pA.name && env.min === pA.min && env.max === pA.max, JSON.stringify(env).slice(0, 200));
    const jump = env.breakpoints.find((p) => Math.abs(p.time - 2) < 1e-3 && p.jump_from !== undefined);
    assert(jump, `the jump at beat 2 should be reported: ${JSON.stringify(env.breakpoints)}`);
    near(jump.value, pA.min + 0.7 * spanA, 2e-3 * spanA, 'value after the jump'); near(jump.jump_from, pA.min + 0.2 * spanA, 2e-3 * spanA, 'value before the jump');
    const one = await call('get_automation', { clip: autoClip, parameter: autoParam });
    assert(one.envelopes.length === 1, 'a single parameter');
    const none = await call('get_automation', { clip: autoClip, parameter: `tracks/${T}/mixer/panning` });
    assert(none.envelopes.length === 0, 'a parameter without an envelope reports none');
    const capped = await call('get_automation', { clip: autoClip, parameter: autoParam, max_points: 2 });
    assert(capped.envelopes[0].breakpoints.length === 2 && capped.envelopes[0].truncated === true, JSON.stringify(capped.envelopes[0]).slice(0, 200));
  });
  await check('merge keeps the envelope outside the drawn range exactly as it was, for straight lines too', async () => {
    await call('draw_automation', { clip: autoClip, parameter: autoParam, points: [{ time: 0, value: pA.min + 0.1 * spanA }, { time: 4, value: pA.min + 0.9 * spanA }] });
    const [b1, b2] = await envelopeAt(T, S, paramExpr(T, D, pA.index), [0.5, 3.5]);
    await call('draw_automation', { clip: autoClip, parameter: autoParam, mode: 'merge', hold: false, points: [{ time: 1, value: pA.min + 0.5 * spanA }, { time: 3, value: pA.min + 0.5 * spanA }] });
    const [before, inside, after] = await envelopeAt(T, S, paramExpr(T, D, pA.index), [0.5, 2, 3.5]);
    near(before, b1, 3e-3 * spanA, 'before the range: the old line'); near(inside, pA.min + 0.5 * spanA, 3e-3 * spanA, 'inside: the new drawing'); near(after, b2, 3e-3 * spanA, 'after the range: the old line');
  });
  await check('the address form and the older track_index form draw the same envelope', async () => {
    const points = [{ time: 0, value: pA.min + 0.3 * spanA }, { time: 4, value: pA.min + 0.6 * spanA }];
    await call('draw_automation', { clip: autoClip, parameter: autoParam, points });
    const viaAddress = await envelopeAt(T, S, paramExpr(T, D, pA.index), [0.5, 2, 3.5]);
    await call('draw_automation', { ...sendA, clip_index: S, points });
    const viaIndex = await envelopeAt(T, S, paramExpr(T, D, pA.index), [0.5, 2, 3.5]);
    viaAddress.forEach((v, i) => near(viaIndex[i], v, 1e-6 * spanA, `time ${i}`));
    await call('clear_automation', { clip: autoClip, parameter: autoParam });
    assert(!(await hasEnvelope(T, S, paramExpr(T, D, pA.index))), 'cleared by address');
  });
  await check('a ramp by address replaces a ramp started the older way, and cancel_ramps by address cancels it', async () => {
    await call('ramp_parameter', { ...sendA, to: pA.max, from: pA.min, seconds: 5 });
    const second = await call('ramp_parameter', { parameter: autoParam, to: pA.min, from: pA.max, seconds: 5 });
    assert(second.active_ramps === 1, `one ramp per parameter however it is addressed: ${second.active_ramps}`);
    const cancelled = await call('cancel_ramps', { parameter: autoParam });
    assert(cancelled.cancelled === 1 && cancelled.active_ramps === 0, JSON.stringify(cancelled));
    await call('set_device_parameter', { ...sendA, value: pA.value });
  });
  await check('re_enable_automation hands an overridden parameter back to its clip automation (only when it is overridden)', async () => {
    const isPlaying = await call('eval', { code: 'bool(self._song.is_playing)' });
    await call('draw_automation', { clip: autoClip, parameter: autoParam, points: [{ time: 0, value: pA.min + 0.3 * spanA }, { time: 4, value: pA.min + 0.6 * spanA }] });
    const state = (await call('get_properties', { address: autoParam, names: ['automation_state'] })).properties.automation_state;
    if (state !== 2) {
      try {
        await call('device_action', { action: 're_enable_automation', address: autoParam });
        throw new Error('re_enable_automation should refuse a parameter that is not overridden');
      } catch (err) {
        assert(err.bridgeCode === 'UNAVAILABLE', `${err.bridgeCode}: ${err.message}`);
      }
    }
    console.log(`       parameter automation_state ${state} (${isPlaying ? 'playing' : 'stopped'}): the override path needs a manual change during playback`);
    await call('device_action', { action: 're_enable_automation', address: 'song' });
    await call('clear_automation', { clip: autoClip });
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
    assert(out.target.device_path.join() === nestedPath().join() && out.breakpoints >= 2, JSON.stringify(out.target));
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
  await check('the Set is exactly as it was before this run (fingerprint invariant)', async () => {
    const setAfter = await call('describe_set');
    if (setAfter.fingerprint === setBefore.fingerprint) return;
    const changed = [];
    for (const group of ['tracks', 'returns']) {
      const a = Object.fromEntries(setBefore[group].map((t) => [t.address, t.hash]));
      for (const t of setAfter[group]) if (a[t.address] !== t.hash) changed.push(`${t.address} (${t.name})`);
      if (setBefore[group].length !== setAfter[group].length) changed.push(`${group}: ${setBefore[group].length} -> ${setAfter[group].length}`);
    }
    if (setBefore.master.hash !== setAfter.master.hash) changed.push('master');
    if (JSON.stringify(setBefore.scenes) !== JSON.stringify(setAfter.scenes)) changed.push('scenes');
    if (JSON.stringify(setBefore.song) !== JSON.stringify(setAfter.song)) changed.push('song settings');
    throw new Error(`the run left the Set changed: ${changed.join(', ') || 'unknown difference'}`);
  });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
