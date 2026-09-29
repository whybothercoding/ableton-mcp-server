import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TOOLS, isToolEnabled } from '../../src/tools/definitions.js';
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
  assert.deepEqual(action.inputSchema.properties.action.enum, ['crop', 'duplicate_loop', 'quantize', 'quantize_pitch', 'scrub', 'stop_scrub', 'move_playing_pos']);
  assert.equal(validateArgs(launch.inputSchema, { address: 'tracks/0/slots/0', legato: 'yes' }), 'legato must be true or false');
  assert.equal(validateArgs(action.inputSchema, { address: 'tracks/0/slots/0/clip', action: 'quantize', amount: 0.5 }), null);
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
    'bulk_set_device_parameters', 'bulk_edit_clips'];
  const names = new Set(TOOLS.map((t) => t.name));
  for (const name of retired) assert.ok(!names.has(name), `${name} should be retired`);
  assert.deepEqual(TOOL_SPEC_BY_NAME.create.inputSchema.properties.kind.enum, ['audio_track', 'midi_track', 'return_track', 'scene', 'midi_clip', 'cue_point']);
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
