import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AbletonClient, AbletonClientError } from '../client/AbletonClient.js';
import { analyzeAudioFile } from '../audio/analyzer.js';
import { GATED_TOOLS, isToolEnabled } from './definitions.js';
import { CompositionError } from './composition.js';
import { TOOL_SPEC_BY_NAME, validateArgs } from './spec.js';

/** Copies only the fields the caller supplied, so absent optionals stay absent (Number(undefined) would send NaN). */
function pick(args: Record<string, any>, numbers: string[], others: string[] = []): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of numbers) {
    if (args[key] !== undefined && args[key] !== null) out[key] = Number(args[key]);
  }
  for (const key of others) {
    if (args[key] !== undefined && args[key] !== null) out[key] = args[key];
  }
  return out;
}

const TARGET_NUMBERS = ['track_index', 'device_index', 'parameter_index'];

export class ToolHandler {
  constructor(private readonly client: AbletonClient) {}

  public async handleToolCall(
    toolName: string,
    args: Record<string, any> = {}
  ): Promise<CallToolResult> {
    try {
      if (!isToolEnabled(toolName)) {
        return {
          content: [
            {
              type: 'text',
              text: `Tool '${toolName}' is disabled. Set ${GATED_TOOLS[toolName]}=1 in the MCP server's environment to enable it.`
            }
          ],
          isError: true
        };
      }

      let resultData: any;

      const spec = TOOL_SPEC_BY_NAME[toolName];
      if (spec) {
        const problem = validateArgs(spec.inputSchema, args);
        if (problem) {
          return { content: [{ type: 'text', text: `Invalid arguments for '${toolName}': ${problem}` }], isError: true };
        }
        this.client.ensureCapability(spec.bridge.command);
        for (const required of spec.requires ?? []) this.client.ensureCapability(required);
        resultData = spec.run
          ? await spec.run(args, this.client)
          : await this.client.sendCommand(spec.bridge.command, spec.bridge.params ? spec.bridge.params(args) : args);
        return { content: [{ type: 'text', text: JSON.stringify(resultData, null, 2) }] };
      }

      switch (toolName) {
        case 'get_health': {
          const info = await this.client.fetchCapabilities();
          resultData = {
            status: 'ok',
            connected: true,
            script_version: info.script_version,
            capabilities_count: info.capabilities?.length || 0,
            capabilities: info.capabilities
          };
          break;
        }

        case 'get_track_detail': {
          this.client.ensureCapability('get_track_info');
          resultData = await this.client.sendCommand('get_track_info', {
            track_index: Number(args.track_index),
            ...pick(args, [], ['track_type'])
          });
          break;
        }

        case 'get_audio_clip_path': {
          this.client.ensureCapability('get_audio_clip_path');
          resultData = await this.client.sendCommand('get_audio_clip_path', {
            track_index: Number(args.track_index),
            clip_index: Number(args.clip_index),
            source: args.source || 'session'
          });
          break;
        }

        case 'analyze_audio_clip': {
          this.client.ensureCapability('get_audio_clip_path');
          const clipInfo = await this.client.sendCommand<Record<string, any>>('get_audio_clip_path', {
            track_index: Number(args.track_index),
            clip_index: Number(args.clip_index),
            source: args.source || 'session'
          });
          const analysis = await analyzeAudioFile(clipInfo.file_path);
          resultData = { clip: clipInfo, analysis };
          break;
        }

        case 'get_device_parameters': {
          this.client.ensureCapability('get_device_parameters');
          resultData = await this.client.sendCommand('get_device_parameters', {
            ...pick(args, ['track_index', 'device_index'], ['track_type', 'device_path'])
          });
          break;
        }

        case 'get_browser_tree': {
          this.client.ensureCapability('get_browser_tree');
          resultData = await this.client.sendCommand('get_browser_tree', {
            category_type: args.category_type || 'all'
          });
          break;
        }

        case 'get_browser_items': {
          this.client.ensureCapability('get_browser_items_at_path');
          resultData = await this.client.sendCommand('get_browser_items_at_path', {
            path: String(args.path),
            limit: args.limit === undefined ? 200 : Number(args.limit),
            offset: args.offset === undefined ? 0 : Number(args.offset)
          });
          break;
        }

        case 'set_device_parameter': {
          this.client.ensureCapability('set_device_parameter');
          resultData = await this.client.sendCommand('set_device_parameter', {
            ...pick(args, ['track_index', 'device_index', 'parameter_index', 'value'], ['track_type', 'device_path'])
          });
          break;
        }

        case 'draw_automation': {
          this.client.ensureCapability('draw_automation');
          resultData = await this.client.sendCommand('draw_automation', {
            ...pick(args, [...TARGET_NUMBERS, 'clip_index', 'resolution'], ['mixer_parameter', 'track_type', 'device_path', 'points', 'curve', 'mode', 'hold'])
          });
          break;
        }

        case 'clear_automation': {
          this.client.ensureCapability('clear_automation');
          resultData = await this.client.sendCommand('clear_automation', {
            ...pick(args, [...TARGET_NUMBERS, 'clip_index'], ['mixer_parameter', 'track_type', 'device_path'])
          });
          break;
        }

        case 'ramp_parameter': {
          this.client.ensureCapability('ramp_parameter');
          resultData = await this.client.sendCommand('ramp_parameter', {
            ...pick(args, [...TARGET_NUMBERS, 'to', 'from', 'beats', 'seconds'], ['mixer_parameter', 'track_type', 'device_path', 'curve'])
          });
          break;
        }

        case 'cancel_ramps': {
          this.client.ensureCapability('cancel_ramps');
          resultData = await this.client.sendCommand('cancel_ramps', {
            ...pick(args, TARGET_NUMBERS, ['mixer_parameter', 'track_type', 'device_path'])
          });
          break;
        }

        case 'load_browser_item': {
          this.client.ensureCapability('load_browser_item');
          resultData = await this.client.sendCommand('load_browser_item', {
            track_index: Number(args.track_index),
            item_uri: String(args.item_uri),
            ...pick(args, [], ['track_type'])
          });
          break;
        }

        case 'bulk_edit_clips': {
          const results: Record<string, any> = {};
          if (Array.isArray(args.create) && args.create.length > 0) {
            if (this.client.hasCapability('bulk_create_clips')) {
              results.created = await this.client.sendCommand('bulk_create_clips', {
                items: args.create
              });
            } else {
              this.client.ensureCapability('create_clip');
              const created = [];
              for (const item of args.create) {
                const res = await this.client.sendCommand('create_clip', item);
                created.push(res);
              }
              results.created = created;
            }
          }
          if (Array.isArray(args.names) && args.names.length > 0) {
            if (this.client.hasCapability('bulk_set_clip_names')) {
              results.renamed = await this.client.sendCommand('bulk_set_clip_names', {
                items: args.names
              });
            } else {
              this.client.ensureCapability('set_clip_name');
              const renamed = [];
              for (const item of args.names) {
                const res = await this.client.sendCommand('set_clip_name', item);
                renamed.push(res);
              }
              results.renamed = renamed;
            }
          }
          resultData = results;
          break;
        }

        case 'bulk_set_device_parameters': {
          this.client.ensureCapability('bulk_set_device_parameters');
          resultData = await this.client.sendCommand('bulk_set_device_parameters', {
            items: args.parameters || []
          });
          break;
        }

        case 'eval_python': {
          this.client.ensureCapability('eval');
          resultData = await this.client.sendCommand('eval', {
            code: String(args.code)
          });
          break;
        }

        default:
          return {
            content: [
              {
                type: 'text',
                text: `Unknown tool name: '${toolName}'`
              }
            ],
            isError: true
          };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(resultData, null, 2)
          }
        ]
      };
    } catch (err: any) {
      const errorMessage =
        err instanceof AbletonClientError || err instanceof CompositionError
          ? err.message
          : `Unexpected error executing tool '${toolName}': ${err.message}`;

      return {
        content: [
          {
            type: 'text',
            text: errorMessage
          }
        ],
        isError: true
      };
    }
  }
}
