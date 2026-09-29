"""Command registry and the error model."""


# Command registry: the single source of truth for dispatch, undo behaviour and the capability list.
_COMMANDS = {}


def command(name, writes=False, destructive=False):
    """Register a bridge command handler `fn(self, params)`.

    writes=True runs the command inside its own undo step. Without explicit steps Live coalesces
    consecutive API edits into one giant step, so a single `undo` could revert unrelated work;
    empty steps are not recorded, so commands that change nothing cost no undo entry."""
    def register(fn):
        _COMMANDS[name] = {"fn": fn, "writes": writes, "destructive": destructive}
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
