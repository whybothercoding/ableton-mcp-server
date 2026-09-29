"""Audio and MIDI routing of tracks and of devices that have a side-chain (Compressor and friends), through Live's typed
routing objects: pick a routing type (its display name as the mixer shows it: 'Ext. In', 'Master', 'Resampling', a track's
name) and a channel. Feedback is the one real danger, so the risky choices need an explicit flag.
"""
import Live

from .helpers import _safe_attr
from .registry import BridgeError, command

DIRECTIONS = ("input", "output")
ROUTING_ACTIONS = ("get", "set")


def _category_names():
    try:
        return dict((int(v), k) for k, v in Live.Track.RoutingTypeCategory.names.items())
    except Exception:
        return {}


def _layout_names():
    try:
        return dict((int(v), k) for k, v in Live.Track.RoutingChannelLayout.names.items())
    except Exception:
        return {}


class RoutingMixin(object):
    """routing."""

    def _routing_owner(self, address):
        kind, obj, canonical = self._resolve(address)
        if kind not in ("track", "device"):
            raise BridgeError("routing needs the address of a track, return track, the master or a device with a side-chain, "
                              "got '{0}' which is a {1}".format(canonical, kind), "INVALID_ARGUMENT")
        return kind, obj, canonical

    @staticmethod
    def _routing_attr(owner, direction, what):
        value = _safe_attr(owner, "{0}_routing_{1}".format(direction, what))
        return value

    def _describe_routing(self, owner, canonical, direction):
        categories, layouts = _category_names(), _layout_names()
        current_type = self._routing_attr(owner, direction, "type")
        current_channel = self._routing_attr(owner, direction, "channel")
        if current_type is None:
            raise BridgeError("'{0}' has no {1} routing".format(canonical, direction), "UNAVAILABLE")
        types = list(_safe_attr(owner, "available_{0}_routing_types".format(direction), []))
        channels = list(_safe_attr(owner, "available_{0}_routing_channels".format(direction), []))
        return {
            "address": canonical, "direction": direction,
            "type": {"display_name": current_type.display_name, "category": categories.get(int(current_type.category), int(current_type.category))},
            "channel": None if current_channel is None else {"display_name": current_channel.display_name,
                                                              "layout": layouts.get(int(current_channel.layout), int(current_channel.layout))},
            "available_types": [{"display_name": t.display_name, "category": categories.get(int(t.category), int(t.category))} for t in types],
            "available_channels": [{"display_name": c.display_name, "layout": layouts.get(int(c.layout), int(c.layout))} for c in channels],
        }

    @staticmethod
    def _pick(items, wanted, label):
        names = [i.display_name for i in items]
        if wanted not in names:
            raise BridgeError("{0} '{1}' is not available. Available: {2}".format(label, wanted, names), "NOT_FOUND")
        return items[names.index(wanted)]

    def _feedback_risk(self, kind, owner, direction, chosen_type):
        """Routing a track's input from the master or from resampling while it monitors its input can feed the signal back."""
        if kind != "track" or direction != "input":
            return None
        categories = _category_names()
        category = categories.get(int(chosen_type.category), "")
        if category not in ("resampling", "master"):
            return None
        monitoring = _safe_attr(owner, "current_monitoring_state")
        if monitoring is None or int(monitoring) == 2:        # OFF
            return None
        return ("Routing '{0}' ({1}) into a track whose monitoring is not Off can feed the sound back into itself and get very loud. "
                "Set monitoring to Off first, or pass allow_feedback: true if you mean it.".format(chosen_type.display_name, category))

    @command("routing", writes=True)
    def _cmd_routing(self, params):
        action, direction = params.get("action", "get"), params.get("direction")
        if action not in ROUTING_ACTIONS:
            raise BridgeError("action must be 'get' or 'set'", "INVALID_ARGUMENT")
        if direction not in DIRECTIONS:
            raise BridgeError("direction must be 'input' or 'output'", "INVALID_ARGUMENT")
        kind, owner, canonical = self._routing_owner(params.get("address"))
        if action == "get":
            return self._describe_routing(owner, canonical, direction)
        wanted_type, wanted_channel = params.get("type"), params.get("channel")
        if wanted_type is None and wanted_channel is None:
            raise BridgeError("set needs type and/or channel (display names as returned by get)", "INVALID_ARGUMENT")
        for name, value in (("type", wanted_type), ("channel", wanted_channel)):
            if value is not None and not isinstance(value, str):
                raise BridgeError("{0} must be a display name (string)".format(name), "TYPE_ERROR")
        allow = params.get("allow_feedback", False)
        if not isinstance(allow, bool):
            raise BridgeError("allow_feedback must be true or false", "TYPE_ERROR")
        before = self._describe_routing(owner, canonical, direction)
        if wanted_type is not None:
            chosen = self._pick(list(getattr(owner, "available_{0}_routing_types".format(direction))), wanted_type, "Routing type")
            warning = self._feedback_risk(kind, owner, direction, chosen)
            if warning and not allow:
                raise BridgeError(warning, "GUARD_FAILED")
            setattr(owner, "{0}_routing_type".format(direction), chosen)
        if wanted_channel is not None:
            channel = self._pick(list(getattr(owner, "available_{0}_routing_channels".format(direction))), wanted_channel, "Routing channel")
            setattr(owner, "{0}_routing_channel".format(direction), channel)
        after = self._describe_routing(owner, canonical, direction)
        after["from"] = {"type": before["type"]["display_name"], "channel": (before["channel"] or {}).get("display_name")}
        return after
