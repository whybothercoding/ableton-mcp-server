"""audio_snapshot: what is audible right now, in one read.

For every track, return track and the master: its output meters, the Session clip playing on it, whether it is effectively muted
(its own mute, or silenced because another track is soloed), its fader and where its output goes; plus the transport and Live's CPU
load. `notes` turn those facts into plain reasons why something that should sound does not. Nothing here is measured from the audio:
the meters are Live's own (0.85 is 0 dB on a fader, the scale is not calibrated to dBFS; a return track's meter reads 0 through the
API), so use bounce for real loudness.
"""
from . import properties
from .helpers import _safe_attr
from .registry import BridgeError, command

SILENT_FADER = 0.0001            # a track fader this low is -inf dB for practical purposes


def _display_name(routing):
    """The name the mixer shows for a RoutingType / RoutingChannel."""
    return _safe_attr(routing, "display_name")


def _device_type(device):
    try:
        return int(device.type)
    except Exception:
        return None


class AudioStateMixin(object):
    """audio_snapshot."""

    @command("audio_snapshot")
    def _cmd_audio_snapshot(self, params):
        scope = params.get("address", "song")
        song = self._song
        if scope == "song":
            owners = [("tracks/{0}".format(i), t) for i, t in enumerate(song.tracks)] + \
                     [("returns/{0}".format(i), t) for i, t in enumerate(song.return_tracks)] + [("master", song.master_track)]
        else:
            kind, track, canonical = self._resolve(scope)
            if kind != "track":
                raise BridgeError("address must be 'song', a track, a return track or 'master', got '{0}' which is a {1}".format(canonical, kind), "INVALID_ARGUMENT")
            owners = [(canonical, track)]
        instrument = properties._enum_names("Live.Device.DeviceType").get("instrument")
        someone_soloed = any(_safe_attr(t, "solo", False) for t in list(song.tracks) + list(song.return_tracks))
        rows, notes = [], []
        for address, track in owners:
            rows.append(self._audio_row(address, track, instrument, notes))
        playing = [r for r in rows if r.get("playing_clip")]
        if not song.is_playing and not playing:
            notes.append("The transport is stopped and no clip is playing: nothing is audible.")
        if playing and all(not (r["meter"]["left"] or r["meter"]["right"]) for r in rows if r["kind"] in ("midi", "audio", "group", "master")):
            notes.append("Clips are playing but every meter reads 0: Live may be in the background (its meters stop updating), or the output is silent.")
        app = self.application()
        return {"scope": scope,
                "transport": {"is_playing": bool(song.is_playing), "tempo": song.tempo, "current_song_time": song.current_song_time},
                "cpu": {"average": _safe_attr(app, "average_process_usage"), "peak": _safe_attr(app, "peak_process_usage")},
                "someone_is_soloed": bool(someone_soloed),
                "audible": [r["address"] for r in rows if r["audible"] and (r["meter"]["left"] or r["meter"]["right"])],
                "tracks": rows, "notes": notes,
                "meters": "Live's output meter units (0.85 is 0 dB on a fader, not calibrated to dBFS); a return track's meter reads 0 through the API"}

    def _audio_row(self, address, track, instrument, notes):
        mixer = _safe_attr(track, "mixer_device")
        volume = _safe_attr(mixer, "volume")
        fader = _safe_attr(volume, "value")
        kind = "master" if address == "master" else "return" if address.startswith("returns/") else \
            "group" if _safe_attr(track, "is_foldable", False) else "midi" if _safe_attr(track, "has_midi_input", False) else "audio"
        mute, silenced = bool(_safe_attr(track, "mute", False)), bool(_safe_attr(track, "muted_via_solo", False))
        clip = None
        for index, slot in enumerate(_safe_attr(track, "clip_slots", [])):
            if slot.has_clip and slot.clip.is_playing:
                clip = {"address": "{0}/slots/{1}/clip".format(address, index), "name": slot.clip.name, "midi": bool(_safe_attr(slot.clip, "is_midi_clip", False))}
                break
        devices = list(_safe_attr(track, "devices", []))
        has_instrument = any(_device_type(d) == instrument for d in devices) if instrument is not None else None
        row = {"address": address, "name": track.name, "kind": kind,
               "meter": {"left": _safe_attr(track, "output_meter_left", 0.0), "right": _safe_attr(track, "output_meter_right", 0.0)},
               "playing_clip": clip, "mute": mute, "silenced_by_solo": silenced, "solo": bool(_safe_attr(track, "solo", False)),
               "fader": fader, "fader_display": volume.str_for_value(fader) if volume is not None and fader is not None else None,
               "output": {"type": _display_name(_safe_attr(track, "output_routing_type")), "channel": _display_name(_safe_attr(track, "output_routing_channel"))},
               "device_count": len(devices)}
        row["audible"] = not mute and not silenced and (fader is None or fader > SILENT_FADER)
        label = "{0} '{1}'".format(address, track.name)
        if clip:
            if mute:
                notes.append("{0} plays '{1}' but is muted.".format(label, clip["name"]))
            elif silenced:
                notes.append("{0} plays '{1}' but another track is soloed, which silences it.".format(label, clip["name"]))
            if fader is not None and fader <= SILENT_FADER:
                notes.append("{0} plays '{1}' but its fader is at -inf.".format(label, clip["name"]))
            if kind == "midi" and clip["midi"] and has_instrument is False:
                notes.append("{0} plays a MIDI clip but has no instrument, so it makes no sound unless its MIDI output is routed to another track.".format(label))
        if kind == "master" and fader is not None and fader <= SILENT_FADER:
            notes.append("The master fader is at -inf: nothing is audible.")
        return row
