"""batch: several commands in one round trip and one undo step, with later commands able to use earlier results.

    {"ops": [{"command": "create", "params": {"kind": "midi_track"}},
             {"command": "device_action", "params": {"action": "insert", "address": "$0.address", "name": "Drift"}}]}

References look like $0.address or $1.ids[0]: the whole string is replaced by that value (any type), or, inside a longer
string, by its text. The batch runs on Live's main thread in one go, so the Set never shows a half-built state to the
user, and `history undo` reverts all of it at once. On an error the default is to stop: what was applied stays applied (one
undo step); the error carries `details` with every op's outcome. Commands that are not undoable or that start background
work (playback, launching, ramps, undo itself) are refused, because a batch must be one revertible step.
"""
import re

from .registry import _COMMANDS, BridgeError, _error_code, command

MAX_OPS = 100
NOT_BATCHABLE = ("batch", "history", "eval", "transport", "launch", "ramp_parameter", "cancel_ramps", "get_script_info",
                 "get_health", "introspect_api", "measure")
# actions of a command that are not one undoable edit (ramps run on after the call, so they cannot be part of a revertible step)
NOT_BATCHABLE_ACTIONS = {"automation": ("ramp", "cancel")}
_REFERENCE = re.compile(r"\$(\d+)((?:\.[A-Za-z_]\w*|\[\d+\])*)")
_STEP = re.compile(r"\.([A-Za-z_]\w*)|\[(\d+)\]")


def _lookup(results, index, path, where):
    if index >= len(results):
        raise BridgeError("{0}: ${1} refers to an op that has not run yet (ops can only use earlier results)".format(where, index), "INVALID_ARGUMENT")
    entry = results[index]
    if entry["status"] != "success":
        raise BridgeError("{0}: ${1} refers to an op that failed".format(where, index), "INVALID_ARGUMENT")
    value = entry["result"]
    for name, position in _STEP.findall(path):
        try:
            value = value[name] if name else value[int(position)]
        except (KeyError, IndexError, TypeError):
            raise BridgeError("{0}: ${1}{2} does not exist in the result of op {1} ({3})".format(
                where, index, path, entry["command"]), "INVALID_ARGUMENT")
    return value


def _substitute(value, results, where):
    if isinstance(value, str):
        whole = _REFERENCE.fullmatch(value)
        if whole:
            return _lookup(results, int(whole.group(1)), whole.group(2), where)
        return _REFERENCE.sub(lambda m: str(_lookup(results, int(m.group(1)), m.group(2), where)), value)
    if isinstance(value, list):
        return [_substitute(v, results, where) for v in value]
    if isinstance(value, dict):
        return dict((k, _substitute(v, results, where)) for k, v in value.items())
    return value


class BatchMixin(object):
    """batch."""

    @command("batch", writes=True)
    def _cmd_batch(self, params):
        ops, on_error = params.get("ops"), params.get("on_error", "stop")
        if not isinstance(ops, list) or not ops:
            raise BridgeError("ops must be a non-empty list of {command, params}", "INVALID_ARGUMENT")
        if len(ops) > MAX_OPS:
            raise BridgeError("At most {0} ops per batch ({1} given)".format(MAX_OPS, len(ops)), "INVALID_ARGUMENT")
        if on_error not in ("stop", "continue"):
            raise BridgeError("on_error must be 'stop' (default) or 'continue'", "INVALID_ARGUMENT")
        for index, op in enumerate(ops):        # everything that can be checked without running anything is checked first
            if not isinstance(op, dict) or not isinstance(op.get("command"), str):
                raise BridgeError("ops[{0}] must be an object with a command name".format(index), "INVALID_ARGUMENT")
            if op["command"] not in _COMMANDS:
                raise BridgeError("ops[{0}]: unknown command '{1}'".format(index, op["command"]), "NOT_FOUND")
            if op["command"] in NOT_BATCHABLE:
                raise BridgeError("ops[{0}]: '{1}' cannot run inside a batch (it is not one undoable step of edits)".format(index, op["command"]),
                                  "INVALID_ARGUMENT")
            if op.get("params") is not None and not isinstance(op["params"], dict):
                raise BridgeError("ops[{0}]: params must be an object".format(index), "INVALID_ARGUMENT")
            action = (op.get("params") or {}).get("action")
            if action in NOT_BATCHABLE_ACTIONS.get(op["command"], ()):
                raise BridgeError("ops[{0}]: '{1}' with action '{2}' cannot run inside a batch (it is not one undoable step of edits)".format(
                    index, op["command"], action), "INVALID_ARGUMENT")
        results, failed = [], []
        for index, op in enumerate(ops):
            name = op["command"]
            try:
                resolved = _substitute(op.get("params") or {}, results, "ops[{0}]".format(index))
                results.append({"index": index, "command": name, "status": "success", "result": _COMMANDS[name]["fn"](self, resolved)})
            except Exception as e:
                results.append({"index": index, "command": name, "status": "error", "code": _error_code(e), "message": str(e)})
                failed.append(index)
                if on_error == "stop":
                    break
        applied = len(results) - len(failed)
        if failed:
            first = results[failed[0]]
            not_run = list(range(len(results), len(ops)))
            raise BridgeError(
                "Batch stopped at op {0} ({1}): {2}. {3} op(s) before it were applied as ONE undo step (history undo reverts them); {4} did not run."
                .format(failed[0], first["command"], first["message"], applied, len(not_run)) if on_error == "stop" else
                "{0} of {1} ops failed (first: op {2}, {3}: {4}). The other {5} were applied as ONE undo step."
                .format(len(failed), len(ops), failed[0], first["command"], first["message"], applied),
                "BATCH_FAILED", {"applied": applied, "failed": failed, "not_run": not_run, "results": results})
        return {"ok": True, "applied": applied, "results": results}
