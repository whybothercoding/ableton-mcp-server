export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  requiredCapability?: string;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'get_health',
    description: 'Ping Ableton Live Remote Script TCP bridge, report connection status, script version, and available capabilities.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_session_info',
    description: 'Get global session metadata including tempo, time signature, track counts, and master track state.',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    requiredCapability: 'get_session_info'
  },
  {
    name: 'get_track_structure',
    description: 'Get summary of all tracks in the session including group tracks, group membership, and arm/mute/solo status.',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    requiredCapability: 'get_bulk_session_structure'
  },
  {
    name: 'get_track_detail',
    description: 'Get detailed information for a specific track, including session clip slots, arrangement clips, and device list.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' }
      },
      required: ['track_index']
    },
    requiredCapability: 'get_track_info'
  },
  {
    name: 'get_clip_notes',
    description: 'Read all MIDI notes from a clip in a track clip slot.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        clip_index: { type: 'number', description: '0-indexed clip slot position' }
      },
      required: ['track_index', 'clip_index']
    },
    requiredCapability: 'get_clip_notes'
  },
  {
    name: 'get_device_parameters',
    description: 'Get parameter list for a specific device on a track, including index, name, current value, min, max.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        device_index: { type: 'number', description: '0-indexed device position' }
      },
      required: ['track_index', 'device_index']
    },
    requiredCapability: 'get_device_parameters'
  },
  {
    name: 'get_browser_tree',
    description: 'Explore top-level categories in Live browser (instruments, sounds, drums, audio_effects, midi_effects).',
    inputSchema: {
      type: 'object',
      properties: {
        category_type: {
          type: 'string',
          description: 'Category filter',
          enum: ['all', 'instruments', 'sounds', 'drums', 'audio_effects', 'midi_effects']
        }
      }
    },
    requiredCapability: 'get_browser_tree'
  },
  {
    name: 'get_browser_items',
    description: 'Get browser items at a given category path (e.g. "instruments/Simpler").',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path in browser tree e.g. "instruments/Simpler"' }
      },
      required: ['path']
    },
    requiredCapability: 'get_browser_items_at_path'
  },
  {
    name: 'get_bulk_session_structure',
    description: 'Retrieve full session structure (tempo, scenes, tracks with clips summary and device counts) in a single batched call.',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    requiredCapability: 'get_bulk_session_structure'
  },
  {
    name: 'set_tempo',
    description: 'Set session tempo in BPM.',
    inputSchema: {
      type: 'object',
      properties: {
        tempo: { type: 'number', description: 'BPM tempo value (e.g. 120.0)' }
      },
      required: ['tempo']
    },
    requiredCapability: 'set_tempo'
  },
  {
    name: 'set_track_name',
    description: 'Rename a track.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        name: { type: 'string', description: 'New name for the track' }
      },
      required: ['track_index', 'name']
    },
    requiredCapability: 'set_track_name'
  },
  {
    name: 'set_track_color',
    description: 'Set color of a track using integer RGB color code.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        color: { type: 'number', description: 'Integer RGB color value' }
      },
      required: ['track_index', 'color']
    },
    requiredCapability: 'set_track_color'
  },
  {
    name: 'set_clip_color',
    description: 'Set color of a clip using integer RGB color code.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        clip_index: { type: 'number', description: '0-indexed clip position' },
        color: { type: 'number', description: 'Integer RGB color value' }
      },
      required: ['track_index', 'clip_index', 'color']
    },
    requiredCapability: 'set_clip_color'
  },
  {
    name: 'set_track_mute',
    description: 'Mute or unmute a track.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        mute: { type: 'boolean', description: 'True to mute, false to unmute' }
      },
      required: ['track_index', 'mute']
    },
    requiredCapability: 'set_track_mute'
  },
  {
    name: 'set_track_solo',
    description: 'Solo or unsolo a track.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        solo: { type: 'boolean', description: 'True to solo, false to unsolo' }
      },
      required: ['track_index', 'solo']
    },
    requiredCapability: 'set_track_solo'
  },
  {
    name: 'set_track_arm',
    description: 'Arm or disarm a track for recording.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        arm: { type: 'boolean', description: 'True to arm, false to disarm' }
      },
      required: ['track_index', 'arm']
    },
    requiredCapability: 'set_track_arm'
  },
  {
    name: 'create_midi_track',
    description: 'Create a new MIDI track.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: '0-indexed track insert position, or -1 for end of list' }
      }
    },
    requiredCapability: 'create_midi_track'
  },
  {
    name: 'create_clip',
    description: 'Create a new MIDI clip in a clip slot.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        clip_index: { type: 'number', description: '0-indexed clip slot position' },
        length: { type: 'number', description: 'Length in beats (default 4.0)' },
        name: { type: 'string', description: 'Optional name for created clip' }
      },
      required: ['track_index', 'clip_index']
    },
    requiredCapability: 'create_clip'
  },
  {
    name: 'set_clip_name',
    description: 'Rename a clip in a clip slot.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        clip_index: { type: 'number', description: '0-indexed clip slot position' },
        name: { type: 'string', description: 'New name for clip' }
      },
      required: ['track_index', 'clip_index', 'name']
    },
    requiredCapability: 'set_clip_name'
  },
  {
    name: 'edit_clip_notes',
    description: 'Add or replace MIDI notes in a clip. In "replace" mode, existing notes are cleared first before writing the new note list.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        clip_index: { type: 'number', description: '0-indexed clip slot position' },
        mode: {
          type: 'string',
          enum: ['add', 'replace'],
          description: '"add" to append notes to clip, "replace" to clear existing notes and write new note list'
        },
        notes: {
          type: 'array',
          description: 'Array of MIDI note objects',
          items: {
            type: 'object',
            properties: {
              pitch: { type: 'number', description: 'MIDI pitch 0-127' },
              start_time: { type: 'number', description: 'Start time in beats' },
              duration: { type: 'number', description: 'Duration in beats' },
              velocity: { type: 'number', description: 'Velocity 1-127 (default 100)' },
              mute: { type: 'boolean', description: 'Muted note' }
            },
            required: ['pitch', 'start_time', 'duration']
          }
        }
      },
      required: ['track_index', 'clip_index', 'mode', 'notes']
    },
    requiredCapability: 'add_notes_to_clip'
  },
  {
    name: 'delete_clip',
    description: 'Delete clip from clip slot.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        clip_index: { type: 'number', description: '0-indexed clip slot position' }
      },
      required: ['track_index', 'clip_index']
    },
    requiredCapability: 'delete_clip'
  },
  {
    name: 'fire_clip',
    description: 'Fire a clip slot in Session view.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        clip_index: { type: 'number', description: '0-indexed clip slot position' }
      },
      required: ['track_index', 'clip_index']
    },
    requiredCapability: 'fire_clip'
  },
  {
    name: 'stop_clip',
    description: 'Stop a clip slot.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        clip_index: { type: 'number', description: '0-indexed clip slot position' }
      },
      required: ['track_index', 'clip_index']
    },
    requiredCapability: 'stop_clip'
  },
  {
    name: 'fire_scene',
    description: 'Fire a scene in Session view.',
    inputSchema: {
      type: 'object',
      properties: {
        scene_index: { type: 'number', description: '0-indexed scene position' }
      },
      required: ['scene_index']
    },
    requiredCapability: 'fire_scene'
  },
  {
    name: 'set_scene_name',
    description: 'Rename a scene in Session view.',
    inputSchema: {
      type: 'object',
      properties: {
        scene_index: { type: 'number', description: '0-indexed scene position' },
        name: { type: 'string', description: 'New name for the scene' }
      },
      required: ['scene_index', 'name']
    },
    requiredCapability: 'set_scene_name'
  },
  {
    name: 'stop_all_clips',
    description: 'Stop playing all session clips.',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    requiredCapability: 'stop_all_clips'
  },
  {
    name: 'start_playback',
    description: 'Start global transport playback.',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    requiredCapability: 'start_playback'
  },
  {
    name: 'stop_playback',
    description: 'Stop global transport playback.',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    requiredCapability: 'stop_playback'
  },
  {
    name: 'set_device_parameter',
    description: 'Set value of a device parameter.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        device_index: { type: 'number', description: '0-indexed device position' },
        parameter_index: { type: 'number', description: '0-indexed parameter position' },
        value: { type: 'number', description: 'Parameter value' }
      },
      required: ['track_index', 'device_index', 'parameter_index', 'value']
    },
    requiredCapability: 'set_device_parameter'
  },
  {
    name: 'load_browser_item',
    description: 'Load a browser item onto a track by URI.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        item_uri: { type: 'string', description: 'URI of browser item' }
      },
      required: ['track_index', 'item_uri']
    },
    requiredCapability: 'load_browser_item'
  },
  {
    name: 'bulk_edit_clips',
    description: 'Batch edit multiple clip names and/or batch create clips in a single round trip.',
    inputSchema: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          description: 'Items to rename',
          items: {
            type: 'object',
            properties: {
              track_index: { type: 'number' },
              clip_index: { type: 'number' },
              name: { type: 'string' }
            },
            required: ['track_index', 'clip_index', 'name']
          }
        },
        create: {
          type: 'array',
          description: 'Items to create',
          items: {
            type: 'object',
            properties: {
              track_index: { type: 'number' },
              clip_index: { type: 'number' },
              length: { type: 'number' },
              name: { type: 'string' }
            },
            required: ['track_index', 'clip_index']
          }
        }
      }
    },
    requiredCapability: 'bulk_set_clip_names'
  },
  {
    name: 'bulk_set_device_parameters',
    description: 'Batch update multiple device parameters in a single round trip.',
    inputSchema: {
      type: 'object',
      properties: {
        parameters: {
          type: 'array',
          description: 'Parameters to set',
          items: {
            type: 'object',
            properties: {
              track_index: { type: 'number' },
              device_index: { type: 'number' },
              parameter_index: { type: 'number' },
              value: { type: 'number' }
            },
            required: ['track_index', 'device_index', 'parameter_index', 'value']
          }
        }
      },
      required: ['parameters']
    },
    requiredCapability: 'bulk_set_device_parameters'
  },
  {
    name: 'eval_python',
    description: 'Evaluate raw Python code on the Ableton Remote Script instance (for development and advanced debugging).',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python expression or script to execute on self' }
      },
      required: ['code']
    },
    requiredCapability: 'eval'
  }
];
