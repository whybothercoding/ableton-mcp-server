"""Settings read at call time (tests patch these)."""
import os

SCRIPT_VERSION = "3.0.0"
DEFAULT_PORT = 9877
HOST = "localhost"

# Commands that are powerful enough to need an opt-in made INSIDE Live's machine, not just in the MCP client's environment: any
# local program can talk to the socket. A gate opens when the empty file `allow_<gate>` exists in this folder (checked on every call,
# so it can be switched on and off without restarting Live).
GATE_DIR = os.path.join(os.path.expanduser("~"), ".ableton-mcp-server")

# Live's Base.Timer resolution is 10 ms (a 5 ms request still fires at 100 Hz); this is also the ramp update rate.
PUMP_INTERVAL_MS = 10
MAX_REQUEST_BYTES = 16 * 1024 * 1024
CLIENT_IDLE_SECONDS = 60
