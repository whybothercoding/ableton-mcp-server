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

const TRACK_TYPE_PROPERTY = {
  type: 'string',
  enum: ['track', 'return', 'master'],
  description: "Which track list track_index refers to: 'track' (default), 'return' (return tracks) or 'master' (track_index is then ignored, pass 0)"
};

const DEVICE_PATH_PROPERTY = {
  type: 'array',
  items: {},
  description:
    'Address a device inside racks instead of device_index: [device, chain, device, ...], ending in a device index. ' +
    'A chain selector is a chain index, {"pad": note} or {"pad": note, "chain": n} for a drum pad, or {"return": n} for a return chain. ' +
    "get_device_parameters lists a rack's chains, return chains and occupied drum pads."
};

const PARAMETER_TARGET_PROPERTIES = {
  track_type: TRACK_TYPE_PROPERTY,
  device_path: DEVICE_PATH_PROPERTY,
  device_index: { type: 'number', description: '0-indexed top-level device position on the track (use with parameter_index)' },
  parameter_index: { type: 'number', description: '0-indexed parameter position (see get_device_parameters for indices and min/max)' },
  mixer_parameter: { type: 'string', description: "Mixer target instead of a device parameter: 'volume', 'pan' or 'send:N' (0-indexed send)" }
};

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
        track_index: { type: 'number', description: '0-indexed track position' },
        track_type: TRACK_TYPE_PROPERTY
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
    name: 'get_audio_clip_path',
    description: 'Get the source audio file path and Live clip metadata for an audio clip in Session or Arrangement view.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        clip_index: { type: 'number', description: '0-indexed clip slot (Session) or arrangement clip position' },
        source: { type: 'string', enum: ['session', 'arrangement'], description: 'Clip collection to inspect; defaults to session' }
      },
      required: ['track_index', 'clip_index']
    },
    requiredCapability: 'get_audio_clip_path'
  },
  {
    name: 'analyze_audio_clip',
    description: 'Analyze a clip source file locally for format metadata, integrated loudness, peak/RMS levels, and an approximate frequency-band profile. Requires ffmpeg and ffprobe on the MCP host.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        clip_index: { type: 'number', description: '0-indexed clip slot (Session) or arrangement clip position' },
        source: { type: 'string', enum: ['session', 'arrangement'], description: 'Clip collection to inspect; defaults to session' }
      },
      required: ['track_index', 'clip_index']
    },
    requiredCapability: 'get_audio_clip_path'
  },
  {
    name: 'get_device_parameters',
    description:
      "Get a device's parameters: index, name, value, min, max, whether it is quantized (with its value_items labels, e.g. Filter Type 0 = Low-pass), the display string, the default and whether it is enabled. " +
      'Works on regular, return and master tracks and, via device_path, on devices inside racks. Racks also list their chains, return chains and occupied drum pads.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        track_type: TRACK_TYPE_PROPERTY,
        device_index: { type: 'number', description: '0-indexed top-level device position (or use device_path)' },
        device_path: DEVICE_PATH_PROPERTY
      },
      required: ['track_index']
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
        path: { type: 'string', description: 'Path in browser tree e.g. "instruments/Simpler"' },
        limit: { type: 'number', description: 'Maximum items to return (default 200)' },
        offset: { type: 'number', description: 'Number of items to skip, for paging through large folders (default 0)' }
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
        track_type: TRACK_TYPE_PROPERTY,
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
        track_type: TRACK_TYPE_PROPERTY,
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
        track_type: TRACK_TYPE_PROPERTY,
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
        track_type: TRACK_TYPE_PROPERTY,
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
        track_type: TRACK_TYPE_PROPERTY,
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
    description: 'Set the value of a device parameter (regular, return or master track; use device_path for devices inside racks). Returns the old value, the value Live holds and its display string.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        track_type: TRACK_TYPE_PROPERTY,
        device_index: { type: 'number', description: '0-indexed top-level device position (or use device_path)' },
        device_path: DEVICE_PATH_PROPERTY,
        parameter_index: { type: 'number', description: '0-indexed parameter position' },
        value: { type: 'number', description: 'Parameter value' }
      },
      required: ['track_index', 'parameter_index', 'value']
    },
    requiredCapability: 'set_device_parameter'
  },
  {
    name: 'draw_automation',
    description:
      "Draw a clip automation envelope for a device or mixer parameter from time/value points. Runs inside Live, so it is tempo-locked and sample-accurate regardless of bridge latency. " +
      "Session clips only (Live's API has no envelopes for arrangement clips), and the parameter must be on the clip's own track. " +
      "Times are beats from the clip start (0 to the clip length); values are in the parameter's own units (see get_device_parameters min/max). " +
      "Ramps are drawn as fine staircases (resolution beats per step) that start exactly on the first value and end exactly on the last. " +
      "mode 'replace' (default) rebuilds the parameter's whole envelope; 'merge' only rewrites the drawn range. With hold (default) the clip edges are filled with the first/last value.",
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        clip_index: { type: 'number', description: '0-indexed Session clip slot' },
        ...PARAMETER_TARGET_PROPERTIES,
        points: {
          type: 'array',
          description: 'Breakpoints, e.g. [{"time":0,"value":0.2},{"time":8,"value":0.9}]. An optional per-point curve shapes the segment that starts there.',
          items: {
            type: 'object',
            properties: {
              time: { type: 'number', description: 'Beats from clip start' },
              value: { type: 'number', description: "Value in the parameter's units" },
              curve: { type: 'string', enum: ['linear', 'step', 'smooth', 'ease_in', 'ease_out'], description: 'Curve to the next point' }
            },
            required: ['time', 'value']
          }
        },
        curve: { type: 'string', enum: ['linear', 'step', 'smooth', 'ease_in', 'ease_out'], description: "Default curve between points (default 'linear'); 'step' holds each value until the next point" },
        resolution: { type: 'number', description: 'Beats per staircase step for non-step curves (default 0.125)' },
        mode: { type: 'string', enum: ['replace', 'merge'], description: "'replace' (default) or 'merge'" },
        hold: { type: 'boolean', description: 'Fill the clip before the first and after the last point with those values (default true)' }
      },
      required: ['track_index', 'clip_index', 'points']
    },
    requiredCapability: 'draw_automation'
  },
  {
    name: 'clear_automation',
    description: "Clear a Session clip's automation: one parameter's envelope, or every envelope on the clip when no parameter is given.",
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        clip_index: { type: 'number', description: '0-indexed Session clip slot' },
        ...PARAMETER_TARGET_PROPERTIES
      },
      required: ['track_index', 'clip_index']
    },
    requiredCapability: 'clear_automation'
  },
  {
    name: 'ramp_parameter',
    description:
      'Sweep a device or mixer parameter to a target value over a number of beats or seconds, driven inside Live at about 100 updates per second. ' +
      'Use for live gestures; use draw_automation for motion that belongs to a looping clip. Starting a new ramp on the same parameter replaces the old one. ' +
      'Returns immediately while the sweep runs; cancel with cancel_ramps.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        ...PARAMETER_TARGET_PROPERTIES,
        to: { type: 'number', description: "Target value in the parameter's units" },
        from: { type: 'number', description: 'Start value (default: the current value)' },
        beats: { type: 'number', description: 'Duration in beats at the current tempo (give beats or seconds)' },
        seconds: { type: 'number', description: 'Duration in seconds, 0.01 to 3600 (give beats or seconds)' },
        curve: { type: 'string', enum: ['linear', 'smooth', 'ease_in', 'ease_out'], description: "Easing (default 'linear')" }
      },
      required: ['track_index', 'to']
    },
    requiredCapability: 'ramp_parameter'
  },
  {
    name: 'cancel_ramps',
    description: 'Cancel active ramps: one parameter when a track (track_index, or track_type "master") and a target are given, otherwise all of them. The parameter stays at its current value.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position (omit to cancel every ramp)' },
        ...PARAMETER_TARGET_PROPERTIES
      }
    },
    requiredCapability: 'cancel_ramps'
  },
  {
    name: 'load_browser_item',
    description: 'Load a browser item onto a track by URI.',
    inputSchema: {
      type: 'object',
      properties: {
        track_index: { type: 'number', description: '0-indexed track position' },
        track_type: TRACK_TYPE_PROPERTY,
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
    description: 'Batch update multiple device parameters in a single round trip. Each item may name a track_type and a device_path; the result reports the value Live holds and why any item was skipped.',
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
              track_type: TRACK_TYPE_PROPERTY,
              device_index: { type: 'number' },
              device_path: DEVICE_PATH_PROPERTY,
              parameter_index: { type: 'number' },
              value: { type: 'number' }
            },
            required: ['track_index', 'parameter_index', 'value']
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

/** Tools that are hidden and refused unless the named environment variable is "1" in the MCP server's environment. */
export const GATED_TOOLS: Record<string, string> = {
  eval_python: 'ABLETON_MCP_ALLOW_EVAL'
};

export function isToolEnabled(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const variable = GATED_TOOLS[name];
  return variable === undefined || env[variable] === '1';
}
