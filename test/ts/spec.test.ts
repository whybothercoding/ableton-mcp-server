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
  for (const spec of TOOL_SPECS) assert.ok(commands.has(spec.bridge.command), `${spec.name} -> ${spec.bridge.command} is not registered`);
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
  assert.ok(size < 45_000, `tool list is ${size} characters; trim descriptions or consolidate tools`);
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
  assert.match(validateArgs(list, { kind: 'device' })!, /must be one of: song, track, scene, slot, clip/);
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
