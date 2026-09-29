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
  const occupied = new Set((track.clips ?? []).map((c) => c.slot));
  const freeIndex = session.scenes.findIndex((_, i) => !occupied.has(i));
  const free = freeIndex >= 0 ? { index: freeIndex } : undefined;
  const params = (await ok('get_device', { address: `tracks/${trackIndex}/devices/0` })).parameters;
  const p = params.find((x) => x.index > 0 && x.max > x.min && !/\bon\b|type|mode|sync/i.test(x.name) && !Number.isInteger(x.value));
  if (free && p) {
    [T, S, D, P] = [trackIndex, free.index, 0, p];
    break;
  }
}
assert(T !== undefined, 'no MIDI track with a device and a free slot');
const original = P.value;
const span = P.max - P.min;
const parameterAddress = `tracks/${T}/devices/${D}/parameters/${P.index}`;
const target = { parameter: parameterAddress };
const clipTarget = `tracks/${T}/slots/${S}/clip`;
console.log(`Track ${T}, parameter "${P.name}", scratch slot ${S}\n`);

try {
  await ok('create', { kind: 'midi_clip', address: `tracks/${T}/slots/${S}`, length: 4, name: 'MCP TOOL TEST' });

  console.log('Tool listing');
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  await check('the automation tools are listed exactly once with object schemas', async () => {
    assert(new Set(tools.map((t) => t.name)).size === tools.length, 'duplicate tool names');
    for (const name of ['draw_automation', 'get_automation', 'clear_automation', 'ramp_parameter', 'cancel_ramps']) {
      assert(byName[name], `${name} missing`);
      assert(byName[name].inputSchema.type === 'object', `${name} schema is not an object`);
      assert(byName[name].description.length > 40, `${name} has no useful description`);
    }
  });
  await check('required arguments are declared and read-only/destructive hints are right', async () => {
    assert(JSON.stringify(byName.draw_automation.inputSchema.required) === JSON.stringify(['clip', 'parameter', 'points']), 'draw_automation.required');
    assert(JSON.stringify(byName.get_automation.inputSchema.required) === JSON.stringify(['clip']), 'get_automation.required');
    assert(JSON.stringify(byName.clear_automation.inputSchema.required) === JSON.stringify(['clip']), 'clear_automation.required');
    assert(JSON.stringify(byName.ramp_parameter.inputSchema.required) === JSON.stringify(['parameter', 'to']), 'ramp_parameter.required');
    assert(byName.cancel_ramps.inputSchema.required === undefined, 'cancel_ramps takes no required args');
    assert(byName.get_automation.annotations.readOnlyHint === true && byName.clear_automation.annotations.destructiveHint === true, 'annotations');
  });
  await check('point schema and curve enums are exposed', async () => {
    const point = byName.draw_automation.inputSchema.properties.points.items;
    assert(JSON.stringify(point.required) === JSON.stringify(['time', 'value']), 'point.required');
    assert(byName.draw_automation.inputSchema.properties.curve.enum.includes('step'), 'draw curve enum');
    assert(JSON.stringify(byName.draw_automation.inputSchema.properties.style.enum) === JSON.stringify(['breakpoints', 'steps']), 'style enum');
    assert(!byName.ramp_parameter.inputSchema.properties.curve.enum.includes('step'), 'ramp curve must not offer step');
  });

  console.log('\nTool calls');
  await check('draw_automation via MCP with a device parameter writes real breakpoints and reads them back', async () => {
    const out = await ok('draw_automation', {
      ...target, clip: clipTarget, points: [{ time: 0, value: P.min + 0.2 * span }, { time: 4, value: P.min + 0.8 * span }], curve: 'smooth'
    });
    assert(out.parameter === P.name && out.style === 'breakpoints' && out.breakpoints > 5 && out.mode === 'replace', JSON.stringify(out));
    for (const row of out.readback) near(row.actual, row.expected, 1e-3 * span, `readback @${row.time}`);
    const back = await ok('get_automation', { clip: clipTarget });
    assert(back.has_envelopes && back.envelopes.length === 1 && back.envelopes[0].parameter === parameterAddress, JSON.stringify(back).slice(0, 300));
    near(back.envelopes[0].breakpoints[0].value, P.min + 0.2 * span, 1e-3 * span, 'first breakpoint');
    near(back.envelopes[0].breakpoints.at(-1).value, P.min + 0.8 * span, 1e-3 * span, 'last breakpoint');
  });
  await check('draw_automation via MCP on the mixer by address, in steps style', async () => {
    const out = await ok('draw_automation', { clip: clipTarget, parameter: `tracks/${T}/mixer/volume`, style: 'steps', points: [{ time: 0, value: 0.4 }, { time: 4, value: 0.7 }] });
    assert(/vol/i.test(out.parameter) && out.style === 'steps' && out.steps > 4, JSON.stringify(out));
  });
  await check('draw_automation merge and hold=false through MCP', async () => {
    const out = await ok('draw_automation', {
      ...target, clip: clipTarget, mode: 'merge', hold: false, curve: 'step',
      points: [{ time: 1, value: P.min + 0.5 * span }, { time: 3, value: P.min + 0.5 * span }]
    });
    assert(out.mode === 'merge', JSON.stringify(out));
  });
  await check('clear_automation via MCP: one parameter, then everything', async () => {
    const one = await ok('clear_automation', { ...target, clip: clipTarget });
    assert(one.had_envelope === true && one.cleared === P.name, JSON.stringify(one));
    const all = await ok('clear_automation', { clip: clipTarget });
    assert(all.cleared === 'all' && all.clip_has_envelopes === false, JSON.stringify(all));
  });
  await check('ramp_parameter via MCP in beats, with optional fields omitted', async () => {
    const out = await ok('ramp_parameter', { ...target, to: P.min + 0.9 * span, from: P.min + 0.1 * span, beats: 0.5, curve: 'ease_out' });
    assert(out.curve === 'ease_out' && out.seconds > 0 && out.active_ramps >= 1, JSON.stringify(out));
    await sleep(out.seconds * 1000 + 300);
    const now = await ok('get_device', { address: `tracks/${T}/devices/${D}` });
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
    await fails('draw_automation', { ...target, clip: clipTarget }, "missing required argument 'points'");
    await fails('draw_automation', { ...target, clip: clipTarget, points: [] }, 'non-empty');
    await fails('draw_automation', { ...target, clip: clipTarget, points: [{ time: 99, value: 0 }] }, 'outside the clip');
    await fails('draw_automation', { clip: clipTarget, parameter: 'tracks/999/mixer/volume', points: [{ time: 0, value: 0.5 }] }, 'out of range');
    await fails('draw_automation', { ...target, clip: `tracks/${T}/slots/${S + 1}/clip`, points: [{ time: 0, value: P.min }] }, 'empty');
    await fails('draw_automation', { clip: `tracks/${T}`, parameter: parameterAddress, points: [{ time: 0, value: P.min }] }, 'address of a clip');
    await fails('draw_automation', { clip: clipTarget, parameter: `tracks/${T}`, points: [{ time: 0, value: P.min }] }, 'address of a device or mixer parameter');
    await fails('clear_automation', {}, "missing required argument 'clip'");
    await fails('ramp_parameter', { ...target, to: P.max }, 'exactly one');
    await fails('ramp_parameter', { ...target, seconds: 1 }, "missing required argument 'to'");
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
    await fails('create', { kind: 'device' }, 'kind must be one of: audio_track, midi_track, return_track, scene, midi_clip, audio_clip, arrangement_midi_clip');
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
  await check('composition tools are listed with their catalogues and destructive annotations', async () => {
    for (const name of ['transform_notes', 'generate_notes']) {
      assert(byName[name].annotations.destructiveHint === true && byName[name].annotations.readOnlyHint === false, `${name} annotations`);
      assert(byName[name].description.length > 1500, `${name} should list its transforms/generators`);
    }
    assert(byName.transform_notes.inputSchema.properties.transform.enum.includes('arpeggiate'), 'transform enum');
    assert(byName.generate_notes.inputSchema.properties.generator.enum.includes('chord_progression'), 'generator enum');
  });
  await check('composition tools preview on the scratch clip, refuse bad calls readably, and write nothing on a dry run', async () => {
    const before = (await ok('get_notes', { address: clipAddress })).count;
    const dry = await ok('generate_notes', { address: clipAddress, generator: 'euclidean', params: { pulses: 5, steps: 16 }, dry_run: true });
    assert(dry.dry_run === true && dry.notes === 5, JSON.stringify(dry).slice(0, 160));
    assert((await ok('get_notes', { address: clipAddress })).count === before, 'a dry run wrote notes');
    await fails('generate_notes', { address: clipAddress, generator: 'jazz' }, 'generator must be one of: euclidean');
    await fails('generate_notes', { address: clipAddress, generator: 'euclidean', params: {} }, 'pulses must be given');
    await fails('transform_notes', { address: clipAddress, transform: 'transpose', params: { semitones: 2 } }, 'no notes in that selection');
    await fails('transform_notes', { address: `tracks/${T}`, transform: 'transpose', params: { semitones: 2 } }, 'address must be a clip');
  });
  await check('batch is listed, runs several tools with references in one call, and reports a failure with every op', async () => {
    assert(byName.batch.annotations.destructiveHint === true && JSON.stringify(byName.batch.inputSchema.required) === JSON.stringify(['ops']), 'batch schema');
    const made = await ok('batch', { ops: [
      { tool: 'create', args: { kind: 'scene', name: 'MCP BATCH SCENE' } },
      { tool: 'set_properties', args: { address: '$0.address', properties: { tempo: 111 } } },
      { tool: 'get_properties', args: { address: '$0.address', names: ['tempo', 'name'] } }] });
    assert(made.applied === 3 && made.results[2].tool === 'get_properties' && made.results[2].result.properties.tempo === 111, JSON.stringify(made).slice(0, 240));
    const address = made.results[0].result.address;
    const failed = await tool('batch', { ops: [{ tool: 'set_properties', args: { address, properties: { name: 'MCP BATCH RENAMED' } } }, { tool: 'set_properties', args: { address: 'scenes/999', properties: { name: 'x' } } }] });
    assert(failed.isError && failed.text.includes('Batch stopped at op 1') && failed.text.includes('"not_run"'), failed.text.slice(0, 300));
    await fails('batch', { ops: [{ tool: 'transport', args: { action: 'play' } }] }, 'cannot be used in a batch');
    await fails('batch', { ops: [{ tool: 'create', args: { kind: 'nonsense' } }] }, 'ops[0] (create): kind must be one of');
    await ok('delete', { address, expect: { name: 'MCP BATCH RENAMED' } });
  });
  await check('browse searches the browser through an index, load_item loads what it finds, and a batch can do both with a new track', async () => {
    assert(byName.browse.annotations.readOnlyHint === true && byName.load_item.annotations.destructiveHint === false, 'annotations');
    const found = await ok('browse', { action: 'search', query: 'eq eight', roots: ['audio_effects'] });
    assert(found.total_matches >= 1 && found.results[0].name === 'EQ Eight' && found.results[0].path === 'audio_effects/EQ Eight', JSON.stringify(found).slice(0, 300));
    const again = await ok('browse', { action: 'search', query: 'utility', roots: ['audio_effects'] });
    assert(again.results[0].name === 'Utility' && again.indexed_now === undefined, 'the second search reuses the index');
    const made = await ok('batch', { ops: [
      { tool: 'create', args: { kind: 'audio_track', name: 'MCP BROWSE TEST' } },
      { tool: 'load_item', args: { path: found.results[0].path, target: '$0.address' } },
      { tool: 'get_device', args: { address: '$0.address/devices/0' } }] });
    assert(made.results[1].result.added[0].name === 'EQ Eight' && made.results[2].result.name === 'EQ Eight', JSON.stringify(made).slice(0, 300));
    await ok('delete', { address: made.results[0].result.address, expect: { name: 'MCP BROWSE TEST' } });
    await fails('browse', { action: 'search' }, 'search needs a query');
    await fails('load_item', { path: 'audio_effects/EQ Eight', target: 'tracks/9999' }, 'out of range');
  });
  await check('analyze_audio_clip works by address: settings and file analysis together, and MIDI clips are refused readably', async () => {
    const audioClip = (await ok('describe_set')).tracks.flatMap((t) => (t.clips ?? []).filter((c) => c.kind === 'audio').map((c) => `${t.address}/slots/${c.slot}/clip`))[0];
    if (!audioClip) {
      console.log('       no audio clip in the Set: skipped');
    } else {
      const out = await ok('analyze_audio_clip', { address: audioClip });
      assert(out.clip.address === audioClip && out.clip.file_path && out.analysis, JSON.stringify(out).slice(0, 200));
    }
    await fails('analyze_audio_clip', { address: clipAddress }, 'is a MIDI clip');
    await fails('analyze_audio_clip', {}, "missing required argument 'address'");
  });
  await check('argument problems are caught in TypeScript with a readable message', async () => {
    await fails('get_properties', {}, "missing required argument 'address'");
    await fails('get_properties', { address: 5 }, 'address must be a string');
    await fails('get_properties', { address: 'song', names: 'tempo' }, 'names must be an array');
    await fails('set_properties', { items: [{ address: 'song' }] }, "items[0]: missing required argument 'properties'");
    await fails('list_properties', { kind: 'plugin' }, 'must be one of: song, track, scene, slot, clip, lane, groove, cue, app, device, chain, pad, parameter, sample');
  });
  await check('bridge problems come back as tool errors with the reason', async () => {
    await fails('get_properties', { address: 'tracks/999' }, 'out of range');
    await fails('get_properties', { address: 'tracks/name:No Such Track' }, "No track named 'No Such Track'");
    await fails('set_properties', { address: clipAddress, properties: { launch_mode: 'sideways' } }, 'trigger, gate, toggle, repeat');
    await fails('set_properties', { address: clipAddress, properties: { muted: 'yes' } }, 'muted must be true or false');
    await fails('set_properties', { address: `tracks/${T}`, properties: { mute: true }, expect: { name: 'Definitely Not This' } }, 'Guard failed');
  });

  console.log('\nDevices, return and master tracks');
  await check('get_device returns quantized labels, display strings and parameter addresses', async () => {
    const out = await ok('get_device', { address: `tracks/${T}/devices/${D}` });
    assert(out.class_name && out.device_type && out.address === `tracks/${T}/devices/${D}`, JSON.stringify(out).slice(0, 200));
    assert(out.parameters.every((p) => typeof p.is_quantized === 'boolean' && typeof p.display === 'string' && p.address.startsWith(out.address + '/parameters/')), 'missing details');
    const quantized = out.parameters.find((p) => p.is_quantized && p.value_items);
    if (quantized) assert(quantized.display === quantized.value_items[quantized.value], `${quantized.name} display/label mismatch`);
  });
  await check('a parameter is set through set_properties by address, in one call for many, and refused outside its range', async () => {
    const base = `tracks/${T}/devices/${D}/parameters`;
    const [a, b] = [P, (await ok('get_device', { address: `tracks/${T}/devices/${D}` })).parameters.find((x) => x.index !== P.index && x.index > 0 && x.max > x.min && !x.is_quantized && x.is_enabled)];
    try {
      const one = await ok('set_properties', { address: `${base}/${a.index}`, properties: { value: a.min + 0.3 * (a.max - a.min) } });
      near(one.applied.value.to, a.min + 0.3 * (a.max - a.min), 1e-4 * (a.max - a.min), 'single write');
      const many = await ok('set_properties', { items: [{ address: `${base}/${a.index}`, properties: { value: a.min + 0.6 * (a.max - a.min) } },
        { address: `${base}/name:${b.name}`, properties: { value: b.min + 0.4 * (b.max - b.min) } }] });
      assert(many.results.length === 2, JSON.stringify(many).slice(0, 200));
      await fails('set_properties', { address: `${base}/${a.index}`, properties: { value: a.max + 1000 } }, "outside this parameter's range");
      await fails('set_properties', { address: `${base}/${a.index}`, properties: { value: 'loud' } }, 'value must be a number');
    } finally {
      await tool('set_properties', { items: [{ address: `${base}/${a.index}`, properties: { value: a.value } }, { address: `${base}/${b.index}`, properties: { value: b.value } }] });
    }
  });
  const returnCount = (await ok('describe_set', { include_clips: false })).returns.length;
  if (returnCount > 0) {
    await check('return tracks work through the tools: read, set, ramp, track detail', async () => {
      const dev = await ok('get_device', { address: 'returns/0/devices/0' });
      assert(dev.address === 'returns/0/devices/0', JSON.stringify(dev).slice(0, 120));
      const prm = dev.parameters.find((p) => p.index > 0 && p.max > p.min && !p.is_quantized && p.is_enabled);
      const rspan = prm.max - prm.min;
      try {
        const set = await ok('set_properties', { address: prm.address, properties: { value: prm.min + 0.25 * rspan } });
        near(set.applied.value.to, prm.min + 0.25 * rspan, 1e-4 * rspan, 'set value');
        await ok('ramp_parameter', { parameter: prm.address, to: prm.min + 0.5 * rspan, seconds: 0.2 });
        await sleep(500);
        const returns = (await ok('describe_set', { include_clips: false })).returns;
        assert(returns[0].address === 'returns/0' && returns[0].devices.length >= 1, JSON.stringify(returns[0]).slice(0, 160));
      } finally {
        await tool('set_properties', { address: prm.address, properties: { value: prm.value } });
      }
    });
  }
  await check('master track works through the tools and guards what it cannot do', async () => {
    const master = (await ok('describe_set', { include_clips: false })).master;
    assert(master.address === 'master' && master.kind === 'master', JSON.stringify(master).slice(0, 160));
    await fails('set_properties', { address: 'master', properties: { mute: true } }, 'mute');
    await fails('get_properties', { address: 'returns/99' }, 'out of range');
    const currentVolume = (await ok('describe_set', { include_clips: false })).master.volume;
    const volume = await tool('ramp_parameter', { parameter: 'master/mixer/volume', to: currentVolume, seconds: 0.05 });
    assert(!volume.isError, volume.text);
    const cancelled = await ok('cancel_ramps', { parameter: 'master/mixer/volume' });
    assert(typeof cancelled.cancelled === 'number', JSON.stringify(cancelled));
    await ok('cancel_ramps');
  });
  await check('device address errors surface through the tools', async () => {
    await fails('get_device', { address: `tracks/${T}/devices/${D}/chains/0` }, 'is not a rack');
    await fails('get_device', { address: `tracks/${T}/devices/99` }, 'Device index 99 out of range');
    await fails('get_device', { address: `tracks/${T}` }, 'get_device needs the address of a device');
    await fails('set_properties', { address: `tracks/${T}/devices/99/parameters/1`, properties: { value: 0 } }, 'out of range');
  });
} finally {
  await tool('cancel_ramps');
  await tool('clear_automation', { clip: clipTarget });
  await tool('delete', { address: `tracks/${T}/slots/${S}/clip`, expect: { name: 'MCP TOOL TEST' } });
  await tool('set_properties', { address: `tracks/${T}/devices/${D}/parameters/${P.index}`, properties: { value: original } });
  await client.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
