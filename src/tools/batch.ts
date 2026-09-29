/**
 * batch: several tool calls as ONE bridge round trip and ONE undo step. Each op names a tool and its arguments exactly as a
 * separate call would; this file turns them into bridge commands. Later ops can use earlier results ($0.address).
 */
import { CompositionError } from './composition.js';
import { validateArgs } from './schema.js';
import type { BridgeClient, ToolSpec } from './spec.js';

/** Tools that are not one undoable edit (playback, launching, undo) or that already combine several calls. */
const REFUSED = new Set(['transport', 'launch', 'history', 'batch']);

const batchable = (specs: Record<string, ToolSpec>): string[] =>
  Object.values(specs)
    .filter((spec) => !spec.run && !REFUSED.has(spec.name))
    .map((spec) => spec.name);

export async function runBatch(args: Record<string, any>, client: BridgeClient, specs: Record<string, ToolSpec>): Promise<unknown> {
  const ops: { tool: string; args?: Record<string, any> }[] = args.ops;
  if (!Array.isArray(ops) || !ops.length) throw new CompositionError('ops must be a non-empty list of {tool, args}');
  const allowed = batchable(specs);
  const commands = ops.map((op, index) => {
    const spec = specs[op.tool];
    if (!spec || !allowed.includes(op.tool)) {
      throw new CompositionError(`ops[${index}]: '${op.tool}' cannot be used in a batch. Batchable tools: ${allowed.join(', ')}`);
    }
    const opArgs = op.args ?? {};
    const problem = validateArgs(spec.inputSchema, opArgs, true);
    if (problem) throw new CompositionError(`ops[${index}] (${op.tool}): ${problem}`);
    return { command: spec.bridge.command, params: spec.bridge.params ? spec.bridge.params(opArgs) : opArgs };
  });
  const result = await client.sendCommand('batch', { ops: commands, on_error: args.on_error ?? 'stop' });
  // the bridge answers with bridge command names; give the caller the tool names it used
  result.results = result.results.map((entry: any, i: number) => ({ ...entry, tool: ops[i].tool }));
  return result;
}

export const BATCH_SPECS: ToolSpec[] = [
  {
    name: 'batch',
    description:
      "Run several tools in ONE round trip and ONE undo step (`history undo` reverts all of it; Live records each device parameter write as its own extra undo entry). `ops`: [{tool, args}] with each tool's usual arguments, run in order on Live's main thread. " +
      "Later ops can use earlier results: '$0.address' is the address op 0 returned (a whole-string reference keeps its type, e.g. a number; inside a longer string it is inserted as text; '$1.ids[0]' indexes lists). " +
      "Example: [{tool:'create',args:{kind:'midi_track',name:'Bass'}},{tool:'device_action',args:{action:'insert',address:'$0.address',name:'Drift'}}]. " +
      "`on_error`: stop (default; ops already applied stay applied as one undo step, later ones do not run) or continue. A failure returns BATCH_FAILED with every op's outcome. Up to 100 ops. " +
      "Batchable tools: " + 'get_properties, set_properties, list_properties, describe_set, get_capabilities, get_notes, get_device, create, duplicate, delete, write_notes, edit_notes, clip_action, device_action, routing' + ". " +
      "Not batchable: transport, launch, history (not undoable edits), transform_notes and generate_notes (already combine calls), and the older automation, ramp and browser tools.",
    inputSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          description: 'The calls, in order',
          items: {
            type: 'object',
            properties: { tool: { type: 'string', description: 'Tool name' }, args: { type: 'object', description: "The tool's arguments (may contain $N references)" } },
            required: ['tool']
          }
        },
        on_error: { type: 'string', enum: ['stop', 'continue'], description: 'Default stop' }
      },
      required: ['ops']
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    bridge: { command: 'batch' },
    run: runBatch
  }
];
