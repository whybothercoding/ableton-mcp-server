import { AUDIO_SPECS } from './audio.js';
import { BATCH_SPECS } from './batch.js';
import { BROWSE_SPECS } from './browse.js';
import { COMPOSITION_SPECS } from './composition.js';

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

/** What a composed tool needs from the bridge: send one command, get its result (AbletonClient satisfies this). */
export interface BridgeClient {
  sendCommand<T = any>(type: string, params?: Record<string, any>): Promise<T>;
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
  /** More commands a composed tool uses (checked like bridge.command). */
  requires?: string[];
  /** Tools that combine several bridge calls (or run code of their own) provide this instead of a single pass-through call. */
  run?: (args: Record<string, any>, client: BridgeClient, specs: Record<string, ToolSpec>) => Promise<unknown>;
}

export { validateArgs, BATCH_REFERENCE } from './schema.js';

const ADDRESS_HELP =
  "Addresses: 'song', 'master', 'tracks/N', 'returns/N', 'scenes/N', 'tracks/N/slots/M' (clip slot) and " +
  "'tracks/N/slots/M/clip', 'tracks/N/arrangement/M' (arrangement clips in time order), 'tracks/N/take_lanes/K', 'tracks/N/devices/M' (also returns/N and master; then '/parameters/P', '/sample' for a Simpler, '/chains/C/devices/...', '/drum_pads/NOTE', '/mixer/volume'), 'grooves/N' (groove pool), 'cue_points/N' and 'app' (the Live application). Indices are 0-based. A name selector works anywhere a number does, e.g. 'tracks/name:Drift' " +
  '(exact match; several matches is an error that lists their indices).';

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'get_properties',
    description:
      'Read properties of the Song, a Track, Scene, ClipSlot, Clip, Groove, cue point, the app, or a device, rack chain, drum pad or device parameter. ' + ADDRESS_HELP +
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
      'Set properties on the Song, a Track, Scene, ClipSlot, Clip, Groove, cue point, device, rack chain, drum pad or device PARAMETER (property `value`, checked against the parameter\'s own range). A clip\'s `groove` is set to a groove address (grooves/N). ' + ADDRESS_HELP +
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
      "The hashes cover note edits (each MIDI clip lists a `notes_hash`), clip launch/loop/warp/gain/pitch/groove settings, sends, routing, " +
      "crossfader, stop buttons and the launch quantization, but not device parameter values. " +
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
      "next_cue / prev_cue (jump to a cue point), toggle_cue (add or remove a cue point at the playhead while playing, or at the arrangement insert marker while stopped, which only the user controls), capture_midi (keep recently played MIDI) and " +
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
      "Undo or redo in Live. Every writing tool call is one undo step, so `undo` reverts exactly the last call (exceptions: Live records a " +
      "track rename and every device parameter write as their own entries, so a call or batch that writes several parameters takes that many extra undos). Undo is global: it also reverts edits the user made by hand, so use it deliberately. `steps` (1-50, default 1) " +
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
      "Create a track, return track, scene, MIDI clip, audio clip, arrangement clip or take lane and get back its address. kind: audio_track, midi_track, return_track (always appended), scene, audio_clip (`address` of an EMPTY slot on an audio track and `path`: an absolute path to an audio file; it is auto-warped by Live's settings and the result reports its length), " +
      "arrangement_midi_clip (`address` of a track or take lane, `time` in beats on the timeline, `length` default 4) and arrangement_audio_clip (`address`, `time`, `path`), take_lane (`address` of a track), midi_clip " +
      "(`address` of an EMPTY clip slot like 'tracks/2/slots/0', `length` in beats, default 4). Cue points cannot be created (Live only toggles them at the arrangement insert marker, which is UI state). For tracks and scenes `index` is the insertion position (0-based; omit or -1 to append; existing objects shift, so re-read addresses afterwards). " +
      "Optional `name` and `color` (RGB integer; Live snaps it to the nearest palette colour and the result reports the colour it applied) are applied immediately. One undo step.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['audio_track', 'midi_track', 'return_track', 'scene', 'midi_clip', 'audio_clip', 'arrangement_midi_clip', 'arrangement_audio_clip', 'take_lane'], description: 'What to create' },
        index: { type: 'number', description: 'Insertion position, -1 (default) appends' },
        address: { type: 'string', description: "midi_clip, audio_clip: the empty clip slot to fill, e.g. 'tracks/2/slots/0'" },
        path: { type: 'string', description: 'audio_clip: absolute path of the audio file' },
        length: { type: 'number', description: 'midi_clip: length in beats (default 4)' },
        time: { type: 'number', description: 'arrangement clips: position in beats' },
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
      "Delete a track ('tracks/N'), return track ('returns/N'), scene ('scenes/N'), clip ('tracks/N/slots/M/clip' or an arrangement clip 'tracks/N/arrangement/M'); cue points cannot be deleted (Live only toggles them at the arrangement insert marker). DESTRUCTIVE (one undo step brings it back). " +
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
      "stop stops it), a scene ('scenes/N': fire only) , a track ('tracks/N': stop all its clips), a cue point ('cue_points/N': jump there) or 'song' (stop all clips, transport keeps running). " +
      "Options for a slot: `quantization` overrides the launch quantization for this launch (q_no_q, q_bar, q_half...), `legato` starts the clip in sync with the one playing, " +
      "`record_length` (beats, empty slot only) starts a recording that ends by itself. Scenes take `legato` and `select` (false keeps the selection where it is). " +
      "Stops take `quantized` (default true; false stops immediately). Launching does not change the Set's content. Arrangement clips cannot be launched (use transport).",
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
      "quantize_pitch (like quantize for one `pitch`, 0-127; MIDI only), scrub (`position` in beats) / stop_scrub, move_playing_pos (`amount` beats, negative goes back; clip must be playing), and on AUDIO clips add_warp_marker (`beat_time`; `sample_time` = seconds in the file, default: where it changes nothing), " +
      "move_warp_marker (`beat_time` of an existing marker, `distance` in beats: this is how audio is retimed) and remove_warp_marker (`beat_time`); current markers are the clip's `warp_markers` property. " +
      "to_arrangement copies a SESSION clip onto its track's arrangement timeline at `time` (beats) and returns the new clip's address; a clip that carries automation envelopes turns them into arrangement track automation (the envelopes do not stay on the copy; the result lists the parameters now automated), which is how arrangement automation is written: draw_automation on the Session clip first. " +
      "`address` must be a clip. crop and quantize rewrite content: one undo step each, and `expect` ({name}) refuses to act on the wrong clip. Returns the clip's length and loop after the action.",
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: "A clip, e.g. 'tracks/2/slots/0/clip'" },
        action: { type: 'string', enum: ['crop', 'duplicate_loop', 'quantize', 'quantize_pitch', 'scrub', 'stop_scrub', 'move_playing_pos', 'add_warp_marker', 'move_warp_marker', 'remove_warp_marker', 'to_arrangement'], description: 'What to do' },
        time: { type: 'number', description: 'to_arrangement: destination position in beats on the arrangement' },
        beat_time: { type: 'number', description: 'Warp marker actions: the marker position in beats' },
        distance: { type: 'number', description: 'move_warp_marker: beats to move by' },
        sample_time: { type: 'number', description: 'add_warp_marker: position in the file in seconds' },
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
    name: 'get_device',
    description:
      "Read a device with all its parameters (`index`, `address`, `value`, `min`, `max`, `display` as Live shows it, `default`, `value_items` labels for quantized ones, `is_enabled`) and, for racks, its chains, return chains, occupied drum pads " +
      "(each with the addresses of the devices it holds) and macro state. `address`: 'tracks/2/devices/0', 'returns/0/devices/1', 'master/devices/0' or nested 'tracks/2/devices/0/chains/1/devices/2' (a name selector works too: 'tracks/2/devices/name:EQ Eight'). " +
      "Device names per track are in describe_set. Change a parameter with set_properties on its address ('.../parameters/5' or '.../parameters/name:Frequency', field `value`; a quantized parameter also takes its label such as 'Low-pass'); " +
      "many at once with `items`. Devices also have properties (name, `on`, `collapsed`) and racks chains, pads and mixers have theirs: see list_properties. " +
      "Simpler, Wavetable, Drift, Meld, Eq Eight, Looper, Hybrid Reverb, Roar, Spectral Resonator, Shifter, Drum Cell and plug-ins also have their own properties and methods: the result's `specific` block lists them (choices such as a wavetable or voice mode are properties that take the label the device shows; `..._options` lists the labels), and a Simpler's sample is at '<device>/sample'.",
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: "A device, e.g. 'tracks/2/devices/0'" } },
      required: ['address']
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    bridge: { command: 'get_device' }
  },
  {
    name: 'device_action',
    description:
      "Change device structure. `action`: insert (`address` of a track, return track, master or rack chain; `name` as in Live's browser, e.g. 'EQ Eight', 'Drum Rack', 'Audio Effect Rack'; optional `position`, default end; Live refuses bad placements " +
      "such as effects before an instrument and says why), delete (`address` of a device; `expect` {name} mandatory), duplicate (a device; the copy goes right after it), move (`address` of a device, `to` a track or chain, optional `position`; returns where it landed), " +
      "save_ab (store the current preset in the A/B compare slot), and for racks: insert_chain (optional `position`), add_macro, remove_macro, randomize_macros, store_variation, recall_variation (`index` selects the variation first; else the selected one; `which` last = the last recalled), delete_variation (`index` or the selected one; Live does nothing when none is selected, so this refuses), " +
      "re_enable_automation (`address` of a parameter whose playing clip automation was overridden, by hand or by any write through this bridge such as set_properties or ramp_parameter, or 'song' for all: hands it back to the automation), " +
      "call (`address` of a device or of a Simpler's '.../sample': `method` and `args` object, one of the methods get_device lists for it: crop, reverse, warp_as, replace_sample on a Simpler; insert_slice, move_slice, remove_slice on its sample; record, overdub, stop, clear, export_to_clip_slot on a Looper; set_modulation_value on a Wavetable), copy_pad (Drum Rack: `from_note` and `to_note`), clear_pad (`address` of a drum pad, e.g. 'tracks/1/devices/0/drum_pads/36'; `expect` {name} mandatory). Returns the new address where one is created. One undo step. DESTRUCTIVE for delete, clear_pad, remove_macro, delete_variation.",
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Track/chain (insert), device (delete, duplicate, move, save_ab, rack actions) or drum pad (clear_pad)' },
        action: {
          type: 'string',
          enum: ['insert', 'delete', 'duplicate', 'move', 'save_ab', 'insert_chain', 'add_macro', 'remove_macro', 'randomize_macros', 'store_variation', 'recall_variation', 'delete_variation', 'copy_pad', 'clear_pad', 're_enable_automation', 'call'],
          description: 'What to do'
        },
        name: { type: 'string', description: 'insert: device name' },
        position: { type: 'number', description: 'insert, move, insert_chain: index, -1 or omitted = end' },
        to: { type: 'string', description: 'move: the track or chain to move the device into' },
        which: { type: 'string', enum: ['selected', 'last'], description: 'recall_variation: default selected' },
        index: { type: 'number', description: 'recall_variation, delete_variation: variation to select first (0-based)' },
        from_note: { type: 'number', description: 'copy_pad: source pad note' },
        to_note: { type: 'number', description: 'copy_pad: destination pad note' },
        method: { type: 'string', description: 'call: the method name' },
        args: { type: 'object', description: 'call: the method arguments by name' },
        expect: { type: 'object', description: 'Guard for delete and clear_pad: {"name": "..."} must match' }
      },
      required: ['address', 'action']
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    bridge: { command: 'device_action' }
  },
  {
    name: 'routing',
    description:
      "Read or change a track's (or a side-chain device's) input or output routing by the display names the mixer shows. `address`: 'tracks/N', 'returns/N', 'master' or a device with a side-chain such as a Compressor ('tracks/2/devices/1', input). " +
      "`direction`: input or output. `action` get (default) returns the current `type` and `channel` and everything `available_types` / `available_channels` (category: external, resampling, master, track, parent_group_track, none...). " +
      "set takes `type` and/or `channel` (exact display names; channels depend on the type, so set both in one call); Live only offers valid choices. " +
      "Feedback guard: routing a track's INPUT from the master or from resampling while its monitoring is not Off can loop the sound back at full level, so it refuses unless `allow_feedback: true` (or monitoring is set to OFF first with set_properties current_monitoring_state). One undo step.",
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: "A track, return track, 'master', or a device with a side-chain" },
        direction: { type: 'string', enum: ['input', 'output'], description: 'Which end' },
        action: { type: 'string', enum: ['get', 'set'], description: 'Default get' },
        type: { type: 'string', description: "set: routing type display name, e.g. 'Ext. In', 'Master', 'Resampling', a track name" },
        channel: { type: 'string', description: "set: channel display name, e.g. '1/2'" },
        allow_feedback: { type: 'boolean', description: 'set: allow input routings that can feed back (default false)' }
      },
      required: ['address', 'direction']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    bridge: { command: 'routing' }
  },
  {
    name: 'draw_automation',
    description:
      "Draw a clip automation envelope for a device or mixer parameter, inside Live (tempo-locked, sample-accurate). `clip`: a Session clip address ('tracks/2/slots/0/clip'); `parameter`: a parameter address on that clip's track " +
      "('tracks/2/devices/0/parameters/5', 'tracks/2/mixer/volume', 'tracks/2/mixer/sends/0'). `points`: [{time, value, curve?}] with time in beats from clip start and value in the parameter's own units (get_device shows min/max). " +
      "The default `style` 'breakpoints' writes real envelope breakpoints (straight lines between them; smooth/ease curves get a breakpoint every `resolution` beats, default 0.25; step curves make jumps), so it is editable in Live and light. " +
      "'steps' writes a staircase of fine steps instead (`resolution` default 0.125). `curve`: linear (default), step, smooth, ease_in, ease_out (a point's own curve shapes the segment after it). " +
      "`mode` replace (default) rebuilds the parameter's envelope, merge rewrites only the drawn range (breakpoints outside connect to it by straight lines). With `hold` (default true) the clip edges are filled with the first/last value. " +
      "The result includes a readback of Live's stored values. Arrangement clips have no envelopes in Live's API. One undo step per call.",
    inputSchema: {
      type: 'object',
      properties: {
        clip: { type: 'string', description: "Session clip address, e.g. 'tracks/2/slots/0/clip'" },
        parameter: { type: 'string', description: "Parameter address, e.g. 'tracks/2/devices/0/parameters/5' or 'tracks/2/mixer/volume'" },
        points: {
          type: 'array',
          description: 'Breakpoints, e.g. [{"time":0,"value":0.2},{"time":8,"value":0.9}]',
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
        curve: { type: 'string', enum: ['linear', 'step', 'smooth', 'ease_in', 'ease_out'], description: "Default curve between points (default 'linear')" },
        style: { type: 'string', enum: ['breakpoints', 'steps'], description: "Default 'breakpoints'" },
        resolution: { type: 'number', description: 'Beats between generated breakpoints (or steps) on curved segments' },
        mode: { type: 'string', enum: ['replace', 'merge'], description: "'replace' (default) or 'merge'" },
        hold: { type: 'boolean', description: 'Fill the clip before the first and after the last point (default true)' }
      },
      required: ['clip', 'parameter', 'points']
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    bridge: { command: 'draw_automation' }
  },
  {
    name: 'get_automation',
    description:
      "Read a Session clip's automation: every envelope on the clip (or only `parameter`'s) as breakpoints in the parameter's own units: {time, value, jump_from?} (`jump_from` marks a step: the value just before it), " +
      "with the parameter's address, name and range. `max_points` caps each envelope (default 500; `truncated` says if more exist). Use it to inspect what a clip already does before drawing over it.",
    inputSchema: {
      type: 'object',
      properties: {
        clip: { type: 'string', description: "Session clip address, e.g. 'tracks/2/slots/0/clip'" },
        parameter: { type: 'string', description: 'Only this parameter' },
        max_points: { type: 'number', description: 'Breakpoints per envelope (default 500)' }
      },
      required: ['clip']
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    bridge: { command: 'get_automation' }
  },
  {
    name: 'clear_automation',
    description:
      "Clear one parameter's envelope on a Session clip (`clip` + `parameter`), or every envelope on the clip when no parameter is given. Returns whether an envelope existed. One undo step.",
    inputSchema: {
      type: 'object',
      properties: {
        clip: { type: 'string', description: "Session clip address, e.g. 'tracks/2/slots/0/clip'" },
        parameter: { type: 'string', description: 'Parameter address; omit to clear all envelopes on the clip' }
      },
      required: ['clip']
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    bridge: { command: 'clear_automation' }
  },
  {
    name: 'ramp_parameter',
    description:
      "Sweep a device or mixer parameter (`parameter` address) to `to` over `beats` or `seconds`, driven inside Live at about 100 updates per second. For live gestures; use draw_automation for motion that belongs to a looping clip. " +
      "`from` defaults to the current value; `curve`: linear, smooth, ease_in, ease_out. A new ramp on the same parameter replaces the old one. Values are in the parameter's own units. Ramps are not undoable and cannot run inside a batch.",
    inputSchema: {
      type: 'object',
      properties: {
        parameter: { type: 'string', description: "Parameter address, e.g. 'tracks/2/devices/0/parameters/5' or 'tracks/2/mixer/volume'" },
        to: { type: 'number', description: 'Target value' },
        from: { type: 'number', description: 'Start value (default: current)' },
        beats: { type: 'number', description: 'Duration in beats (give beats or seconds)' },
        seconds: { type: 'number', description: 'Duration in seconds (0.01 to 3600)' },
        curve: { type: 'string', enum: ['linear', 'smooth', 'ease_in', 'ease_out'], description: 'Default linear' }
      },
      required: ['parameter', 'to']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bridge: { command: 'ramp_parameter' }
  },
  {
    name: 'cancel_ramps',
    description: 'Cancel the ramp on one `parameter`, or every active ramp when no parameter is given. The parameter stays wherever the ramp had taken it.',
    inputSchema: { type: 'object', properties: { parameter: { type: 'string', description: 'Parameter address; omit to cancel all' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    bridge: { command: 'cancel_ramps' }
  },
  {
    name: 'record',
    description:
      "GATED (set ABLETON_MCP_ALLOW_RECORD=1 in the MCP server's environment and create ~/.ableton-mcp-server/allow_record; responses show the flags just set, Live applies them a moment later; while arrangement recording runs Live ALSO records playing Session clips onto their own tracks, armed or not, so stop them first; session_start begins at the next launch-quantization boundary, into the selected scene's slot): recording can overwrite what is on the timeline or in clip slots. `action`: status (default; state of recording and armed tracks), " +
      "arrangement_start (needs an armed track; optional `from_time` beats, `play` default true), arrangement_stop (`stop_transport` optional), session_start (records into the armed tracks' next free slots; optional `record_length` beats), " +
      "session_stop, overdub (`enabled`), punch (`punch_in`/`punch_out`) and automation (`enabled`: automation recording). Starting refuses when nothing is armed or recording is already on. Arm tracks with set_properties `arm`. " +
      "Recorded clips are ordinary clips afterwards. Not undoable step by step and not batchable.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'arrangement_start', 'arrangement_stop', 'session_start', 'session_stop', 'overdub', 'punch', 'automation'], description: 'Default status' },
        from_time: { type: 'number', description: 'arrangement_start: playhead position in beats' },
        play: { type: 'boolean', description: 'arrangement_start: also start playback (default true). Live starts the transport anyway once recording is on' },
        stop_transport: { type: 'boolean', description: 'arrangement_stop: stop playback too' },
        record_length: { type: 'number', description: 'session_start: beats to record' },
        enabled: { type: 'boolean', description: 'overdub, automation' },
        punch_in: { type: 'boolean', description: 'punch' },
        punch_out: { type: 'boolean', description: 'punch' }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    bridge: { command: 'record' }
  },
  {
    name: 'follow_actions',
    description:
      "Clip follow actions, which Live's API does not have, emulated inside Live on the Remote Script's 10 ms timer. `set` (`address` of a Session clip; `actions`: names or {action, weight} objects, chosen by weight each pass: " +
      "next, previous, first, last, any, other, again, stop, all relative to the clip's own track; `after_bars` or `after_beats`, default one pass through the clip) launches the chosen clip when the clip has played that long. " +
      "It only acts while the transport runs and the clip plays, once per pass, and launches through Live's normal clip launch, so Live's launch quantization decides the exact moment (the trigger fires ~40 ms early to catch the grid point; use q_none or a matching quantization for tight timing). " +
      "`clear` (an `address`, or everything) stops them at once; `status` lists them. Configurations live in memory only: they are lost when Live restarts or the script reloads. Not undoable, not batchable.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'clear', 'status'], description: 'Default status' },
        address: { type: 'string', description: "set/clear: a Session clip, e.g. 'tracks/2/slots/0/clip'" },
        actions: {
          type: 'array',
          description: "set: e.g. ['next'] or [{action:'next',weight:3},{action:'again',weight:1}]",
          items: { type: 'object', properties: { action: { type: 'string', enum: ['next', 'previous', 'first', 'last', 'any', 'other', 'again', 'stop'] }, weight: { type: 'number' } } }
        },
        after_bars: { type: 'number', description: "set: bars of the clip's time signature before the action" },
        after_beats: { type: 'number', description: 'set: beats before the action (min 0.25)' }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bridge: { command: 'follow_actions' }
  },
  {
    name: 'list_properties',
    description:
      'List the properties get_properties/set_properties know for an object kind: type, whether it is writable, allowed enum values ' +
      'and ranges. Give an `address` (its kind is used) or a `kind`: song, track, scene, slot, clip, lane, groove, cue, app, device, chain, pad, parameter or sample. With an address of a device or sample the listing includes its device-specific properties (choices show their labels) and methods.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Object address; its kind is listed' },
        kind: { type: 'string', enum: ['song', 'track', 'scene', 'slot', 'clip', 'lane', 'groove', 'cue', 'app', 'device', 'chain', 'pad', 'parameter', 'sample'], description: 'Object kind (when no address is given)' }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    bridge: { command: 'list_properties' }
  },
  ...COMPOSITION_SPECS
];

TOOL_SPECS.push(...BATCH_SPECS, ...BROWSE_SPECS, ...AUDIO_SPECS);

export const TOOL_SPEC_BY_NAME: Record<string, ToolSpec> = Object.fromEntries(TOOL_SPECS.map((s) => [s.name, s]));
