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
          ? await spec.run(args, this.client, TOOL_SPEC_BY_NAME)
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
      let errorMessage =
        err instanceof AbletonClientError || err instanceof CompositionError
          ? err.message
          : `Unexpected error executing tool '${toolName}': ${err.message}`;
      if (err instanceof AbletonClientError && err.details) errorMessage += `\n${JSON.stringify(err.details, null, 2)}`;

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
