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

- Ableton Live 10, 11 or 12 (any edition; Remote Scripts are supported everywhere)
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

### Supported Live Versions & Python Surface
- **Python Compatibility**: Supports Python 2 (Live 10) and Python 3 (Live 11/12).
- **Group Track Safety**: Safely inspects group tracks (`is_foldable`), folded tracks (`is_grouped`), return tracks, and master tracks without throwing `AttributeError` on arm state.
- **Arrangement & Session Clips**: Exposes both Session View clip slots and Arrangement View clips where available.

### Available MCP Tools

#### Health & Discovery
- `get_health`: Ping Ableton Live Remote Script TCP bridge, report script version, and capability list.

#### Read Tools
- `get_session_info`: Global session metadata (tempo, time signature, track count, master volume/pan).
- `get_track_structure`: Summary of all tracks including group parent/child relationships and mixer state.
- `get_track_detail`: Detailed track breakdown (clip slots, arrangement clips, devices).
- `get_clip_notes`: Read all MIDI notes from a clip slot.
- `get_audio_clip_path`: Get an audio clip's source path and Live-side sample/warp metadata from Session or Arrangement view.
- `analyze_audio_clip`: Analyze the source file for codec/format metadata, integrated LUFS, sample peak, true peak (dBTP), RMS, and an approximate six-band frequency profile.
- `get_device_parameters`: Get parameter list for a device on a track.
- `get_browser_tree`: Explore top-level categories in Live browser.
- `get_browser_items`: Retrieve browser items at a category path. Paged with `limit` (default 200) and `offset`; the result includes `total` and `truncated`.
- `get_bulk_session_structure`: Retrieve session info, scenes, and all tracks with clip summaries in one single round trip.

#### Mutation / Write Tools
- `set_tempo`: Modify BPM.
- `set_track_name` / `set_track_color`: Rename or recolor a track.
- `set_track_mute` / `set_track_solo` / `set_track_arm`: Control track mixer states.
- `create_midi_track`: Insert a new MIDI track.
- `create_clip`: Create a new clip slot clip with specified length and name.
- `set_clip_name` / `set_clip_color`: Rename or recolor a clip.
- `set_scene_name`: Rename a scene.
- `edit_clip_notes`: Add or replace MIDI notes in a clip slot (`mode: "add" | "replace"`). Replacing explicitly clears existing notes before inserting the complete new sequence.
- `delete_clip`: Remove a clip slot clip.
- `fire_clip` / `stop_clip`: Transport controls for individual clip slots.
- `fire_scene` / `stop_all_clips`: Session view scene launching.
- `start_playback` / `stop_playback`: Global playback transport controls.
- `set_device_parameter`: Update device parameter values.
- `load_browser_item`: Load an instrument, effect or sample onto a track by URI (any URI returned by `get_browser_items`). Samples load into the track's selected clip slot, replacing what is there.
- `bulk_edit_clips`: Batch clip creation and renaming in serial order on Live's main thread.
- `bulk_set_device_parameters`: Batch update multiple device parameters in a single round trip.

#### Automation & Ramps
- `draw_automation`: Draw a Session-clip automation envelope for a device or mixer parameter from `{time, value}` points (times in beats from clip start, values in the parameter's own units). Curves: `linear`, `step`, `smooth`, `ease_in`, `ease_out`, per call or per point. Ramps are drawn as fine staircases (`resolution` beats per step) that start exactly on the first value and end exactly on the last. `mode: "replace"` (default) rebuilds the parameter's envelope, `"merge"` rewrites only the drawn range; `hold` (default) fills the clip edges. The result includes a readback of Live's stored values.
- `clear_automation`: Clear one parameter's envelope on a clip, or every envelope when no parameter is given.
- `ramp_parameter`: Sweep a device or mixer parameter to a target over `beats` or `seconds`, driven inside Live at about 100 updates per second (Live's timer resolution is 10 ms). For live gestures; use `draw_automation` for motion that belongs to a looping clip. A new ramp on the same parameter replaces the old one.
- `cancel_ramps`: Cancel one ramp, or all of them.

Targets are `device_index` (or `device_path`) + `parameter_index`, or `mixer_parameter` (`"volume"`, `"pan"`, `"send:N"`), on any `track_type` (see below). Limits from Live's API: automation envelopes exist only on **Session** clips (not arrangement clips), and only for parameters on the clip's own track.

#### Properties by address
`get_properties`, `set_properties` and `list_properties` read and write about a hundred properties of the Song, tracks, scenes, clip slots and clips through one address grammar instead of one tool per property:

- **Addresses:** `song`, `master`, `tracks/N`, `returns/N`, `scenes/N`, `tracks/N/slots/M` (clip slot) and `tracks/N/slots/M/clip`; indices are 0-based. A name selector works wherever a number does: `tracks/name:Drift`, `scenes/name:Verse` (exact match; several matches is an `AMBIGUOUS` error listing the indices).
- **Strict values:** booleans must be `true`/`false`, integers whole numbers, enums are given **by name** (`"launch_mode": "gate"`; `list_properties` shows the valid names and ranges). Wrong types are `TYPE_ERROR`, out-of-range values `OUT_OF_RANGE`, unknown or read-only properties are refused.
- **Interdependent properties** (`loop_start`/`loop_end`, ...) can be set together in any order, and a call is all-or-nothing: if one write fails, the others are restored.
- **`get_properties` without `names`** reads everything readable; properties that do not apply to that object (audio-only ones on a MIDI clip, `arm` on a return track) are listed under `unavailable`.
- **`set_properties` with `items`** changes several objects in one call. `expect: {"name": "Drift"}` refuses to write if the object is not the one you meant (index drift after deletes).
- Virtual mixer properties on tracks: `volume` and `panning` (device values; volume 0.85 is 0 dB). An unset scene `tempo` or `time_signature_numerator` reads as `-1`.

#### Set structure, capabilities, transport and history
- `describe_set`: a compact map of the whole Set (song settings, every track/return/master with address, kind, mixer state, devices and clips, every scene). Each track has a `hash`, and the Set a `fingerprint`, that change only when the Set really changes (playhead, play state and meters are ignored), so a client can detect edits by comparing fingerprints and see which track changed by comparing hashes. `include_clips: false` gives a lighter summary. The live test suite uses the fingerprint as an invariant: it must be identical before and after a run.
- `get_capabilities`: script version and build id, Live version/variant, unavailable features and feature probes (Max for Live, Conversions, note probabilities, Suite devices such as Meld/Roar). A beta build reports variant `Beta` and edition `unknown` (the edition is not readable), so rely on `features`.
- `transport`: `play`, `continue`, `stop`, `stop_all_clips`, `tap_tempo`, `jump_by` (`amount` in beats), `next_cue`/`prev_cue`, `toggle_cue` (adds or removes a cue point at the playhead), `capture_midi`, `capture_and_insert_scene`. Returns the resulting transport state. Change tempo or loop settings with `set_properties` on `song`.
- `history`: `undo`/`redo` (`steps` 1-50). It is flagged destructive because undo is global and also reverts edits made by hand.

#### Addressing: track types, racks and parameter details
Every device-facing tool (`get_track_detail`, `get_device_parameters`, `set_device_parameter`, `bulk_set_device_parameters`, `load_browser_item`, `ramp_parameter`, `cancel_ramps`, and the `set_track_*` tools) takes:

- `track_type`: `"track"` (default), `"return"` (`track_index` counts return tracks) or `"master"` (`track_index` is ignored; pass 0). The master and return tracks can hold devices, so they can be read, loaded onto, set, ramped and mixed like any other. Clip automation is not available on them (they have no clips). Live prefixes return track names with their letter (`A-Reverb`), so write the bare name when renaming.
- `device_path`: reaches devices inside racks. It alternates device and chain selectors and ends on a device index, e.g. `[0, 2, 1]` is device 1 in chain 2 of the rack at device 0. A chain selector is a chain index, `{"pad": 36}` (or `{"pad": 36, "chain": 1}`) for a drum pad, or `{"return": 0}` for a return chain. Use it instead of `device_index`.

`get_device_parameters` lists, for each parameter: `index`, `name`, `value`, `min`, `max`, `is_quantized`, `is_enabled`, the `display` string Live shows (`"14.2 kHz"`), a `default` for continuous parameters and `value_items` labels for quantized ones (Filter Type `0` is `"Low-pass"`). For a rack it also lists its `chains`, `return_chains` and occupied `drum_pads`, so you can see what a `device_path` can reach. `get_bulk_session_structure` now includes the return tracks and the master.

Not covered: device properties Live keeps outside `parameters` (Wavetable's oscillator wavetable selection, Drift's mod matrix, unison and voice modes), and VST/AU plugin parameters beyond the ones Live has configured.

#### Development
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
```

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
