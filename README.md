# Ableton Live MCP Server (`ableton-mcp-server`)

A Node.js/TypeScript stdio Model Context Protocol (MCP) server for controlling and querying Ableton Live via a Python Remote Script TCP bridge.

## Architecture

```
+-------------------+      stdio (MCP)      +--------------------+      TCP (JSON)      +--------------------+
|    MCP Client     | <-------------------> | ableton-mcp-server | <------------------> | Ableton Live       |
| (Claude, AGY, etc)|                       | (Node.js/TS)       |    localhost:9877    | (Remote Script)    |
+-------------------+                       +--------------------+                      +--------------------+
```

- **MCP Transport**: Communicates over `stdio` using `@modelcontextprotocol/sdk`. Diagnostics and operational logs are strictly directed to `stderr` to preserve stdout for JSON-RPC frames.
- **Ableton Bridge**: Keeps Ableton Live access behind a typed `AbletonClient` adapter communicating over localhost TCP port `9877` using framed JSON requests.
- **Remote Script**: A Python Control Surface script running inside Ableton Live's Python environment (**Live 12 or later**). Its socket server is pumped by a `Live.Base.Timer` on Live's main thread, so every command runs on the main thread and answers in about 10 ms (a threaded server answered in 300-600 ms because socket threads only got the GIL when Live called into Python). Commands are registered with a `@command` decorator, which is the single source of truth for dispatch, undo behaviour and the capability list.
- **Capability Discovery**: Queries the running Remote Script's handshake (`get_script_info`) dynamically at startup to verify supported capabilities and script version.

---

## Requirements

- Ableton Live 12 or newer (any edition; some features depend on the edition, see `get_capabilities`)
- Node.js 18+ and npm
- Optional: `ffmpeg` / `ffprobe` for `analyze_audio_clip`

---

## Installation

### 1. Build the MCP server

From the repository root:

```bash
npm install
npm run build
```

### 2. Install the Remote Script into Live

Live loads Remote Scripts from a `Remote Scripts` folder inside your **User Library**, and the User Library location is configurable. The script is a package (a folder of Python files), so the whole folder has to be copied.

**Easiest: `npm run deploy`.** It finds your User Library from Live's own preferences (or from `ABLETON_USER_LIBRARY`), refuses to write anywhere that doesn't look like a User Library, mirrors `remote-script/AbletonMCP/` into `Remote Scripts/AbletonMCP/` (removing stale files) and prints the build id. `npm run deploy -- --dry-run` shows what would change without touching anything, and `npm run deploy -- --check` compares the build running inside Live with your source.

**By hand:** in Live open **Preferences → Library**, note the **User Library** location, then copy the *folder* `remote-script/AbletonMCP` to `<User Library>/Remote Scripts/AbletonMCP`:

```
<your User Library>/
└── Remote Scripts/
    └── AbletonMCP/
        ├── __init__.py      (entry point: create_instance, the AbletonMCP class, build id)
        ├── config.py  clock.py  registry.py  helpers.py  curves.py
        └── server.py  session.py  tracks.py  clips.py  devices.py  automation.py  browser.py
```

A partial copy makes the script fail to import; AbletonMCP then silently disappears from the Control Surface list (the error is in Live's `Log.txt`). The handshake reports a `build_id` (a hash of the sources) so a stale or partial deploy is visible: `get_health`/`get_script_info` show it.

While developing, `npm run hotswap` reloads the deployed package inside the running Live without a restart (dev only: only a real restart proves a clean load).

> **Note:** Live scans for Remote Scripts only at launch. Restart Live after installing or updating the script. If the User Library is on an external drive, make sure it is mounted before launching Live. On macOS, the terminal you copy from may need permission to access removable volumes (System Settings → Privacy & Security → Files and Folders).

### 3. Enable the script in Live

1. Restart Live.
2. Open **Preferences → Link, Tempo & MIDI**.
3. In a **Control Surface** slot, choose **AbletonMCP**.
4. Set **Input** and **Output** to `None`.
5. Live shows: `AbletonMCP: Listening for commands on port 9877`.

### 4. Register the server with your MCP client

Point your client at the built entry point, `dist/index.js` in this repo, using an absolute path for your machine.

**Claude Code** (from the repo root):

```bash
claude mcp add ableton -- node "$(pwd)/dist/index.js"
```

**Claude Desktop / other clients** (JSON config):

```json
{
  "mcpServers": {
    "ableton": {
      "command": "node",
      "args": ["<absolute path to this repo>/dist/index.js"],
      "env": {
        "ABLETON_HOST": "127.0.0.1",
        "ABLETON_PORT": "9877"
      }
    }
  }
}
```

The repo's `.mcp.json` uses a relative path and works for Claude Code sessions started in the repo root.

### 5. Verify

With Live running and the script enabled, call the `get_health` tool. It should report the script version and capability list. Live's `Log.txt` should also contain `(AbletonMCP) AbletonMCP initialized`.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ABLETON_HOST` | `127.0.0.1` | Host of the Remote Script socket |
| `ABLETON_PORT` | `9877` | Port of the Remote Script socket |
| `FFMPEG_PATH` / `FFPROBE_PATH` | on `PATH` | Binaries used by `analyze_audio_clip` |

---

## Capabilities & Compatibility

### Supported Live Versions
- **Live 12 or newer** (developed against 12.4). Live's Python API is undocumented and shifts between versions, so `npm run test:drift` compares the running Live with a committed API dump (see "Live API reference and drift").
- **Group, return and master tracks** are inspected safely: properties that do not apply to a track type are reported as unavailable instead of failing.

### Available MCP Tools

Most tools take an **address** (`song`, `tracks/N`, `tracks/N/slots/M/clip`, `grooves/N`, ...): see "Properties by address". Tools carry MCP risk annotations (read-only, destructive), and every writing call is one undo step.

| Area | Tools |
| --- | --- |
| Discover | `get_health`, `get_capabilities`, `describe_set`, `list_properties`, `get_track_detail`, `get_device`, `get_browser_tree`, `get_browser_items`, `get_audio_clip_path`, `analyze_audio_clip` |
| Read / change any property | `get_properties`, `set_properties` |
| Structure | `create`, `duplicate`, `delete` (needs `expect`) |
| Play | `transport`, `launch`, `history` (undo/redo) |
| Mixing and routing | `routing` (plus `set_properties` on mixer parameters and track properties) |
| Clips and notes | `clip_action`, `get_notes`, `write_notes`, `edit_notes` |
| Many edits at once | `batch` |
| Compose | `generate_notes`, `transform_notes` |
| Devices and sound | `device_action`, `load_browser_item`, `draw_automation`, `get_automation`, `clear_automation`, `ramp_parameter`, `cancel_ramps` (parameters and device properties are written with `set_properties`) |
| Development | `eval_python` (gated) |

Earlier versions had one tool per property or action. These were folded into the verbs above (their bridge commands still exist, only the MCP tools were retired to keep the tool list small):

| Retired tool | Use instead |
| --- | --- |
| `get_session_info`, `get_track_structure`, `get_bulk_session_structure` | `describe_set` (whole Set), `get_properties` on `song` |
| `set_tempo`, `set_track_name`/`color`/`mute`/`solo`/`arm`, `set_clip_name`/`color`, `set_scene_name` | `set_properties` (`tempo`, `name`, `color`, `mute`, `solo`, `arm`, ... on `song`, `tracks/N`, `returns/N`, `master`, clips, scenes) |
| `create_midi_track`, `create_clip` | `create` (`midi_track`, `midi_clip`) |
| `delete_clip` | `delete` (`expect` guard) |
| `fire_clip`, `stop_clip`, `fire_scene`, `stop_all_clips` | `launch` |
| `start_playback`, `stop_playback` | `transport` |
| `get_clip_notes`, `edit_clip_notes` | `get_notes`, `write_notes`, `edit_notes` |
| `bulk_edit_clips` | `batch` (`create` midi_clip + `set_properties` name/color per clip, one undo step) |
| `get_device_parameters` | `get_device` (parameters with addresses, racks with their chains and pads) |
| `set_device_parameter`, `bulk_set_device_parameters` | `set_properties` on a parameter address (`.../parameters/5`), `items` for many at once |

#### Notes on a few tools
- `get_track_detail`: clip slots, arrangement clips and devices of a track. `get_audio_clip_path`: an audio clip's source path and warp metadata. `analyze_audio_clip`: codec/format metadata, integrated LUFS, sample and true peak (dBTP), RMS and an approximate six-band frequency profile of the clip's source file. `get_browser_items`: browser items at a category path, paged with `limit` (default 200) and `offset` (`total` and `truncated` in the result).
- `load_browser_item`: load an instrument, effect or sample onto a track by URI (any URI returned by `get_browser_items`). Samples load into the track's selected clip slot, replacing what is there.

#### Automation & Ramps
Targets are addresses: a Session **clip** (`tracks/2/slots/0/clip`) and a **parameter** (`tracks/2/devices/0/parameters/5`, `tracks/2/mixer/volume`, `.../chains/1/devices/0/parameters/3`, ...).

- `draw_automation`: draws a clip envelope from `{time, value, curve?}` points (beats from clip start, values in the parameter's own units). The default `style: "breakpoints"` writes **real envelope breakpoints**: a linear ramp is two of them, smooth/ease curves get one every `resolution` beats (default 0.25; Live draws straight lines between breakpoints, so it is a smooth curve, not a staircase), and `step` makes true jumps. Envelopes drawn this way are light and stay editable in Live. `style: "steps"` writes the older staircase of fine steps. `mode: "replace"` (default) rebuilds the parameter's envelope; `"merge"` rewrites only the drawn range and pins the old envelope at both edges, so everything outside stays exactly as it was. `hold` (default) fills the clip edges. The result includes a readback of Live's stored values.
- `get_automation`: reads a clip's envelopes (all, or one `parameter`) as breakpoints in the parameter's units with the parameter's address, name and range; a jump is reported as `jump_from`.
- `clear_automation`: one parameter's envelope, or all of them on the clip.
- `ramp_parameter`: sweeps a parameter to a target over `beats` or `seconds`, driven inside Live at about 100 updates per second (Live's timer resolution is 10 ms). For live gestures; use `draw_automation` for motion that belongs to a looping clip. A new ramp on the same parameter replaces the old one however it was addressed. `cancel_ramps`: one parameter, or all. Ramps are not undoable and cannot run inside a batch.
- `device_action` `re_enable_automation` hands a parameter that a manual change overrode (`automation_state` 2) back to its automation, or every parameter when the address is `song`.

Limits from Live's API: envelopes exist only on **Session** clips (not arrangement clips), only for parameters on the clip's own track, and Live ignores the curve (control) coefficients of an envelope event, so curves are approximated by breakpoints. The bridge still accepts the older `track_index`/`clip_index`/`device_index` argument forms.

#### Properties by address
`get_properties`, `set_properties` and `list_properties` read and write about a hundred and fifty properties of the Song, tracks, scenes, clip slots, clips, grooves, cue points and the application through one address grammar instead of one tool per property:

- **Addresses:** `song`, `master`, `tracks/N`, `returns/N`, `scenes/N`, `tracks/N/slots/M` (clip slot), `tracks/N/slots/M/clip` and `grooves/N` (the groove pool), `cue_points/N` (in time order) and `app` (the Live application); indices are 0-based. A name selector works wherever a number does: `tracks/name:Drift`, `scenes/name:Verse` (exact match; several matches is an `AMBIGUOUS` error listing the indices).
- **Strict values:** booleans must be `true`/`false`, integers whole numbers, enums are given **by name** (`"launch_mode": "gate"`; `list_properties` shows the valid names and ranges). Wrong types are `TYPE_ERROR`, out-of-range values `OUT_OF_RANGE`, unknown or read-only properties are refused.
- **Interdependent properties** (`loop_start`/`loop_end`, ...) can be set together in any order, and a call is all-or-nothing: if one write fails, the others are restored.
- **`list_properties`** shows every curated property with its type, range and enum names, plus `not_exposed`: the properties Live's API has on that class that this server does not expose yet (from the generated registry, see "Live API reference and drift").
- **`get_properties` without `names`** reads everything readable; properties that do not apply to that object (audio-only ones on a MIDI clip, `arm` on a return track) are listed under `unavailable`.
- **`set_properties` with `items`** changes several objects in one call. `expect: {"name": "Drift"}` refuses to write if the object is not the one you meant (index drift after deletes).
- Virtual mixer properties on tracks: `volume` and `panning` (device values; volume 0.85 is 0 dB). An unset scene `tempo` or `time_signature_numerator` reads as `-1`.

#### Launching and clip actions
- `launch`: `address` is a clip slot or clip (`fire` starts the clip, or the slot's stop button when it is empty; `stop`), a scene (`fire` only), a track (`stop`: all its clips) or `song` (`stop`: all clips, transport keeps running). Slot options: `quantization` (launch quantization for this launch, e.g. `q_no_q`, `q_bar`), `legato`, and `record_length` (beats; empty slots only, Live refuses it on a slot that holds a clip). Scenes take `legato` and `select`. Stops take `quantized` (default true). Launching never changes the Set's content, but firing a scene also triggers the stop buttons of empty slots, which stops whatever is playing on those tracks.
- `clip_action` (destructive, one undo step): `crop`, `duplicate_loop` (MIDI), `quantize` (`grid` by name, e.g. `rec_q_sixtenth`; `amount` 0-1; aligns warp markers on audio clips), `quantize_pitch` (one `pitch`, MIDI), `scrub`/`stop_scrub`, `move_playing_pos`. `expect: {"name": ...}` refuses to act on the wrong clip. Live's own error messages come through unchanged.
- **Grooves:** `grooves/N` addresses the groove pool (`get_properties`/`set_properties`: name, base grid, timing/quantization/random/velocity amounts, in percent). A clip's `groove` property reads and writes as a groove address. Live reports a groove for every clip (a fresh clip in a one-groove pool reported that groove) and rejects `None`, so an assignment cannot be cleared, grooves are shared objects (changing one changes every clip that uses it), and the API cannot add grooves to the pool.

#### Notes
- `get_notes`: every field Live stores for each note (`id`, `pitch`, `start_time`, `duration` in beats, `velocity` 1-127, `mute`, `probability` 0-1, `velocity_deviation` -127..127, `release_velocity` 0-127), sorted by time then pitch. Filter by range (`from_time`/`time_span`/`from_pitch`/`pitch_span`), `ids` or `selected`; `limit` (default 2000) caps the answer and `truncated` says if more exist. MIDI clips only.
- `write_notes`: additive. Every note is validated before anything is written, so one bad note rejects the whole call (max 5000 notes). Returns the new ids and the clip's real `note_count`: Live never lets notes of one pitch overlap, so a new note shortens an earlier note that runs into it and one at exactly the same start time replaces it.
- `edit_notes` (destructive, one undo step): `modify` (`changes: [{id, ...fields}]` or `ids` + `set`; goes through Live's `apply_note_modifications`, which keeps note ids and per-note events), `remove` (exactly one of `ids`, a range, `all: true`), `replace` (swap the notes in a range, or all, for `notes` in one step; if Live refuses the new notes the old ones are put back), `duplicate` (`ids`, `destination_time`, `transposition`), `duplicate_region`, `select` (`ids`, `all`, `none`). Ids that are not in the clip are refused (`NOT_FOUND`) with nothing changed.

#### Composition: generate_notes and transform_notes
The music logic is pure TypeScript in `src/music` (no Live needed to test it); the two tools read notes, run it, and write the result back in **one undo step**. Times are beats (quarter notes); rates are numbers or strings like `1/16`, `1/8t` (triplet), `1/4d` (dotted); keys are text like `C minor`, `F# dorian`, `Bb major pentatonic`; pitches are numbers or Ableton note names (**C3 = 60**); `seed` makes random choices repeatable. Every call accepts `dry_run` (preview only) and `expect` (clip name guard), and unknown parameters are refused.

- `generate_notes` (`address` of a MIDI clip, `generator`, `params`, `start_time`, `mode`): **euclidean** (evenly spread hits, with layers for several drums), **drum_pattern** (step strings per drum: `x` hit, `X` accent, `o` ghost, `.` rest), **chord_progression** (roman numerals in a key, or chord symbols like `Am7`; voice leading, voicings, block/strum/arp/pulse/offbeat styles, optional bass), **bassline** (follows the chords: root, root+fifth, octaves, walking), **melody** (seeded random walk inside a scale with contour, rests and a tonic resolution), **scale_run**, **random_notes**. `mode` is `add` (default), `replace_span` or `replace_all`. If the music runs past the clip's loop end the result carries a `warning`.
- `transform_notes` (`address`, `transform`, `params`, optional selection by range `from_time`/`time_span`/`from_pitch`/`pitch_span` or by `ids`): **in-place** transforms keep note ids and per-note settings (transpose by semitones or scale degrees, fit_to_scale, invert, reverse, stretch, shift, humanize, swing, quantize, legato, gate, velocity_shape, strum, recombine); **rebuilds** replace the selected range in one atomic step (arpeggiate, chop, trill); **additions** keep the notes and add more (stack, grace_notes, repeat). A transform that would push notes outside 0-127 or before beat 0 refuses and changes nothing.
- The full parameter list of every generator and transform is in the tool descriptions. `npm run test:scenarios` composes, transforms, undoes and cleans up on a scratch track through MCP only.

#### Devices, racks and parameters
Devices, rack chains, drum pads and parameters have addresses under a track (`tracks/N`, `returns/N` or `master`):

- `tracks/3/devices/0` (or `devices/name:EQ Eight`), then `/parameters/5` (or `parameters/name:Frequency`), `/chains/1/devices/2` (racks nest as deep as they go), `/return_chains/0`, `/drum_pads/36` (by MIDI note) and `/drum_pads/36/chains/0/devices/0`. Mixers are parameters too: `tracks/3/mixer/volume`, `mixer/panning`, `mixer/sends/0`, and `chains/1/mixer/volume`.
- `get_device` reads a device with every parameter (`index`, `address`, `value`, `min`, `max`, `display`, `default`, labels for quantized ones) and, for racks, chains, return chains, occupied drum pads and macro state.
- `set_properties` writes a **parameter's `value`**, checked against that parameter's own range (`OUT_OF_RANGE`); a quantized parameter also takes its label (`"value": "Low-pass"`); disabled or macro-mapped parameters refuse (`UNAVAILABLE`); `items` writes many parameters (or anything else) in one call. Devices have `name`, `on` (the Device On switch), `collapsed`, `is_using_compare_preset_b` and rack state; chains have `name`, `color`, `mute`, `solo`, `volume`, `panning`; pads `mute` and `solo` (Live ignores those on an empty pad, and the result shows what Live holds).
- `device_action`: `insert` (`name` as in Live's browser, `position`; Live's own refusals such as "Insert audio effects after instruments" come through), `delete` (needs `expect: {"name"}`), `duplicate`, `move` (to another track or chain; returns where it landed), `save_ab`, and rack actions `insert_chain`, `add_macro`, `remove_macro`, `randomize_macros`, `store_variation`, `recall_variation` and `delete_variation` (by `index`: Live silently does nothing when no variation is selected, so the tool refuses instead), `copy_pad`, `clear_pad` (needs `expect`). Each call is one undo step. A device chain holds one instrument, and Live refuses to duplicate instruments.
- Not in Live's API: deleting a rack chain, loading presets by path (use `load_browser_item`), plugin parameters beyond those Live has configured.

#### Mixing and routing
- **Mixer parameters** are addressable like any parameter: `tracks/N/mixer/volume`, `mixer/panning`, `mixer/sends/M`, `mixer/track_activator`, `mixer/left_split_stereo` and `right_split_stereo`, and on the master `master/mixer/crossfader`, `cue_volume` and `song_tempo`; chains have their own (`.../chains/1/mixer/volume`). Tracks also take `volume` and `panning` directly, plus `crossfade_assign` (`A`, `NONE`, `B`), `panning_mode` (`stereo`, `stereo_split`) and `current_monitoring_state`.
- `routing`: `address` is a track, return track, `master`, or a device with a side-chain (a Compressor); `direction` is `input` or `output`. `get` returns the current `type` and `channel` and every available type and channel by the display names the mixer shows (`Ext. In`, `Main`, `Resampling`, a track's name). `set` takes `type` and/or `channel` by those names; Live only offers valid choices, so it cannot create a routing loop through this call. **Feedback guard:** routing a track's *input* from the master or from resampling while its monitoring is not Off refuses (`GUARD_FAILED`) unless `allow_feedback: true`. Resampling (bounce-in-place substitute): create an audio track, set monitoring Off, route its input to `Resampling` and record (recording is a later stage).
- Track delay and solo/cue mode are not in Live's API.

#### Batches
`batch` runs several tool calls (`ops: [{tool, args}]`, up to 100) as **one round trip and one undo step** on Live's main thread, so `history undo` reverts all of it (see the parameter quirk below) and the user never sees a half-built Set. Later ops can use earlier results: `"$0.address"` is the address op 0 returned (a whole-string reference keeps its type; inside a longer string it is inserted as text; `$1.ids[0]` indexes lists), e.g. create a track, then insert a device into `$0.address`. Arguments are validated in TypeScript before anything is sent (references pass for any type). `on_error: "stop"` (default) leaves ops that already ran applied as one undo step and skips the rest; `"continue"` runs everything. A failure comes back as `BATCH_FAILED` with the outcome of every op. Not batchable: `transport`, `launch`, `history`, `ramp_parameter`, `cancel_ramps` (not undoable edits), `transform_notes`, `generate_notes` (they combine calls themselves) and the older browser tools. A failed batch is reported, not rolled back automatically (Live's undo cannot be tried out from outside without touching the user's own history): use `history undo` deliberately. One Live quirk to know: **device parameter writes are always their own undo entries**, even inside a batch, so a batch that writes k parameter values needs k+1 undos to revert (the same holds for `set_properties` with several parameters in `items`). `history` returns what each undo reverted.

#### Set structure, capabilities, transport and history
- `describe_set`: a compact map of the whole Set (song settings, every track/return/master with address, kind, mixer state, devices and clips, every scene). Each track has a `hash`, and the Set a `fingerprint`, that change only when the Set really changes (playhead, play state and meters are ignored), so a client can detect edits by comparing fingerprints and see which track changed by comparing hashes. `include_clips: false` gives a lighter summary. The live test suite uses the fingerprint as an invariant: it must be identical before and after a run.
- `get_capabilities`: script version and build id, Live version/variant, unavailable features and feature probes (Max for Live, Conversions, note probabilities, Suite devices such as Meld/Roar). A beta build reports variant `Beta` and edition `unknown` (the edition is not readable), so rely on `features`.
- `transport`: `play`, `continue`, `stop`, `stop_all_clips`, `tap_tempo`, `jump_by` (`amount` in beats), `next_cue`/`prev_cue`, `toggle_cue` (adds or removes a cue point at the playhead), `capture_midi`, `capture_and_insert_scene`. Returns the resulting transport state. Change tempo or loop settings with `set_properties` on `song`.
- `history`: `undo`/`redo` (`steps` 1-50). It is flagged destructive because undo is global and also reverts edits made by hand.

#### Creating, duplicating and deleting
- `create`: `kind` is `audio_track`, `midi_track`, `return_track` (always appended), `scene`, `midi_clip` (`address` of an empty clip slot, `length` in beats, default 4) or `cue_point` (`time` in beats; the transport must be stopped, because Live sets cue points at the playhead, which is put back afterwards); optional `index` (0-based insertion position, -1 appends), `name` and `color`. Returns the new object's `address`. Live snaps colours to its palette, so the result reports the colour it actually applied.
- `duplicate`: a regular track (`tracks/N`, with devices and clips), a scene, or a clip slot (`tracks/N/slots/M`); the copy lands right after the source and the new address is returned. Return tracks and the master cannot be duplicated.
- `delete` (destructive): a track, return track, scene or clip. **`expect: {"name": ...}` is mandatory**: indices shift after every create/delete, and a stale index is exactly how the wrong object gets removed, so the call is refused (`GUARD_FAILED`) when the object's current name differs. The master cannot be deleted, and a Set always keeps at least one scene. Each call is one undo step, and `history` `undo` brings a deleted object back.
- Cue points are deleted with `delete` on `cue_points/N` (same guard, transport stopped), renamed with `set_properties`, and jumped to with `launch`. `describe_set` lists them and they are part of its fingerprint.
- Read-only state you can watch: `app` (`average_process_usage`, `peak_process_usage`, open dialogs), Song recording/count-in/Link/tempo-follower flags, track meters, clip slot `playing_status`. Recording and network toggles (`record_mode`, `session_record`, Link) are read-only here on purpose: they belong to the gated record tools.
- Live renumbers default track names when tracks are inserted or removed ("12-Acid..." becomes "13-Acid..."), so re-read addresses after structural changes instead of caching them.

#### Addressing: track types, racks and parameter details
`get_track_detail` and `load_browser_item` still name their target with track numbers instead of addresses (they move when the browser tools are consolidated):

- `track_type`: `"track"` (default), `"return"` (`track_index` counts return tracks) or `"master"` (`track_index` is ignored; pass 0). The master and return tracks can hold devices, so they can be read, loaded onto, set, ramped and mixed like any other. Clip automation is not available on them (they have no clips). Live prefixes return track names with their letter (`A-Reverb`), so write the bare name when renaming.
- `device_path`: reaches devices inside racks. It alternates device and chain selectors and ends on a device index, e.g. `[0, 2, 1]` is device 1 in chain 2 of the rack at device 0. A chain selector is a chain index, `{"pad": 36}` (or `{"pad": 36, "chain": 1}`) for a drum pad, or `{"return": 0}` for a return chain. Use it instead of `device_index`.

`get_device` lists, for each parameter: `index`, `name`, `value`, `min`, `max`, `is_quantized`, `is_enabled`, the `display` string Live shows (`"14.2 kHz"`), a `default` for continuous parameters and `value_items` labels for quantized ones (Filter Type `0` is `"Low-pass"`). For a rack it also lists its `chains`, `return_chains` and occupied `drum_pads`, so you can see what a `device_path` can reach; every entry carries its address.

Not covered: device properties Live keeps outside `parameters` (Wavetable's oscillator wavetable selection, Drift's mod matrix, unison and voice modes), and VST/AU plugin parameters beyond the ones Live has configured.

#### Development
- `introspect_api` (bridge command, no MCP tool): without `module`, returns the running Live's version and the API module list; with `module`, describes every class in it (properties with getter/setter types, method signatures, listeners, enums). It reads class-level descriptors only, so it cannot change the Set. It feeds `npm run dump-api`.
- `eval_python`: Evaluate raw Python on the Remote Script instance. Executes arbitrary code inside Live, so the tool is **hidden and refused unless `ABLETON_MCP_ALLOW_EVAL=1`** is set in the MCP server's environment (this repo's `.mcp.json` sets it for development). Failures come back as errors, not success strings.

---

## Troubleshooting

### Errors, timing and undo
- Every bridge response carries `elapsed_ms` (time spent inside Live). Errors carry a stable `code`: `OUT_OF_RANGE`, `NOT_FOUND`, `INVALID_ARGUMENT`, `TYPE_ERROR`, `LIVE_ERROR` (Live itself refused), `UNKNOWN_COMMAND`, `INVALID_REQUEST`, `INTERNAL_ERROR`. The Node client exposes it as `error.bridgeCode`.
- Every writing command runs in its own undo step, so one `undo` in Live reverts exactly one tool call. (Without explicit steps Live coalesces all API edits into a single giant step.) Read-only and no-op commands add no undo entries. One exception: Live records a **track** rename as its own undo entry even inside a grouped call, so undoing a `set_properties` that renames a track can take two undos (clip and scene renames group normally). Ramps run outside any step and each becomes one undo step of its own.

### Audio Analysis Requirements
- Install `ffmpeg` and `ffprobe` on the machine running the MCP server. Set `FFMPEG_PATH` and `FFPROBE_PATH` if they are not on `PATH`.
- The MCP host must be able to read the same source-file path reported by Ableton Live. Analysis reads the first 60 seconds for signal statistics and frequency bands; integrated loudness is measured across the full file.
- Not decodable by ffmpeg, so these return an "unsupported source" error: Ableton-compressed `.aif` files (Live pack samples, AIFF-C codec `able`) and REX files (`.rx2`). Analyze a WAV or uncompressed AIFF instead.
- Audio analysis is local DSP and file metadata only. It does not provide AI instrument recognition, transcription, key detection, or tempo estimation.

0. **Slow responses (hundreds of milliseconds per call)**: the timer-pumped server answers in about 10 ms. If calls are much slower, the Remote Script in your User Library is probably an older version (the log line `Server started on port 9877 (timer pump, 10 ms)` confirms the new one) or your Live is older than Live 12 (`Live.Base.Timer` is required; the log then says "AbletonMCP requires Live 12 or later"). Run `npm run deploy -- --check`, then `npm run deploy` and restart Live.

1. **AbletonMCP is not listed under Control Surface**:
   - Live only reads the User Library configured in **Preferences → Library**. Confirm the script is in *that* library's `Remote Scripts/AbletonMCP/__init__.py`, not a different one.
   - Confirm the User Library drive is mounted, then restart Live.
   - Check `Log.txt` (in Live's preferences folder) for `RemoteScriptError` entries mentioning AbletonMCP.

2. **Connection Refused (`127.0.0.1:9877`)**:
   - Ensure Ableton Live is open and `AbletonMCP` is selected as an active **Control Surface** in Live Preferences.
   - Check if port 9877 is blocked by firewall or in use by another application.

3. **Unsupported Capability Errors**:
   - The MCP server queries `get_script_info` on startup. If a tool requires a Remote Script command that is missing, it returns a clear unsupported-capability error. Run `npm run deploy` (it copies the whole `remote-script/AbletonMCP` package into your User Library) and restart Live.

4. **Group Track Errors**:
   - Group tracks and Master/Return tracks do not have arm buttons. The `AbletonMCP` script handles arm state safely via `can_be_armed` checks.

---

## Testing

```bash
npm test            # offline: Remote Script logic against a mocked Live API (no Live needed)
npm run test:live   # integration: a running Live with AbletonMCP enabled
npm run test:mcp    # MCP layer: tool schemas, handlers and errors over stdio (needs Live)
npm run test:scenarios  # end-to-end composition scenario through MCP tools only (needs Live)
```

### Live API reference and drift

Live's Python API is undocumented and changes between versions (a beta most of all), so the repo keeps a machine-readable copy and checks it:

```bash
npm run dump-api         # write docs/live-api/<live version>.json from the running Live (243 KB, sorted, diff-friendly)
npm run build-registry   # regenerate remote-script/AbletonMCP/registry_data.json from the newest dump (-- --check to verify)
npm run test:drift       # compare the running Live with the committed dump; exit 1 and list added/removed/changed entries
```

`registry_data.json` ships inside the Remote Script: it records, for the Song, Track, Scene, ClipSlot and Clip classes, the type Live reports for every property's getter and setter, plus the enum tables the property table refers to. The offline tests check the hand-written property table against it (a property must exist, be writable when we say so, and have a compatible type) and generate fakes from it that behave like Boost.Python (a wrong setter type raises), so every writable property gets an automatic set/read-back. After a Live update, run `npm run test:drift`; on drift, review the list, run `dump-api` and `build-registry`, fix any property the offline tests now flag, and commit the new dump.

The live suites use a scratch clip on a MIDI track with a device, restore every parameter they touch, and delete what they create. Run them with the transport playing to include the check that Live's parameter follows a drawn envelope during playback. Audio will briefly change while they run.

---

## How to Add a New Live-Side Command

1. **Implement it in the matching module** under `remote-script/AbletonMCP/` (`session.py`, `tracks.py`, `clips.py`, `devices.py`, `automation.py`, `browser.py`; each is a mixin class on `AbletonMCP`). Write the implementation as a method that raises on failure (`ValueError`, `IndexError`, ...; the dispatcher turns them into coded error responses).
2. **Register a thin adapter with `@command`** in the same class:
   ```python
   @command("my_new_feature", writes=True)          # writes=True: runs in its own undo step; destructive=True flags deletes
   def _cmd_my_new_feature(self, params):
       return self._my_new_feature(params.get("track_index", 0))
   ```
   The registry drives dispatch, undo wrapping and the capability list (no other list to update). Everything runs on Live's main thread, so keep handlers quick: a slow one blocks Live.
3. **Add the MCP tool**: a definition in `src/tools/definitions.ts` (with `requiredCapability: 'my_new_feature'`), a case in `src/tools/handlers.ts` that calls `this.client.sendCommand('my_new_feature', {...})`, and types in `src/types/ableton.ts` if needed.
4. **Test it**: offline (`test/remote_script_test.py`, extend the fakes), live (`test/live-integration.mjs`, with cleanup) and MCP (`test/mcp-tools.mjs`).
5. **Build and deploy**: `npm run build && npm run deploy`, restart Live (or `npm run hotswap` while iterating).

---

## License

MIT License. See [LICENSE](LICENSE) for details.
