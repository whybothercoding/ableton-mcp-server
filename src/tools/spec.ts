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
  "'tracks/N/slots/M/clip' and 'grooves/N' (groove pool). Indices are 0-based. A name selector works anywhere a number does, e.g. 'tracks/name:Drift' " +
  '(exact match; several matches is an error that lists their indices).';

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'get_properties',
    description:
      'Read properties of a Song, Track, Scene, ClipSlot, Clip or Groove. ' + ADDRESS_HELP +
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
      'Set properties on a Song, Track, Scene, ClipSlot, Clip or Groove. A clip\'s `groove` is set to a groove address (grooves/N). ' + ADDRESS_HELP +
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
      "Create a track, return track, scene or MIDI clip and get back its address. kind: audio_track, midi_track, return_track (always appended), scene, or midi_clip " +
      "(`address` of an EMPTY clip slot like 'tracks/2/slots/0', `length` in beats, default 4). For tracks and scenes `index` is the insertion position (0-based; omit or -1 to append; existing objects shift, so re-read addresses afterwards). " +
      "Optional `name` and `color` (RGB integer; Live snaps it to the nearest palette colour and the result reports the colour it applied) are applied immediately. One undo step.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['audio_track', 'midi_track', 'return_track', 'scene', 'midi_clip'], description: 'What to create' },
        index: { type: 'number', description: 'Insertion position, -1 (default) appends' },
        address: { type: 'string', description: "midi_clip: the empty clip slot to fill, e.g. 'tracks/2/slots/0'" },
        length: { type: 'number', description: 'midi_clip: length in beats (default 4)' },
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
    name: 'launch',
    description:
      "Fire or stop things in the Session view. `address` is a clip slot or clip ('tracks/N/slots/M[/clip]': fire starts the clip, or the slot's stop button when empty; " +
      "stop stops it), a scene ('scenes/N': fire only) , a track ('tracks/N': stop all its clips) or 'song' (stop all clips, transport keeps running). " +
      "Options for a slot: `quantization` overrides the launch quantization for this launch (q_no_q, q_bar, q_half...), `legato` starts the clip in sync with the one playing, " +
      "`record_length` (beats, empty slot only) starts a recording that ends by itself. Scenes take `legato` and `select` (false keeps the selection where it is). " +
      "Stops take `quantized` (default true; false stops immediately). Launching does not change the Set's content.",
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: "Slot, clip, scene, track or 'song'" },
        action: { type: 'string', enum: ['fire', 'stop'], description: 'Default fire' },
        quantization: { type: 'string', description: 'Song.Quantization name for this launch (slots only), e.g. q_bar' },
        legato: { type: 'boolean', description: 'Start in sync with the playing clip (slots and scenes)' },
        record_length: { type: 'number', description: 'Beats to record (empty slots only)' },
        select: { type: 'boolean', description: 'Scenes: whether launching selects the scene (default true)' },
        quantized: { type: 'boolean', description: 'Stops: wait for the launch quantization (default true)' }
      },
      required: ['address']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bridge: { command: 'launch' }
  },
  {
    name: 'clip_action',
    description:
      "Edit a clip in place: crop (discard everything outside the loop), duplicate_loop (loop twice as long, notes and envelopes copied; MIDI only), " +
      "quantize (`grid`: rec_q_quarter, rec_q_eight, rec_q_eight_triplet, rec_q_sixtenth, rec_q_thirtysecond...; `amount` 0-1, default 1; on audio clips it aligns warp markers), " +
      "quantize_pitch (like quantize for one `pitch`, 0-127; MIDI only), scrub (`position` in beats) / stop_scrub, move_playing_pos (`amount` beats, negative goes back; clip must be playing). " +
      "`address` must be a clip. crop and quantize rewrite content: one undo step each, and `expect` ({name}) refuses to act on the wrong clip. Returns the clip's length and loop after the action.",
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: "A clip, e.g. 'tracks/2/slots/0/clip'" },
        action: { type: 'string', enum: ['crop', 'duplicate_loop', 'quantize', 'quantize_pitch', 'scrub', 'stop_scrub', 'move_playing_pos'], description: 'What to do' },
        grid: { type: 'string', description: 'Song.RecordingQuantization name (quantize, quantize_pitch)' },
        amount: { type: 'number', description: 'quantize: 0-1 strength; move_playing_pos: beats' },
        pitch: { type: 'number', description: 'MIDI note number (quantize_pitch)' },
        position: { type: 'number', description: 'Beats from the clip start (scrub)' },
        expect: { type: 'object', description: 'Guard: {"name": "..."} must match the clip' }
      },
      required: ['address', 'action']
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    bridge: { command: 'clip_action' }
  },
  {
    name: 'get_notes',
    description:
      "Read the MIDI notes of a clip (`address`: 'tracks/N/slots/M/clip', MIDI clips only) with every field Live stores: `id` (stable while the note exists; use it with edit_notes), " +
      "pitch, start_time and duration (beats), velocity (1-127), mute, probability (0-1), velocity_deviation (-127..127) and release_velocity (0-127). " +
      "Sorted by start_time then pitch. Without filters it returns all notes (capped by `limit`, default 2000; `truncated` says if more exist). Filter by a range " +
      "(`from_time`/`time_span` in beats, `from_pitch`/`pitch_span`), by `ids`, or with selected: true for the notes selected in Live's editor. Also returns the clip's length and loop.",
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: "A MIDI clip, e.g. 'tracks/2/slots/0/clip'" },
        from_time: { type: 'number', description: 'Range start in beats (notes that start in the range)' },
        time_span: { type: 'number', description: 'Range length in beats' },
        from_pitch: { type: 'number', description: 'Lowest MIDI pitch of the range' },
        pitch_span: { type: 'number', description: 'Number of pitches in the range' },
        ids: { type: 'array', items: { type: 'number' }, description: 'Only these note ids' },
        selected: { type: 'boolean', description: "Only notes selected in Live's editor" },
        limit: { type: 'number', description: 'Maximum notes returned (default 2000)' }
      },
      required: ['address']
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    bridge: { command: 'get_notes' }
  },
  {
    name: 'write_notes',
    description:
      "Add MIDI notes to a clip (additive: existing notes stay). Each note: pitch (0-127), start_time and duration (beats, duration > 0) and optionally velocity (1-127, default 100), " +
      "mute, probability (0-1, default 1), velocity_deviation (-127..127, default 0), release_velocity (0-127, default 64). Every note is validated before anything is written, so a bad note " +
      "rejects the whole call (up to 5000 notes per call). Live never lets notes of one pitch overlap: a new note shortens an earlier note of that pitch that runs into it, and one starting at exactly the same time replaces it, so `note_count` " +
      "in the result can be lower than expected. Returns the new note ids. One undo step. To replace or change existing notes use edit_notes.",
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'A MIDI clip' },
        notes: {
          type: 'array',
          description: 'Notes to add',
          items: {
            type: 'object',
            properties: {
              pitch: { type: 'number' }, start_time: { type: 'number' }, duration: { type: 'number' }, velocity: { type: 'number' },
              mute: { type: 'boolean' }, probability: { type: 'number' }, velocity_deviation: { type: 'number' }, release_velocity: { type: 'number' }
            },
            required: ['pitch', 'start_time', 'duration']
          }
        },
        expect: { type: 'object', description: 'Guard: {"name": "..."} must match the clip' }
      },
      required: ['address', 'notes']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bridge: { command: 'write_notes' }
  },
  {
    name: 'edit_notes',
    description:
      "Change notes that already exist in a MIDI clip. `action`: modify (`changes`: [{id, <fields>}] or `ids` + `set`: {field: value}; keeps note ids and per-note events), " +
      "remove (exactly one of `ids`, a range from_time/time_span/from_pitch/pitch_span, or all: true), replace (swap the notes in a range, or all notes, for `notes` in one step; if Live refuses the new notes the old ones are restored; " +
      "omit `notes` to clear the range), duplicate (`ids`, optional `destination_time` and `transposition` semitones), duplicate_region (`start`, `length`, `destination_time`, optional `pitch` and `transposition`) " +
      "and select (`ids`, all: true or none: true, for the editor's selection). Get ids from get_notes; unknown ids are refused (NOT_FOUND) with nothing changed. `expect` ({name}) guards against the wrong clip. One undo step; DESTRUCTIVE (remove, replace).",
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'A MIDI clip' },
        action: { type: 'string', enum: ['modify', 'remove', 'replace', 'duplicate', 'duplicate_region', 'select'], description: 'What to do' },
        ids: { type: 'array', items: { type: 'number' }, description: 'Note ids (modify with set, remove, duplicate, select)' },
        changes: { type: 'array', description: 'modify: [{id, pitch?, start_time?, duration?, velocity?, mute?, probability?, velocity_deviation?, release_velocity?}]', items: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
        set: { type: 'object', description: 'modify with ids: fields to set on all of them' },
        notes: { type: 'array', description: 'replace: the new notes (same fields as write_notes)', items: { type: 'object' } },
        all: { type: 'boolean', description: 'remove or select every note' },
        none: { type: 'boolean', description: 'select: clear the selection' },
        from_time: { type: 'number', description: 'Range start (remove, replace)' },
        time_span: { type: 'number', description: 'Range length (remove, replace)' },
        from_pitch: { type: 'number', description: 'Lowest pitch (remove, replace)' },
        pitch_span: { type: 'number', description: 'Pitch count (remove, replace)' },
        start: { type: 'number', description: 'duplicate_region: source start in beats' },
        length: { type: 'number', description: 'duplicate_region: source length in beats' },
        destination_time: { type: 'number', description: 'duplicate, duplicate_region: where the copies start' },
        pitch: { type: 'number', description: 'duplicate_region: only this pitch (-1 = all)' },
        transposition: { type: 'number', description: 'duplicate, duplicate_region: semitones' },
        expect: { type: 'object', description: 'Guard: {"name": "..."} must match the clip' }
      },
      required: ['address', 'action']
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    bridge: { command: 'edit_notes' }
  },
  {
    name: 'list_properties',
    description:
      'List the properties get_properties/set_properties know for an object kind: type, whether it is writable, allowed enum values ' +
      'and ranges. Give an `address` (its kind is used) or a `kind`: song, track, scene, slot, clip or groove.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Object address; its kind is listed' },
        kind: { type: 'string', enum: ['song', 'track', 'scene', 'slot', 'clip', 'groove'], description: 'Object kind (when no address is given)' }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    bridge: { command: 'list_properties' }
  }
];

export const TOOL_SPEC_BY_NAME: Record<string, ToolSpec> = Object.fromEntries(TOOL_SPECS.map((s) => [s.name, s]));
