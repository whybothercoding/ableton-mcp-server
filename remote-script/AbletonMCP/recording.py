"""Recording: arrangement record, session record, overdub, punch and automation recording.

Recording can overwrite what is already in the Set, so the command is gated twice: the MCP tool needs ABLETON_MCP_ALLOW_RECORD=1
and the script itself needs the opt-in file ~/.ableton-mcp-server/allow_record. Every start needs at least one armed track: Live would otherwise "record" nothing. Nothing here is undoable step by step, which is why
it does not run inside a batch.
"""
from .helpers import _is_number, _safe_attr
from .registry import BridgeError, command

RECORD_ACTIONS = ("status", "arrangement_start", "arrangement_stop", "session_start", "session_stop", "overdub", "punch", "automation")


class RecordingMixin(object):
    """record."""

    def _armed_tracks(self):
        return ["tracks/{0}".format(i) for i, t in enumerate(self._song.tracks) if _safe_attr(t, "arm", False)]

    def _record_status(self, **just_set):
        """The recording state. Live applies a flag a moment AFTER the call that set it returns, so reading it back in the same call
        shows the old value: `just_set` carries the values this call asked for and they win over the read-back."""
        song = self._song
        status = {"record_mode": bool(song.record_mode), "session_record": bool(song.session_record),
                "session_record_status": _safe_attr(song, "session_record_status"), "arrangement_overdub": bool(song.arrangement_overdub),
                "punch_in": bool(song.punch_in), "punch_out": bool(song.punch_out),
                "session_automation_record": bool(song.session_automation_record), "is_playing": bool(song.is_playing),
                "is_counting_in": bool(_safe_attr(song, "is_counting_in", False)), "armed_tracks": self._armed_tracks()}
        status.update(just_set)
        return status

    @staticmethod
    def _flag(params, name, default=None):
        value = params.get(name, default)
        if value is not None and not isinstance(value, bool):
            raise BridgeError("{0} must be true or false".format(name), "TYPE_ERROR")
        return value

    def _playing_session_clips(self):
        """Addresses of the tracks that have a Session clip playing."""
        found = []
        for index, track in enumerate(self._song.tracks):
            for slot in (_safe_attr(track, "clip_slots") or []):
                if slot.has_clip and _safe_attr(slot.clip, "is_playing", False):
                    found.append("tracks/{0}".format(index))
                    break
        return found

    def _need_armed(self, action):
        armed = self._armed_tracks()
        if not armed:
            raise BridgeError("{0} needs at least one armed track: nothing would be recorded. Arm a track first "
                              "(set_properties arm: true on a track, or create a scratch track for it).".format(action), "UNAVAILABLE")
        return armed

    @command("record", gate="record")
    def _cmd_record(self, params):
        action, song = params.get("action", "status"), self._song
        if action not in RECORD_ACTIONS:
            raise BridgeError("action must be one of: {0}".format(", ".join(RECORD_ACTIONS)), "INVALID_ARGUMENT")
        if action == "status":
            return self._record_status()
        if action == "arrangement_start":
            armed = self._need_armed(action)
            if song.record_mode:
                raise BridgeError("Arrangement recording is already on", "UNAVAILABLE")
            start, play = params.get("from_time"), self._flag(params, "play", True)          # everything is checked before anything changes
            if start is not None and (not _is_number(start) or start < 0):
                raise BridgeError("from_time must be a position in beats from 0", "INVALID_ARGUMENT")
            if start is not None:
                song.current_song_time = float(start)
            song.record_mode = True
            if play:
                song.start_playing()
            # Live 12.4 starts the transport as soon as arrangement recording is switched on, whatever `play` says (proven: play=False still played)
            result = self._record_status(record_mode=True, is_playing=True)
            result["recording_into"] = armed
            result["note"] = "Live starts the transport as soon as arrangement recording is on; stop it with arrangement_stop (stop_transport: true)."
            playing = self._playing_session_clips()
            if playing:
                # Live records the Session clips that play during arrangement recording onto their own tracks' timelines, armed or not
                result["warning"] = ("Session clips are playing on {0}: while arrangement recording runs, Live also records them onto the timeline "
                                     "of their own tracks, armed or not. Stop them first, or stop recording with arrangement_stop.".format(", ".join(playing)))
            return result
        if action == "arrangement_stop":
            stop_transport = self._flag(params, "stop_transport", False)
            song.record_mode = False
            if stop_transport:
                song.stop_playing()
            return self._record_status(record_mode=False, **({"is_playing": False} if stop_transport else {}))
        if action == "session_start":
            armed = self._need_armed(action)
            if song.session_record:
                raise BridgeError("Session recording is already on", "UNAVAILABLE")
            length = params.get("record_length")
            if length is not None and (not _is_number(length) or length <= 0):
                raise BridgeError("record_length must be a positive number of beats", "INVALID_ARGUMENT")
            if length is None:
                song.trigger_session_record()
            else:
                song.trigger_session_record(float(length))
            result = self._record_status()
            result["recording_into"] = armed
            result["note"] = ("Live starts recording at its next launch-quantization boundary and the clip goes into the slot of the selected "
                              "scene: poll status until session_record is true, and until it is false again when record_length was given.")
            return result
        if action == "session_stop":
            song.session_record = False
            return self._record_status(session_record=False)
        if action == "overdub":
            enabled = self._flag(params, "enabled")
            if enabled is None:
                raise BridgeError("overdub needs enabled: true or false", "INVALID_ARGUMENT")
            song.arrangement_overdub = enabled
            return self._record_status(arrangement_overdub=enabled)
        elif action == "punch":
            punch_in, punch_out = self._flag(params, "punch_in"), self._flag(params, "punch_out")
            if punch_in is None and punch_out is None:
                raise BridgeError("punch needs punch_in and/or punch_out: true or false", "INVALID_ARGUMENT")
            if punch_in is not None:
                song.punch_in = punch_in
            if punch_out is not None:
                song.punch_out = punch_out
            return self._record_status(**dict((k, v) for k, v in (("punch_in", punch_in), ("punch_out", punch_out)) if v is not None))
        else:
            enabled = self._flag(params, "enabled")
            if enabled is None:
                raise BridgeError("automation needs enabled: true or false", "INVALID_ARGUMENT")
            song.session_automation_record = enabled
            return self._record_status(session_automation_record=enabled)
