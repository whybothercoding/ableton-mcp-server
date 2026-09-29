"""Launching (clips, scenes, stopping) and in-place clip operations (crop, duplicate loop, quantize, scrub).

Both take an address. `launch` never edits the Set; `clip_action` rewrites clip content in place, which is why it runs in
its own undo step and accepts an `expect` guard like the other writing commands.
"""
import Live

from . import properties
from .helpers import _is_number, _safe_attr
from .registry import BridgeError, command

# ClipSlot.fire takes positional optionals; these are Live's "not passed" values (see its docstring)
_NO_RECORD_LENGTH = 1.7976931348623157e+308
_NO_QUANTIZATION = -2147483648

LAUNCH_ACTIONS = ("fire", "stop")
CLIP_ACTIONS = ("crop", "duplicate_loop", "quantize", "quantize_pitch", "scrub", "stop_scrub", "move_playing_pos", "add_warp_marker",
                "move_warp_marker", "remove_warp_marker", "to_arrangement")


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


def _warp_markers(clip):
    return [{"beat_time": m.beat_time, "sample_time": m.sample_time} for m in clip.warp_markers]


def _sample_time_at(clip, beat):
    """Where in the file a new marker at `beat` belongs so that adding it changes nothing: interpolate between its neighbours."""
    markers = sorted(_warp_markers(clip), key=lambda m: m["beat_time"])
    if not markers:
        raise BridgeError("The clip has no warp markers to place a new one against: warp it first", "UNAVAILABLE")
    for left, right in zip(markers, markers[1:]):
        if left["beat_time"] - 1e-9 <= beat <= right["beat_time"] + 1e-9 and right["beat_time"] > left["beat_time"]:
            span = (beat - left["beat_time"]) / (right["beat_time"] - left["beat_time"])
            return left["sample_time"] + span * (right["sample_time"] - left["sample_time"])
    raise BridgeError("beat_time {0:g} is outside the warped range ({1:g} to {2:g}): give sample_time too".format(
        beat, markers[0]["beat_time"], markers[-1]["beat_time"]), "OUT_OF_RANGE")


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

        if kind == "clip" and "/arrangement/" in canonical:
            raise BridgeError("'{0}' is on the arrangement timeline: only Session clips launch (playback of the arrangement is transport play)".format(canonical),
                              "INVALID_ARGUMENT")
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
        elif action == "to_arrangement":
            return self._to_arrangement(clip, canonical, params)
        elif action in ("add_warp_marker", "move_warp_marker", "remove_warp_marker"):
            self._warp_marker_action(clip, action, params)
        elif action == "move_playing_pos":
            amount = params.get("amount")
            if not _is_number(amount):
                raise BridgeError("move_playing_pos needs amount: the number of beats to move the playing position by", "INVALID_ARGUMENT")
            clip.move_playing_pos(float(amount))
        result = {"address": canonical, "action": action, "length": clip.length, "loop_start": clip.loop_start,
                  "loop_end": clip.loop_end, "is_playing": bool(clip.is_playing)}
        if action.endswith("warp_marker"):
            result["warp_markers"] = _warp_markers(clip)
        return result

    def _to_arrangement(self, clip, canonical, params):
        """Copy a Session clip onto the arrangement timeline of its track. A clip with automation envelopes brings them along as
        track automation, which is how arrangement automation is written (Live has no envelope API for arrangement clips)."""
        if "/arrangement/" in canonical:
            raise BridgeError("'{0}' is already on the arrangement: give a Session clip".format(canonical), "INVALID_ARGUMENT")
        time = params.get("time")
        if not _is_number(time) or time < 0:
            raise BridgeError("to_arrangement needs time: the start position in beats on the arrangement", "INVALID_ARGUMENT")
        track_address = canonical.split("/slots/")[0]
        track = self._resolve(track_address)[1]
        automated = [envelope.parameter for envelope in _safe_attr(clip, "automation_envelopes", [])]
        copy = track.duplicate_clip_to_arrangement(clip, float(time))
        # The envelopes do not stay on the copy: Live turns them into the track's arrangement automation, which shows as the
        # parameters' automation_state (1 = automation is playing).
        return {"address": self._address_of(copy), "source": canonical, "action": "to_arrangement", "start_time": copy.start_time,
                "length": copy.length,
                "automation": [{"parameter": self._address_of(p), "name": p.name, "automation_state": p.automation_state} for p in automated]}

    def _warp_marker_action(self, clip, action, params):
        if not clip.is_audio_clip:
            raise BridgeError("Warp markers exist only on audio clips", "INVALID_ARGUMENT")
        beat = params.get("beat_time")
        if not _is_number(beat) or beat < 0:
            raise BridgeError("{0} needs beat_time: a position in beats".format(action), "INVALID_ARGUMENT")
        beat = float(beat)
        if action == "remove_warp_marker":
            clip.remove_warp_marker(beat)
        elif action == "move_warp_marker":
            distance = params.get("distance")
            if not _is_number(distance):
                raise BridgeError("move_warp_marker needs distance: how many beats to move the marker (negative moves it earlier)", "INVALID_ARGUMENT")
            clip.move_warp_marker(beat, float(distance))
        else:
            sample = params.get("sample_time")
            if sample is None:
                sample = _sample_time_at(clip, beat)
            elif not _is_number(sample) or sample < 0:
                raise BridgeError("sample_time must be a position in the audio file in seconds", "INVALID_ARGUMENT")
            clip.add_warp_marker(Live.Clip.WarpMarker(float(sample), beat))
