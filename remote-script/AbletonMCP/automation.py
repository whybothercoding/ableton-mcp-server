"""Clip automation envelopes and timer-driven parameter ramps."""

import Live
from . import config
from . import clock
from .registry import command
from .helpers import _as_index
from .helpers import _is_number
from .curves import _EPS
from .curves import CURVES
from .curves import _ease
from .curves import _normalize_points
from .curves import _build_steps
from .curves import _build_breakpoints
from .curves import _eval_breakpoints
from .helpers import _safe_attr
from .registry import BridgeError
from .device_addressing import MIXER_PARAMETERS

# action -> the method that does it (the writing `automation` command)
AUTOMATION_ACTIONS = {"draw": "_draw_automation", "clear": "_clear_automation", "ramp": "_ramp_parameter", "cancel": "_cancel_ramps"}
AUTOMATION_REQUIRED = {"draw": ("clip", "parameter", "points"), "clear": ("clip",), "ramp": ("parameter", "to"), "cancel": ()}      # as addresses; the old index forms stay with the old commands
AUTOMATION_STATES = {1: "playing", 2: "overridden"}


class AutomationMixin(object):
    """Clip automation envelopes and timer-driven parameter ramps."""

    @command("draw_automation", writes=True)
    def _cmd_draw_automation(self, params):
        return self._draw_automation(params)

    @command("clear_automation", writes=True, destructive=True)
    def _cmd_clear_automation(self, params):
        return self._clear_automation(params)

    @command("ramp_parameter", writes=True)
    def _cmd_ramp_parameter(self, params):
        return self._ramp_parameter(params)

    @command("cancel_ramps")
    def _cmd_cancel_ramps(self, params):
        return self._cancel_ramps(params)

    @command("automation", writes=True, destructive=True)
    def _cmd_automation(self, params):
        """The writing automation tool in one command: draw / clear a Session clip's envelopes, ramp a parameter now, cancel ramps."""
        action = params.get("action")
        if action not in AUTOMATION_ACTIONS:
            raise BridgeError("action must be one of: {0}".format(", ".join(AUTOMATION_ACTIONS)), "INVALID_ARGUMENT")
        missing = [key for key in AUTOMATION_REQUIRED[action] if params.get(key) is None]
        if missing:
            raise BridgeError("automation {0} needs {1}".format(action, ", ".join(AUTOMATION_REQUIRED[action])), "INVALID_ARGUMENT", {"missing": missing})
        rest = dict((key, value) for key, value in params.items() if key != "action")
        return getattr(self, AUTOMATION_ACTIONS[action])(rest)

    @command("get_automation")
    def _cmd_get_automation(self, params):
        """A Session clip's envelopes, or (no clip given) which parameters of the whole Set are automated."""
        if params.get("clip") is None and params.get("track_index") is None:
            return self._automation_overview(params)
        return self._get_automation(params)

    def _automation_overview(self, params):
        """Every parameter that has automation now (automation_state 1: playing, 2: overridden by a hand or bridge write) in `address` (a track,
        return track, 'master', or 'song' for all), and the Session clips that carry envelopes with the parameters those control. Arrangement
        automation shows up as automation_state 1 on its parameter; its breakpoints cannot be read through Live's API."""
        scope = params.get("address", "song")
        limit = params.get("max_items", 500)
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
            raise BridgeError("max_items must be a whole number from 1", "INVALID_ARGUMENT")
        if scope == "song":
            owners = [("tracks/{0}".format(i), t) for i, t in enumerate(self._song.tracks)] + \
                     [("returns/{0}".format(i), t) for i, t in enumerate(self._song.return_tracks)] + [("master", self._song.master_track)]
        else:
            kind, track, canonical = self._resolve(scope)
            if kind != "track":
                raise BridgeError("address must be 'song', a track, a return track or 'master', got '{0}' which is a {1}".format(canonical, kind), "INVALID_ARGUMENT")
            owners = [(canonical, track)]
        automated, clips, scanned = [], [], 0
        for address, track in owners:
            for parameter, device_name in self._automatable_parameters(track):
                scanned += 1
                state = _safe_attr(parameter, "automation_state", 0)
                if state:
                    automated.append({"address": self._address_of(parameter), "name": parameter.name, "device": device_name, "track": address,
                                      "state": AUTOMATION_STATES.get(state, state)})
            for slot_index, slot in enumerate(_safe_attr(track, "clip_slots", [])):
                if slot.has_clip and slot.clip.has_envelopes:
                    clip = slot.clip
                    clips.append({"address": "{0}/slots/{1}/clip".format(address, slot_index), "name": clip.name,
                                  "parameters": [{"address": self._address_of(e.parameter), "name": e.parameter.name}
                                                 for e in _safe_attr(clip, "automation_envelopes", [])]})
        return {"scope": scope, "parameters_scanned": scanned, "automated_count": len(automated),
                "overridden_count": sum(1 for a in automated if a["state"] == "overridden"),
                "automated": automated[:limit], "clips_with_envelopes": clips[:limit], "truncated": len(automated) > limit or len(clips) > limit,
                "song_has_overridden_automation": bool(_safe_attr(self._song, "re_enable_automation_enabled", False))}

    def _automatable_parameters(self, track):
        """(parameter, device name) for the mixer of a track, then every device on it, racks and their chains included."""
        for parameter in self._mixer_parameters(track):
            yield parameter, "Mixer"
        for device in track.devices:
            for pair in self._device_parameters(device):
                yield pair

    @staticmethod
    def _mixer_parameters(owner):
        mixer = _safe_attr(owner, "mixer_device")
        if mixer is None:
            return []
        found = [p for p in (_safe_attr(mixer, name) for name in MIXER_PARAMETERS) if p is not None]
        return found + list(_safe_attr(mixer, "sends", []))

    def _device_parameters(self, device):
        for parameter in device.parameters:
            yield parameter, device.name
        for group in ("chains", "return_chains"):
            for chain in _safe_attr(device, group, []):
                for parameter in self._mixer_parameters(chain):
                    yield parameter, "{0} / {1}".format(device.name, chain.name)
                for inner in chain.devices:
                    for pair in self._device_parameters(inner):
                        yield pair

    def _resolve_parameter(self, params):
        """Locate a device or mixer parameter from track_index (and track_type) plus device_index or
        device_path with parameter_index, or mixer_parameter ('volume', 'pan', 'send:N').
        Returns (track_index, track, parameter, target). `parameter` may instead be an address such as
        'tracks/2/devices/0/parameters/5' or 'tracks/2/mixer/volume'."""
        if params.get("parameter") is not None:
            kind, parameter, canonical = self._resolve(params.get("parameter"))
            if kind != "parameter":
                raise BridgeError("parameter must be the address of a device or mixer parameter, got '{0}' which is a {1}".format(canonical, kind),
                                  "INVALID_ARGUMENT")
            return self._index_in(canonical), None, parameter, {"parameter": canonical}
        track_type = params.get("track_type", "track")
        track = self._track_by(track_type, params.get("track_index"))
        track_index = None if track_type == "master" else _as_index(params.get("track_index"), "track_index")
        base = {} if track_type == "track" else {"track_type": track_type}
        
        mixer_parameter = params.get("mixer_parameter")
        if mixer_parameter is not None:
            if any(params.get(key) is not None for key in ("device_index", "device_path", "parameter_index")):
                raise ValueError("give either mixer_parameter or a device with parameter_index, not both")
            name = str(mixer_parameter).lower()
            mixer = track.mixer_device
            if name == "volume":
                parameter = mixer.volume
            elif name in ("pan", "panning"):
                parameter = mixer.panning
            elif name.startswith("send"):
                digits = name[4:].lstrip(":_ ")
                if not digits.isdigit():
                    raise ValueError("mixer_parameter send must look like 'send:0'")
                sends = getattr(mixer, "sends", [])
                if int(digits) >= len(sends):
                    raise IndexError("Send index out of range")
                parameter = sends[int(digits)]
            else:
                raise ValueError("mixer_parameter must be 'volume', 'pan' or 'send:N'")
            base["mixer_parameter"] = name
            return track_index, track, parameter, base
        
        device = self._device_by(track, params.get("device_index"), params.get("device_path"))
        parameter_index = _as_index(params.get("parameter_index"), "parameter_index")
        if not 0 <= parameter_index < len(device.parameters):
            raise IndexError("Parameter index out of range")
        if params.get("device_path") is not None:
            base["device_path"] = params.get("device_path")
        else:
            base["device_index"] = params.get("device_index")
        base["parameter_index"] = parameter_index
        return track_index, track, device.parameters[parameter_index], base

    @staticmethod
    def _index_in(canonical):
        """The track index in an address like tracks/3/..., else None."""
        parts = canonical.split("/")
        return int(parts[1]) if parts[0] == "tracks" and len(parts) > 1 and parts[1].isdigit() else None

    def _get_session_clip(self, params):
        """Return (track_index, track, clip) for a Session clip slot named by track_index and clip_index, or by a `clip` address."""
        if params.get("clip") is not None:
            kind, clip, canonical = self._resolve(params.get("clip"))
            if kind != "clip":
                raise BridgeError("clip must be the address of a clip (tracks/N/slots/M/clip), got '{0}' which is a {1}".format(canonical, kind),
                                  "INVALID_ARGUMENT")
            index = self._index_in(canonical)
            return index, self._song.tracks[index], clip
        if params.get("source", "session") != "session":
            raise ValueError("Automation envelopes exist only on Session clips (Live's API returns none for arrangement clips)")
        if params.get("track_type", "track") != "track":
            raise ValueError("Only regular tracks have clips: return and master tracks cannot hold automation clips")
        track_index = _as_index(params.get("track_index"), "track_index")
        if not 0 <= track_index < len(self._song.tracks):
            raise IndexError("Track index out of range")
        track = self._song.tracks[track_index]
        clip_index = _as_index(params.get("clip_index"), "clip_index")
        if not 0 <= clip_index < len(track.clip_slots):
            raise IndexError("Clip index out of range")
        slot = track.clip_slots[clip_index]
        if not slot.has_clip:
            raise ValueError("The selected Session clip slot is empty")
        return track_index, track, slot.clip

    def _draw_automation(self, params):
        """Draw a clip automation envelope from time/value points (times in beats from clip start)."""
        track_index, track, clip = self._get_session_clip(params)
        _t, _track, parameter, target = self._resolve_parameter(params)
        mode = params.get("mode", "replace")
        if mode not in ("replace", "merge"):
            raise ValueError("mode must be 'replace' or 'merge'")
        hold = params.get("hold", True)
        if not isinstance(hold, bool):
            raise ValueError("hold must be true or false")
        
        style = params.get("style", "breakpoints")
        if style not in ("breakpoints", "steps"):
            raise ValueError("style must be 'breakpoints' (default: real envelope breakpoints, straight lines between them) or 'steps' (a staircase of fine steps)")
        clip_length = float(clip.length)
        low, high = float(parameter.min), float(parameter.max)
        points = _normalize_points(params.get("points"), clip_length, low, high)
        resolution = params.get("resolution", 0.125 if style == "steps" else 0.25)
        if style == "steps":
            steps = _build_steps(points, params.get("curve", "linear"), resolution, clip_length, hold)
            start, end = steps[0][0], steps[-1][0] + steps[-1][1]
        else:
            events = _build_breakpoints(points, params.get("curve", "linear"), resolution, clip_length, hold)
            start, end = events[0][0], events[-1][0]

        if mode == "replace":
            if clip.automation_envelope(parameter) is not None:
                clip.clear_envelope(parameter)
            envelope = clip.create_automation_envelope(parameter)
        else:
            envelope = clip.automation_envelope(parameter)
            if envelope is None:
                envelope = clip.create_automation_envelope(parameter)
            anchors = (None, None)
            if style == "breakpoints" and len(list(envelope.events_in_range(0.0, clip_length))) > 0:
                # Breakpoints are joined by lines, so what the old envelope did just outside the range is pinned first:
                # a jump at each edge from the old value to the new drawing keeps the rest of the envelope as it was.
                anchors = (envelope.value_at_time(start - 0.0005) if start > 0.001 else None,
                           envelope.value_at_time(end + 0.0005) if end < clip_length - 0.001 else None)
            envelope.delete_events_in_range(start, end)
            if anchors[0] is not None:
                events = [(start, anchors[0])] + events
            if anchors[1] is not None:
                events = events + [(end, anchors[1])]
        if envelope is None:
            raise RuntimeError("Live did not create an automation envelope for '{0}'".format(parameter.name))

        if style == "steps":
            for step_start, length, value in steps:
                envelope.insert_step(step_start, length, value)
        else:
            for time_beats, value in events:
                envelope.create_event(Live.Envelope.EnvelopeEvent(float(time_beats), float(value)))

        readback = []
        seen = set()
        for point in points:
            if point["time"] in seen:
                continue
            seen.add(point["time"])
            probe = min(point["time"] + 0.0005, clip_length - 0.0005)
            if style == "steps":
                expected = [value for step_start, length, value in steps if step_start - _EPS <= probe < step_start + length + _EPS]
                expected = expected[0] if expected else None
            else:
                expected = _eval_breakpoints(events, probe)
            readback.append({"time": point["time"], "expected": expected, "actual": envelope.value_at_time(probe)})

        return {
            "track_index": track_index,
            "clip_name": clip.name,
            "parameter": parameter.name,
            "target": target,
            "range": [low, high],
            "clip_length": clip_length,
            "mode": mode,
            "curve": params.get("curve", "linear"),
            "style": style,
            "steps" if style == "steps" else "breakpoints": len(steps) if style == "steps" else len(events),
            "readback": readback
        }

    def _get_automation(self, params):
        """Read a Session clip's automation: every envelope (or one parameter's) as breakpoints in the parameter's own units."""
        _index, _track, clip = self._get_session_clip(params)
        wanted = None
        if params.get("parameter") is not None:
            _i, _t, wanted, _target = self._resolve_parameter(params)
        limit = params.get("max_points", 500)
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 2:
            raise BridgeError("max_points must be a whole number from 2", "INVALID_ARGUMENT")
        length = float(clip.length)
        envelopes = []
        if wanted is not None:
            found = clip.automation_envelope(wanted)
            candidates = [found] if found is not None else []
        else:
            candidates = list(_safe_attr(clip, "automation_envelopes", []))
        for envelope in candidates:
            parameter = envelope.parameter
            times = sorted(set(round(e.time, 6) for e in envelope.events_in_range(0.0, length)))
            points = []
            for t in times:
                entry = {"time": t, "value": envelope.value_at_time(min(t + 0.0005, length - 0.0005))}
                if t > 0.001:
                    before = envelope.value_at_time(t - 0.0005)
                    if abs(before - entry["value"]) > 0.002 * max(1.0, abs(entry["value"])) and abs(before - envelope.value_at_time(t - 0.0025)) < 0.05 * max(1.0, abs(before)):
                        entry["jump_from"] = before
                points.append(entry)
            envelopes.append({"parameter": self._address_of(parameter), "name": parameter.name, "min": parameter.min, "max": parameter.max,
                              "breakpoints": points[:limit], "truncated": len(points) > limit, "total_breakpoints": len(points)})
        return {"clip_length": length, "clip_name": clip.name, "has_envelopes": bool(clip.has_envelopes), "envelopes": envelopes}

    def _clear_automation(self, params):
        """Clear one parameter's envelope on a Session clip, or every envelope if no parameter is given."""
        track_index, track, clip = self._get_session_clip(params)
        wants_parameter = any(params.get(key) is not None for key in ("parameter", "device_index", "device_path", "parameter_index", "mixer_parameter"))
        if wants_parameter:
            _t, _track, parameter, target = self._resolve_parameter(params)
            had = clip.automation_envelope(parameter) is not None
            if had:
                clip.clear_envelope(parameter)
            cleared = parameter.name
        else:
            had = bool(clip.has_envelopes)
            clip.clear_all_envelopes()
            cleared = "all"
        return {"track_index": track_index, "clip_name": clip.name, "cleared": cleared,
                "had_envelope": had, "clip_has_envelopes": bool(clip.has_envelopes)}

    def _ramp_key(self, track_index, target):
        return "{0}:{1}".format(track_index, sorted(target.items()))

    def _ramp_key_for(self, track_index, target, parameter):
        """One key per parameter however it was addressed, so a new ramp always replaces the old one."""
        address = self._address_of(parameter)
        return "address:{0}".format(address) if address else self._ramp_key(track_index, target)

    def _ramp_parameter(self, params):
        """Sweep a device or mixer parameter to a target over beats or seconds, driven by the pump timer."""
        track_index, track, parameter, target = self._resolve_parameter(params)
        low, high = float(parameter.min), float(parameter.max)
        end = params.get("to")
        if not _is_number(end) or not low - _EPS <= end <= high + _EPS:
            raise ValueError("to must be a number within the parameter range {0} to {1}".format(low, high))
        start = params.get("from")
        if start is None:
            start = parameter.value
        elif not _is_number(start) or not low - _EPS <= start <= high + _EPS:
            raise ValueError("from must be a number within the parameter range {0} to {1}".format(low, high))
        curve = params.get("curve", "linear")
        if curve not in CURVES or curve == "step":
            raise ValueError("curve must be one of: linear, smooth, ease_in, ease_out")
        beats, seconds = params.get("beats"), params.get("seconds")
        if (beats is None) == (seconds is None):
            raise ValueError("give exactly one of beats or seconds")
        if beats is not None:
            if not _is_number(beats):
                raise ValueError("beats must be a number")
            seconds = beats * 60.0 / float(self._song.tempo)
        if not _is_number(seconds) or not 0.01 <= seconds <= 3600:
            raise ValueError("duration must be between 0.01 and 3600 seconds")
        if not parameter.is_enabled:
            raise ValueError("Parameter is not enabled")
        
        parameter.value = min(max(float(start), low), high)
        self._ramps[self._ramp_key_for(track_index, target, parameter)] = {
            "param": parameter, "start": float(start), "end": float(end), "t0": clock.now(),
            "duration": float(seconds), "curve": curve, "low": low, "high": high, "name": parameter.name
        }
        return {"track_index": track_index, "parameter": parameter.name, "target": target, "from": float(start),
                "to": float(end), "seconds": float(seconds), "curve": curve,
                "update_interval_ms": config.PUMP_INTERVAL_MS, "active_ramps": len(self._ramps)}

    def _cancel_ramps(self, params):
        """Cancel one parameter's ramp, or every active ramp when no track (index or master) is given."""
        if params.get("track_index") is None and params.get("track_type") != "master" and params.get("parameter") is None:
            cancelled = len(self._ramps)
            self._ramps = {}
        else:
            track_index, _track, _parameter, target = self._resolve_parameter(params)
            cancelled = 1 if self._ramps.pop(self._ramp_key_for(track_index, target, _parameter), None) is not None else 0
        return {"cancelled": cancelled, "active_ramps": len(self._ramps)}

    def _tick_ramps(self):
        """Advance every active ramp; called from the pump timer."""
        if not self._ramps:
            return
        now = clock.now()
        for key in list(self._ramps.keys()):
            ramp = self._ramps.get(key)
            if ramp is None:
                continue
            progress = (now - ramp["t0"]) / ramp["duration"]
            finished = progress >= 1.0
            if finished:
                value = ramp["end"]
            else:
                value = ramp["start"] + (ramp["end"] - ramp["start"]) * _ease(ramp["curve"], max(progress, 0.0))
            try:
                ramp["param"].value = min(max(value, ramp["low"]), ramp["high"])
            except Exception as e:
                self.log_message("Ramp on '{0}' stopped: {1}".format(ramp["name"], e))
                finished = True
            if finished:
                self._ramps.pop(key, None)
