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

    def _resolve_parameter(self, params):
        """Locate a device or mixer parameter from track_index (and track_type) plus device_index or
        device_path with parameter_index, or mixer_parameter ('volume', 'pan', 'send:N').
        Returns (track_index, track, parameter, target)."""
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

    def _get_session_clip(self, params):
        """Return (track_index, track, clip) for a Session clip slot named by track_index and clip_index."""
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
        
        clip_length = float(clip.length)
        low, high = float(parameter.min), float(parameter.max)
        points = _normalize_points(params.get("points"), clip_length, low, high)
        steps = _build_steps(points, params.get("curve", "linear"), params.get("resolution", 0.125), clip_length, hold)
        
        if mode == "replace":
            if clip.automation_envelope(parameter) is not None:
                clip.clear_envelope(parameter)
            envelope = clip.create_automation_envelope(parameter)
        else:
            envelope = clip.automation_envelope(parameter)
            if envelope is None:
                envelope = clip.create_automation_envelope(parameter)
            envelope.delete_events_in_range(steps[0][0], steps[-1][0] + steps[-1][1])
        if envelope is None:
            raise RuntimeError("Live did not create an automation envelope for '{0}'".format(parameter.name))
        
        for start, length, value in steps:
            envelope.insert_step(start, length, value)
        
        readback = []
        seen = set()
        for point in points:
            if point["time"] in seen:
                continue
            seen.add(point["time"])
            probe = min(point["time"] + 0.0005, clip_length - 0.0005)
            expected = [value for start, length, value in steps if start - _EPS <= probe < start + length + _EPS]
            readback.append({"time": point["time"], "expected": expected[0] if expected else None,
                             "actual": envelope.value_at_time(probe)})
        
        return {
            "track_index": track_index,
            "clip_name": clip.name,
            "parameter": parameter.name,
            "target": target,
            "range": [low, high],
            "clip_length": clip_length,
            "mode": mode,
            "curve": params.get("curve", "linear"),
            "steps": len(steps),
            "readback": readback
        }

    def _clear_automation(self, params):
        """Clear one parameter's envelope on a Session clip, or every envelope if no parameter is given."""
        track_index, track, clip = self._get_session_clip(params)
        wants_parameter = any(params.get(key) is not None for key in ("device_index", "device_path", "parameter_index", "mixer_parameter"))
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
        self._ramps[self._ramp_key(track_index, target)] = {
            "param": parameter, "start": float(start), "end": float(end), "t0": clock.now(),
            "duration": float(seconds), "curve": curve, "low": low, "high": high, "name": parameter.name
        }
        return {"track_index": track_index, "parameter": parameter.name, "target": target, "from": float(start),
                "to": float(end), "seconds": float(seconds), "curve": curve,
                "update_interval_ms": config.PUMP_INTERVAL_MS, "active_ramps": len(self._ramps)}

    def _cancel_ramps(self, params):
        """Cancel one parameter's ramp, or every active ramp when no track (index or master) is given."""
        if params.get("track_index") is None and params.get("track_type") != "master":
            cancelled = len(self._ramps)
            self._ramps = {}
        else:
            track_index, _track, _parameter, target = self._resolve_parameter(params)
            cancelled = 1 if self._ramps.pop(self._ramp_key(track_index, target), None) is not None else 0
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
