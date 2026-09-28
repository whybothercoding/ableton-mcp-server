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
- **Remote Script**: A Python Control Surface script running inside Ableton Live's Python environment that handles commands and thread-safe main-thread scheduling.
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

Live loads Remote Scripts from a `Remote Scripts` folder inside your **User Library**. The User Library location is configurable, so look up yours first:

1. In Live, open **Preferences → Library**.
2. Note the **User Library** location shown there. (It can be the default location or a custom one, e.g. on an external drive.)
3. Inside that folder, create `Remote Scripts/AbletonMCP/` if it doesn't exist.
4. Copy `remote-script/__init__.py` from this repo into it.

The result must look like this. The file has to be named `__init__.py` and sit directly inside `AbletonMCP/`:

```
<your User Library>/
└── Remote Scripts/
    └── AbletonMCP/
        └── __init__.py
```

Shell equivalent, with `USER_LIBRARY` set to the path from step 2:

```bash
mkdir -p "$USER_LIBRARY/Remote Scripts/AbletonMCP"
cp remote-script/__init__.py "$USER_LIBRARY/Remote Scripts/AbletonMCP/"
```

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

#### Development
- `eval_python`: Evaluate raw Python on the Remote Script instance. Executes arbitrary code inside Live; intended for development and debugging only.

---

## Troubleshooting

### Audio Analysis Requirements
- Install `ffmpeg` and `ffprobe` on the machine running the MCP server. Set `FFMPEG_PATH` and `FFPROBE_PATH` if they are not on `PATH`.
- The MCP host must be able to read the same source-file path reported by Ableton Live. Analysis reads the first 60 seconds for signal statistics and frequency bands; integrated loudness is measured across the full file.
- Not decodable by ffmpeg, so these return an "unsupported source" error: Ableton-compressed `.aif` files (Live pack samples, AIFF-C codec `able`) and REX files (`.rx2`). Analyze a WAV or uncompressed AIFF instead.
- Audio analysis is local DSP and file metadata only. It does not provide AI instrument recognition, transcription, key detection, or tempo estimation.

1. **AbletonMCP is not listed under Control Surface**:
   - Live only reads the User Library configured in **Preferences → Library**. Confirm the script is in *that* library's `Remote Scripts/AbletonMCP/__init__.py`, not a different one.
   - Confirm the User Library drive is mounted, then restart Live.
   - Check `Log.txt` (in Live's preferences folder) for `RemoteScriptError` entries mentioning AbletonMCP.

2. **Connection Refused (`127.0.0.1:9877`)**:
   - Ensure Ableton Live is open and `AbletonMCP` is selected as an active **Control Surface** in Live Preferences.
   - Check if port 9877 is blocked by firewall or in use by another application.

3. **Unsupported Capability Errors**:
   - The MCP server queries `get_script_info` on startup. If a tool requires a Remote Script command that is missing, it returns a clear unsupported-capability error. Copy the current `remote-script/__init__.py` into your User Library's `Remote Scripts/AbletonMCP/` and restart Live.

4. **Group Track Errors**:
   - Group tracks and Master/Return tracks do not have arm buttons. The `AbletonMCP` script handles arm state safely via `can_be_armed` checks.

---

## How to Add a New Live-Side Command

To add a new capability to the server:

1. **Add Python Handler in `remote-script/__init__.py`**:
   ```python
   def _my_new_feature(self, param1):
       # Perform Live API call
       return {"result": ...}
   ```

2. **Route Command in `_process_command`**:
   - If reading state, dispatch directly.
   - If mutating state, schedule on the main thread via `main_thread_task`.

3. **Register Capability in `_get_script_info`**:
   Add `"my_new_feature"` string to the `capabilities` list in `_get_script_info()`.

4. **Define Types & Schema**:
   - Add TypeScript type definitions in `src/types/ableton.ts`.
   - Add tool definition in `src/tools/definitions.ts` specifying `requiredCapability: 'my_new_feature'`.

5. **Implement Handler**:
   - Add a case branch in `src/tools/handlers.ts` calling `this.client.sendCommand('my_new_feature', { ... })`.

6. **Rebuild**:
   ```bash
   npm run build
   ```

---

## License

MIT License. See [LICENSE](LICENSE) for details.
