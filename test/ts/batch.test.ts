import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AbletonClientError } from '../../src/client/AbletonClient.js';
import { runBatch } from '../../src/tools/batch.js';
import { ToolHandler } from '../../src/tools/handlers.js';
import { TOOL_SPEC_BY_NAME, validateArgs } from '../../src/tools/spec.js';

class Recorder {
  calls: { type: string; params: any }[] = [];
  constructor(private readonly reply: (params: any) => any = (params) => ({ ok: true, applied: params.ops.length, results: params.ops.map((op: any, index: number) => ({ index, command: op.command, status: 'success', result: {} })) })) {}
  async sendCommand(type: string, params: any) {
    this.calls.push({ type, params });
    return this.reply(params);
  }
}

test('ops become bridge commands, in order, with the tool arguments untouched', async () => {
  const bridge = new Recorder();
  const result: any = await runBatch({ ops: [
    { tool: 'create', args: { kind: 'midi_track', name: 'Bass' } },
    { tool: 'device_action', args: { action: 'insert', address: '$0.address', name: 'Drift' } },
    { tool: 'set_properties', args: { address: '$0.address', properties: { mute: false } } }
  ] }, bridge, TOOL_SPEC_BY_NAME);
  assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.calls[0].type, 'batch');
  assert.deepEqual(bridge.calls[0].params.ops, [
    { command: 'create', params: { kind: 'midi_track', name: 'Bass' } },
    { command: 'device_action', params: { action: 'insert', address: '$0.address', name: 'Drift' } },
    { command: 'set_properties', params: { address: '$0.address', properties: { mute: false } } }
  ]);
  assert.equal(bridge.calls[0].params.on_error, 'stop');
  assert.deepEqual(result.results.map((r: any) => r.tool), ['create', 'device_action', 'set_properties']);
});

test('references pass validation for any type, real mistakes do not', async () => {
  const create = TOOL_SPEC_BY_NAME.create.inputSchema;
  assert.equal(validateArgs(create, { kind: 'scene', color: '$0.color', index: '$1.position' }, true), null);
  assert.match(validateArgs(create, { kind: 'scene', color: '$0.color' }, false) ?? '', /color must be a number/);
  assert.match(validateArgs(create, { kind: '$0.kind_x oops' }, true) ?? '', /kind must be one of/);
  await assert.rejects(runBatch({ ops: [{ tool: 'create', args: { kind: 'device' } }] }, new Recorder(), TOOL_SPEC_BY_NAME), /ops\[0\] \(create\): kind must be one of/);
  await assert.rejects(runBatch({ ops: [{ tool: 'create', args: { kind: 'scene' } }, { tool: 'delete', args: { address: '$0.address' } }] }, new Recorder(), TOOL_SPEC_BY_NAME),
    /ops\[1\] \(delete\): missing required argument 'expect'/);
});

test('tools that are not one undoable edit, compose calls or are legacy are refused with the list of allowed ones', async () => {
  for (const tool of ['transport', 'launch', 'history', 'batch', 'transform_notes', 'generate_notes', 'ramp_parameter', 'cancel_ramps', 'record', 'get_health', 'nonsense']) {
    await assert.rejects(runBatch({ ops: [{ tool, args: {} }] }, new Recorder(), TOOL_SPEC_BY_NAME), /cannot be used in a batch. Batchable tools: get_properties/, tool);
  }
  await assert.rejects(runBatch({ ops: [] }, new Recorder(), TOOL_SPEC_BY_NAME), /non-empty list/);
  await assert.rejects(runBatch({}, new Recorder(), TOOL_SPEC_BY_NAME), /non-empty list/);
});

test('the tool description lists exactly the batchable tools', () => {
  const batchable = Object.values(TOOL_SPEC_BY_NAME).filter((s) => !s.run && !['transport', 'launch', 'history', 'batch', 'ramp_parameter', 'cancel_ramps', 'record'].includes(s.name)).map((s) => s.name).sort();
  const listed = /Batchable tools: ([a-z_, ]+)\./.exec(TOOL_SPEC_BY_NAME.batch.description)![1].split(', ').sort();
  assert.deepEqual(listed, batchable);
  assert.equal(TOOL_SPEC_BY_NAME.batch.annotations.destructiveHint, true);
  assert.deepEqual(TOOL_SPEC_BY_NAME.batch.inputSchema.required, ['ops']);
});

test('a failed batch reaches the caller with every op outcome', async () => {
  const details = { applied: 1, failed: [1], not_run: [2], results: [{ index: 0, command: 'create', status: 'success' }, { index: 1, command: 'create', status: 'error', code: 'OUT_OF_RANGE', message: 'index 99 is beyond the end' }] };
  const client: any = {
    ensureCapability: () => undefined,
    sendCommand: async () => {
      throw new AbletonClientError('Batch stopped at op 1 (create): index 99 is beyond the end. 1 op(s) before it were applied as ONE undo step.', 'REMOTE_ERROR', false, 'BATCH_FAILED', details);
    }
  };
  const handler = new ToolHandler(client);
  const out = await handler.handleToolCall('batch', { ops: [{ tool: 'create', args: { kind: 'scene' } }, { tool: 'create', args: { kind: 'scene', index: 99 } }] });
  assert.equal(out.isError, true);
  const text = (out.content[0] as any).text as string;
  assert.match(text, /^Batch stopped at op 1 \(create\)/);
  assert.deepEqual(JSON.parse(text.slice(text.indexOf('\n') + 1)), details);
});

test('on_error is passed through and checked', async () => {
  const bridge = new Recorder();
  await runBatch({ ops: [{ tool: 'describe_set', args: {} }], on_error: 'continue' }, bridge, TOOL_SPEC_BY_NAME);
  assert.equal(bridge.calls[0].params.on_error, 'continue');
  assert.match(validateArgs(TOOL_SPEC_BY_NAME.batch.inputSchema, { ops: [{ tool: 'x' }], on_error: 'explode' }) ?? '', /on_error must be one of: stop, continue/);
});
