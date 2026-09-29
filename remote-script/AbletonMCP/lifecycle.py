"""Creating, duplicating and deleting tracks, return tracks, scenes and clips.

Everything returns an address the caller can reuse. delete is destructive and demands an `expect` guard, because indices
shift after every earlier create/delete and a stale index is exactly how the wrong object gets removed.
"""
from .registry import BridgeError, command

CREATE_KINDS = ("audio_track", "midi_track", "return_track", "scene")


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
        if kind == "return_track":
            if params.get("index") not in (None, -1):
                raise BridgeError("return tracks are always appended: leave index out", "INVALID_ARGUMENT")
            created = song.create_return_track()
        else:
            index = self._position(params)
            limit = len(song.scenes if kind == "scene" else song.tracks)
            if index > limit:
                raise BridgeError("index {0} is beyond the end (0 to {1})".format(index, limit), "OUT_OF_RANGE")
            created = {"audio_track": song.create_audio_track, "midi_track": song.create_midi_track,
                       "scene": song.create_scene}[kind](index)
        if name is not None:
            created.name = name
        if color is not None:
            created.color = color
        # Live snaps colors to its palette, so report the color it actually applied
        return {"address": self._address_of(created), "name": created.name, "kind": kind,
                "color": getattr(created, "color", None)}

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
        elif kind == "clip":
            slot = self._resolve(canonical[: -len("/clip")])[1]
            slot.delete_clip()
        else:
            raise BridgeError("Only tracks, return tracks, scenes and clips can be deleted (got '{0}')".format(canonical),
                              "INVALID_ARGUMENT")
        return {"deleted": canonical, "name": name, "tracks": len(song.tracks), "returns": len(song.return_tracks),
                "scenes": len(song.scenes)}
