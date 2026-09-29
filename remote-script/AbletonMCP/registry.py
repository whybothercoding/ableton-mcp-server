"""Command registry and the error model."""
import os

from . import config


# Command registry: the single source of truth for dispatch, undo behaviour and the capability list.
_COMMANDS = {}


GATE_REASONS = {
    "eval": "runs any Python code inside Live",
    "record": "can record over the clips and timeline of your Set",
}


def gate_marker(gate):
    """The empty file whose existence opens `gate`."""
    return os.path.join(config.GATE_DIR, "allow_" + gate)


def gate_open(gate):
    return os.path.isfile(gate_marker(gate))


def gates_status():
    """{gate: open?} for every gated command that is registered."""
    return dict((entry["gate"], gate_open(entry["gate"])) for entry in _COMMANDS.values() if entry.get("gate"))


def command(name, writes=False, destructive=False, gate=None):
    """Register a bridge command handler `fn(self, params)`.

    writes=True runs the command inside its own undo step. Without explicit steps Live coalesces
    consecutive API edits into one giant step, so a single `undo` could revert unrelated work;
    empty steps are not recorded, so commands that change nothing cost no undo entry.

    gate="x" makes the command refuse unless the opt-in file `allow_x` exists (see config.GATE_DIR)."""
    def register(fn):
        _COMMANDS[name] = {"fn": fn, "writes": writes, "destructive": destructive, "gate": gate}
        return fn
    return register


class BridgeError(Exception):
    """An error with a stable machine-readable code."""
    code = "INTERNAL_ERROR"

    details = None

    def __init__(self, message, code=None, details=None):
        Exception.__init__(self, message)
        if code:
            self.code = code
        if details is not None:
            self.details = details


def _error_code(exc):
    """Map an exception to a stable error code (Boost's ArgumentError is a TypeError)."""
    if isinstance(exc, BridgeError):
        return exc.code
    if isinstance(exc, IndexError):
        return "OUT_OF_RANGE"
    if isinstance(exc, KeyError):
        return "NOT_FOUND"
    if isinstance(exc, TypeError):
        return "TYPE_ERROR"
    if isinstance(exc, ValueError):
        return "NOT_FOUND" if "not found" in str(exc).lower() else "INVALID_ARGUMENT"
    if isinstance(exc, RuntimeError):
        return "LIVE_ERROR"
    return "INTERNAL_ERROR"


def _error_response(code, message, details=None):
    response = {"status": "error", "code": code, "message": message}
    if details is not None:
        response["details"] = details
    return response
