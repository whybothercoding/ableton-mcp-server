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
