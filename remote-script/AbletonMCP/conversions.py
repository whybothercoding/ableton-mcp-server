"""Live's audio-to-MIDI and Drum Rack conversions (Live.Conversions), which are edition dependent.

Each conversion creates a new track; the tool returns its address so the result can be used at once. Live's own refusals
(an edition without the feature, an audio clip it cannot analyse) come through unchanged.
"""
import Live

from .helpers import _safe_attr
from .registry import BridgeError, command

CONVERT_ACTIONS = ("check", "audio_to_midi", "simpler_track", "drum_rack_from_clip", "pad_to_track", "slice_to_drum_rack")
MIDI_TYPES = ("harmony", "melody", "drums")


class ConversionsMixin(object):
    """convert."""

    def _conversions(self):
        module = _safe_attr(Live, "Conversions")
        if module is None:
            raise BridgeError("This Live has no Conversions API", "UNAVAILABLE")
        return module

    def _new_tracks(self, before):
        song = self._song
        return [{"address": "tracks/{0}".format(i), "name": t.name, "devices": [d.name for d in t.devices], "device_classes": [d.class_name for d in t.devices],
                 "clips": [{"slot": j, "name": s.clip.name, "kind": "midi" if s.clip.is_midi_clip else "audio"}
                           for j, s in enumerate(_safe_attr(t, "clip_slots", [])) if s.has_clip]}
                for i, t in enumerate(song.tracks) if not any(t == b for b in before)]

    @command("convert", writes=True)
    def _cmd_convert(self, params):
        action = params.get("action")
        if action not in CONVERT_ACTIONS:
            raise BridgeError("action must be one of: {0}".format(", ".join(CONVERT_ACTIONS)), "INVALID_ARGUMENT")
        conversions = self._conversions()
        kind, obj, canonical = self._resolve(params.get("address"))
        song, before = self._song, list(self._song.tracks)

        if action in ("check", "audio_to_midi", "simpler_track", "drum_rack_from_clip"):
            if kind != "clip":
                raise BridgeError("{0} needs the address of an audio clip (tracks/N/slots/M/clip), got '{1}' which is a {2}".format(action, canonical, kind),
                                  "INVALID_ARGUMENT")
            if not obj.is_audio_clip:
                raise BridgeError("'{0}' is a MIDI clip: this converts audio clips".format(canonical), "INVALID_ARGUMENT")
            if action == "check":
                return {"address": canonical, "convertible_to_midi": bool(conversions.is_convertible_to_midi(song, obj))}
            if action == "audio_to_midi":
                midi_type = params.get("type")
                if midi_type not in MIDI_TYPES:
                    raise BridgeError("type must be one of: {0}".format(", ".join(MIDI_TYPES)), "INVALID_ARGUMENT")
                if not conversions.is_convertible_to_midi(song, obj):
                    raise BridgeError("Live cannot convert '{0}' to MIDI (too short, or nothing it can analyse)".format(canonical), "UNAVAILABLE")
                conversions.audio_to_midi_clip(song, obj, {"harmony": 0, "melody": 1, "drums": 2}[midi_type])
            elif action == "simpler_track":
                conversions.create_midi_track_with_simpler(song, obj)
            else:
                conversions.create_drum_rack_from_audio_clip(song, obj)
        elif action == "pad_to_track":
            if kind != "pad":
                raise BridgeError("pad_to_track needs the address of a drum pad, got '{0}' which is a {1}".format(canonical, kind), "INVALID_ARGUMENT")
            if not len(obj.chains):
                raise BridgeError("Drum pad '{0}' is empty: there is nothing to move to a track".format(canonical), "UNAVAILABLE")
            conversions.create_midi_track_from_drum_pad(song, obj)
        else:
            if kind != "device" or _safe_attr(obj, "class_name") != "OriginalSimpler":
                raise BridgeError("slice_to_drum_rack needs the address of a Simpler device in Slicing mode, got '{0}'".format(canonical), "INVALID_ARGUMENT")
            conversions.sliced_simpler_to_drum_rack(song, obj)
        created = self._new_tracks(before)
        result = {"action": action, "source": canonical, "new_tracks": created}
        if action == "audio_to_midi" and not created:
            # Live analyses the audio in the background: the new track shows up a moment after this call returns
            result["pending"] = True
        return result
