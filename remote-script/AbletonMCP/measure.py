"""measure: step through scenes or clips while sampling the output meters of tracks and the master.

Level checks need playback and a lot of patience: launch a scene, wait for it to start, skip the launch transient, sample the
meters for a few bars, move on. Doing that by hand through eval is slow and leaves the Set in a changed state when anything goes
wrong, so it is one command: a state machine on the pump timer that changes only what the caller asked for (the master fader,
devices to bypass, the crossfader, parameters to set per step) and puts every one of them back when it finishes, is aborted or
fails. It plays audio: the caller must say so (`confirm_playback`).

Meter values are Live's own 0..1 scale (0.85 is 0 dB on a fader, not a calibrated dBFS): compare them with each other.
"""
import re

from . import clock
from .helpers import _is_number, _safe_attr
from .registry import BridgeError, command

MEASURE_ACTIONS = ("start", "status", "abort")
MAX_STEPS = 64
MAX_PHASE_BEATS = 256.0
START_TIMEOUT_SECONDS = 60.0
ZERO_METER_SECONDS = 2.5
LOG_LIMIT = 50
_SLOT_ADDRESS = re.compile(r"^tracks/(\d+)/slots/(\d+)")


def _meter_level(obj):
    """The louder channel of a track's or the master's output meter."""
    return max(float(_safe_attr(obj, "output_meter_left", 0.0) or 0.0), float(_safe_attr(obj, "output_meter_right", 0.0) or 0.0))


class MeasureMixin(object):
    """measure."""

    _measure = None          # the current or last run; a class default, because a hot-swap reloads the code without running __init__ again

    # ---- validation

    def _measure_targets(self, wanted):
        song = self._song
        if wanted is None:
            addresses = ["tracks/{0}".format(i) for i in range(len(song.tracks))] + ["master"]
        elif isinstance(wanted, list) and wanted and all(isinstance(a, str) for a in wanted):
            addresses = wanted
        else:
            raise BridgeError("targets must be a list of track addresses ('tracks/N', 'returns/N', 'master')", "INVALID_ARGUMENT")
        targets = []
        for address in addresses:
            kind, obj, canonical = self._resolve(address)
            if kind != "track":
                raise BridgeError("targets must be tracks, return tracks or 'master', got '{0}' which is a {1}".format(canonical, kind), "INVALID_ARGUMENT")
            targets.append({"address": canonical, "name": getattr(obj, "name", canonical), "obj": obj})
        return targets

    def _measure_slot(self, address):
        kind, _obj, canonical = self._resolve(address)
        match = _SLOT_ADDRESS.match(canonical) if kind in ("slot", "clip") else None
        if match is None:
            raise BridgeError("a clip must be given as 'tracks/N/slots/M' (or its '/clip'), got '{0}'".format(address), "INVALID_ARGUMENT")
        track_index, slot_index = int(match.group(1)), int(match.group(2))
        slot = self._song.tracks[track_index].clip_slots[slot_index]
        if not slot.has_clip:
            raise BridgeError("'{0}' has no clip to launch".format(canonical), "NOT_FOUND")
        return {"track": track_index, "slot": slot_index, "address": "tracks/{0}/slots/{1}".format(track_index, slot_index), "slot_obj": slot}

    def _measure_steps(self, steps):
        if not isinstance(steps, list) or not steps:
            raise BridgeError("steps must be a non-empty list: each {scene: N} or {clip: 'tracks/N/slots/M'} or {clips: [...]}, "
                              "optionally with label and set: [{address, value|display}]", "INVALID_ARGUMENT")
        if len(steps) > MAX_STEPS:
            raise BridgeError("at most {0} steps per measurement".format(MAX_STEPS), "OUT_OF_RANGE")
        song, parsed = self._song, []
        for index, step in enumerate(steps):
            if not isinstance(step, dict):
                raise BridgeError("step {0} must be an object".format(index), "TYPE_ERROR")
            given = [k for k in ("scene", "clip", "clips") if k in step]
            if len(given) != 1:
                raise BridgeError("step {0} needs exactly one of scene, clip or clips".format(index), "INVALID_ARGUMENT")
            entry = {"index": index, "label": step.get("label")}
            if given[0] == "scene":
                scene = step["scene"]
                if isinstance(scene, bool) or not isinstance(scene, int) or not 0 <= scene < len(song.scenes):
                    raise BridgeError("step {0}: scene must be a scene index from 0 to {1}".format(index, len(song.scenes) - 1), "OUT_OF_RANGE")
                entry["scene"] = scene
            else:
                clips = [step["clip"]] if given[0] == "clip" else step["clips"]
                if not isinstance(clips, list) or not clips or not all(isinstance(c, str) for c in clips):
                    raise BridgeError("step {0}: clips must be a list of 'tracks/N/slots/M' addresses".format(index), "INVALID_ARGUMENT")
                entry["clips"] = [self._measure_slot(c) for c in clips]
            entry["set"] = []
            for item in step.get("set", []) or []:
                if not isinstance(item, dict) or not isinstance(item.get("address"), str) or (("value" in item) == ("display" in item)):
                    raise BridgeError("step {0}: each set item needs an address and exactly one of value or display".format(index), "INVALID_ARGUMENT")
                kind, obj, canonical = self._resolve(item["address"])
                if kind != "parameter":
                    raise BridgeError("step {0}: set needs parameter addresses, got '{1}' which is a {2}".format(index, canonical, kind), "INVALID_ARGUMENT")
                entry["set"].append({"address": canonical, "obj": obj, "property": "value" if "value" in item else "display", "to": item.get("value", item.get("display"))})
            parsed.append(entry)
        return parsed

    # ---- commands

    @command("measure", writes=True)
    def _cmd_measure(self, params):
        action = params.get("action", "start")
        if action not in MEASURE_ACTIONS:
            raise BridgeError("action must be one of: {0}".format(", ".join(MEASURE_ACTIONS)), "INVALID_ARGUMENT")
        if action == "status":
            return self._measure_status()
        if action == "abort":
            run = self._measure
            if run is None or run["state"] != "running":
                raise BridgeError("No measurement is running", "UNAVAILABLE")
            self._measure_finish(run, "aborted", "aborted by request")
            return self._measure_status()
        return self._measure_start(params)

    def _measure_start(self, params):
        song = self._song
        if self._measure is not None and self._measure["state"] == "running":
            raise BridgeError("A measurement is already running: read it with action status or stop it with action abort", "GUARD_FAILED")
        if params.get("confirm_playback") is not True:
            raise BridgeError("measure plays the Set through its outputs. Warn the user, then pass confirm_playback: true", "GUARD_FAILED")
        if song.is_playing and params.get("allow_while_playing") is not True:
            raise BridgeError("The transport is playing: measure launches and stops clips itself, so it would take over a live performance. "
                              "Stop first, or pass allow_while_playing: true", "GUARD_FAILED")
        settle, length = params.get("settle_beats", 4), params.get("measure_beats", 16)
        for name, value, low in (("settle_beats", settle, 0.0), ("measure_beats", length, 1.0)):
            if not _is_number(value) or not low <= value <= MAX_PHASE_BEATS:
                raise BridgeError("{0} must be a number from {1:g} to {2:g}".format(name, low, MAX_PHASE_BEATS), "OUT_OF_RANGE")
        master_volume = params.get("master_volume", 0.55)
        if master_volume is not None and (not _is_number(master_volume) or not 0.0 <= master_volume <= 1.0):
            raise BridgeError("master_volume must be a device value from 0 to 1 (0.85 is 0 dB) or null to leave it alone", "OUT_OF_RANGE")
        crossfader = params.get("crossfader")
        if crossfader is not None and (not _is_number(crossfader) or not -1.0 <= crossfader <= 1.0):
            raise BridgeError("crossfader must be a number from -1 (A) to 1 (B)", "OUT_OF_RANGE")
        stop_after = params.get("stop_after", True)
        if not isinstance(stop_after, bool):
            raise BridgeError("stop_after must be true or false", "TYPE_ERROR")
        steps = self._measure_steps(params.get("steps"))
        targets = self._measure_targets(params.get("targets"))
        bypass = []
        for address in params.get("bypass", []) or []:
            if not isinstance(address, str):
                raise BridgeError("bypass must be a list of device addresses", "TYPE_ERROR")
            kind, device, canonical = self._resolve(address)
            if kind != "device":
                raise BridgeError("bypass needs device addresses, got '{0}' which is a {1}".format(canonical, kind), "INVALID_ARGUMENT")
            bypass.append({"address": canonical, "device": device})
        run = {"state": "running", "phase": "start", "step": 0, "steps": steps, "targets": targets, "settle": float(settle), "length": float(length),
               "stop_after": stop_after, "results": [], "log": [], "restore": [], "restored": [], "started": clock.now(), "message": None}
        self._measure = run
        # Everything applied below is put back by _measure_finish, however the run ends (also when one of these writes fails).
        try:
            master = song.master_track.mixer_device
            if master_volume is not None:
                before = master.volume.value
                run["restore"].append(("master fader", lambda: setattr(master.volume, "value", before)))
                master.volume.value = float(master_volume)
            if crossfader is not None:
                before = master.crossfader.value
                run["restore"].append(("crossfader", lambda: setattr(master.crossfader, "value", before)))
                master.crossfader.value = float(crossfader)
            for item in bypass:
                was_on = self._device_is_on(item["device"])
                run["restore"].append(("device " + item["address"], (lambda d=item["device"], v=was_on: self._device_set_on(d, v))))
                self._device_set_on(item["device"], False)
            song.stop_all_clips()
        except Exception as e:
            self._measure_finish(run, "error", str(e))
            raise
        return dict(self._measure_status(), note="Started: poll with action status. Steps take settle_beats + measure_beats of playback each.")

    @staticmethod
    def _device_is_on(device):
        for parameter in device.parameters:
            if parameter.name == "Device On":
                return parameter.value > 0.5
        raise BridgeError("'{0}' has no on/off switch to bypass".format(device.name), "UNAVAILABLE")

    @staticmethod
    def _device_set_on(device, on):
        for parameter in device.parameters:
            if parameter.name == "Device On":
                parameter.value = 1.0 if on else 0.0
                return
        raise BridgeError("'{0}' has no on/off switch".format(device.name), "UNAVAILABLE")

    def _measure_status(self):
        run = self._measure
        if run is None:
            return {"state": "idle"}
        result = {"state": run["state"], "step": min(run["step"], len(run["steps"])), "of": len(run["steps"]), "phase": run["phase"],
                  "elapsed_seconds": round(clock.now() - run["started"], 1), "results": run["results"], "log": run["log"][-LOG_LIMIT:]}
        if run["message"]:
            result["message"] = run["message"]
        if run["state"] != "running":
            result["restored"] = list(run["restored"])
        return result

    # ---- the state machine, ticked by the pump

    def _measure_finish(self, run, state, message=None):
        """End a run: stop playback, put back everything it changed, and report what could not be restored."""
        run["state"], run["message"] = state, message
        song = self._song
        try:
            if run["stop_after"]:
                song.stop_all_clips()
                song.stop_playing()
        except Exception as e:
            run["log"].append("could not stop playback: {0}".format(e))
        for label, undo in reversed(run["restore"]):
            try:
                undo()
                run["restored"].append(label)
            except Exception as e:
                run["log"].append("COULD NOT RESTORE {0}: {1}".format(label, e))
        run["restore"] = []
        run["phase"] = "finished"

    def _measure_cleanup(self):
        """Called when the server stops (Live closes, hotswap): never leave a fader down or a device bypassed."""
        run = getattr(self, "_measure", None)
        if run is not None and run["state"] == "running":
            try:
                self._measure_finish(run, "aborted", "the script was stopped")
            except Exception:
                pass

    def _tick_measure(self):
        run = self._measure
        if run is None or run["state"] != "running":
            return
        try:
            self._measure_step(run)
        except Exception as e:
            run["log"].append("error: {0}".format(e))
            self._measure_finish(run, "error", str(e))

    def _measure_step(self, run):
        song = self._song
        if run["step"] >= len(run["steps"]):
            self._measure_finish(run, "done")
            return
        step, phase, now = run["steps"][run["step"]], run["phase"], song.current_song_time
        if phase == "start":
            for item in step["set"]:
                if "before" not in item:
                    item["before"] = item["obj"].value
                    run["restore"].append(("parameter " + item["address"], (lambda o=item["obj"], v=item["before"]: setattr(o, "value", v))))
                self._set_properties(item["address"], {item["property"]: item["to"]})
            if "scene" in step:
                song.scenes[step["scene"]].fire()
            else:
                for clip in step["clips"]:
                    clip["slot_obj"].fire()
            run["phase"], run["waited_from"] = "wait", clock.now()
        elif phase == "wait":
            if self._measure_started(step):
                run["phase"], run["t0"] = "settle", now
            elif clock.now() - run["waited_from"] > START_TIMEOUT_SECONDS:
                run["log"].append("step {0}: the launch did not start within {1:g} s (is the transport running and the quantization short enough?)".format(step["index"], START_TIMEOUT_SECONDS))
                run["results"].append({"index": step["index"], "label": step["label"], "error": "did not start"})
                run["step"], run["phase"] = run["step"] + 1, "start"
        elif phase == "settle":
            if now - run["t0"] >= run["settle"]:
                run["phase"], run["t1"], run["wall1"] = "measure", now, clock.now()
                run["samples"] = dict((t["address"], []) for t in run["targets"])
        elif phase == "measure":
            for target in run["targets"]:
                run["samples"][target["address"]].append(_meter_level(target["obj"]))
            elapsed = clock.now() - run["wall1"]
            if elapsed >= ZERO_METER_SECONDS and not any(max(v) > 0 for v in run["samples"].values() if v):
                run["log"].append("every meter read 0 for {0:g} s while playing: bring Live to the front and check the audio engine (meters read 0 in the background)".format(ZERO_METER_SECONDS))
                self._measure_finish(run, "aborted", "all meters read 0")
                return
            tempo = max(float(_safe_attr(song, "tempo", 120.0) or 120.0), 20.0)
            overdue = elapsed > run["length"] * 60.0 / tempo * 3.0 + 5.0         # the transport stopped under us
            if now - run["t1"] >= run["length"] or overdue:
                self._measure_record(run, step, now - run["t1"], overdue)
                run["step"], run["phase"] = run["step"] + 1, "start"

    def _measure_started(self, step):
        tracks = list(self._song.tracks)
        if "scene" in step:
            return any(_safe_attr(t, "playing_slot_index", -1) == step["scene"] for t in tracks)
        return all(_safe_attr(tracks[c["track"]], "playing_slot_index", -1) == c["slot"] for c in step["clips"])

    def _measure_record(self, run, step, beats, overdue):
        entry = {"index": step["index"], "label": step["label"], "beats": round(beats, 2)}
        entry.update({"scene": step["scene"]} if "scene" in step else {"clips": [c["address"] for c in step["clips"]]})
        if step["set"]:
            entry["set"] = [{"address": i["address"], "property": i["property"], "to": i["to"]} for i in step["set"]]
        entry["targets"] = {}
        for target in run["targets"]:
            values = run["samples"][target["address"]]
            if values:
                entry["targets"][target["address"]] = {"name": target["name"], "peak": round(max(values), 3), "mean": round(sum(values) / len(values), 3)}
        entry["samples"] = len(next(iter(run["samples"].values()), []))
        if overdue:
            entry["warning"] = "the transport stopped before the measurement window was over"
        run["results"].append(entry)
