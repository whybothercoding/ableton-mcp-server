"""Set structure and capabilities, plus transport and undo/redo actions."""
import hashlib
import json

import Live

from . import config
from .helpers import _is_number, _safe_attr
from .registry import _COMMANDS, BridgeError, command, gates_status

# Song properties that describe the Set itself; playhead, play state and meters are deliberately left out so the
# fingerprint only changes when the Set really changes.
_STABLE_SONG = ("tempo", "signature_numerator", "signature_denominator", "loop", "loop_start", "loop_length",
                "root_note", "scale_name", "scale_mode", "groove_amount", "swing_amount", "metronome",
                "clip_trigger_quantization")

# Clip properties that are edited by hand and change how the Set plays, but are too bulky to list per clip. They feed the
# clip, track and Set hashes only (not the output), so a changed hash says "something about these clips changed". Anything
# that moves while playing (is_playing, playing_position, meters) stays out. Properties a clip type lacks read as None.
_CLIP_SETTINGS = ("launch_mode", "launch_quantization", "legato", "looping", "loop_start", "loop_end", "start_marker",
                  "end_marker", "color", "velocity_amount", "warping", "warp_mode", "gain", "pitch_coarse", "pitch_fine")

TRANSPORT_ACTIONS = ("play", "continue", "stop", "stop_all_clips", "tap_tempo", "jump_by", "next_cue", "prev_cue",
                     "toggle_cue", "capture_midi", "capture_and_insert_scene")


def _digest(value):
    return hashlib.sha1(json.dumps(value, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:12]


def _plain(value):
    """A JSON-friendly copy of a property value: Live enums become their names, plain values are returned as they are."""
    if value is None or type(value) in (bool, int, float, str):
        return value
    return str(value)


def _stable(value):
    """A hashable copy of a property value with float noise rounded away."""
    return round(value, 5) if isinstance(value, float) else value


def _notes_summary(clip):
    """(note_count, notes_hash) of a MIDI clip, or (None, None) when the API cannot read notes.

    The hash covers every note field (pitch, timing, velocity, mute, probability, deviations), so editing, moving or
    transposing notes changes it even when the note count stays the same. Notes outside the loop are included."""
    if not hasattr(clip, "get_all_notes_extended"):
        return None, None
    rows = sorted((n.pitch, round(n.start_time, 5), round(n.duration, 5), round(n.velocity, 3), bool(n.mute),
                   round(_safe_attr(n, "probability", 1.0), 3), round(_safe_attr(n, "velocity_deviation", 0.0), 3),
                   round(_safe_attr(n, "release_velocity", 64.0), 3)) for n in clip.get_all_notes_extended())
    return len(rows), _digest(rows)


def _clip_settings(clip):
    settings = dict((name, _stable(_safe_attr(clip, name))) for name in _CLIP_SETTINGS)
    settings["groove"] = _safe_attr(_safe_attr(clip, "groove"), "name")
    return settings


def _track_extras(track, slots):
    """Track settings that change the Set but are not listed by describe_set; they feed the track hash only."""
    mixer = _safe_attr(track, "mixer_device")
    routing = dict((name, _safe_attr(_safe_attr(track, name), "display_name"))
                   for name in ("input_routing_type", "input_routing_channel", "output_routing_type", "output_routing_channel"))
    return {
        "sends": [round(s.value, 4) for s in (_safe_attr(mixer, "sends") or [])],
        "crossfade_assign": _stable(_safe_attr(mixer, "crossfade_assign")),
        "devices_off": [d.name for d in track.devices if not _safe_attr(d, "is_active", True)],
        "no_stop_button": [i for i, s in enumerate(slots or []) if not _safe_attr(s, "has_stop_button", True)],
        "routing": routing,
    }


class StructureMixin(object):
    """describe_set, get_capabilities, transport, history."""

    # ---- describe_set

    def _track_summary(self, track, address, kind, include_clips):
        info = {
            "address": address,
            "name": track.name,
            "kind": kind,
            "color": _safe_attr(track, "color"),
            "mute": _safe_attr(track, "mute", False),
            "solo": _safe_attr(track, "solo", False),
            "volume": round(track.mixer_device.volume.value, 4),
            "panning": round(track.mixer_device.panning.value, 4),
            "devices": [d.name for d in track.devices],
        }
        if kind in ("midi", "audio", "group"):
            info["arm"] = bool(_safe_attr(track, "arm", False))
            info["group"] = track.group_track.name if _safe_attr(track, "is_grouped", False) and _safe_attr(track, "group_track") else None
        slots = _safe_attr(track, "clip_slots")
        if slots is not None:
            clips, hashed = [], []
            for index, slot in enumerate(slots):
                if not slot.has_clip:
                    continue
                clip = slot.clip
                entry = {"slot": index, "name": clip.name, "length": clip.length, "muted": _safe_attr(clip, "muted", False),
                         "kind": "midi" if _safe_attr(clip, "is_midi_clip", False) else "audio"}
                if entry["kind"] == "midi":
                    entry["note_count"], notes_hash = _notes_summary(clip)
                    if notes_hash is not None:
                        entry["notes_hash"] = notes_hash
                clips.append(entry)
                hashed.append(dict(entry, settings=_clip_settings(clip)))
            info["clip_count"] = len(clips)
            if include_clips:
                info["clips"] = clips
            info["clips_hash"] = _digest(hashed)
        arrangement = _safe_attr(track, "arrangement_clips")
        if arrangement is not None:
            timeline = []
            for i, c in enumerate(arrangement):
                entry = {"index": i, "name": c.name, "start": c.start_time, "length": c.length,
                         "kind": "midi" if _safe_attr(c, "is_midi_clip", False) else "audio"}
                if entry["kind"] == "midi":
                    notes_hash = _notes_summary(c)[1]
                    if notes_hash is not None:
                        entry["notes_hash"] = notes_hash
                timeline.append(entry)
            info["arrangement_count"] = len(timeline)
            if include_clips:
                info["arrangement"] = timeline
            info["arrangement_hash"] = _digest(timeline)
        hashed_info = dict((k, v) for k, v in info.items() if k not in ("clips", "arrangement"))
        hashed_info["extras"] = _track_extras(track, slots)
        info["hash"] = _digest(hashed_info)
        return info

    def _track_kind(self, track):
        if _safe_attr(track, "is_foldable", False):
            return "group"
        if _safe_attr(track, "has_midi_input", False):
            return "midi"
        return "audio"

    def _describe_set(self, include_clips=True):
        song = self._song
        summaries = {
            "tracks": [self._track_summary(t, "tracks/{0}".format(i), self._track_kind(t), include_clips) for i, t in enumerate(song.tracks)],
            "returns": [self._track_summary(t, "returns/{0}".format(i), "return", include_clips) for i, t in enumerate(song.return_tracks)],
            "master": self._track_summary(song.master_track, "master", "master", include_clips),
        }
        scenes = []
        for index, scene in enumerate(song.scenes):
            scenes.append({"address": "scenes/{0}".format(index), "name": scene.name, "tempo": _safe_attr(scene, "tempo"),
                           "tempo_enabled": _safe_attr(scene, "tempo_enabled", False),
                           "time_signature_enabled": _safe_attr(scene, "time_signature_enabled", False)})
        cues = [{"address": "cue_points/{0}".format(i), "name": c.name, "time": c.time}
                for i, c in enumerate(_safe_attr(song, "cue_points", []))]
        stable = dict((name, _plain(_safe_attr(song, name))) for name in _STABLE_SONG)
        fingerprint = _digest({"song": stable, "tracks": [t["hash"] for t in summaries["tracks"]],
                               "returns": [t["hash"] for t in summaries["returns"]], "master": summaries["master"]["hash"],
                               "scenes": scenes, "cue_points": cues})
        result = {"fingerprint": fingerprint, "song": dict(stable, is_playing=bool(_safe_attr(song, "is_playing", False))),
                  "scenes": scenes, "cue_points": cues}
        result.update(summaries)
        return result

    @command("describe_set")
    def _cmd_describe_set(self, params):
        return self._describe_set(params.get("include_clips", True))

    # ---- get_capabilities

    def _child_names(self, root):
        try:
            return [child.name for child in root.children]
        except Exception:
            return []

    def _get_capabilities(self):
        app = self.application()
        variant = app.get_variant()
        try:
            names = _safe_attr(Live.Application.UnavailableFeature, "names", {})
            by_value = dict((int(v), k) for k, v in names.items())
            unavailable = [by_value.get(int(f), int(f)) for f in app.unavailable_features]
        except Exception:
            unavailable = []
        browser = app.browser
        instruments = self._child_names(browser.instruments)
        effects = self._child_names(browser.audio_effects)
        return {
            "script": {"version": config.SCRIPT_VERSION, "build_id": getattr(self, "build_id", None)},
            "live": {
                "version": app.get_version_string(),
                "build": app.get_build_id(),
                "variant": variant,
                # A beta build reports "Beta" instead of its edition, so the edition is unknown: use `features`.
                "edition": "unknown" if variant == "Beta" else variant,
                "unavailable_features": unavailable,
            },
            "features": {
                "max_for_live": len(self._child_names(browser.max_for_live)) > 0,
                "conversions": hasattr(Live, "Conversions"),
                "note_probabilities": "note_velocity_ranges_and_probabilities" not in unavailable,
                "devices": {"Meld": "Meld" in instruments, "Roar": "Roar" in effects},
            },
            "commands": sorted(_COMMANDS),
            "gates": gates_status(),
        }

    @command("get_capabilities")
    def _cmd_get_capabilities(self, params):
        return self._get_capabilities()

    # ---- transport and history

    def _transport_state(self, action):
        song = self._song
        return {"action": action, "is_playing": bool(song.is_playing), "current_song_time": song.current_song_time,
                "tempo": song.tempo, "can_undo": bool(song.can_undo), "can_redo": bool(song.can_redo)}

    @command("transport", writes=True)
    def _cmd_transport(self, params):
        action, amount, song = params.get("action"), params.get("amount"), self._song
        if action not in TRANSPORT_ACTIONS:
            raise BridgeError("action must be one of: {0}".format(", ".join(TRANSPORT_ACTIONS)), "INVALID_ARGUMENT")
        if action == "jump_by":
            if not _is_number(amount):
                raise BridgeError("jump_by needs amount: the number of beats to jump (negative jumps back)", "INVALID_ARGUMENT")
            song.jump_by(float(amount))
        elif action == "play":
            song.start_playing()
        elif action == "continue":
            song.continue_playing()
        elif action == "stop":
            song.stop_playing()
        elif action == "stop_all_clips":
            song.stop_all_clips()
        elif action == "tap_tempo":
            song.tap_tempo()
        elif action == "next_cue":
            if not song.can_jump_to_next_cue:
                raise BridgeError("There is no next cue point", "UNAVAILABLE")
            song.jump_to_next_cue()
        elif action == "prev_cue":
            if not song.can_jump_to_prev_cue:
                raise BridgeError("There is no previous cue point", "UNAVAILABLE")
            song.jump_to_prev_cue()
        elif action == "toggle_cue":
            song.set_or_delete_cue()
        elif action == "capture_midi":
            if not song.can_capture_midi:
                raise BridgeError("There is no recently played MIDI to capture", "UNAVAILABLE")
            song.capture_midi()
        elif action == "capture_and_insert_scene":
            song.capture_and_insert_scene()
        return self._transport_state(action)

    @command("history")
    def _cmd_history(self, params):
        # Not a writing command: it must run outside an undo step of its own.
        action, steps, song = params.get("action"), params.get("steps", 1), self._song
        if action not in ("undo", "redo"):
            raise BridgeError("action must be 'undo' or 'redo'", "INVALID_ARGUMENT")
        if isinstance(steps, bool) or not isinstance(steps, int) or not 1 <= steps <= 50:
            raise BridgeError("steps must be a whole number from 1 to 50", "INVALID_ARGUMENT")
        performed = []
        for _ in range(steps):
            if not (song.can_undo if action == "undo" else song.can_redo):
                break
            performed.append(song.undo() if action == "undo" else song.redo())
        if not performed:
            raise BridgeError("Nothing to {0}".format(action), "UNAVAILABLE")
        return {"action": action, "performed": len(performed), "steps": performed,
                "can_undo": bool(song.can_undo), "can_redo": bool(song.can_redo)}
