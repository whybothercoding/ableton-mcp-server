import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AbletonClient, AbletonClientError } from '../client/AbletonClient.js';
import { analyzeAudioFile } from '../audio/analyzer.js';

export class ToolHandler {
  constructor(private readonly client: AbletonClient) {}

  public async handleToolCall(
    toolName: string,
    args: Record<string, any> = {}
  ): Promise<CallToolResult> {
    try {
      let resultData: any;

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

        case 'get_session_info': {
          this.client.ensureCapability('get_session_info');
          resultData = await this.client.sendCommand('get_session_info');
          break;
        }

        case 'get_track_structure': {
          this.client.ensureCapability('get_bulk_session_structure');
          const bulk = await this.client.sendCommand('get_bulk_session_structure');
          resultData = {
            session: bulk.session,
            tracks: (bulk.tracks || []).map((t: any) => ({
              index: t.index,
              name: t.name,
              is_group: t.is_group,
              is_grouped: t.is_grouped,
              group_track_name: t.group_track_name,
              is_audio_track: t.is_audio_track,
              is_midi_track: t.is_midi_track,
              mute: t.mute,
              solo: t.solo,
              can_be_armed: t.can_be_armed,
              arm: t.arm,
              volume: t.volume,
              panning: t.panning,
              playing_slot_index: t.playing_slot_index,
              device_count: t.device_count,
              clip_count: (t.clips || []).length
            }))
          };
          break;
        }

        case 'get_track_detail': {
          this.client.ensureCapability('get_track_info');
          resultData = await this.client.sendCommand('get_track_info', {
            track_index: Number(args.track_index)
          });
          break;
        }

        case 'get_clip_notes': {
          this.client.ensureCapability('get_clip_notes');
          resultData = await this.client.sendCommand('get_clip_notes', {
            track_index: Number(args.track_index),
            clip_index: Number(args.clip_index)
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
            track_index: Number(args.track_index),
            device_index: Number(args.device_index)
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

        case 'get_bulk_session_structure': {
          this.client.ensureCapability('get_bulk_session_structure');
          resultData = await this.client.sendCommand('get_bulk_session_structure');
          break;
        }

        case 'set_tempo': {
          this.client.ensureCapability('set_tempo');
          resultData = await this.client.sendCommand('set_tempo', {
            tempo: Number(args.tempo)
          });
          break;
        }

        case 'set_track_name': {
          this.client.ensureCapability('set_track_name');
          resultData = await this.client.sendCommand('set_track_name', {
            track_index: Number(args.track_index),
            name: String(args.name)
          });
          break;
        }

        case 'set_track_color': {
          this.client.ensureCapability('set_track_color');
          resultData = await this.client.sendCommand('set_track_color', {
            track_index: Number(args.track_index),
            color: Number(args.color)
          });
          break;
        }

        case 'set_clip_color': {
          this.client.ensureCapability('set_clip_color');
          resultData = await this.client.sendCommand('set_clip_color', {
            track_index: Number(args.track_index),
            clip_index: Number(args.clip_index),
            color: Number(args.color)
          });
          break;
        }

        case 'set_track_mute': {
          this.client.ensureCapability('set_track_mute');
          resultData = await this.client.sendCommand('set_track_mute', {
            track_index: Number(args.track_index),
            mute: Boolean(args.mute)
          });
          break;
        }

        case 'set_track_solo': {
          this.client.ensureCapability('set_track_solo');
          resultData = await this.client.sendCommand('set_track_solo', {
            track_index: Number(args.track_index),
            solo: Boolean(args.solo)
          });
          break;
        }

        case 'set_track_arm': {
          this.client.ensureCapability('set_track_arm');
          resultData = await this.client.sendCommand('set_track_arm', {
            track_index: Number(args.track_index),
            arm: Boolean(args.arm)
          });
          break;
        }

        case 'create_midi_track': {
          this.client.ensureCapability('create_midi_track');
          resultData = await this.client.sendCommand('create_midi_track', {
            index: args.index !== undefined ? Number(args.index) : -1
          });
          break;
        }

        case 'create_clip': {
          this.client.ensureCapability('create_clip');
          resultData = await this.client.sendCommand('create_clip', {
            track_index: Number(args.track_index),
            clip_index: Number(args.clip_index),
            length: args.length !== undefined ? Number(args.length) : 4.0
          });
          if (args.name && this.client.hasCapability('set_clip_name')) {
            await this.client.sendCommand('set_clip_name', {
              track_index: Number(args.track_index),
              clip_index: Number(args.clip_index),
              name: String(args.name)
            });
            resultData.name = String(args.name);
          }
          break;
        }

        case 'set_clip_name': {
          this.client.ensureCapability('set_clip_name');
          resultData = await this.client.sendCommand('set_clip_name', {
            track_index: Number(args.track_index),
            clip_index: Number(args.clip_index),
            name: String(args.name)
          });
          break;
        }

        case 'edit_clip_notes': {
          const mode = String(args.mode || 'add').toLowerCase();
          const trackIndex = Number(args.track_index);
          const clipIndex = Number(args.clip_index);
          const notes = Array.isArray(args.notes) ? args.notes : [];

          if (mode === 'replace') {
            this.client.ensureCapability('clear_notes_from_clip');
            await this.client.sendCommand('clear_notes_from_clip', {
              track_index: trackIndex,
              clip_index: clipIndex
            });
          }

          this.client.ensureCapability('add_notes_to_clip');
          resultData = await this.client.sendCommand('add_notes_to_clip', {
            track_index: trackIndex,
            clip_index: clipIndex,
            notes
          });
          resultData.mode = mode;
          resultData.notes_written = notes.length;
          break;
        }

        case 'delete_clip': {
          this.client.ensureCapability('delete_clip');
          resultData = await this.client.sendCommand('delete_clip', {
            track_index: Number(args.track_index),
            clip_index: Number(args.clip_index)
          });
          break;
        }

        case 'fire_clip': {
          this.client.ensureCapability('fire_clip');
          resultData = await this.client.sendCommand('fire_clip', {
            track_index: Number(args.track_index),
            clip_index: Number(args.clip_index)
          });
          break;
        }

        case 'stop_clip': {
          this.client.ensureCapability('stop_clip');
          resultData = await this.client.sendCommand('stop_clip', {
            track_index: Number(args.track_index),
            clip_index: Number(args.clip_index)
          });
          break;
        }

        case 'fire_scene': {
          this.client.ensureCapability('fire_scene');
          resultData = await this.client.sendCommand('fire_scene', {
            scene_index: Number(args.scene_index)
          });
          break;
        }

        case 'set_scene_name': {
          this.client.ensureCapability('set_scene_name');
          resultData = await this.client.sendCommand('set_scene_name', {
            scene_index: Number(args.scene_index),
            name: String(args.name)
          });
          break;
        }

        case 'stop_all_clips': {
          this.client.ensureCapability('stop_all_clips');
          resultData = await this.client.sendCommand('stop_all_clips');
          break;
        }

        case 'start_playback': {
          this.client.ensureCapability('start_playback');
          resultData = await this.client.sendCommand('start_playback');
          break;
        }

        case 'stop_playback': {
          this.client.ensureCapability('stop_playback');
          resultData = await this.client.sendCommand('stop_playback');
          break;
        }

        case 'set_device_parameter': {
          this.client.ensureCapability('set_device_parameter');
          resultData = await this.client.sendCommand('set_device_parameter', {
            track_index: Number(args.track_index),
            device_index: Number(args.device_index),
            parameter_index: Number(args.parameter_index),
            value: Number(args.value)
          });
          break;
        }

        case 'load_browser_item': {
          this.client.ensureCapability('load_browser_item');
          resultData = await this.client.sendCommand('load_browser_item', {
            track_index: Number(args.track_index),
            item_uri: String(args.item_uri)
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
        err instanceof AbletonClientError
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
