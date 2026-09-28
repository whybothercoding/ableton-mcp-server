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

## Setup Instructions

### 1. Install the Ableton Remote Script

Copy the `remote-script/` directory into your Ableton Live User Library's `Remote Scripts` folder:

**macOS**:
```bash
mkdir -p ~/Music/Ableton/User\ Library/Remote\ Scripts/AbletonMCP
cp remote-script/__init__.py ~/Music/Ableton/User\ Library/Remote\ Scripts/AbletonMCP/__init__.py
```

**Windows**:
```cmd
xcopy remote-script\__init__.py "%USERPROFILE%\Documents\Ableton\User Library\Remote Scripts\AbletonMCP\" /Y
```

### 2. Enable in Ableton Live

1. Open **Ableton Live**.
2. Open **Preferences** (`Cmd + ,` or `Ctrl + ,`).
3. Select the **Link / Tempo / MIDI** tab.
4. Under **Control Surface**, select **AbletonMCP** from the dropdown menu.
5. Set Input and Output to `None`.
6. Live will display a status message: `AbletonMCP: Listening for commands on port 9877`.

### 3. Build & Run the MCP Server

```bash
# Install dependencies
npm install

# Build TypeScript output
npm run build

# Start the stdio MCP server
npm start
```

### 4. Configure in MCP Client

Add the server to your MCP client configuration (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ableton": {
      "command": "node",
      "args": [
        "/path/to/ableton-mcp-server/dist/index.js"
      ],
      "env": {
        "ABLETON_HOST": "127.0.0.1",
        "ABLETON_PORT": "9877"
      }
    }
  }
}
```

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
- `get_device_parameters`: Get parameter list for a device on a track.
- `get_browser_tree`: Explore top-level categories in Live browser.
- `get_browser_items`: Retrieve browser items at a category path.
- `get_bulk_session_structure`: Retrieve session info, scenes, and all tracks with clip summaries in one single round trip.

#### Mutation / Write Tools
- `set_tempo`: Modify BPM.
- `set_track_name`: Rename a track.
- `set_track_mute` / `set_track_solo` / `set_track_arm`: Control track mixer states.
- `create_midi_track`: Insert a new MIDI track.
- `create_clip`: Create a new clip slot clip with specified length and name.
- `set_clip_name`: Rename a clip.
- `edit_clip_notes`: Add or replace MIDI notes in a clip slot (`mode: "add" | "replace"`). Replacing explicitly clears existing notes before inserting the complete new sequence.
- `delete_clip`: Remove a clip slot clip.
- `fire_clip` / `stop_clip`: Transport controls for individual clip slots.
- `fire_scene` / `stop_all_clips`: Session view scene launching.
- `start_playback` / `stop_playback`: Global playback transport controls.
- `set_device_parameter`: Update device parameter values.
- `load_browser_item`: Load instrument/effect by URI onto a track.
- `bulk_edit_clips`: Batch clip creation and renaming in serial order on Live's main thread.
- `bulk_set_device_parameters`: Batch update multiple device parameters in a single round trip.

---

## Troubleshooting

1. **Connection Refused (`127.0.0.1:9877`)**:
   - Ensure Ableton Live is open and `AbletonMCP` is selected as an active **Control Surface** in Live Preferences.
   - Check if port 9877 is blocked by firewall or in use by another application.

2. **Unsupported Capability Errors**:
   - The MCP server queries `get_script_info` on startup. If a tool requires a Remote Script command that is missing, it returns a clear unsupported-capability error. Ensure `remote-script/__init__.py` is updated in your User Library.

3. **Group Track Errors**:
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
