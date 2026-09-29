"""Creating, duplicating and deleting tracks, return tracks, scenes and clips.

Everything returns an address the caller can reuse. delete is destructive and demands an `expect` guard, because indices
shift after every earlier create/delete and a stale index is exactly how the wrong object gets removed.
"""
import os

from .helpers import _is_number
from .registry import BridgeError, command

CREATE_KINDS = ("audio_track", "midi_track", "return_track", "scene", "midi_clip", "audio_clip", "arrangement_midi_clip", "arrangement_audio_clip",
                "take_lane", "cue_point")


class LifecycleMixin(object):
    """create / duplicate / delete."""

    @staticmethod
    def _position(params, name="index"):
        """An optional insertion index; -1 (the default) appends."""
        value = params.get(name, -1)
        if value is None:
            return -1
        if isinstance(value, bool) or not isinstance(value, int) or value < -1:
            raise BridgeError("{0} must be -1 (append) or a position from 0".format(name), "INVALID_ARGUMENT")
        return value

    @command("create", writes=True)
    def _cmd_create(self, params):
        kind = params.get("kind")
        if kind not in CREATE_KINDS:
            raise BridgeError("kind must be one of: {0}".format(", ".join(CREATE_KINDS)), "INVALID_ARGUMENT")
        name, color = params.get("name"), params.get("color")
        if name is not None and not isinstance(name, str):
            raise BridgeError("name must be a string", "TYPE_ERROR")
        if color is not None and (isinstance(color, bool) or not isinstance(color, int)):
            raise BridgeError("color must be an RGB integer", "TYPE_ERROR")
        song = self._song
        if kind == "cue_point" and color is not None:
            raise BridgeError("cue points have no color", "INVALID_ARGUMENT")
        if kind == "midi_clip":
            created, address = self._create_midi_clip(params)
        elif kind == "audio_clip":
            created, address = self._create_audio_clip(params)
        elif kind in ("arrangement_midi_clip", "arrangement_audio_clip"):
            created, address = self._create_arrangement_clip(params, kind == "arrangement_audio_clip")
        elif kind == "take_lane":
            created, address = self._create_take_lane(params)
        elif kind == "cue_point":
            created, address = self._create_cue_point(params)
        elif kind == "return_track":
            if params.get("index") not in (None, -1):
                raise BridgeError("return tracks are always appended: leave index out", "INVALID_ARGUMENT")
            created = song.create_return_track()
            address = self._address_of(created)
        else:
            index = self._position(params)
            limit = len(song.scenes if kind == "scene" else song.tracks)
            if index > limit:
                raise BridgeError("index {0} is beyond the end (0 to {1})".format(index, limit), "OUT_OF_RANGE")
            created = {"audio_track": song.create_audio_track, "midi_track": song.create_midi_track,
                       "scene": song.create_scene}[kind](index)
            address = self._address_of(created)
        if name is not None:
            created.name = name
        if color is not None:
            created.color = color
        # Live snaps colors to its palette, so report the color it actually applied
        result = {"address": address, "name": created.name, "kind": kind, "color": getattr(created, "color", None)}
        if kind in ("midi_clip", "audio_clip", "arrangement_midi_clip", "arrangement_audio_clip"):
            result["length"] = created.length
        if kind in ("arrangement_midi_clip", "arrangement_audio_clip"):
            result["start_time"] = created.start_time
        if kind in ("audio_clip", "arrangement_audio_clip"):
            result.update({"file_path": created.file_path, "warping": created.warping})
        if kind == "cue_point":
            result["time"] = created.time
        return result

    def _create_audio_clip(self, params):
        """A clip in the empty slot at `address` that plays the audio file at `path` (an absolute path Live can read)."""
        slot_kind, slot, canonical = self._resolve(params.get("address"))
        if slot_kind != "slot":
            raise BridgeError("audio_clip needs address: the clip slot to fill (tracks/N/slots/M) on an audio track", "INVALID_ARGUMENT")
        if slot.has_clip:
            raise BridgeError("'{0}' already holds a clip: pick an empty slot or delete the clip first".format(canonical), "INVALID_ARGUMENT")
        path = params.get("path")
        if not isinstance(path, str) or not path:
            raise BridgeError("audio_clip needs path: the absolute path of an audio file", "INVALID_ARGUMENT")
        if not os.path.isabs(path):
            raise BridgeError("path must be absolute, got '{0}'".format(path), "INVALID_ARGUMENT")
        if not os.path.isfile(path):
            raise BridgeError("No file at '{0}'".format(path), "NOT_FOUND")
        clip = slot.create_audio_clip(path)
        return clip, canonical + "/clip"

    def _arrangement_owner(self, params, what):
        kind, owner, canonical = self._resolve(params.get("address"))
        if kind == "lane":
            return owner, canonical
        if kind != "track" or not canonical.startswith("tracks/") or canonical.count("/") != 1:
            raise BridgeError("{0} needs address: a regular track ('tracks/N') or one of its take lanes ('tracks/N/take_lanes/K'), got '{1}'".format(
                what, canonical), "INVALID_ARGUMENT")
        return owner, canonical

    def _create_arrangement_clip(self, params, audio):
        """A clip on the arrangement timeline of a track (or take lane) at `time` beats."""
        what = "arrangement_audio_clip" if audio else "arrangement_midi_clip"
        owner, _canonical = self._arrangement_owner(params, what)
        time = params.get("time")
        if not _is_number(time) or time < 0:
            raise BridgeError("{0} needs time: the start position in beats from 0".format(what), "INVALID_ARGUMENT")
        if audio:
            path = params.get("path")
            if not isinstance(path, str) or not os.path.isabs(path):
                raise BridgeError("{0} needs path: the absolute path of an audio file".format(what), "INVALID_ARGUMENT")
            if not os.path.isfile(path):
                raise BridgeError("No file at '{0}'".format(path), "NOT_FOUND")
            clip = owner.create_audio_clip(path, float(time))
        else:
            length = params.get("length", 4.0)
            if not _is_number(length) or length <= 0:
                raise BridgeError("length must be a positive number of beats", "INVALID_ARGUMENT")
            clip = owner.create_midi_clip(float(time), float(length))
        return clip, self._address_of(clip)

    def _create_take_lane(self, params):
        kind, track, canonical = self._resolve(params.get("address"))
        if kind != "track" or canonical.count("/") != 1 or not canonical.startswith("tracks/"):
            raise BridgeError("take_lane needs address: a regular track ('tracks/N')", "INVALID_ARGUMENT")
        lane = track.create_take_lane()
        return lane, self._address_of(lane)

    def _at_playhead(self, time, action):
        """Run `action` with the playhead at `time` (cue points can only be set or removed at the playhead), then put it back."""
        song = self._song
        if song.is_playing:
            raise BridgeError("Stop the transport first: cue points are set and removed at the playhead, which this has to move",
                              "UNAVAILABLE")
        original = song.current_song_time
        try:
            song.current_song_time = float(time)
            action()
        finally:
            song.current_song_time = original

    def _create_cue_point(self, params):
        time = params.get("time")
        if not _is_number(time) or time < 0:
            raise BridgeError("cue_point needs time: a position in beats from 0", "INVALID_ARGUMENT")
        song = self._song
        for cue in song.cue_points:
            if abs(cue.time - time) < 1e-6:
                raise BridgeError("There is already a cue point at beat {0:g}: '{1}'".format(time, cue.name), "INVALID_ARGUMENT")
        self._at_playhead(time, song.set_or_delete_cue)
        cues = list(song.cue_points)
        for index, cue in enumerate(cues):
            if abs(cue.time - time) < 1e-6:
                return cue, "cue_points/{0}".format(index)
        raise BridgeError("Live did not create a cue point at beat {0:g}".format(time), "LIVE_ERROR")

    def _create_midi_clip(self, params):
        """An empty MIDI clip of `length` beats in the empty clip slot at `address`."""
        slot_kind, slot, canonical = self._resolve(params.get("address"))
        if slot_kind != "slot":
            raise BridgeError("midi_clip needs address: the clip slot to fill (tracks/N/slots/M)", "INVALID_ARGUMENT")
        if slot.has_clip:
            raise BridgeError("'{0}' already holds a clip: pick an empty slot or delete the clip first".format(canonical), "INVALID_ARGUMENT")
        length = params.get("length", 4.0)
        if not _is_number(length) or length <= 0:
            raise BridgeError("length must be a positive number of beats", "INVALID_ARGUMENT")
        slot.create_clip(float(length))
        return slot.clip, canonical + "/clip"

    @command("duplicate", writes=True)
    def _cmd_duplicate(self, params):
        address = params.get("address")
        kind, obj, canonical = self._resolve(address)
        song = self._song
        if kind == "track" and canonical.startswith("tracks/"):
            index = int(canonical.split("/")[1])
            song.duplicate_track(index)
            new = "tracks/{0}".format(index + 1)
        elif kind == "scene":
            index = int(canonical.split("/")[1])
            song.duplicate_scene(index)
            new = "scenes/{0}".format(index + 1)
        elif kind == "slot":
            track_index, slot_index = int(canonical.split("/")[1]), int(canonical.split("/")[3])
            new_index = song.tracks[track_index].duplicate_clip_slot(slot_index)
            new = "tracks/{0}/slots/{1}".format(track_index, new_index)
        else:
            raise BridgeError("Only regular tracks, scenes and clip slots can be duplicated (got '{0}')".format(canonical),
                              "INVALID_ARGUMENT")
        return {"source": canonical, "address": new, "name": self._resolve(new)[1].name if kind != "slot" else None}

    @command("delete", writes=True, destructive=True)
    def _cmd_delete(self, params):
        kind, obj, canonical = self._resolve(params.get("address"))
        expect = params.get("expect")
        if not isinstance(expect, dict) or "name" not in expect:
            raise BridgeError("delete requires expect: {\"name\": <the object's current name>}. Read the object first "
                              "(describe_set / get_properties) so a stale index cannot delete the wrong one.", "INVALID_ARGUMENT")
        self._guard(obj, expect, canonical)
        song = self._song
        name = obj.name
        if canonical == "master":
            raise BridgeError("The master track cannot be deleted", "INVALID_ARGUMENT")
        if kind == "track" and canonical.startswith("tracks/"):
            song.delete_track(int(canonical.split("/")[1]))
        elif kind == "track":
            song.delete_return_track(int(canonical.split("/")[1]))
        elif kind == "scene":
            song.delete_scene(int(canonical.split("/")[1]))
        elif kind == "clip" and "/arrangement/" in canonical:
            track = self._resolve(canonical.split("/arrangement/")[0].split("/take_lanes/")[0])[1]
            track.delete_clip(obj)
        elif kind == "clip":
            slot = self._resolve(canonical[: -len("/clip")])[1]
            slot.delete_clip()
        elif kind == "cue":
            self._at_playhead(obj.time, song.set_or_delete_cue)
        else:
            raise BridgeError("Only tracks, return tracks, scenes, clips and cue points can be deleted (got '{0}')".format(canonical),
                              "INVALID_ARGUMENT")
        return {"deleted": canonical, "name": name, "tracks": len(song.tracks), "returns": len(song.return_tracks),
                "scenes": len(song.scenes), "cue_points": len(song.cue_points)}
