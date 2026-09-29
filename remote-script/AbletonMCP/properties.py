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


def _spec(type_, rw=True, enum=None, doc="", lo=None, hi=None, get=None, set=None, ref=None, coerce=None):
    """coerce(obj, value) replaces the standard value checks when a property's valid values depend on the object itself."""
    return {"type": type_, "rw": rw, "enum": enum, "doc": doc, "min": lo, "max": hi, "get": get, "set": set, "ref": ref,
            "coerce": coerce}


def _volume_get(track):
    return track.mixer_device.volume.value


def _volume_set(track, value):
    track.mixer_device.volume.value = value


def _pan_get(track):
    return track.mixer_device.panning.value


def _pan_set(track, value):
    track.mixer_device.panning.value = value


def _warp_markers_get(clip):
    return [{"beat_time": m.beat_time, "sample_time": m.sample_time} for m in clip.warp_markers]


def _mixer_get(name):
    return lambda track: getattr(track.mixer_device, name)


def _mixer_set(name):
    return lambda track, value: setattr(track.mixer_device, name, value)


def _device_on_parameter(device):
    parameters = list(device.parameters)
    for parameter in parameters:
        if parameter.name == "Device On":
            return parameter
    raise RuntimeError("'{0}' has no on/off switch".format(device.name))


def _device_on_get(device):
    return _device_on_parameter(device).value > 0.5


def _device_on_set(device, value):
    _device_on_parameter(device).value = 1.0 if value else 0.0


def _collapsed_get(device):
    return device.view.is_collapsed


def _collapsed_set(device, value):
    device.view.is_collapsed = value


def _display_get(parameter):
    return parameter.str_for_value(parameter.value)


def _value_items_get(parameter):
    return list(parameter.value_items)


def _parameter_value(parameter, value):
    """A parameter's value: a number inside its range, or for a quantized parameter the label Live shows for it."""
    if not parameter.is_enabled:
        raise BridgeError("Parameter '{0}' is not enabled (macro-mapped or switched off by another parameter)".format(parameter.name), "UNAVAILABLE")
    if isinstance(value, str):
        if not parameter.is_quantized:
            raise BridgeError("value must be a number: '{0}' is not a quantized parameter".format(parameter.name), "TYPE_ERROR")
        items = list(parameter.value_items)
        if value not in items:
            raise BridgeError("value must be one of: {0}".format(", ".join(items)), "INVALID_ARGUMENT")
        return float(parameter.min + items.index(value))
    if not _is_number(value):
        raise BridgeError("value must be a number" + (" or a label" if parameter.is_quantized else ""), "TYPE_ERROR")
    value = float(value)
    if value < parameter.min or value > parameter.max:
        raise BridgeError("value {0:g} is outside this parameter's range {1:g} to {2:g}".format(value, parameter.min, parameter.max), "OUT_OF_RANGE")
    return value


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
        "is_counting_in": _spec("bool", RO),
        "can_jump_to_next_cue": _spec("bool", RO),
        "can_jump_to_prev_cue": _spec("bool", RO),
        "last_event_time": _spec("float", RO, doc="End of the last clip or automation event, beats"),
        "session_record_status": _spec("enum", RO, enum="Live.Song.SessionRecordStatus"),
        "record_mode": _spec("bool", RO, doc="Arrangement recording: read here, started through the gated record tools"),
        "overdub": _spec("bool", RO),
        "session_record": _spec("bool", RO),
        "session_automation_record": _spec("bool", RO),
        "re_enable_automation_enabled": _spec("bool", RO, doc="True when some automation was overridden and can be re-enabled"),
        "is_ableton_link_enabled": _spec("bool", RO, doc="Link is a network feature: changing it is left to the user"),
        "is_ableton_link_start_stop_sync_enabled": _spec("bool", RO),
        "tempo_follower_enabled": _spec("bool", RO),
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
        "crossfade_assign": _spec("enum", enum="Live.MixerDevice.MixerDevice.crossfade_assignments", doc="Regular and return tracks: A, NONE or B",
                                  get=_mixer_get("crossfade_assign"), set=_mixer_set("crossfade_assign")),
        "panning_mode": _spec("enum", enum="Live.MixerDevice.MixerDevice.panning_modes", doc="stereo or stereo_split (then use the mixer/left_split_stereo and right_split_stereo parameters)",
                              get=_mixer_get("panning_mode"), set=_mixer_set("panning_mode")),
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
        "input_meter_left": _spec("float", RO),
        "input_meter_right": _spec("float", RO),
        "output_meter_left": _spec("float", RO),
        "output_meter_right": _spec("float", RO),
        "performance_impact": _spec("float", RO),
        "is_part_of_selection": _spec("bool", RO),
        "can_show_chains": _spec("bool", RO, doc="Instrument racks: whether the track can show its chains"),
        "is_showing_chains": _spec("bool", doc="Instrument racks: chains shown as Session tracks"),
        "back_to_arranger": _spec("bool", doc="Session clip launches on this track have taken it off the arrangement"),
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
        "color_index": _spec("int", RO),
        "playing_status": _spec("enum", RO, enum="Live.ClipSlot.ClipSlotPlayingState"),
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
        "sample_length": _spec("int", RO, doc="Audio clips only, samples"),
        "gain_display_string": _spec("str", RO, doc="Audio clips only, e.g. '-3.0 dB'"),
        "available_warp_modes": _spec("list", RO, doc="Audio clips only: the warp_mode values this clip accepts"),
        "warp_markers": _spec("list", RO, doc="Audio clips only: [{beat_time, sample_time (seconds in the file)}]; edit with clip_action", get=_warp_markers_get),
        "has_envelopes": _spec("bool", RO),
        "has_groove": _spec("bool", RO),
        "groove": _spec("ref", ref="groove", doc="Address of a groove in the pool (grooves/N); a clip always has one"),
        "is_take_lane_clip": _spec("bool", RO),
        "will_record_on_start": _spec("bool", RO),
    },
    "device": {
        "name": _spec("str"),
        "class_name": _spec("str", RO),
        "class_display_name": _spec("str", RO),
        "type": _spec("enum", RO, enum="Live.Device.DeviceType"),
        "is_active": _spec("bool", RO, doc="False when the device or something above it is switched off"),
        "on": _spec("bool", doc="The device's own on/off switch (its 'Device On' parameter)", get=_device_on_get, set=_device_on_set),
        "collapsed": _spec("bool", doc="Device shown collapsed in the device chain", get=_collapsed_get, set=_collapsed_set),
        "can_have_chains": _spec("bool", RO, doc="True for racks"),
        "can_have_drum_pads": _spec("bool", RO, doc="True for Drum Racks"),
        "can_compare_ab": _spec("bool", RO),
        "is_using_compare_preset_b": _spec("bool", doc="A/B compare: the B preset is loaded"),
        "latency_in_ms": _spec("float", RO),
        "latency_in_samples": _spec("int", RO),
        "can_show_chains": _spec("bool", RO, doc="Racks only"),
        "is_showing_chains": _spec("bool", doc="Racks only: chains shown as Session tracks"),
        "has_drum_pads": _spec("bool", RO, doc="Drum Racks only"),
        "has_macro_mappings": _spec("bool", RO, doc="Racks only"),
        "macros_mapped": _spec("list", RO, doc="Racks only: one flag per macro"),
        "visible_macro_count": _spec("int", RO, doc="Racks only"),
        "variation_count": _spec("int", RO, doc="Racks only: stored macro variations"),
        "selected_variation_index": _spec("int", doc="Racks only: the variation recall_variation would recall"),
    },
    "chain": {
        "name": _spec("str"),
        "color": _spec("int"),
        "color_index": _spec("int"),
        "is_auto_colored": _spec("bool"),
        "mute": _spec("bool"),
        "solo": _spec("bool"),
        "muted_via_solo": _spec("bool", RO),
        "volume": _spec("float", doc="Chain mixer volume (device value, 0..1, 0.85 = 0 dB)", lo=0.0, hi=1.0, get=_volume_get, set=_volume_set),
        "panning": _spec("float", doc="Chain mixer pan, -1..1", lo=-1.0, hi=1.0, get=_pan_get, set=_pan_set),
        "has_audio_input": _spec("bool", RO),
        "has_audio_output": _spec("bool", RO),
        "has_midi_input": _spec("bool", RO),
        "has_midi_output": _spec("bool", RO),
    },
    "pad": {
        "name": _spec("str", RO),
        "note": _spec("int", RO),
        "mute": _spec("bool"),
        "solo": _spec("bool"),
    },
    "parameter": {
        "value": _spec("float", doc="Raw value within min..max; a quantized parameter also takes its label (e.g. 'Low-pass')", coerce=_parameter_value),
        "name": _spec("str", RO),
        "original_name": _spec("str", RO),
        "min": _spec("float", RO),
        "max": _spec("float", RO),
        "default_value": _spec("float", RO, doc="Not available for quantized parameters"),
        "is_quantized": _spec("bool", RO),
        "is_enabled": _spec("bool", RO, doc="False when macro-mapped or disabled by another parameter"),
        "display": _spec("str", RO, doc="The value as Live shows it ('14.2 kHz')", get=_display_get),
        "value_items": _spec("list", RO, doc="Labels of a quantized parameter", get=_value_items_get),
        "automation_state": _spec("int", RO, doc="0 none, 1 automation playing, 2 overridden"),
        "state": _spec("int", RO),
    },
    "cue": {
        "name": _spec("str"),
        "time": _spec("float", RO, doc="Position in beats; create a cue point with `create` at a time"),
    },
    "app": {
        "average_process_usage": _spec("float", RO, doc="CPU load, average"),
        "peak_process_usage": _spec("float", RO, doc="CPU load, peak since the last read"),
        "open_dialog_count": _spec("int", RO),
        "current_dialog_message": _spec("str", RO),
        "current_dialog_button_count": _spec("int", RO),
        "number_of_push_apps_running": _spec("int", RO),
    },
    "groove": {
        "name": _spec("str"),
        "base": _spec("enum", enum="Live.Groove.Base", doc="The grid the groove is laid on"),
        "timing_amount": _spec("float", doc="percent"),
        "quantization_amount": _spec("float", doc="percent"),
        "random_amount": _spec("float", doc="percent"),
        "velocity_amount": _spec("float", doc="percent"),
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

    def _value(self, obj, name, spec):
        """Read a property as the caller sees it: enums by name, referenced objects by address."""
        value = _read(obj, name, spec)
        if spec["type"] == "ref":
            return None if value is None else self._address_of(value)
        return value

    def _resolve_ref(self, name, spec, value):
        if not isinstance(value, str):
            raise BridgeError("{0} must be the address of a {1} (for example 'grooves/0')".format(name, spec["ref"]), "TYPE_ERROR")
        kind, target, canonical = self._resolve(value)
        if kind != spec["ref"]:
            raise BridgeError("{0} must be the address of a {1}, but '{2}' is a {3}".format(name, spec["ref"], canonical, kind), "TYPE_ERROR")
        return target

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
                values[name] = self._value(obj, name, specs[name])
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
            if specs[name]["type"] == "ref":
                pending[name] = self._resolve_ref(name, specs[name], value)
            elif specs[name]["coerce"]:
                pending[name] = specs[name]["coerce"](obj, value)
            else:
                pending[name] = _coerce(name, specs[name], value)
        before = dict((name, self._value(obj, name, specs[name])) for name in pending)
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
            applied[name] = {"from": before[name], "to": self._value(obj, name, specs[name])}
        return {"address": canonical, "kind": kind, "applied": applied}

    def _writable_value(self, spec, value):
        """Turn a value read back for the caller (enum name, object address) into what the setter takes."""
        if spec["type"] == "enum" and isinstance(value, str):
            return _enum_names(spec["enum"])[value]
        if spec["type"] == "ref" and isinstance(value, str):
            return self._resolve(value)[1]
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
            for key in ("doc", "min", "max", "ref"):
                if spec[key] not in (None, ""):
                    entry["refers_to" if key == "ref" else key] = spec[key]
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
