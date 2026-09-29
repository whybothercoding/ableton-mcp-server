"""AbletonMCP Remote Script for Ableton Live 12+: a timer-pumped TCP bridge for the MCP server."""
import hashlib
import os

from _Framework.ControlSurface import ControlSurface

from . import clock, config
from .registry import _COMMANDS, BridgeError, _error_code, _error_response, command
from .helpers import _as_index, _is_number, _safe_attr
from .curves import CURVES, MAX_AUTOMATION_STEPS, _EPS, _build_steps, _ease, _normalize_points
from .addressing import AddressingMixin
from .device_addressing import DeviceAddressingMixin
from .properties import PropertiesMixin
from .structure import StructureMixin
from .lifecycle import LifecycleMixin
from .clip_actions import ClipActionsMixin
from .notes import NotesMixin
from .introspect import IntrospectMixin
from .batch import BatchMixin
from .server import ServerMixin
from .session import SessionMixin
from .tracks import TracksMixin
from .clips import ClipsMixin
from .devices import DevicesMixin
from .routing import RoutingMixin
from .device_actions import DeviceActionsMixin
from .automation import AutomationMixin
from .browser import BrowserMixin


def _compute_build_id():
    """Hash of every source and data file, so a stale or partial deploy is visible in the handshake."""
    here = os.path.dirname(os.path.abspath(__file__))
    digest = hashlib.sha1()
    for name in sorted(n for n in os.listdir(here) if n.endswith((".py", ".json"))):
        with open(os.path.join(here, name), "rb") as handle:
            digest.update(name.encode("utf-8") + b"\0" + handle.read() + b"\0")
    return digest.hexdigest()[:12]


BUILD_ID = _compute_build_id()


def create_instance(c_instance):
    """Create and return the AbletonMCP script instance"""
    return AbletonMCP(c_instance)


class AbletonMCP(ServerMixin, BatchMixin, AddressingMixin, DeviceAddressingMixin, PropertiesMixin, StructureMixin, LifecycleMixin, ClipActionsMixin, NotesMixin, IntrospectMixin, SessionMixin, TracksMixin, ClipsMixin, DevicesMixin, DeviceActionsMixin, RoutingMixin, AutomationMixin, BrowserMixin,
                 ControlSurface):
    """AbletonMCP Remote Script for Ableton Live"""

    build_id = BUILD_ID

    def __init__(self, c_instance):
        """Initialize the control surface"""
        ControlSurface.__init__(self, c_instance)
        self.log_message("AbletonMCP Remote Script initializing...")
        
        # Socket server for communication
        self.server = None
        self.running = False
        self._clients = {}
        self._pump_timer = None
        self._ramps = {}
        
        # Cache the song reference for easier access
        self._song = self.song()
        
        # Start the socket server
        self.start_server()
        
        self.log_message("AbletonMCP initialized")
        
        # Show a message in Ableton
        self.show_message("AbletonMCP: Listening for commands on port " + str(config.DEFAULT_PORT))
