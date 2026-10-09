import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TOOLS, isToolEnabled } from '../../src/tools/definitions.js';
import { ToolHandler } from '../../src/tools/handlers.js';
import { TOOL_SPECS, TOOL_SPEC_BY_NAME, validateArgs } from '../../src/tools/spec.js';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/** Command names registered in the Remote Script (the @command("...") decorators). */
function pythonCommands(): Set<string> {
  const dir = path.join(root, 'remote-script', 'AbletonMCP');
  const names = new Set<string>();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.py'))) {
    for (const m of fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/@command\("([a-z_]+)"/g)) names.add(m[1]);
  }
  return names;
}

test('tool names are unique', () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test('every declarative spec maps to a command the Remote Script registers', () => {
  const commands = pythonCommands();
  assert.ok(commands.size > 40);
  for (const spec of TOOL_SPECS) {
    for (const command of [spec.bridge.command, ...(spec.requires ?? [])]) assert.ok(commands.has(command), `${spec.name} -> ${command} is not registered`);
  }
});

test('every legacy tool that names a required capability names a registered command', () => {
  const commands = pythonCommands();
  for (const tool of TOOLS.filter((t) => t.requiredCapability)) {
    assert.ok(commands.has(tool.requiredCapability!), `${tool.name} requires unknown capability ${tool.requiredCapability}`);
  }
});

test('specs carry accurate annotations', () => {
  for (const spec of TOOL_SPECS) {
    assert.equal(typeof spec.annotations.readOnlyHint, 'boolean', `${spec.name} needs readOnlyHint`);
    assert.equal(typeof spec.annotations.destructiveHint, 'boolean', `${spec.name} needs destructiveHint`);
  }
  assert.equal(TOOL_SPEC_BY_NAME.get_properties.annotations.readOnlyHint, true);
  assert.equal(TOOL_SPEC_BY_NAME.list_properties.annotations.readOnlyHint, true);
  assert.equal(TOOL_SPEC_BY_NAME.set_properties.annotations.readOnlyHint, false);
  for (const name of ['get_capabilities', 'describe_set']) assert.equal(TOOL_SPEC_BY_NAME[name].annotations.readOnlyHint, true, name);
  assert.equal(TOOL_SPEC_BY_NAME.transport.annotations.readOnlyHint, false);
  assert.equal(TOOL_SPEC_BY_NAME.history.annotations.destructiveHint, true); // undo can revert the user's own edits
  assert.equal(TOOL_SPEC_BY_NAME.transport.annotations.destructiveHint, false);
});

test('create, duplicate and delete schemas and risk annotations', () => {
  assert.equal(TOOL_SPEC_BY_NAME.delete.annotations.destructiveHint, true);
  assert.equal(TOOL_SPEC_BY_NAME.create.annotations.destructiveHint, false);
  assert.equal(TOOL_SPEC_BY_NAME.duplicate.annotations.destructiveHint, false);
  const create = TOOL_SPEC_BY_NAME.create.inputSchema;
  assert.equal(validateArgs(create, { kind: 'scene', name: 'Verse', index: 0 }), null);
  assert.match(validateArgs(create, {})!, /missing required argument 'kind'/);
  assert.match(validateArgs(create, { kind: 'device' })!, /must be one of: audio_track, midi_track, return_track, scene/);
  assert.match(validateArgs(create, { kind: 'scene', name: 5 })!, /name must be a string/);
  assert.equal(validateArgs(TOOL_SPEC_BY_NAME.duplicate.inputSchema, { address: 'tracks/1' }), null);
  assert.match(validateArgs(TOOL_SPEC_BY_NAME.duplicate.inputSchema, {})!, /missing required argument 'address'/);
  const del = TOOL_SPEC_BY_NAME.delete.inputSchema;
  assert.equal(validateArgs(del, { address: 'tracks/1', expect: { name: 'B' } }), null);
  assert.match(validateArgs(del, { address: 'tracks/1' })!, /missing required argument 'expect'/);
  assert.match(validateArgs(del, { address: 'tracks/1', expect: {} })!, /expect: missing required argument 'name'/);
  assert.match(validateArgs(del, { address: 'tracks/1', expect: { name: 5 } })!, /expect.name must be a string/);
});

test('transport and history schemas', () => {
  const transport = TOOL_SPEC_BY_NAME.transport.inputSchema;
  assert.equal(validateArgs(transport, { action: 'play' }), null);
  assert.equal(validateArgs(transport, { action: 'jump_by', amount: -4 }), null);
  assert.match(validateArgs(transport, {})!, /missing required argument 'action'/);
  assert.match(validateArgs(transport, { action: 'rewind' })!, /action must be one of: play, continue, stop/);
  assert.match(validateArgs(transport, { action: 'jump_by', amount: '4' })!, /amount must be a number/);
  const history = TOOL_SPEC_BY_NAME.history.inputSchema;
  assert.equal(validateArgs(history, { action: 'undo', steps: 3 }), null);
  assert.match(validateArgs(history, { action: 'rewind' })!, /must be one of: undo, redo/);
  assert.equal(validateArgs(TOOL_SPEC_BY_NAME.describe_set.inputSchema, { include_clips: false }), null);
  assert.match(validateArgs(TOOL_SPEC_BY_NAME.describe_set.inputSchema, { include_clips: 'no' })!, /include_clips must be true or false/);
  assert.equal(validateArgs(TOOL_SPEC_BY_NAME.get_capabilities.inputSchema, {}), null);
});

test('spec-derived tools appear in the tool list with their annotations', () => {
  for (const spec of TOOL_SPECS) {
    const tool = TOOLS.find((t) => t.name === spec.name)!;
    assert.ok(tool, spec.name);
    assert.deepEqual(tool.annotations, spec.annotations);
    assert.equal(tool.requiredCapability, spec.bridge.command);
  }
});

test('the advertised schema stays inside its size budget', () => {
  const size = JSON.stringify(TOOLS.filter((t) => isToolEnabled(t.name))).length;
  assert.ok(size < 50_000, `tool list is ${size} characters; trim descriptions or consolidate tools`);
});

test('a tool with a long form declares help, points to it, and answers it without validating or touching Live', async () => {
  const withHelp = TOOL_SPECS.filter((s) => s.help);
  assert.ok(withHelp.length >= 5, 'the long descriptions moved into help');
  const calls: string[] = [];
  const client = new Proxy({}, { get: (_t, prop) => () => { calls.push(String(prop)); throw new Error('help must not reach the bridge'); } });
  const handler = new ToolHandler(client as any);
  for (const spec of withHelp) {
    assert.deepEqual(spec.inputSchema.properties.help, { type: 'boolean' }, `${spec.name} declares help`);
    assert.match(spec.description, /help: true/, `${spec.name} tells the caller about help`);
    assert.ok(spec.help!.length > spec.description.length / 2, `${spec.name}: help should carry the long form`);
    const answer = await handler.handleToolCall(spec.name, { help: true });   // required arguments are missing on purpose
    assert.ok(!answer.isError, spec.name);
    assert.equal(answer.content[0].type, 'text');
    assert.ok((answer.content[0] as { text: string }).text.includes(spec.help!), spec.name);
  }
  assert.deepEqual(calls, []);
  const wrong = await handler.handleToolCall('device_action', { help: 'yes' });          // not true: the normal validation runs
  assert.equal(wrong.isError, true);
});

test('eval_python is gated', () => {
  assert.equal(isToolEnabled('eval_python', {}), false);
  assert.equal(isToolEnabled('eval_python', { ABLETON_MCP_ALLOW_EVAL: '1' }), true);
  assert.equal(isToolEnabled('get_properties', {}), true);
});

const schema = TOOL_SPEC_BY_NAME.set_properties.inputSchema;

test('validateArgs: required, types, enums and nested items', () => {
  const get = TOOL_SPEC_BY_NAME.get_properties.inputSchema;
  assert.equal(validateArgs(get, { address: 'tracks/0' }), null);
  assert.match(validateArgs(get, {})!, /missing required argument 'address'/);
  assert.match(validateArgs(get, { address: 5 })!, /address must be a string/);
  assert.match(validateArgs(get, { address: 'song', names: 'name' })!, /must be an array/);
  assert.match(validateArgs(get, { address: 'song', names: ['ok', 3] })!, /names\[1\] must be a string/);
  const list = TOOL_SPEC_BY_NAME.list_properties.inputSchema;
  assert.equal(validateArgs(list, { kind: 'clip' }), null);
  assert.match(validateArgs(list, { kind: 'plugin' })!, /must be one of: song, track, scene, slot, clip/);
  assert.equal(validateArgs(list, { kind: 'device' }), null);
  assert.equal(validateArgs(schema, {}), null); // either address+properties or items: the bridge decides
  assert.match(validateArgs(schema, { items: [{ address: 'song' }] })!, /items\[0\]: missing required argument 'properties'/);
  assert.match(validateArgs(schema, { address: 'song', properties: [] })!, /must be an object/);
  assert.equal(validateArgs(schema, { items: [{ address: 'song', properties: { tempo: 120 } }] }), null);
});

test('validateArgs: nulls count as absent, NaN is not a number, unknown keys are tolerated', () => {
  const get = TOOL_SPEC_BY_NAME.get_properties.inputSchema;
  assert.equal(validateArgs(get, { address: 'song', names: null, extra: 1 }), null);
  assert.match(validateArgs(get, { address: null })!, /missing required argument 'address'/);
  const numeric = { type: 'object' as const, properties: { n: { type: 'number' } } };
  assert.match(validateArgs(numeric, { n: NaN })!, /must be a number/);
  assert.match(validateArgs(numeric, { n: '3' })!, /must be a number/);
  assert.equal(validateArgs(numeric, { n: 3 }), null);
});

test('launch and clip_action schemas and risk annotations', () => {
  const launch = TOOL_SPEC_BY_NAME.launch;
  const action = TOOL_SPEC_BY_NAME.clip_action;
  assert.deepEqual(launch.inputSchema.required, ['address']);
  assert.deepEqual(launch.inputSchema.properties.action.enum, ['fire', 'stop']);
  assert.equal(launch.annotations.destructiveHint, false);
  assert.deepEqual(action.inputSchema.required, ['address', 'action']);
  assert.equal(action.annotations.destructiveHint, true);
  assert.deepEqual(action.inputSchema.properties.action.enum, ['crop', 'duplicate_loop', 'quantize', 'quantize_pitch', 'scrub', 'stop_scrub', 'move_playing_pos', 'add_warp_marker', 'move_warp_marker', 'remove_warp_marker', 'to_arrangement']);
  assert.equal(validateArgs(launch.inputSchema, { address: 'tracks/0/slots/0', legato: 'yes' }), 'legato must be true or false');
  assert.equal(validateArgs(action.inputSchema, { address: 'tracks/0/slots/0/clip', action: 'quantize', amount: 0.5 }), null);
});

test('launch can hold and release a fire button, and duplicate can name the slot to copy to', () => {
  const launch = TOOL_SPEC_BY_NAME.launch;
  assert.equal(validateArgs(launch.inputSchema, { address: 'tracks/0/slots/0', hold: true, hold_seconds: 2 }), null);
  assert.equal(validateArgs(launch.inputSchema, { address: 'scenes/1', hold: true, hold_beats: 4 }), null);
  assert.equal(validateArgs(launch.inputSchema, { address: 'tracks/0/slots/0', hold: false }), null);
  assert.equal(validateArgs(launch.inputSchema, { address: 'tracks/0/slots/0', hold: 'yes' }), 'hold must be true or false');
  assert.equal(validateArgs(launch.inputSchema, { address: 'tracks/0/slots/0', hold: true, hold_beats: '2' }), 'hold_beats must be a number');
  assert.match(launch.description, /gate-mode clip plays only while held/);
  assert.equal(launch.annotations.destructiveHint, false);
  const duplicate = TOOL_SPEC_BY_NAME.duplicate;
  assert.equal(validateArgs(duplicate.inputSchema, { address: 'tracks/0/slots/0', to: 'tracks/1/slots/2' }), null);
  assert.equal(validateArgs(duplicate.inputSchema, { address: 'tracks/0/slots/0', to: 3 }), 'to must be a string');
  assert.deepEqual(duplicate.inputSchema.required, ['address']);
  assert.equal(duplicate.annotations.destructiveHint, false, 'an occupied destination is refused, so duplicate never replaces anything');
  assert.match(duplicate.description, /empty slot with `to`/);
});

test('note tools: schemas, required arguments and risk annotations', () => {
  const get = TOOL_SPEC_BY_NAME.get_notes;
  const write = TOOL_SPEC_BY_NAME.write_notes;
  const edit = TOOL_SPEC_BY_NAME.edit_notes;
  assert.equal(get.annotations.readOnlyHint, true);
  assert.equal(write.annotations.destructiveHint, false);
  assert.equal(edit.annotations.destructiveHint, true);
  assert.deepEqual(write.inputSchema.required, ['address', 'notes']);
  assert.deepEqual(write.inputSchema.properties.notes.items.required, ['pitch', 'start_time', 'duration']);
  assert.deepEqual(edit.inputSchema.properties.action.enum, ['modify', 'remove', 'replace', 'duplicate', 'duplicate_region', 'select']);
  assert.match(validateArgs(write.inputSchema, { address: 'tracks/0/slots/0/clip', notes: [{ pitch: 60, start_time: 0 }] }) ?? '', /notes\[0\]: missing required argument 'duration'/);
  assert.equal(validateArgs(edit.inputSchema, { address: 'a', action: 'modify', changes: [{ id: 3, velocity: 50 }] }), null);
  assert.match(validateArgs(edit.inputSchema, { address: 'a', action: 'modify', changes: [{ velocity: 50 }] }) ?? '', /missing required argument 'id'/);
});

test('tools folded into the verb tools are no longer advertised', () => {
  const retired = ['get_session_info', 'get_track_structure', 'get_bulk_session_structure', 'get_clip_notes', 'edit_clip_notes', 'set_tempo', 'set_track_name',
    'set_track_color', 'set_track_mute', 'set_track_solo', 'set_track_arm', 'set_clip_name', 'set_clip_color', 'set_scene_name', 'create_midi_track', 'create_clip',
    'delete_clip', 'fire_clip', 'stop_clip', 'fire_scene', 'stop_all_clips', 'start_playback', 'stop_playback', 'get_device_parameters', 'set_device_parameter',
    'bulk_set_device_parameters', 'bulk_edit_clips', 'load_browser_item', 'get_browser_tree', 'get_browser_items', 'get_audio_clip_path', 'get_track_detail'];
  const names = new Set(TOOLS.map((t) => t.name));
  for (const name of retired) assert.ok(!names.has(name), `${name} should be retired`);
  assert.deepEqual(TOOL_SPEC_BY_NAME.create.inputSchema.properties.kind.enum, ['audio_track', 'midi_track', 'return_track', 'scene', 'midi_clip', 'audio_clip', 'arrangement_midi_clip', 'arrangement_audio_clip', 'take_lane']);
});

test('device tools: schemas and risk annotations', () => {
  const get = TOOL_SPEC_BY_NAME.get_device;
  const action = TOOL_SPEC_BY_NAME.device_action;
  assert.equal(get.annotations.readOnlyHint, true);
  assert.equal(action.annotations.destructiveHint, true);
  assert.deepEqual(action.inputSchema.required, ['address', 'action']);
  assert.ok(action.inputSchema.properties.action.enum.includes('insert') && action.inputSchema.properties.action.enum.includes('clear_pad'));
  assert.equal(validateArgs(action.inputSchema, { address: 'tracks/0', action: 'insert', name: 'Utility' }), null);
  assert.match(validateArgs(action.inputSchema, { address: 'tracks/0', action: 'explode' }) ?? '', /action must be one of: insert/);
  assert.match(validateArgs(get.inputSchema, {}) ?? '', /missing required argument 'address'/);
});

test('routing tool: schema and annotations', () => {
  const routing = TOOL_SPEC_BY_NAME.routing;
  assert.deepEqual(routing.inputSchema.required, ['address', 'direction']);
  assert.equal(routing.annotations.destructiveHint, false);
  assert.match(validateArgs(routing.inputSchema, { address: 'tracks/0', direction: 'sideways' }) ?? '', /direction must be one of: input, output/);
  assert.equal(validateArgs(routing.inputSchema, { address: 'tracks/0', direction: 'input', action: 'set', type: 'Master', allow_feedback: true }), null);
});

test('automation: one writing tool with four actions, a read-only reader, per-action required arguments and batch rules', async () => {
  const automation = TOOL_SPEC_BY_NAME.automation;
  assert.deepEqual(automation.inputSchema.required, ['action']);
  assert.deepEqual(automation.inputSchema.properties.action.enum, ['draw', 'clear', 'ramp', 'cancel']);
  assert.deepEqual(automation.inputSchema.properties.style.enum, ['breakpoints', 'steps']);
  assert.equal(automation.annotations.destructiveHint, true, 'draw and clear rewrite envelopes');
  assert.equal(automation.bridge.command, 'automation');
  for (const retired of ['draw_automation', 'clear_automation', 'ramp_parameter', 'cancel_ramps']) assert.equal(TOOL_SPEC_BY_NAME[retired], undefined, `${retired} is part of automation now`);
  const get = TOOL_SPEC_BY_NAME.get_automation;
  assert.equal(get.annotations.readOnlyHint, true, 'reading stays a read-only tool');
  assert.equal(get.inputSchema.required, undefined, 'without a clip it gives the overview of the Set');
  assert.equal(validateArgs(get.inputSchema, {}), null);
  assert.equal(validateArgs(get.inputSchema, { address: 'tracks/2', max_items: 50 }), null);
  const params = automation.bridge.params!;
  assert.deepEqual(params({ action: 'draw', clip: 'c', parameter: 'p', points: [{ time: 0, value: 1 }] }).action, 'draw');
  assert.throws(() => params({ action: 'draw', clip: 'c', parameter: 'p' }), /automation draw: missing required argument 'points'/);
  assert.throws(() => params({ action: 'clear' }), /automation clear: missing required argument 'clip'/);
  assert.throws(() => params({ action: 'ramp', parameter: 'p' }), /automation ramp: missing required argument 'to'/);
  assert.throws(() => params({ action: 'ramp', parameter: 'p', to: 1, curve: 'step' }), /curve must be one of: linear, smooth, ease_in, ease_out/);
  assert.doesNotThrow(() => params({ action: 'cancel' }));
  assert.match(validateArgs(automation.inputSchema, { action: 'sweep' }) ?? '', /action must be one of: draw, clear, ramp, cancel/);
  assert.match(validateArgs(automation.inputSchema, { action: 'draw', points: [{ time: 0 }] }) ?? '', /points\[0\]: missing required argument 'value'/);
  assert.match(TOOL_SPEC_BY_NAME.batch.description, /routing, automation, get_automation/);
  assert.match(TOOL_SPEC_BY_NAME.batch.description, /ramp and cancel actions of automation/);
  const { runBatch } = await import('../../src/tools/batch.js');
  const never: any = { sendCommand: async () => { throw new Error('nothing may be sent'); } };
  for (const action of ['ramp', 'cancel']) {
    await assert.rejects(runBatch({ ops: [{ tool: 'automation', args: { action, parameter: 'p', to: 1 } }] }, never, TOOL_SPEC_BY_NAME), new RegExp(`'automation' with action '${action}' cannot be used in a batch`));
  }
  const sent: any[] = [];
  const recorder: any = { sendCommand: async (type: string, p: any) => { sent.push({ type, p }); return { results: [{}, {}] }; } };
  await runBatch({ ops: [{ tool: 'automation', args: { action: 'clear', clip: 'tracks/0/slots/0/clip' } }, { tool: 'get_automation', args: {} }] }, recorder, TOOL_SPEC_BY_NAME);
  assert.deepEqual(sent[0].p.ops.map((o: any) => o.command), ['automation', 'get_automation']);
  await assert.rejects(runBatch({ ops: [{ tool: 'automation', args: { action: 'draw', clip: 'c' } }] }, never, TOOL_SPEC_BY_NAME), /automation draw: missing required argument 'parameter'/);
});

test('audio tools: convert, warp marker actions and audio_clip creation are declared', () => {
  const convert = TOOL_SPEC_BY_NAME.convert;
  assert.deepEqual(convert.inputSchema.required, ['address', 'action']);
  assert.deepEqual(convert.inputSchema.properties.type.enum, ['harmony', 'melody', 'drums']);
  assert.equal(convert.annotations.destructiveHint, false);
  assert.equal(validateArgs(convert.inputSchema, { address: 'tracks/0/slots/0/clip', action: 'audio_to_midi', type: 'melody' }), null);
  assert.ok(TOOL_SPEC_BY_NAME.create.inputSchema.properties.path);
  const audio = TOOL_SPEC_BY_NAME.audio;
  assert.equal(TOOL_SPEC_BY_NAME.analyze_audio_clip, undefined, 'analyze_audio_clip is the analyze action of audio now');
  assert.deepEqual(audio.inputSchema.required, ['action']);
  assert.deepEqual(audio.inputSchema.properties.action.enum, ['snapshot', 'analyze']);
  assert.equal(audio.annotations.readOnlyHint, true, 'both actions only read');
  assert.deepEqual(audio.requires, ['audio_snapshot']);
  assert.equal(validateArgs(audio.inputSchema, { action: 'snapshot' }), null);
  assert.equal(validateArgs(audio.inputSchema, { action: 'analyze', address: 'tracks/2/slots/0/clip', curve: true, max_points: 60 }), null);
  assert.match(validateArgs(audio.inputSchema, { action: 'listen' }) ?? '', /action must be one of: snapshot, analyze/);
  assert.equal(validateArgs(audio.inputSchema, { action: 'analyze', curve: 'yes' }), 'curve must be true or false');
  assert.ok(TOOL_SPEC_BY_NAME.bounce.inputSchema.properties.curve, 'bounce can return the loudness over time too');
  assert.ok(TOOL_SPEC_BY_NAME.convert.run, 'convert waits for Live to finish, so it is a composed tool');
});

test('record is gated like eval_python and destructive; arrangement kinds are declared', () => {
  assert.equal(isToolEnabled('record', {}), false);
  assert.equal(isToolEnabled('record', { ABLETON_MCP_ALLOW_RECORD: '1' }), true);
  assert.equal(TOOL_SPEC_BY_NAME.record.annotations.destructiveHint, true);
  assert.ok(TOOL_SPEC_BY_NAME.record.description.startsWith('GATED'));
  assert.ok(!TOOLS.filter((t) => isToolEnabled(t.name, {})).some((t) => t.name === 'record'));
  assert.ok(TOOL_SPEC_BY_NAME.create.inputSchema.properties.time);
  assert.ok(TOOL_SPEC_BY_NAME.clip_action.inputSchema.properties.time);
});

test('device_action call and the device-specific vocabulary are declared', () => {
  const action = TOOL_SPEC_BY_NAME.device_action;
  assert.ok(action.inputSchema.properties.action.enum.includes('call'));
  assert.ok(action.inputSchema.properties.method && action.inputSchema.properties.args);
  assert.equal(validateArgs(action.inputSchema, { address: 'tracks/0/devices/0', action: 'call', method: 'crop', args: {} }), null);
  assert.match(TOOL_SPEC_BY_NAME.get_device.description, /`specific` block/);
  assert.ok(TOOL_SPEC_BY_NAME.list_properties.inputSchema.properties.kind.enum.includes('sample'));
});

test('follow_actions is declared, described honestly, and not batchable', () => {
  const spec = TOOL_SPEC_BY_NAME.follow_actions;
  assert.deepEqual(spec.inputSchema.properties.action.enum, ['set', 'clear', 'status']);
  assert.equal(validateArgs(spec.inputSchema, { action: 'set', address: 'tracks/0/slots/0/clip', actions: [{ action: 'next', weight: 2 }], after_bars: 1 }), null);
  assert.match(spec.description, /memory only/);
  assert.match(TOOL_SPEC_BY_NAME.batch.description, /follow_actions/);
});
