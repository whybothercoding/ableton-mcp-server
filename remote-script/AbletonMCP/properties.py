"""Curated get/set for Live object properties (Song, Track, Scene, ClipSlot, Clip).

Live's Boost.Python setters take exact C++ types, raise multi-line ArgumentErrors and enforce ordering between
properties (loop end before loop start...). This layer validates and coerces first (strict bool/int/float/str, enums
by name, never raw ints from the caller), applies writes in as many passes as needed so dependent properties order
themselves, and reads every value back. It is a curated table now; a generated registry replaces it later.
"""
import Live

from . import api_registry
from .helpers import _is_number
from .registry import BridgeError, command


def _spec(type_, rw=True, enum=None, doc="", lo=None, hi=None, get=None, set=None):
    return {"type": type_, "rw": rw, "enum": enum, "doc": doc, "min": lo, "max": hi, "get": get, "set": set}


def _volume_get(track):
    return track.mixer_device.volume.value


def _volume_set(track, value):
    track.mixer_device.volume.value = value


def _pan_get(track):
    return track.mixer_device.panning.value


def _pan_set(track, value):
    track.mixer_device.panning.value = value


RO = False

PROPERTY_SPECS = {
    "song": {
        "tempo": _spec("float", doc="BPM", lo=20.0, hi=999.0),
        "signature_numerator": _spec("int", lo=1, hi=99),
        "signature_denominator": _spec("int", doc="1, 2, 4, 8 or 16"),
        "metronome": _spec("bool"),
        "loop": _spec("bool", doc="Arrangement loop on/off"),
        "loop_start": _spec("float", doc="beats"),
        "loop_length": _spec("float", doc="beats"),
        "punch_in": _spec("bool"),
        "punch_out": _spec("bool"),
        "start_time": _spec("float", doc="Arrangement play start, beats"),
        "current_song_time": _spec("float", doc="Playhead, beats"),
        "groove_amount": _spec("float", doc="Global groove amount, 0 to 1.3", lo=0.0, hi=1.3),
        "swing_amount": _spec("float", lo=0.0, hi=1.0),
        "clip_trigger_quantization": _spec("enum", enum="Live.Song.Quantization", doc="Global launch quantization"),
        "midi_recording_quantization": _spec("enum", enum="Live.Song.RecordingQuantization"),
        "root_note": _spec("int", doc="Scale root, 0 (C) to 11 (B)", lo=0, hi=11),
        "scale_name": _spec("str"),
        "scale_mode": _spec("bool", doc="Scale awareness on/off"),
        "scale_intervals": _spec("list", RO),
        "arrangement_overdub": _spec("bool"),
        "back_to_arranger": _spec("bool"),
        "is_playing": _spec("bool", RO, doc="Use transport actions to start/stop"),
        "song_length": _spec("float", RO),
        "can_undo": _spec("bool", RO),
        "can_redo": _spec("bool", RO),
        "can_capture_midi": _spec("bool", RO),
        "count_in_duration": _spec("int", RO, doc="0 none, 1 = 1 bar, 2 = 2 bars, 3 = 4 bars"),
        "exclusive_arm": _spec("bool", RO),
        "exclusive_solo": _spec("bool", RO),
        "select_on_launch": _spec("bool", RO),
        "name": _spec("str", RO),
        "file_path": _spec("str", RO),
    },
    "track": {
        "name": _spec("str"),
        "color": _spec("int", doc="RGB integer"),
        "color_index": _spec("int"),
        "mute": _spec("bool"),
        "solo": _spec("bool"),
        "arm": _spec("bool", doc="Only tracks with can_be_armed"),
        "implicit_arm": _spec("bool"),
        "fold_state": _spec("bool", doc="Group track folded"),
        "current_monitoring_state": _spec("enum", enum="Live.Track.Track.monitoring_states", doc="IN / AUTO / OFF"),
        "volume": _spec("float", doc="Mixer volume (device value, 0..1, 0.85 = 0 dB)", lo=0.0, hi=1.0, get=_volume_get, set=_volume_set),
        "panning": _spec("float", doc="Mixer pan, -1..1", lo=-1.0, hi=1.0, get=_pan_get, set=_pan_set),
        "can_be_armed": _spec("bool", RO),
        "can_be_frozen": _spec("bool", RO),
        "is_frozen": _spec("bool", RO),
        "is_foldable": _spec("bool", RO),
        "is_grouped": _spec("bool", RO),
        "is_visible": _spec("bool", RO),
        "muted_via_solo": _spec("bool", RO),
        "has_audio_input": _spec("bool", RO),
        "has_audio_output": _spec("bool", RO),
        "has_midi_input": _spec("bool", RO),
        "has_midi_output": _spec("bool", RO),
        "playing_slot_index": _spec("int", RO),
        "fired_slot_index": _spec("int", RO),
        "input_meter_level": _spec("float", RO),
        "output_meter_level": _spec("float", RO),
        "performance_impact": _spec("float", RO),
    },
    "scene": {
        "name": _spec("str"),
        "color": _spec("int"),
        "color_index": _spec("int"),
        "tempo": _spec("float", doc="Scene tempo override, BPM", lo=20.0, hi=999.0),
        "tempo_enabled": _spec("bool"),
        "time_signature_numerator": _spec("int", lo=1, hi=99),
        "time_signature_denominator": _spec("int", doc="1, 2, 4, 8 or 16"),
        "time_signature_enabled": _spec("bool"),
        "is_empty": _spec("bool", RO),
        "is_triggered": _spec("bool", RO),
    },
    "slot": {
        "has_clip": _spec("bool", RO),
        "has_stop_button": _spec("bool"),
        "is_playing": _spec("bool", RO),
        "is_recording": _spec("bool", RO),
        "is_triggered": _spec("bool", RO),
        "is_group_slot": _spec("bool", RO),
        "controls_other_clips": _spec("bool", RO),
        "will_record_on_start": _spec("bool", RO),
        "color": _spec("int", RO),
    },
    "clip": {
        "name": _spec("str"),
        "color": _spec("int"),
        "color_index": _spec("int"),
        "muted": _spec("bool"),
        "looping": _spec("bool"),
        "loop_start": _spec("float", doc="beats"),
        "loop_end": _spec("float", doc="beats"),
        "start_marker": _spec("float", doc="beats"),
        "end_marker": _spec("float", doc="beats"),
        "position": _spec("float", doc="beats"),
        "signature_numerator": _spec("int"),
        "signature_denominator": _spec("int"),
        "launch_mode": _spec("enum", enum="Live.Clip.LaunchMode"),
        "launch_quantization": _spec("enum", enum="Live.Clip.ClipLaunchQuantization"),
        "legato": _spec("bool"),
        "velocity_amount": _spec("float", doc="0..1: how much note velocity affects clip volume", lo=0.0, hi=1.0),
        "root_note": _spec("int", lo=0, hi=11),
        "scale_name": _spec("str"),
        "scale_mode": _spec("bool"),
        "scale_intervals": _spec("list", RO),
        "gain": _spec("float", doc="Audio clips only"),
        "pitch_coarse": _spec("int", doc="Audio clips only, semitones"),
        "pitch_fine": _spec("float", doc="Audio clips only, cents"),
        "warping": _spec("bool", doc="Audio clips only"),
        "warp_mode": _spec("enum", enum="Live.Clip.WarpMode", doc="Audio clips only"),
        "ram_mode": _spec("bool", doc="Audio clips only"),
        "length": _spec("float", RO, doc="beats"),
        "start_time": _spec("float", RO),
        "end_time": _spec("float", RO),
        "playing_position": _spec("float", RO),
        "is_playing": _spec("bool", RO),
        "is_triggered": _spec("bool", RO),
        "is_recording": _spec("bool", RO),
        "is_overdubbing": _spec("bool", RO),
        "is_audio_clip": _spec("bool", RO),
        "is_midi_clip": _spec("bool", RO),
        "is_session_clip": _spec("bool", RO),
        "is_arrangement_clip": _spec("bool", RO),
        "file_path": _spec("str", RO, doc="Audio clips only"),
        "sample_rate": _spec("float", RO, doc="Audio clips only"),
    },
}


def _enum_class(path):
    """Resolve a dotted Live enum path such as 'Live.Clip.LaunchMode'."""
    target = Live
    for part in path.split(".")[1:]:
        target = getattr(target, part)
    return target


def _enum_names(path):
    """name -> int table of a Live enum (Boost exposes it as `.names`; the 'count' sentinel is dropped)."""
    return dict((k, int(v)) for k, v in _enum_class(path).names.items() if k != "count")


def _read(obj, name, spec):
    value = spec["get"](obj) if spec["get"] else getattr(obj, name)
    if spec["type"] == "enum":
        by_value = dict((v, k) for k, v in _enum_names(spec["enum"]).items())
        return by_value.get(int(value), int(value))
    if spec["type"] == "list":
        return list(value)
    return value


def _coerce(name, spec, value):
    """Validate a caller value against the spec and convert it to what Live's setter accepts."""
    kind = spec["type"]
    if kind == "bool":
        if not isinstance(value, bool):
            raise BridgeError("{0} must be true or false".format(name), "TYPE_ERROR")
        return value
    if kind == "int":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
            raise BridgeError("{0} must be an integer".format(name), "TYPE_ERROR")
        value = int(value)
    elif kind == "float":
        if not _is_number(value):
            raise BridgeError("{0} must be a number".format(name), "TYPE_ERROR")
        value = float(value)
    elif kind == "str":
        if not isinstance(value, str):
            raise BridgeError("{0} must be a string".format(name), "TYPE_ERROR")
        return value
    elif kind == "enum":
        names = _enum_names(spec["enum"])
        if not isinstance(value, str) or value not in names:
            raise BridgeError("{0} must be one of: {1}".format(name, ", ".join(sorted(names, key=names.get))), "INVALID_ARGUMENT")
        return names[value]
    else:
        raise BridgeError("{0} cannot be written".format(name), "INVALID_ARGUMENT")
    if spec["min"] is not None and value < spec["min"] or spec["max"] is not None and value > spec["max"]:
        raise BridgeError("{0} {1} is outside {2} to {3}".format(name, value, spec["min"], spec["max"]), "OUT_OF_RANGE")
    return value


def _kind_specs(kind):
    return PROPERTY_SPECS[kind]


class PropertiesMixin(object):
    """get_properties / set_properties / list_properties over addresses."""

    def _get_properties(self, address, names=None):
        kind, obj, canonical = self._resolve(address)
        specs = _kind_specs(kind)
        if names is not None:
            if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
                raise BridgeError("names must be a list of property names", "INVALID_ARGUMENT")
            unknown = [n for n in names if n not in specs]
            if unknown:
                raise BridgeError("Unknown {0} properties: {1}. Valid: {2}".format(kind, unknown, sorted(specs)), "NOT_FOUND")
        values, unavailable = {}, {}
        for name in (names if names is not None else sorted(specs)):
            try:
                values[name] = _read(obj, name, specs[name])
            except Exception as e:
                if names is not None:
                    raise
                unavailable[name] = "not available on this object" if isinstance(e, (RuntimeError, AttributeError)) else str(e)
        result = {"address": canonical, "kind": kind, "properties": values}
        if unavailable:
            result["unavailable"] = unavailable
        return result

    def _set_properties(self, address, values, expect=None):
        kind, obj, canonical = self._resolve(address)
        self._guard(obj, expect, canonical)
        if not isinstance(values, dict) or not values:
            raise BridgeError("properties must be a non-empty object of name: value", "INVALID_ARGUMENT")
        specs = _kind_specs(kind)
        pending = {}
        for name, value in values.items():
            if name not in specs:
                raise BridgeError("Unknown {0} property '{1}'. Valid: {2}".format(kind, name, sorted(specs)), "NOT_FOUND")
            if not specs[name]["rw"]:
                raise BridgeError("{0} is read-only".format(name), "INVALID_ARGUMENT")
            pending[name] = _coerce(name, specs[name], value)
        before = dict((name, _read(obj, name, specs[name])) for name in pending)
        # Apply in passes: Live enforces ordering between properties (e.g. loop_end before loop_start), so retry the
        # writes that raise until a pass makes no progress. On failure, restore what was already written so the call
        # is all-or-nothing.
        def write(name, value):
            spec = specs[name]
            if spec["set"]:
                spec["set"](obj, value)
            else:
                setattr(obj, name, value)

        errors, done = {}, []
        while pending:
            progressed = False
            for name in list(pending):
                try:
                    write(name, pending[name])
                    del pending[name]
                    done.append(name)
                    progressed = True
                except Exception as e:
                    errors[name] = e
            if not progressed:
                for name in reversed(done):
                    try:
                        write(name, self._writable_value(specs[name], before[name]))
                    except Exception:
                        pass
                raise errors[sorted(pending)[0]]
        applied = {}
        for name in values:
            applied[name] = {"from": before[name], "to": _read(obj, name, specs[name])}
        return {"address": canonical, "kind": kind, "applied": applied}

    @staticmethod
    def _writable_value(spec, value):
        """Turn a value read back for the caller (enum name) into what the setter takes (int)."""
        if spec["type"] == "enum" and isinstance(value, str):
            return _enum_names(spec["enum"])[value]
        return value

    def _list_properties(self, address=None, kind=None):
        if address is not None:
            kind = self._resolve(address)[0]
        if kind not in PROPERTY_SPECS:
            raise BridgeError("kind must be one of: {0}".format(", ".join(sorted(PROPERTY_SPECS))), "INVALID_ARGUMENT")
        listing = {}
        for name, spec in sorted(PROPERTY_SPECS[kind].items()):
            entry = {"type": spec["type"], "writable": spec["rw"]}
            if spec["enum"]:
                entry["values"] = sorted(_enum_names(spec["enum"]), key=_enum_names(spec["enum"]).get)
            for key in ("doc", "min", "max"):
                if spec[key] not in (None, ""):
                    entry[key] = spec[key]
            listing[name] = entry
        result = {"kind": kind, "properties": listing}
        # What Live exposes that this tool does not (yet): visible gaps instead of hidden ones
        known = api_registry.class_properties(api_registry.KIND_CLASSES[kind])
        result["not_exposed"] = dict((name, {"type": info["get"], "writable": info["set"] is not None})
                                     for name, info in sorted(known.items()) if name not in PROPERTY_SPECS[kind])
        return result

    @command("get_properties")
    def _cmd_get_properties(self, params):
        return self._get_properties(params.get("address"), params.get("names"))

    @command("set_properties", writes=True)
    def _cmd_set_properties(self, params):
        if "items" in params:
            return {"results": [self._set_properties(i.get("address"), i.get("properties"), i.get("expect")) for i in params["items"]]}
        return self._set_properties(params.get("address"), params.get("properties"), params.get("expect"))

    @command("list_properties")
    def _cmd_list_properties(self, params):
        return self._list_properties(params.get("address"), params.get("kind"))
