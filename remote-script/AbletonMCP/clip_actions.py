"""Launching (clips, scenes, stopping) and in-place clip operations (crop, duplicate loop, quantize, scrub).

Both take an address. `launch` never edits the Set; `clip_action` rewrites clip content in place, which is why it runs in
its own undo step and accepts an `expect` guard like the other writing commands.
"""
from . import properties
from .helpers import _is_number
from .registry import BridgeError, command

# ClipSlot.fire takes positional optionals; these are Live's "not passed" values (see its docstring)
_NO_RECORD_LENGTH = 1.7976931348623157e+308
_NO_QUANTIZATION = -2147483648

LAUNCH_ACTIONS = ("fire", "stop")
CLIP_ACTIONS = ("crop", "duplicate_loop", "quantize", "quantize_pitch", "scrub", "stop_scrub", "move_playing_pos")


def _grid(value):
    """A record-quantization grid by name (rec_q_sixtenth...), to the int Clip.quantize takes."""
    names = properties._enum_names("Live.Song.RecordingQuantization")
    if not isinstance(value, str) or value not in names:
        raise BridgeError("grid must be one of: {0}".format(", ".join(sorted(names, key=names.get))), "INVALID_ARGUMENT")
    if names[value] == 0:
        raise BridgeError("grid 'rec_q_no_q' means no quantization: pick a real grid", "INVALID_ARGUMENT")
    return names[value]


def _amount(params, name="amount", default=1.0):
    value = params.get(name, default)
    if not _is_number(value):
        raise BridgeError("{0} must be a number".format(name), "TYPE_ERROR")
    if not 0.0 <= value <= 1.0:
        raise BridgeError("{0} {1} is outside 0 to 1".format(name, value), "OUT_OF_RANGE")
    return float(value)


class ClipActionsMixin(object):
    """launch and clip_action."""

    # ---- launch

    @staticmethod
    def _launch_state(kind, obj):
        if kind == "scene":
            return {"is_triggered": bool(obj.is_triggered)}
        if kind == "track":
            return {"playing_slot_index": obj.playing_slot_index, "fired_slot_index": obj.fired_slot_index}
        return {"is_playing": bool(obj.is_playing), "is_triggered": bool(obj.is_triggered), "is_recording": bool(obj.is_recording)}

    @command("launch", writes=True)
    def _cmd_launch(self, params):
        action = params.get("action", "fire")
        if action not in LAUNCH_ACTIONS:
            raise BridgeError("action must be one of: {0}".format(", ".join(LAUNCH_ACTIONS)), "INVALID_ARGUMENT")
        kind, obj, canonical = self._resolve(params.get("address"))
        quantized = params.get("quantized", True)
        if not isinstance(quantized, bool):
            raise BridgeError("quantized must be true or false", "TYPE_ERROR")
        legato, record_length, quantization = params.get("legato"), params.get("record_length"), params.get("quantization")
        if legato is not None and not isinstance(legato, bool):
            raise BridgeError("legato must be true or false", "TYPE_ERROR")
        if record_length is not None and (not _is_number(record_length) or record_length <= 0):
            raise BridgeError("record_length must be a positive number of beats", "INVALID_ARGUMENT")
        launch_quantization = None
        if quantization is not None:
            names = properties._enum_names("Live.Song.Quantization")
            if quantization not in names:
                raise BridgeError("quantization must be one of: {0}".format(", ".join(sorted(names, key=names.get))), "INVALID_ARGUMENT")
            launch_quantization = names[quantization]
        select = params.get("select", True)
        if not isinstance(select, bool):
            raise BridgeError("select must be true or false", "TYPE_ERROR")

        if kind == "clip":                       # a clip is launched through the slot that owns it
            canonical = canonical[: -len("/clip")]
            kind, obj = "slot", self._resolve(canonical)[1]
        options = legato is not None or record_length is not None or launch_quantization is not None
        if kind == "slot":
            if action == "stop":
                obj.stop()
            elif options:
                obj.fire(float(record_length) if record_length is not None else _NO_RECORD_LENGTH,
                         launch_quantization if launch_quantization is not None else _NO_QUANTIZATION,
                         bool(legato))
            else:
                obj.fire()
        elif kind == "scene":
            if action == "stop":
                raise BridgeError("A scene cannot be stopped: stop the song ('song') or a track ('tracks/N')", "INVALID_ARGUMENT")
            if record_length is not None or launch_quantization is not None:
                raise BridgeError("Scenes launch with legato and select only", "INVALID_ARGUMENT")
            obj.fire(bool(legato), select)
        elif kind == "cue":
            if action == "stop":
                raise BridgeError("A cue point cannot be stopped: launching it jumps the playhead there", "INVALID_ARGUMENT")
            obj.jump()
        elif kind == "track" and canonical.startswith("tracks/"):
            if action == "fire":
                raise BridgeError("A track cannot be fired: launch a clip slot ('tracks/N/slots/M') or a scene", "INVALID_ARGUMENT")
            obj.stop_all_clips(quantized)
        elif kind == "song":
            if action == "fire":
                raise BridgeError("The song cannot be fired: use transport 'play', or launch a scene", "INVALID_ARGUMENT")
            obj.stop_all_clips(quantized)
        else:
            raise BridgeError("Cannot {0} '{1}': launch clip slots, clips and scenes; stop tracks (tracks/N) or the song".format(
                action, canonical), "INVALID_ARGUMENT")
        return {"address": canonical, "action": action, "state": self._launch_state(kind, obj) if kind not in ("song", "cue") else {}}

    # ---- clip_action

    @command("clip_action", writes=True)
    def _cmd_clip_action(self, params):
        action = params.get("action")
        if action not in CLIP_ACTIONS:
            raise BridgeError("action must be one of: {0}".format(", ".join(CLIP_ACTIONS)), "INVALID_ARGUMENT")
        kind, clip, canonical = self._resolve(params.get("address"))
        if kind != "clip":
            raise BridgeError("clip_action needs the address of a clip (tracks/N/slots/M/clip), got '{0}'".format(canonical), "INVALID_ARGUMENT")
        self._guard(clip, params.get("expect"), canonical)
        if action == "crop":
            clip.crop()
        elif action == "duplicate_loop":
            clip.duplicate_loop()
        elif action == "quantize":
            clip.quantize(_grid(params.get("grid")), _amount(params))
        elif action == "quantize_pitch":
            pitch = params.get("pitch")
            if isinstance(pitch, bool) or not isinstance(pitch, int) or not 0 <= pitch <= 127:
                raise BridgeError("quantize_pitch needs pitch: a MIDI note number 0 to 127", "INVALID_ARGUMENT")
            clip.quantize_pitch(pitch, _grid(params.get("grid")), _amount(params))
        elif action == "scrub":
            position = params.get("position")
            if not _is_number(position) or position < 0:
                raise BridgeError("scrub needs position: a time in beats from the clip start", "INVALID_ARGUMENT")
            clip.scrub(float(position))
        elif action == "stop_scrub":
            clip.stop_scrub()
        elif action == "move_playing_pos":
            amount = params.get("amount")
            if not _is_number(amount):
                raise BridgeError("move_playing_pos needs amount: the number of beats to move the playing position by", "INVALID_ARGUMENT")
            clip.move_playing_pos(float(amount))
        return {"address": canonical, "action": action, "length": clip.length, "loop_start": clip.loop_start,
                "loop_end": clip.loop_end, "is_playing": bool(clip.is_playing)}
