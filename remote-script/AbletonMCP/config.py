"""Settings read at call time (tests patch these)."""

SCRIPT_VERSION = "2.0.0"
DEFAULT_PORT = 9877
HOST = "localhost"

# Live's Base.Timer resolution is 10 ms (a 5 ms request still fires at 100 Hz); this is also the ramp update rate.
PUMP_INTERVAL_MS = 10
MAX_REQUEST_BYTES = 16 * 1024 * 1024
CLIENT_IDLE_SECONDS = 60
