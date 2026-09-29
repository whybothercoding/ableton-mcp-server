// MCP-layer test: spawns dist/index.js and drives the automation/ramp tools through a real MCP client,
// so tool schemas, argument handling and error reporting are exercised end to end. Needs a running Live.
//
//   npm run build && node test/mcp-tools.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = new Client({ name: 'mcp-tools-test', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [path.join(root, 'dist', 'index.js')], stderr: 'ignore' }));

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
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const near = (a, b, tol, label) => assert(Math.abs(a - b) <= tol, `${label}: expected ${b} ± ${tol}, got ${a}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain-text error */
  }
  return { isError: Boolean(result.isError), data, text };
}
async function ok(name, args) {
  const r = await tool(name, args);
  assert(!r.isError, `${name} failed: ${r.text}`);
  return r.data;
}
async function fails(name, args, fragment) {
  const r = await tool(name, args);
  assert(r.isError, `${name} should have failed`);
  assert(r.text.includes(fragment), `${name}: expected "${fragment}" in "${r.text}"`);
}

// discovery through the public tools
const session = await ok('describe_set');
let T, S, D, P;
for (const track of session.tracks) {
  if (track.kind !== 'midi' || track.devices.length < 1) continue;
  const trackIndex = Number(track.address.split('/')[1]);
  const detail = await ok('get_track_detail', { track_index: trackIndex });
  const free = detail.clip_slots.find((slot) => !slot.has_clip);
  const params = (await ok('get_device_parameters', { track_index: trackIndex, device_index: 0 })).parameters;
  const p = params.find((x) => x.index > 0 && x.max > x.min && !/\bon\b|type|mode|sync/i.test(x.name) && !Number.isInteger(x.value));
  if (free && p) {
    [T, S, D, P] = [trackIndex, free.index, 0, p];
    break;
  }
}
assert(T !== undefined, 'no MIDI track with a device and a free slot');
const original = P.value;
const span = P.max - P.min;
const target = { track_index: T, device_index: D, parameter_index: P.index };
console.log(`Track ${T}, parameter "${P.name}", scratch slot ${S}\n`);

try {
  await ok('create', { kind: 'midi_clip', address: `tracks/${T}/slots/${S}`, length: 4, name: 'MCP TOOL TEST' });

  console.log('Tool listing');
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await check('all four new tools are listed exactly once with object schemas', async () => {
    assert(new Set(tools.map((t) => t.name)).size === tools.length, 'duplicate tool names');
    for (const name of ['draw_automation', 'clear_automation', 'ramp_parameter', 'cancel_ramps']) {
      assert(byName[name], `${name} missing`);
      assert(byName[name].inputSchema.type === 'object', `${name} schema is not an object`);
      assert(byName[name].description.length > 40, `${name} has no useful description`);
    }
  });
  await check('required arguments are declared', async () => {
    assert(JSON.stringify(byName.draw_automation.inputSchema.required) === JSON.stringify(['track_index', 'clip_index', 'points']), 'draw_automation.required');
    assert(JSON.stringify(byName.clear_automation.inputSchema.required) === JSON.stringify(['track_index', 'clip_index']), 'clear_automation.required');
    assert(JSON.stringify(byName.ramp_parameter.inputSchema.required) === JSON.stringify(['track_index', 'to']), 'ramp_parameter.required');
    assert(byName.cancel_ramps.inputSchema.required === undefined, 'cancel_ramps takes no required args');
  });
  await check('point schema and curve enums are exposed', async () => {
    const point = byName.draw_automation.inputSchema.properties.points.items;
    assert(JSON.stringify(point.required) === JSON.stringify(['time', 'value']), 'point.required');
    assert(byName.draw_automation.inputSchema.properties.curve.enum.includes('step'), 'draw curve enum');
    assert(!byName.ramp_parameter.inputSchema.properties.curve.enum.includes('step'), 'ramp curve must not offer step');
  });

  console.log('\nTool calls');
  await check('draw_automation via MCP with a device parameter', async () => {
    const out = await ok('draw_automation', {
      ...target, clip_index: S, points: [{ time: 0, value: P.min + 0.2 * span }, { time: 4, value: P.min + 0.8 * span }], curve: 'smooth'
    });
    assert(out.parameter === P.name && out.steps > 10 && out.mode === 'replace', JSON.stringify(out));
    for (const row of out.readback) near(row.actual, row.expected, 1e-4 * span, `readback @${row.time}`);
  });
  await check('draw_automation via MCP on the mixer, optional device fields omitted', async () => {
    const out = await ok('draw_automation', { track_index: T, clip_index: S, mixer_parameter: 'volume', points: [{ time: 0, value: 0.4 }, { time: 4, value: 0.7 }] });
    assert(out.parameter === 'Volume' || /vol/i.test(out.parameter), out.parameter);
    assert(out.target.mixer_parameter === 'volume', JSON.stringify(out.target));
  });
  await check('draw_automation merge and hold=false through MCP', async () => {
    const out = await ok('draw_automation', {
      ...target, clip_index: S, mode: 'merge', hold: false, curve: 'step',
      points: [{ time: 1, value: P.min + 0.5 * span }, { time: 3, value: P.min + 0.5 * span }]
    });
    assert(out.mode === 'merge', JSON.stringify(out));
  });
  await check('clear_automation via MCP: one parameter, then everything', async () => {
    const one = await ok('clear_automation', { ...target, clip_index: S });
    assert(one.had_envelope === true && one.cleared === P.name, JSON.stringify(one));
    const all = await ok('clear_automation', { track_index: T, clip_index: S });
    assert(all.cleared === 'all' && all.clip_has_envelopes === false, JSON.stringify(all));
  });
  await check('ramp_parameter via MCP in beats, with optional fields omitted', async () => {
    const out = await ok('ramp_parameter', { ...target, to: P.min + 0.9 * span, from: P.min + 0.1 * span, beats: 0.5, curve: 'ease_out' });
    assert(out.curve === 'ease_out' && out.seconds > 0 && out.active_ramps >= 1, JSON.stringify(out));
    await sleep(out.seconds * 1000 + 300);
    const now = await ok('get_device_parameters', { track_index: T, device_index: D });
    near(now.parameters.find((x) => x.index === P.index).value, P.min + 0.9 * span, 1e-6 * span, 'landed on target');
  });
  await check('cancel_ramps via MCP with and without arguments', async () => {
    await ok('ramp_parameter', { ...target, to: P.max, from: P.min, seconds: 5 });
    const one = await ok('cancel_ramps', target);
    assert(one.cancelled === 1, JSON.stringify(one));
    await ok('ramp_parameter', { ...target, to: P.max, from: P.min, seconds: 5 });
    const all = await ok('cancel_ramps');
    assert(all.cancelled === 1 && all.active_ramps === 0, JSON.stringify(all));
  });
  await check('errors come back as tool errors with the reason', async () => {
    await fails('draw_automation', { ...target, clip_index: S }, 'non-empty');
    await fails('draw_automation', { ...target, clip_index: S, points: [{ time: 99, value: 0 }] }, 'outside the clip');
    await fails('draw_automation', { track_index: 999, clip_index: S, mixer_parameter: 'volume', points: [{ time: 0, value: 0.5 }] }, 'Track index out of range');
    await fails('draw_automation', { ...target, clip_index: S + 1, points: [{ time: 0, value: P.min }] }, 'empty');
    await fails('clear_automation', { track_index: T }, 'clip_index');
    await fails('ramp_parameter', { ...target, to: P.max }, 'exactly one');
    await fails('ramp_parameter', { ...target, seconds: 1 }, 'to must');
    await fails('ramp_parameter', { ...target, to: P.max + 1000, seconds: 1 }, 'to must');
  });
  await check('get_health lists the new capabilities', async () => {
    const health = await ok('get_health');
    for (const c of ['draw_automation', 'clear_automation', 'ramp_parameter', 'cancel_ramps']) assert(health.capabilities.includes(c), `${c} missing`);
  });
  await check('an ordinary tool still works after all of that', async () => {
    const info = await ok('get_properties', { address: 'song', names: ['tempo'] });
    assert(typeof info.properties.tempo === 'number', 'no tempo');
  });

  console.log('\nAddresses and properties');
  const clipAddress = `tracks/${T}/slots/${S}/clip`;
  await check('the property tools are listed with accurate annotations', async () => {
    for (const [name, readOnly] of [['get_properties', true], ['list_properties', true], ['set_properties', false]]) {
      const tool = byName[name];
      assert(tool, `${name} missing`);
      assert(tool.annotations?.readOnlyHint === readOnly, `${name}.readOnlyHint should be ${readOnly}: ${JSON.stringify(tool.annotations)}`);
      assert(tool.annotations?.destructiveHint === false, `${name} is not destructive`);
    }
    assert(JSON.stringify(byName.get_properties.inputSchema.required) === JSON.stringify(['address']), 'get_properties.required');
    assert(byName.eval_python === undefined, 'eval_python must be hidden unless ABLETON_MCP_ALLOW_EVAL=1');
  });
  await check('get_properties and list_properties return usable data', async () => {
    const song = await ok('get_properties', { address: 'song', names: ['tempo', 'clip_trigger_quantization'] });
    assert(typeof song.properties.tempo === 'number' && typeof song.properties.clip_trigger_quantization === 'string', JSON.stringify(song));
    const listing = await ok('list_properties', { kind: 'clip' });
    assert(listing.properties.launch_mode.values.includes('gate'), JSON.stringify(listing.properties.launch_mode));
  });
  await check('set_properties changes a scratch clip and reports old and new values', async () => {
    const out = await ok('set_properties', { address: clipAddress, properties: { muted: true, launch_mode: 'toggle' } });
    assert(out.applied.muted.from === false && out.applied.muted.to === true && out.applied.launch_mode.to === 'toggle', JSON.stringify(out));
    const back = await ok('set_properties', { address: clipAddress, properties: { muted: false, launch_mode: 'trigger' } });
    assert(back.applied.muted.to === false, JSON.stringify(back));
  });
  await check('capabilities, set description, transport and history are listed with the right risk annotations', async () => {
    for (const [name, readOnly, destructive] of [['get_capabilities', true, false], ['describe_set', true, false], ['transport', false, false], ['history', false, true]]) {
      const tool = byName[name];
      assert(tool, `${name} missing`);
      assert(tool.annotations?.readOnlyHint === readOnly && tool.annotations?.destructiveHint === destructive, `${name}: ${JSON.stringify(tool.annotations)}`);
    }
  });
  await check('get_capabilities and describe_set return usable data', async () => {
    const caps = await ok('get_capabilities');
    assert(caps.script.build_id && caps.live.version && caps.commands.includes('history'), JSON.stringify(caps).slice(0, 200));
    const set = await ok('describe_set', { include_clips: false });
    assert(set.fingerprint.length === 12 && set.tracks.length > 0 && set.master.address === 'master', JSON.stringify(set).slice(0, 200));
  });
  await check('history undoes exactly the last write and redo reapplies it', async () => {
    await ok('set_properties', { address: clipAddress, properties: { muted: true } });
    const undone = await ok('history', { action: 'undo' });
    assert(undone.performed === 1, JSON.stringify(undone));
    assert((await ok('get_properties', { address: clipAddress, names: ['muted'] })).properties.muted === false, 'undo should revert the write');
    await ok('history', { action: 'redo' });
    assert((await ok('get_properties', { address: clipAddress, names: ['muted'] })).properties.muted === true, 'redo should reapply it');
    await ok('set_properties', { address: clipAddress, properties: { muted: false } });
  });
  await check('transport and history reject bad arguments before reaching Live', async () => {
    await fails('transport', {}, "missing required argument 'action'");
    await fails('transport', { action: 'rewind' }, 'action must be one of: play, continue, stop');
    await fails('transport', { action: 'jump_by' }, 'jump_by needs amount');
    await fails('history', { action: 'rewind' }, 'action must be one of: undo, redo');
    await fails('history', { action: 'undo', steps: 99 }, 'steps must be a whole number from 1 to 50');
  });
  await check('create, duplicate and delete carry the right risk annotations and a mandatory guard', async () => {
    assert(byName.create.annotations.destructiveHint === false && byName.duplicate.annotations.destructiveHint === false, 'create/duplicate are not destructive');
    assert(byName.delete.annotations.destructiveHint === true, 'delete must be flagged destructive');
    assert(JSON.stringify(byName.delete.inputSchema.required) === JSON.stringify(['address', 'expect']), 'delete requires address and expect');
    assert(JSON.stringify(byName.delete.inputSchema.properties.expect.required) === JSON.stringify(['name']), 'expect requires a name');
  });
  await check('create, duplicate and delete work through MCP and the guard refuses a wrong name', async () => {
    const scenes = (await ok('describe_set', { include_clips: false })).scenes.length;
    const made = await ok('create', { kind: 'scene', name: 'MCP TOOL TEST SCENE' });
    let dup = null;
    try {
      assert(made.address === `scenes/${scenes}` && made.name === 'MCP TOOL TEST SCENE', JSON.stringify(made));
      dup = await ok('duplicate', { address: made.address });
      assert(dup.address === `scenes/${scenes + 1}` && dup.name === 'MCP TOOL TEST SCENE', JSON.stringify(dup));
      await fails('delete', { address: made.address, expect: { name: 'Definitely Not This' } }, 'Guard failed');
      await fails('delete', { address: made.address }, "missing required argument 'expect'");
      await fails('delete', { address: made.address, expect: {} }, "expect: missing required argument 'name'");
      assert((await ok('describe_set', { include_clips: false })).scenes.length === scenes + 2, 'refused deletes must remove nothing');
    } finally {
      for (const address of [dup && dup.address, made.address].filter(Boolean)) {
        await tool('delete', { address, expect: { name: 'MCP TOOL TEST SCENE' } });
      }
    }
    assert((await ok('describe_set', { include_clips: false })).scenes.length === scenes, 'the scratch scenes should be gone');
    await fails('create', { kind: 'device' }, 'kind must be one of: audio_track, midi_track, return_track, scene, midi_clip');
    await fails('duplicate', { address: 'master' }, 'Only regular tracks, scenes and clip slots can be duplicated');
  });
  await check('launch and clip_action are listed with the right risk annotations and required arguments', async () => {
    assert(byName.launch.annotations.destructiveHint === false && byName.launch.annotations.readOnlyHint === false, 'launch changes playback, not content');
    assert(byName.clip_action.annotations.destructiveHint === true, 'clip_action rewrites clip content: destructive');
    assert(JSON.stringify(byName.launch.inputSchema.required) === JSON.stringify(['address']), 'launch requires an address');
    assert(JSON.stringify(byName.clip_action.inputSchema.required) === JSON.stringify(['address', 'action']), 'clip_action requires address and action');
  });
  await check('launch and clip_action reject bad calls with readable errors, without touching the Set', async () => {
    await fails('launch', {}, "missing required argument 'address'");
    await fails('launch', { address: clipAddress, legato: 'yes' }, 'legato must be true or false');
    await fails('launch', { address: `tracks/${T}` }, 'A track cannot be fired');
    await fails('launch', { address: 'song' }, 'The song cannot be fired');
    await fails('launch', { address: clipAddress, action: 'jump' }, 'action must be one of: fire, stop');
    await fails('clip_action', { address: clipAddress, action: 'explode' }, 'action must be one of: crop, duplicate_loop');
    await fails('clip_action', { address: `tracks/${T}`, action: 'crop' }, 'needs the address of a clip');
    await fails('clip_action', { address: clipAddress, action: 'crop', expect: { name: 'Definitely Not This' } }, 'Guard failed');
    await fails('clip_action', { address: clipAddress, action: 'quantize', grid: 'sixteenth' }, 'grid must be one of');
  });
  await check('a clip_action goes through MCP on the scratch clip, and history undoes it', async () => {
    const before = await ok('get_properties', { address: clipAddress, names: ['length', 'loop_end'] });
    const result = await ok('clip_action', { address: clipAddress, action: 'duplicate_loop' });
    assert(result.length === before.properties.length * 2, JSON.stringify(result));
    await ok('history', { action: 'undo' });
    assert((await ok('get_properties', { address: clipAddress, names: ['length'] })).properties.length === before.properties.length, 'undo should restore the length');
  });
  await check('note tools are listed with the right risk annotations and required arguments', async () => {
    assert(byName.get_notes.annotations.readOnlyHint === true, 'get_notes is read-only');
    assert(byName.write_notes.annotations.destructiveHint === false && byName.write_notes.annotations.readOnlyHint === false, 'write_notes only adds');
    assert(byName.edit_notes.annotations.destructiveHint === true, 'edit_notes removes and replaces: destructive');
    assert(JSON.stringify(byName.write_notes.inputSchema.required) === JSON.stringify(['address', 'notes']), 'write_notes requires address and notes');
  });
  await check('the note tools work end to end through MCP on the scratch clip and reject bad calls readably', async () => {
    await fails('write_notes', { address: clipAddress, notes: [{ pitch: 60, start_time: 0 }] }, "notes[0]: missing required argument 'duration'");
    await fails('write_notes', { address: clipAddress, notes: [{ pitch: 200, start_time: 0, duration: 1 }] }, 'notes[0]: pitch 200 is outside 0 to 127');
    await fails('edit_notes', { address: clipAddress, action: 'remove' }, 'remove needs exactly one of');
    await fails('edit_notes', { address: clipAddress, action: 'modify', changes: [{ id: 987654, velocity: 5 }] }, 'No notes with ids [987654]');
    const before = (await ok('get_notes', { address: clipAddress })).count;
    const written = await ok('write_notes', { address: clipAddress, notes: [{ pitch: 61, start_time: 0.5, duration: 0.5, probability: 0.6 }] });
    assert(written.ids.length === 1 && written.note_count === before + 1, JSON.stringify(written));
    const note = (await ok('get_notes', { address: clipAddress, ids: written.ids })).notes[0];
    near(note.probability, 0.6, 1e-6, 'probability');
    await ok('edit_notes', { address: clipAddress, action: 'remove', ids: written.ids });
    assert((await ok('get_notes', { address: clipAddress })).count === before, 'the scratch note should be gone');
  });
  await check('argument problems are caught in TypeScript with a readable message', async () => {
    await fails('get_properties', {}, "missing required argument 'address'");
    await fails('get_properties', { address: 5 }, 'address must be a string');
    await fails('get_properties', { address: 'song', names: 'tempo' }, 'names must be an array');
    await fails('set_properties', { items: [{ address: 'song' }] }, "items[0]: missing required argument 'properties'");
    await fails('list_properties', { kind: 'device' }, 'must be one of: song, track, scene, slot, clip');
  });
  await check('bridge problems come back as tool errors with the reason', async () => {
    await fails('get_properties', { address: 'tracks/999' }, 'out of range');
    await fails('get_properties', { address: 'tracks/name:No Such Track' }, "No track named 'No Such Track'");
    await fails('set_properties', { address: clipAddress, properties: { launch_mode: 'sideways' } }, 'trigger, gate, toggle, repeat');
    await fails('set_properties', { address: clipAddress, properties: { muted: 'yes' } }, 'muted must be true or false');
    await fails('set_properties', { address: `tracks/${T}`, properties: { mute: true }, expect: { name: 'Definitely Not This' } }, 'Guard failed');
  });

  console.log('\nTrack types, device paths and parameter details');
  await check('schemas expose track_type and device_path where they apply', async () => {
    for (const name of ['get_track_detail', 'get_device_parameters', 'set_device_parameter', 'load_browser_item', 'ramp_parameter', 'cancel_ramps', 'draw_automation', 'clear_automation']) {
      const prop = byName[name].inputSchema.properties.track_type;
      assert(prop && JSON.stringify(prop.enum) === JSON.stringify(['track', 'return', 'master']), `${name} lacks a track_type enum`);
    }
    for (const name of ['get_device_parameters', 'set_device_parameter', 'ramp_parameter', 'cancel_ramps', 'draw_automation', 'clear_automation']) {
      assert(byName[name].inputSchema.properties.device_path?.type === 'array', `${name} lacks device_path`);
    }
    assert(JSON.stringify(byName.get_device_parameters.inputSchema.required) === JSON.stringify(['track_index']), 'get_device_parameters.required');
    assert(JSON.stringify(byName.set_device_parameter.inputSchema.required) === JSON.stringify(['track_index', 'parameter_index', 'value']), 'set_device_parameter.required');
    const item = byName.bulk_set_device_parameters.inputSchema.properties.parameters.items.properties;
    assert(item.track_type && item.device_path, 'bulk items lack track_type/device_path');
  });
  await check('get_device_parameters returns quantized labels and display strings', async () => {
    const out = await ok('get_device_parameters', target);
    assert(out.class_name && out.device_type && out.track_type === 'track', JSON.stringify(out).slice(0, 200));
    assert(out.parameters.every((p) => typeof p.is_quantized === 'boolean' && typeof p.display === 'string'), 'missing details');
    const quantized = out.parameters.find((p) => p.is_quantized && p.value_items);
    if (quantized) assert(quantized.display === quantized.value_items[quantized.value], `${quantized.name} display/label mismatch`);
  });
  const returnCount = (await ok('describe_set', { include_clips: false })).returns.length;
  if (returnCount > 0) {
    await check('return tracks work through the tools: read, set, ramp, bulk, track detail', async () => {
      const dev = await ok('get_device_parameters', { track_index: 0, track_type: 'return', device_index: 0 });
      assert(dev.track_type === 'return', JSON.stringify(dev).slice(0, 120));
      const prm = dev.parameters.find((p) => p.index > 0 && p.max > p.min && !p.is_quantized && p.is_enabled);
      const rspan = prm.max - prm.min;
      const rt = { track_index: 0, track_type: 'return', device_index: 0, parameter_index: prm.index };
      try {
        const set = await ok('set_device_parameter', { ...rt, value: prm.min + 0.25 * rspan });
        near(set.value, prm.min + 0.25 * rspan, 1e-4 * rspan, 'set value');
        await ok('ramp_parameter', { ...rt, to: prm.min + 0.5 * rspan, seconds: 0.2 });
        await sleep(500);
        const bulk = await ok('bulk_set_device_parameters', { parameters: [{ ...rt, value: prm.min + 0.75 * rspan }, { ...rt, device_index: 99, value: 0 }] });
        assert(bulk.count === 1 && bulk.skipped.length === 1 && bulk.updated[0].track_type === 'return', JSON.stringify(bulk));
        const detail = await ok('get_track_detail', { track_index: 0, track_type: 'return' });
        assert(detail.track_type === 'return' && detail.devices.length >= 1, JSON.stringify(detail).slice(0, 160));
      } finally {
        await tool('set_device_parameter', { ...rt, value: prm.value });
      }
    });
  }
  await check('master track works through the tools and guards what it cannot do', async () => {
    const detail = await ok('get_track_detail', { track_index: 0, track_type: 'master' });
    assert(detail.track_type === 'master' && detail.index === null, JSON.stringify(detail).slice(0, 160));
    await fails('set_properties', { address: 'master', properties: { mute: true } }, 'mute');
    await fails('get_track_detail', { track_index: 99, track_type: 'return' }, 'Return track index out of range');
    const currentVolume = (await ok('describe_set', { include_clips: false })).master.volume;
    const volume = await tool('ramp_parameter', { track_index: 0, track_type: 'master', mixer_parameter: 'volume', to: currentVolume, seconds: 0.05 });
    assert(!volume.isError, volume.text);
    const cancelled = await ok('cancel_ramps', { track_index: 0, track_type: 'master', mixer_parameter: 'volume' });
    assert(typeof cancelled.cancelled === 'number', JSON.stringify(cancelled));
    await ok('cancel_ramps');
  });
  await check('device_path errors surface through the tools', async () => {
    await fails('get_device_parameters', { track_index: T, device_path: [D, 0, 0] }, 'has no chains');
    await fails('set_device_parameter', { track_index: T, device_path: [99], parameter_index: 1, value: 0 }, 'Device index out of range at device_path[0]');
    await fails('get_device_parameters', { track_index: T, device_index: D, device_path: [D] }, 'not both');
  });
} finally {
  await tool('cancel_ramps');
  await tool('clear_automation', { track_index: T, clip_index: S });
  await tool('delete', { address: `tracks/${T}/slots/${S}/clip`, expect: { name: 'MCP TOOL TEST' } });
  await tool('set_device_parameter', { ...target, value: original });
  await client.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
