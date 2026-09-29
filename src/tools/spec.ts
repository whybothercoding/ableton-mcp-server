/**
 * Declarative tool specs: a tool's schema, MCP annotations and bridge mapping live in one place.
 * Legacy tools are still handled by the switch in handlers.ts and migrate here as their replacements land.
 */

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, any>; required?: string[] };
  annotations: ToolAnnotations;
  bridge: {
    /** Remote Script command; also the capability the connected script must advertise. */
    command: string;
    /** Maps tool arguments to bridge params. Defaults to passing the arguments through unchanged. */
    params?: (args: Record<string, any>) => Record<string, any>;
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkValue(schema: any, value: unknown, label: string): string | null {
  if (schema === undefined || schema === null) return null;
  const type = schema.type;
  const bad = (expected: string) => `${label} must be ${expected}`;
  if (type === 'number' && !(typeof value === 'number' && Number.isFinite(value))) return bad('a number');
  if (type === 'string' && typeof value !== 'string') return bad('a string');
  if (type === 'boolean' && typeof value !== 'boolean') return bad('true or false');
  if (type === 'object' && !isPlainObject(value)) return bad('an object');
  if (type === 'array') {
    if (!Array.isArray(value)) return bad('an array');
    for (let i = 0; i < value.length; i += 1) {
      const problem = checkValue(schema.items, value[i], `${label}[${i}]`);
      if (problem) return problem;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${label} must be one of: ${schema.enum.join(', ')}`;
  if (type === 'object' && isPlainObject(value)) return checkObject(schema, value, label);
  return null;
}

function checkObject(schema: any, value: Record<string, unknown>, label: string): string | null {
  for (const key of schema.required ?? []) {
    if (value[key] === undefined || value[key] === null) return `${label ? label + ': ' : ''}missing required argument '${key}'`;
  }
  for (const [key, sub] of Object.entries<any>(schema.properties ?? {})) {
    if (value[key] === undefined || value[key] === null) continue;
    const problem = checkValue(sub, value[key], label ? `${label}.${key}` : key);
    if (problem) return problem;
  }
  return null;
}

/** Validates tool arguments against the advertised JSON schema; returns a readable problem or null. */
export function validateArgs(schema: ToolSpec['inputSchema'], args: Record<string, unknown>): string | null {
  return checkObject(schema, args, '');
}

const ADDRESS_HELP =
  "Addresses: 'song', 'master', 'tracks/N', 'returns/N', 'scenes/N', 'tracks/N/slots/M' (clip slot) and " +
  "'tracks/N/slots/M/clip'. Indices are 0-based. A name selector works anywhere a number does, e.g. 'tracks/name:Drift' " +
  '(exact match; several matches is an error that lists their indices).';

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'get_properties',
    description:
      'Read properties of a Song, Track, Scene, ClipSlot or Clip. ' + ADDRESS_HELP +
      ' Give `names` for specific properties, or omit it to read every readable property (properties that do not apply to the ' +
      'object, e.g. audio-only ones on a MIDI clip, are listed under `unavailable`). Enum values come back as names. ' +
      'Use list_properties to see what exists.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: "Object address, e.g. 'tracks/0/slots/1/clip'" },
        names: { type: 'array', items: { type: 'string' }, description: 'Property names to read (default: all)' }
      },
      required: ['address']
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    bridge: { command: 'get_properties' }
  },
  {
    name: 'set_properties',
    description:
      'Set properties on a Song, Track, Scene, ClipSlot or Clip. ' + ADDRESS_HELP +
      ' Values are checked strictly (booleans must be true/false, integers whole numbers, enums given by name; see list_properties). ' +
      'Interdependent properties (e.g. loop_start/loop_end) can be set together in any order, and the call is all-or-nothing: if one ' +
      'write fails, the others are restored. Returns each property\'s previous and new value. Each call is one undo step in Live. ' +
      'Give `address` + `properties`, or `items` to change several objects in one call. `expect` ({name}) refuses to write if the object is not the one you meant.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Object address' },
        properties: { type: 'object', description: "Property values, e.g. {\"mute\": true, \"volume\": 0.7}" },
        expect: { type: 'object', description: "Guard: {\"name\": \"Drift\"} (optionally class_name) must match the object, or nothing is written" },
        items: {
          type: 'array',
          description: 'Several objects at once: [{address, properties, expect?}]',
          items: {
            type: 'object',
            properties: { address: { type: 'string' }, properties: { type: 'object' }, expect: { type: 'object' } },
            required: ['address', 'properties']
          }
        }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    bridge: { command: 'set_properties' }
  },
  {
    name: 'get_capabilities',
    description:
      "What this Live and this bridge can do: script version and build id, Live version and variant, unavailable features, and feature probes " +
      "(Max for Live present, Conversions, note probabilities, Suite devices such as Meld/Roar). A beta build reports variant 'Beta' and " +
      "edition 'unknown' because the edition is not readable: rely on `features`, never on the edition. Also lists every bridge command.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    bridge: { command: 'get_capabilities' }
  },
  {
    name: 'describe_set',
    description:
      "A compact map of the whole Set: song settings, every track (regular, return, master) with its address, kind, mixer state, devices and " +
      "clips, and every scene. Each track has a `hash` and the Set has a `fingerprint` that only change when the Set really changes " +
      "(playhead, play state and meters are ignored): compare fingerprints to detect edits, or hashes to see which track changed. " +
      "Set include_clips=false for a lighter summary (clip counts and hashes stay).",
    inputSchema: {
      type: 'object',
      properties: { include_clips: { type: 'boolean', description: 'List each track\'s clips (default true)' } }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    bridge: { command: 'describe_set' }
  },
  {
    name: 'transport',
    description:
      "Transport and playhead actions: play, continue, stop, stop_all_clips, tap_tempo, jump_by (needs `amount`: beats, negative jumps back), " +
      "next_cue / prev_cue (jump to a cue point), toggle_cue (add or remove a cue point at the playhead), capture_midi (keep recently played MIDI) and " +
      "capture_and_insert_scene. Returns the resulting transport state. To change tempo or loop settings use set_properties on 'song'. " +
      "For undo/redo use the history tool.",
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['play', 'continue', 'stop', 'stop_all_clips', 'tap_tempo', 'jump_by', 'next_cue', 'prev_cue', 'toggle_cue', 'capture_midi', 'capture_and_insert_scene'],
          description: 'What to do'
        },
        amount: { type: 'number', description: 'Beats to jump (jump_by only)' }
      },
      required: ['action']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bridge: { command: 'transport' }
  },
  {
    name: 'history',
    description:
      "Undo or redo in Live. Every writing tool call is one undo step, so `undo` reverts exactly the last call (one exception: Live records a " +
      "track rename as its own step). Undo is global: it also reverts edits the user made by hand, so use it deliberately. `steps` (1-50, default 1) " +
      "repeats it; returns the names of what was undone and whether more undo/redo is available.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['undo', 'redo'], description: 'Direction' },
        steps: { type: 'number', description: 'How many steps (1-50, default 1)' }
      },
      required: ['action']
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    bridge: { command: 'history' }
  },
  {
    name: 'create',
    description:
      "Create a track, return track or scene and get back its address. kind: audio_track, midi_track, return_track (always appended) or scene. " +
      "`index` is the insertion position (0-based; omit or -1 to append; existing objects shift, so re-read addresses afterwards). " +
      "Optional `name` and `color` (RGB integer; Live snaps it to the nearest palette colour and the result reports the colour it applied) are applied immediately. One undo step.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['audio_track', 'midi_track', 'return_track', 'scene'], description: 'What to create' },
        index: { type: 'number', description: 'Insertion position, -1 (default) appends' },
        name: { type: 'string', description: 'Name to give it' },
        color: { type: 'number', description: 'RGB color integer' }
      },
      required: ['kind']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bridge: { command: 'create' }
  },
  {
    name: 'duplicate',
    description:
      "Duplicate a regular track ('tracks/N', with its devices and clips), a scene ('scenes/N') or a clip slot ('tracks/N/slots/M', with its clip). " +
      "The copy lands right after the source (a duplicated slot goes into the next scene); returns the new address. Return tracks and the master cannot be duplicated.",
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: "What to duplicate, e.g. 'tracks/3', 'scenes/name:Verse', 'tracks/0/slots/2'" } },
      required: ['address']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bridge: { command: 'duplicate' }
  },
  {
    name: 'delete',
    description:
      "Delete a track ('tracks/N'), return track ('returns/N'), scene ('scenes/N') or clip ('tracks/N/slots/M/clip'). DESTRUCTIVE (one undo step brings it back). " +
      "`expect` is mandatory: {\"name\": <the object's current name>}. Indices shift after every create/delete, so read the object first; if its name no longer matches, " +
      "nothing is deleted (GUARD_FAILED). The master track cannot be deleted, and a Set always keeps at least one scene.",
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'What to delete' },
        expect: {
          type: 'object',
          description: 'Guard: the object must still have this name (class_name optional)',
          properties: { name: { type: 'string' }, class_name: { type: 'string' } },
          required: ['name']
        }
      },
      required: ['address', 'expect']
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    bridge: { command: 'delete' }
  },
  {
    name: 'list_properties',
    description:
      'List the properties get_properties/set_properties know for an object kind: type, whether it is writable, allowed enum values ' +
      'and ranges. Give an `address` (its kind is used) or a `kind`: song, track, scene, slot or clip.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Object address; its kind is listed' },
        kind: { type: 'string', enum: ['song', 'track', 'scene', 'slot', 'clip'], description: 'Object kind (when no address is given)' }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    bridge: { command: 'list_properties' }
  }
];

export const TOOL_SPEC_BY_NAME: Record<string, ToolSpec> = Object.fromEntries(TOOL_SPECS.map((s) => [s.name, s]));
