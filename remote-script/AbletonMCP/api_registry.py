"""The generated API registry (registry_data.json, built from docs/live-api/<version>.json by scripts/build-registry.mjs).

It records, for the classes the property engine covers, every property's getter/setter type as Live reports it, and the
enum tables the overlay refers to. Tests check the curated property table against it; list_properties uses it to show
what exists but is not exposed yet.
"""
import json
import os

_DATA = None

# property engine kinds -> Live classes
KIND_CLASSES = {"song": "Live.Song.Song", "track": "Live.Track.Track", "scene": "Live.Scene.Scene",
                "slot": "Live.ClipSlot.ClipSlot", "clip": "Live.Clip.Clip",
                "groove": "Live.Groove.Groove", "cue": "Live.Song.CuePoint", "app": "Live.Application.Application",
                "device": "Live.RackDevice.RackDevice", "chain": "Live.Chain.Chain", "pad": "Live.DrumPad.DrumPad",
                "parameter": "Live.DeviceParameter.DeviceParameter", "lane": "Live.TakeLane.TakeLane", "sample": "Live.Sample.Sample",
                "view": "Live.Song.Song.View", "app_view": "Live.Application.Application.View", "track_view": "Live.Track.Track.View",
                "clip_view": "Live.Clip.Clip.View", "device_view": "Live.Device.Device.View"}


def data():
    global _DATA
    if _DATA is None:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "registry_data.json")) as handle:
            _DATA = json.load(handle)
    return _DATA


def class_properties(qualname):
    """name -> {"get": type, "set": type or None} for a covered class."""
    return data()["classes"][qualname]["properties"]


def enum_table(qualname):
    return data()["enums"][qualname]


def family(type_name):
    """Collapse Boost type names into the families the property engine uses."""
    if type_name in ("float", "double"):
        return "float"
    if type_name in ("int", "bool", "str"):
        return type_name
    if type_name == "object":
        return "object"  # Live reports TString setters and nullable colour indices as `object`: any scalar fits
    if type_name == "tuple" or (type_name and type_name.startswith("Base.") and type_name.endswith("Vector")):
        return "list"
    if type_name and "Live." + type_name in data()["enums"]:
        return "enum"
    if type_name and "." in type_name and type_name.split(".")[0] in ("Song", "Clip", "Track", "Scene"):
        module, name = type_name.split(".", 1)
        return "ref" if name == module else "enum"        # Track.Track is an object (a selected track); Clip.GridQuantization is an enum
    return "ref"
