import { TOOL_SPECS, ToolAnnotations } from './spec.js';

export interface ToolDefinition {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
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
    "get_device lists a rack's chains, return chains and occupied drum pads."
};

const PARAMETER_TARGET_PROPERTIES = {
  track_type: TRACK_TYPE_PROPERTY,
  device_path: DEVICE_PATH_PROPERTY,
  device_index: { type: 'number', description: '0-indexed top-level device position on the track (use with parameter_index)' },
  parameter_index: { type: 'number', description: '0-indexed parameter position (see get_device for indices and min/max)' },
  mixer_parameter: { type: 'string', description: "Mixer target instead of a device parameter: 'volume', 'pan' or 'send:N' (0-indexed send)" }
};

const LEGACY_TOOLS: ToolDefinition[] = [
  {
    name: 'get_health',
    description: 'Ping Ableton Live Remote Script TCP bridge, report connection status, script version, and available capabilities.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
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

/** Legacy tools (switch in handlers.ts) followed by the declarative specs (spec.ts). */
export const TOOLS: ToolDefinition[] = [
  ...LEGACY_TOOLS,
  ...TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: spec.annotations,
    requiredCapability: spec.bridge.command
  }))
];
