"""Properties and methods that belong to particular devices: Simpler and its Sample, Wavetable, Drift, Meld, Eq Eight, Looper,
Hybrid Reverb, Roar, Spectral Resonator, Shifter, Drum Cell and plug-ins.

Nothing here is written per property. The property tables are built from the generated API registry (so they are exactly
what Live's classes offer, and stay right after a Live update), with three touches: integer properties that Live documents
as an enum take its names, "X_index" + "X_list" pairs become one property `X` that takes the label the device shows, and
big lists are only read when asked for. Methods (crop a Simpler sample, record on a Looper, set a Wavetable modulation) go
through a short whitelist with typed arguments, run by device_action `call`; get_device lists what a device offers.
"""
import os

import Live

from . import api_registry
from .helpers import _is_number, _safe_attr
from .registry import BridgeError

# (Live module, class, {property: enum path}, {label property: (index property, list property)})
DEVICE_CLASSES = (
    ("SimplerDevice", "SimplerDevice", {"playback_mode": "Live.SimplerDevice.PlaybackMode", "slicing_playback_mode": "Live.SimplerDevice.SlicingPlaybackMode"}, {}),
    ("WavetableDevice", "WavetableDevice",
     {"oscillator_1_effect_mode": "Live.WavetableDevice.EffectMode", "oscillator_2_effect_mode": "Live.WavetableDevice.EffectMode",
      "filter_routing": "Live.WavetableDevice.FilterRouting", "unison_mode": "Live.WavetableDevice.UnisonMode",
      "poly_voices": "Live.WavetableDevice.VoiceCount", "mono_poly": "Live.WavetableDevice.Voicing"},
     {"oscillator_1_wavetable": ("oscillator_1_wavetable_index", "oscillator_1_wavetables"),
      "oscillator_2_wavetable": ("oscillator_2_wavetable_index", "oscillator_2_wavetables"),
      "oscillator_1_wavetable_category": ("oscillator_1_wavetable_category", "oscillator_wavetable_categories"),
      "oscillator_2_wavetable_category": ("oscillator_2_wavetable_category", "oscillator_wavetable_categories")}),
    ("DriftDevice", "DriftDevice", {}, {}),
    ("MeldDevice", "MeldDevice", {}, {}),
    ("Eq8Device", "Eq8Device", {"global_mode": "Live.Eq8Device.GlobalMode"}, {}),
    ("LooperDevice", "LooperDevice", {}, {}),
    ("HybridReverbDevice", "HybridReverbDevice", {}, {}),
    ("RoarDevice", "RoarDevice", {}, {}),
    ("SpectralResonatorDevice", "SpectralResonatorDevice", {}, {}),
    ("ShifterDevice", "ShifterDevice", {}, {}),
    ("DrumCellDevice", "DrumCellDevice", {}, {}),
    ("PluginDevice", "PluginDevice", {}, {}),
)
SAMPLE_CLASS = ("Sample", "Sample", {"warp_mode": "Live.Clip.WarpMode", "slicing_style": "Live.Sample.SlicingStyle",
                                       "slicing_beat_division": "Live.Sample.SlicingBeatDivision",
                                       "beats_transient_loop_mode": "Live.Sample.TransientLoopMode"}, {})

# Not offered here: they are base device properties, references, routing (the routing tool) or plumbing.
_SKIP = frozenset(("canonical_parent", "parameters", "view", "name", "type", "class_name", "class_display_name", "is_active", "latency_in_ms",
                   "latency_in_samples", "can_have_chains", "can_have_drum_pads", "can_compare_ab", "is_using_compare_preset_b",
                   "sample", "warp_markers", "audio_inputs", "audio_outputs", "midi_inputs", "midi_outputs", "is_editor_open"))

_ROUTING_PREFIXES = ("input_routing", "output_routing", "available_input", "available_output")   # the routing tool's business
_CACHE = {}


def _spec(type_, rw=True, enum=None, doc="", get=None, set=None, coerce=None, options=None, on_request=False):
    return {"type": type_, "rw": rw, "enum": enum, "doc": doc, "min": None, "max": None, "get": get, "set": set, "ref": None,
            "coerce": coerce, "options": options, "on_request": on_request}


def _choice_specs(index_prop, list_prop, label_name, writable):
    """One property that reads and writes the label a device shows for an index into one of its lists."""
    def options(obj):
        return list(getattr(obj, list_prop))

    def get(obj):
        labels, index = options(obj), getattr(obj, index_prop)
        return labels[index] if 0 <= index < len(labels) else index

    def coerce(obj, value):
        labels = options(obj)
        if isinstance(value, bool) or (not isinstance(value, str) and not isinstance(value, int)):
            raise BridgeError("{0} must be one of the labels in {1}_options (or its position)".format(label_name, label_name), "TYPE_ERROR")
        if isinstance(value, int):
            if not 0 <= value < len(labels):
                raise BridgeError("{0} position {1} is outside 0 to {2}".format(label_name, value, len(labels) - 1), "OUT_OF_RANGE")
            return value
        if value not in labels:
            shown = labels[:30] + (["..."] if len(labels) > 30 else [])
            raise BridgeError("{0} must be one of: {1}".format(label_name, ", ".join(shown)), "INVALID_ARGUMENT")
        return labels.index(value)

    def write(obj, value):
        setattr(obj, index_prop, value)

    return (_spec("choice", writable, doc="Label as the device shows it; the choices are in {0}_options".format(label_name), get=get, set=write,
                  coerce=coerce, options=options),
            _spec("list", False, doc="The choices for {0}".format(label_name), get=lambda obj: options(obj), on_request=True))


def _build(module, cls, enums, choices):
    qualname = "Live.{0}.{1}".format(module, cls)
    props = api_registry.class_properties(qualname)
    specs, consumed = {}, set()
    for label, (index_prop, list_prop) in choices.items():
        if index_prop in props and list_prop in props:
            index_spec, options_spec = _choice_specs(index_prop, list_prop, label, props[index_prop]["set"] is not None)
            specs[label], specs[label + "_options"] = index_spec, options_spec
            consumed.update((index_prop, list_prop))
    for name, info in sorted(props.items()):
        if name in _SKIP or name in consumed or name.startswith(_ROUTING_PREFIXES) or name in specs:
            continue
        family = api_registry.family(info["get"])
        if name.endswith("_index") and name[: -len("_index")] + "_list" in props and name[: -len("_index")] not in specs:
            base = name[: -len("_index")]
            specs[base], specs[base + "_options"] = _choice_specs(name, base + "_list", base, info["set"] is not None)
            consumed.update((name, base + "_list"))
            continue
        if family in ("float", "int", "bool", "str"):
            enum = enums.get(name)
            specs[name] = _spec("enum" if enum else family, info["set"] is not None, enum=enum, doc=info.get("doc", ""))
        elif family == "list":
            specs[name] = _spec("list", False, on_request=True)
    return specs


def _live_class(module, cls):
    return _safe_attr(_safe_attr(Live, module), cls)


def specs_for_device(device):
    """The device-specific property table for `device` ({} for devices without one)."""
    for module, cls, enums, choices in DEVICE_CLASSES:
        live_cls = _live_class(module, cls)
        if live_cls is not None and isinstance(device, live_cls):
            key = (module, cls)
            if key not in _CACHE:
                _CACHE[key] = _build(module, cls, enums, choices)
            return _CACHE[key]
    return {}


def specs_for_sample():
    if SAMPLE_CLASS[:2] not in _CACHE:
        _CACHE[SAMPLE_CLASS[:2]] = _build(*SAMPLE_CLASS)
    return _CACHE[SAMPLE_CLASS[:2]]


def device_kind_of(device):
    for module, cls, _enums, _choices in DEVICE_CLASSES:
        live_cls = _live_class(module, cls)
        if live_cls is not None and isinstance(device, live_cls):
            return cls
    return None


# ---- methods: name -> (argument list, description). Argument kinds: number, int, string, path, parameter, slot, enum:<Live path>

METHODS = {
    "SimplerDevice": {
        "crop": ([], "Crop the loaded sample to the area between the start and end markers"),
        "reverse": ([], "Reverse the loaded sample"),
        "warp_double": ([], "Double the tempo of the region between the markers"),
        "warp_half": ([], "Halve the tempo of the region between the markers"),
        "warp_as": ([("beat_time", "number")], "Warp the region between the markers to this many beats"),
        "guess_playback_length": ([], "Estimate the beat length between the markers"),
        "replace_sample": ([("path", "path")], "Load another audio file (absolute path) as the sample"),
    },
    "LooperDevice": {
        "record": ([], "Record incoming audio"), "overdub": ([], "Play back while adding layers"), "play": ([], "Play back without overdubbing"),
        "stop": ([], "Stop playback"), "clear": ([], "Erase the recorded content"), "undo": ([], "Undo the last overdub pass"),
        "double_length": ([], "Double the buffer length"), "half_length": ([], "Halve the buffer length"),
        "double_speed": ([], "Double the playback speed"), "half_speed": ([], "Halve the playback speed"),
        "export_to_clip_slot": ([("slot", "slot")], "Export the loop to a Session clip slot (address)"),
    },
    "WavetableDevice": {
        "is_parameter_modulatable": ([("parameter", "parameter")], "Whether the parameter can be a modulation target"),
        "add_parameter_to_modulation_matrix": ([("parameter", "parameter")], "Add a parameter to the modulation matrix; returns its target index"),
        "get_modulation_target_parameter_name": ([("target_index", "int")], "The parameter name at a modulation target index"),
        "get_modulation_value": ([("target_index", "int"), ("source", "enum:Live.WavetableDevice.ModulationSource")], "The modulation amount of a source on a target"),
        "set_modulation_value": ([("target_index", "int"), ("source", "enum:Live.WavetableDevice.ModulationSource"), ("value", "number")],
                                 "Set the modulation amount of a source on a target"),
    },
    "Sample": {
        "insert_slice": ([("time", "int")], "Add a slice point at a sample time (Simpler manual slicing)"),
        "move_slice": ([("old_time", "int"), ("new_time", "int")], "Move a slice point; returns where it landed"),
        "remove_slice": ([("time", "int")], "Remove the slice point at a sample time"),
        "clear_slices": ([], "Remove all manual slices"),
        "reset_slices": ([], "Put edited slices back at their original positions"),
        "beat_to_sample_time": ([("beat_time", "number")], "Convert a beat time (warped samples only)"),
        "sample_to_beat_time": ([("sample_time", "number")], "Convert a sample time (warped samples only)"),
    },
}


def methods_for(kind, obj):
    """The whitelisted methods an object offers: {name: {args: [{name, type}], doc}}."""
    key = "Sample" if kind == "sample" else device_kind_of(obj)
    return dict((name, {"args": [{"name": a, "type": t} for a, t in args], "doc": doc}) for name, (args, doc) in METHODS.get(key, {}).items())


def call_method(script, kind, obj, canonical, method, args):
    """Run a whitelisted method with typed arguments and return something JSON-safe."""
    key = "Sample" if kind == "sample" else device_kind_of(obj)
    table = METHODS.get(key, {})
    if method not in table:
        offered = sorted(table)
        raise BridgeError("'{0}' has no method '{1}'.{2}".format(canonical, method, " It offers: {0}".format(", ".join(offered)) if offered
                                                                  else " It has no device-specific methods"), "NOT_FOUND")
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise BridgeError("args must be an object of argument name: value", "TYPE_ERROR")
    signature = table[method][0]
    unknown = sorted(set(args) - set(name for name, _ in signature))
    if unknown:
        raise BridgeError("{0} does not take {1}. Arguments: {2}".format(method, unknown, [n for n, _ in signature] or "none"), "INVALID_ARGUMENT")
    values = []
    for name, type_ in signature:
        if name not in args:
            raise BridgeError("{0} needs {1} ({2})".format(method, name, type_), "INVALID_ARGUMENT")
        values.append(_convert(script, name, type_, args[name]))
    result = getattr(obj, method)(*values)
    return _plain(result)


def _convert(script, name, type_, value):
    if type_ == "number":
        if not _is_number(value):
            raise BridgeError("{0} must be a number".format(name), "TYPE_ERROR")
        return float(value)
    if type_ == "int":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
            raise BridgeError("{0} must be a whole number".format(name), "TYPE_ERROR")
        return int(value)
    if type_ == "string":
        if not isinstance(value, str):
            raise BridgeError("{0} must be a string".format(name), "TYPE_ERROR")
        return value
    if type_ == "path":
        if not isinstance(value, str) or not os.path.isabs(value):
            raise BridgeError("{0} must be an absolute file path".format(name), "INVALID_ARGUMENT")
        if not os.path.isfile(value):
            raise BridgeError("No file at '{0}'".format(value), "NOT_FOUND")
        return value
    if type_ in ("parameter", "slot"):
        kind, obj, canonical = script._resolve(value)
        if kind != type_:
            raise BridgeError("{0} must be the address of a {1}, but '{2}' is a {3}".format(name, "device parameter" if type_ == "parameter" else "clip slot",
                                                                                          canonical, kind), "TYPE_ERROR")
        return obj
    if type_.startswith("enum:"):
        from . import properties
        names = properties._enum_names(type_[len("enum:"):])
        if not isinstance(value, str) or value not in names:
            raise BridgeError("{0} must be one of: {1}".format(name, ", ".join(sorted(names, key=names.get))), "INVALID_ARGUMENT")
        return names[value]
    raise BridgeError("Unsupported argument type {0}".format(type_), "INTERNAL_ERROR")


def _plain(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return str(value)
