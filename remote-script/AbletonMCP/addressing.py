"""Canonical string addresses for Live objects, and their reverse.

    song                     the Song
    tracks/3                 regular track 3 (0-based)      tracks/name:Drift   a track by exact name
    returns/0                return track 0                 master              the master track
    scenes/2                 scene 2                        scenes/name:Verse
    tracks/3/slots/1         clip slot 1 of track 3         tracks/3/slots/1/clip   the clip in it
    tracks/3/arrangement/2   arrangement clip 2 of track 3 (in time order)
    tracks/3/take_lanes/0    a take lane;  tracks/3/take_lanes/0/arrangement/1  a clip in it
    grooves/0                groove 0 of the groove pool    grooves/name:Swing 16ths 66
    cue_points/0             cue point 0 (by time order)    cue_points/name:Chorus
    app                      the Live application (CPU load, dialogs)

Views (what Live's window shows: selection, the Detail view, grids), none of it part of the Set:
    view                     the Song's view: selected track, scene, clip slot, Detail clip
    app/view                 the application's view: Session or Arranger in front, which panels are visible
    tracks/3/view            a track's view (also returns/N/view and master/view)
    tracks/3/slots/1/clip/view   a clip's view (also an arrangement clip: tracks/3/arrangement/2/view): grid
    tracks/3/devices/0/view  a device's view (also inside chains): collapsed, a rack's selected chain, an EQ Eight's band

A name selector must match exactly one object: no match is NOT_FOUND, several are AMBIGUOUS (the error lists the
candidates' indices). Every tool that creates or finds an object returns an address the caller can reuse.
"""
from .helpers import _as_index, _safe_attr
from .registry import BridgeError


class AddressingMixin(object):
    """Resolve addresses to Live objects and build addresses from objects."""

    def _resolve(self, address):
        """Return (kind, object, canonical_address). kind is song, track, scene, slot, clip, lane, groove, cue, app, device, chain, pad, parameter
        or sample, or one of the view kinds: view, app_view, track_view, clip_view, device_view."""
        if not isinstance(address, str) or not address.strip():
            raise BridgeError("address must be a non-empty string such as 'tracks/0/slots/1/clip'", "INVALID_ARGUMENT")
        parts = [p for p in address.strip().strip("/").split("/") if p != ""]
        head = parts[0]
        if head == "song" and len(parts) == 1:
            return "song", self._song, "song"
        if head == "master":
            if len(parts) == 1:
                return "track", self._song.master_track, "master"
            return self._resolve_track_tail(self._song.master_track, "master", parts[1:], address)
        if head == "scenes" and len(parts) == 2:
            index = self._select(self._song.scenes, parts[1], "scene", lambda s: s.name)
            return "scene", self._song.scenes[index], "scenes/{0}".format(index)
        if head == "view" and len(parts) == 1:
            return "view", self._song.view, "view"
        if head == "app" and len(parts) == 1:
            return "app", self.application(), "app"
        if head == "app" and parts[1:] == ["view"]:
            return "app_view", self.application().view, "app/view"
        if head == "cue_points" and len(parts) == 2:
            cues = list(self._song.cue_points)
            index = self._select(cues, parts[1], "cue point", lambda c: c.name)
            return "cue", cues[index], "cue_points/{0}".format(index)
        if head == "grooves" and len(parts) == 2:
            grooves = list(self._song.groove_pool.grooves)
            index = self._select(grooves, parts[1], "groove", lambda g: g.name)
            return "groove", grooves[index], "grooves/{0}".format(index)
        if head in ("tracks", "returns") and len(parts) >= 2:
            tracks = self._song.tracks if head == "tracks" else self._song.return_tracks
            label = "track" if head == "tracks" else "return track"
            index = self._select(tracks, parts[1], label, lambda t: t.name)
            track, canonical = tracks[index], "{0}/{1}".format(head, index)
            if len(parts) == 2:
                return "track", track, canonical
            if parts[2] in ("devices", "mixer", "view"):
                return self._resolve_track_tail(track, canonical, parts[2:], address)
            if head == "tracks" and parts[2] == "arrangement" and len(parts) in (4, 5):
                return self._resolve_arrangement_clip(track, canonical, parts[3], address, parts[4:])
            if head == "tracks" and parts[2] == "take_lanes" and len(parts) in (4, 6, 7):
                lanes = list(_safe_attr(track, "take_lanes", []))
                index = self._select(lanes, parts[3], "take lane", lambda l: l.name)
                lane, lane_address = lanes[index], "{0}/take_lanes/{1}".format(canonical, index)
                if len(parts) == 4:
                    return "lane", lane, lane_address
                if parts[4] != "arrangement":
                    raise BridgeError("Unknown address '{0}'".format(address), "NOT_FOUND")
                return self._resolve_arrangement_clip(lane, lane_address, parts[5], address, parts[6:])
            if head == "tracks" and parts[2] == "slots" and len(parts) in (4, 5, 6):
                slots = track.clip_slots
                slot_index = _as_index(self._number(parts[3], address), "slot index")
                if not 0 <= slot_index < len(slots):
                    raise BridgeError("Clip slot index out of range in '{0}'".format(address), "OUT_OF_RANGE")
                slot, canonical = slots[slot_index], "{0}/slots/{1}".format(canonical, slot_index)
                if len(parts) == 4:
                    return "slot", slot, canonical
                if parts[4] != "clip":
                    raise BridgeError("Unknown address '{0}'".format(address), "NOT_FOUND")
                if not slot.has_clip:
                    raise BridgeError("The clip slot in '{0}' is empty".format(address), "NOT_FOUND")
                return self._clip_or_view(slot.clip, canonical + "/clip", parts[5:], address)
        raise BridgeError("Unknown address '{0}'. Use song, master, tracks/N, returns/N, scenes/N, "
                          "tracks/N/slots/M[/clip], tracks/N/devices/M[/parameters/P | /chains/C/devices/...], grooves/N, cue_points/N, app, "
                          "view, app/view, <track|clip|device>/view, or a name: selector such as tracks/name:Drift".format(address), "NOT_FOUND")

    def _resolve_arrangement_clip(self, owner, canonical, token, address, tail=()):
        """A clip on the arrangement timeline of a track or take lane, by position in time order (or its view, with tail ['view'])."""
        clips = list(_safe_attr(owner, "arrangement_clips", []))
        index = self._select(clips, token, "arrangement clip", lambda c: c.name)
        return self._clip_or_view(clips[index], "{0}/arrangement/{1}".format(canonical, index), list(tail), address)

    @staticmethod
    def _clip_or_view(clip, canonical, tail, address):
        """The clip itself, or with tail ['view'] its view (grid settings)."""
        if not tail:
            return "clip", clip, canonical
        if list(tail) == ["view"]:
            return "clip_view", clip.view, canonical + "/view"
        raise BridgeError("Unknown address '{0}'".format(address), "NOT_FOUND")

    def _resolve_track_tail(self, track, canonical, rest, address):
        """Below a track (or the master): its device chain, mixer and view."""
        if rest[0] == "view" and len(rest) == 1:
            return "track_view", track.view, canonical + "/view"
        if rest[0] == "devices":
            return self._resolve_devices(track, canonical, rest, address)
        if rest[0] == "mixer":
            return self._resolve_mixer(track, canonical, rest, address)
        raise BridgeError("Unknown address '{0}'".format(address), "NOT_FOUND")

    @staticmethod
    def _number(text, address):
        try:
            return int(text)
        except ValueError:
            raise BridgeError("'{0}' is not a number in address '{1}'".format(text, address), "INVALID_ARGUMENT")

    def _select(self, items, token, label, name_of):
        """Pick an index from a list by number or by 'name:<exact name>'."""
        if token.startswith("name:"):
            wanted = token[len("name:"):]
            matches = [i for i, item in enumerate(items) if name_of(item) == wanted]
            if not matches:
                raise BridgeError("No {0} named '{1}'. Names: {2}".format(label, wanted, [name_of(i) for i in items]), "NOT_FOUND")
            if len(matches) > 1:
                raise BridgeError("{0} name '{1}' is ambiguous: indices {2}. Use the numeric index.".format(
                    label.capitalize(), wanted, matches), "AMBIGUOUS")
            return matches[0]
        index = self._number(token, token)
        if not 0 <= index < len(items):
            raise BridgeError("{0} index {1} out of range (0 to {2})".format(label.capitalize(), index, len(items) - 1), "OUT_OF_RANGE")
        return index

    def _address_of(self, obj):
        """The canonical address of a song, track, scene, clip slot, clip or groove (found by identity), or None."""
        song = self._song
        if obj == song:
            return "song"
        if obj == song.master_track:
            return "master"
        for i, track in enumerate(song.tracks):
            if obj == track:
                return "tracks/{0}".format(i)
            for j, clip in enumerate(_safe_attr(track, "arrangement_clips", [])):
                if obj == clip:
                    return "tracks/{0}/arrangement/{1}".format(i, j)
            for k, lane in enumerate(_safe_attr(track, "take_lanes", [])):
                if obj == lane:
                    return "tracks/{0}/take_lanes/{1}".format(i, k)
                for j, clip in enumerate(_safe_attr(lane, "arrangement_clips", [])):
                    if obj == clip:
                        return "tracks/{0}/take_lanes/{1}/arrangement/{2}".format(i, k, j)
            for j, slot in enumerate(_safe_attr(track, "clip_slots", [])):
                if obj == slot:
                    return "tracks/{0}/slots/{1}".format(i, j)
                if slot.has_clip and obj == slot.clip:
                    return "tracks/{0}/slots/{1}/clip".format(i, j)
        for i, track in enumerate(song.return_tracks):
            if obj == track:
                return "returns/{0}".format(i)
        for i, scene in enumerate(song.scenes):
            if obj == scene:
                return "scenes/{0}".format(i)
        for i, groove in enumerate(song.groove_pool.grooves):
            if obj == groove:
                return "grooves/{0}".format(i)
        for i, cue in enumerate(_safe_attr(song, "cue_points", [])):
            if obj == cue:
                return "cue_points/{0}".format(i)
        return self._address_of_lom(obj)

    def _guard(self, obj, expect, address):
        """Refuse to act on an object that no longer matches what the caller expected (index drift after deletes)."""
        if not expect:
            return
        if not isinstance(expect, dict):
            raise BridgeError("expect must be an object like {\"name\": \"Drift\"}", "INVALID_ARGUMENT")
        for key, wanted in expect.items():
            if key not in ("name", "class_name"):
                raise BridgeError("expect supports only 'name' and 'class_name', not '{0}'".format(key), "INVALID_ARGUMENT")
            actual = getattr(obj, key, None)
            if actual != wanted:
                raise BridgeError("Guard failed for '{0}': expected {1}={2!r} but found {3!r}. The Set may have changed; "
                                  "re-read it and retry.".format(address, key, wanted, actual), "GUARD_FAILED")
