"""Offline tests for the Remote Script: pure helpers, automation, ramps and the timer-pumped server.

Live's Python API is replaced by small fakes, so no Ableton Live is needed:

    python3 -m unittest discover -s test -p "remote_script_test.py" -v
"""
import importlib.util
import json
import os
import socket
import sys
import threading
import time as real_time
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ---------------------------------------------------------------- fake Live API

class FakeTimer(object):
    instances = []

    def __init__(self, callback, interval, repeat=False, start=False):
        self.callback, self.interval, self.repeat, self.running = callback, interval, repeat, start
        FakeTimer.instances.append(self)

    def stop(self):
        self.running = False


class FakeControlSurface(object):
    def __init__(self, c_instance):
        self._c_instance = c_instance
        self.logs = []

    def log_message(self, message):
        self.logs.append(message)

    def show_message(self, message):
        pass

    def song(self):
        return self._c_instance.song

    def application(self):
        return self._c_instance.app

    def schedule_message(self, delay, callback):
        callback()

    def disconnect(self):
        pass


class FakeParam(object):
    def __init__(self, name, value=0.0, low=0.0, high=1.0, enabled=True, items=None):
        self.name, self.value, self.min, self.max, self.is_enabled = name, value, low, high, enabled
        self.value_items = tuple(items or ())
        self.is_quantized = bool(items)
        self.writes = []
        self._valid = True

    @property
    def default_value(self):
        if self.is_quantized:
            raise RuntimeError("There is no default value available for this type of parameter")
        return self.min

    def str_for_value(self, value):
        if self.is_quantized:
            return self.value_items[int(value)]
        return "{0:g} units".format(value)

    def __setattr__(self, key, val):
        if key == "value":
            if not self.__dict__.get("_valid", True):
                raise RuntimeError("parameter no longer valid")
            self.__dict__.setdefault("writes", []).append(val)
        object.__setattr__(self, key, val)


class FakeEnvelope(object):
    """Events are (start, length, value); like Live, value_at_time(t) is the step with start < t <= end."""

    def __init__(self, parameter):
        self.parameter, self.events = parameter, []

    def _carve(self, start, end):
        """Remove [start, end) from existing steps, splitting steps that straddle it."""
        kept = []
        for s, l, v in self.events:
            e = s + l
            if e <= start + 1e-12 or s >= end - 1e-12:
                kept.append((s, l, v))
                continue
            if s < start - 1e-12:
                kept.append((s, start - s, v))
            if e > end + 1e-12:
                kept.append((end, e - end, v))
        self.events = kept

    def insert_step(self, start, length, value):
        self._carve(start, start + length)
        self.events.append((start, length, value))

    def delete_events_in_range(self, start, end):
        self._carve(start, end)

    def value_at_time(self, t):
        for start, length, value in self.events:
            if start < t <= start + length + 1e-12:
                return value
        return self.parameter.value


class FakeClip(object):
    def __init__(self, name="clip", length=8.0):
        self.name, self.length, self.envelopes = name, length, {}
        self.is_playing = self.is_recording = False

    @property
    def has_envelopes(self):
        return bool(self.envelopes)

    def automation_envelope(self, parameter):
        return self.envelopes.get(id(parameter))

    def create_automation_envelope(self, parameter):
        if id(parameter) in self.envelopes:
            raise RuntimeError("envelope already exists")
        self.envelopes[id(parameter)] = FakeEnvelope(parameter)
        return self.envelopes[id(parameter)]

    def clear_envelope(self, parameter):
        self.envelopes.pop(id(parameter), None)

    def clear_all_envelopes(self):
        self.envelopes.clear()


class FakeSlot(object):
    def __init__(self, clip=None):
        self.clip = clip
        self.has_clip = clip is not None


class FakeDevice(object):
    def __init__(self, name, params=None, dev_type=2, chains=None, return_chains=None, drum_pads=None):
        self.name, self.class_name, self.type = name, name.replace(" ", ""), dev_type
        self.parameters = params if params is not None else [
            FakeParam("Device On", 1, 0, 1), FakeParam("Freq", 0.5, 0, 1), FakeParam("Drive", 50, 0, 100),
            FakeParam("Off", 0, 0, 1, enabled=False), FakeParam("Mode", 1, 0, 2, items=["A", "B", "C"])]
        self.chains = chains
        self.return_chains = return_chains if return_chains is not None else ([] if chains is not None else None)
        self.drum_pads = drum_pads
        self.can_have_chains = chains is not None or drum_pads is not None
        self.can_have_drum_pads = drum_pads is not None
        if not self.can_have_chains:
            del self.chains, self.return_chains, self.drum_pads


class FakeChain(object):
    def __init__(self, name, devices):
        self.name, self.devices = name, devices


class FakePad(object):
    def __init__(self, note, name, chains):
        self.note, self.name, self.chains = note, name, chains


def make_mixer(sends=True):
    mixer = types.SimpleNamespace(volume=FakeParam("Volume", 0.85, 0, 1), panning=FakeParam("Pan", 0, -1, 1))
    mixer.sends = [FakeParam("Send A", 0, 0, 1), FakeParam("Send B", 0, 0, 1)] if sends else []
    return mixer


class FakeTrack(object):
    def __init__(self, name, with_clips=True):
        self.name = name
        self.devices = [FakeDevice("Dev")]
        self.mixer_device = make_mixer()
        self.mute = self.solo = False
        self.color = 0
        if with_clips:
            self.clip_slots = [FakeSlot(FakeClip("loop", 8.0)), FakeSlot(), FakeSlot(FakeClip("short", 2.0))]


def make_rack_track():
    """Track 'Rack' with: 0 Audio Effect Rack (chains: 'Wide' [Delay, Rack in Rack], 'Dry' []; return chain 'FX' [Reverb]),
    1 Drum Rack (pad 36 -> chain with [Snare Synth]), 2 plain effect."""
    inner = FakeDevice("Inner Rack", chains=[FakeChain("Deep", [FakeDevice("Deep Effect")])])
    rack = FakeDevice("Audio Effect Rack", chains=[FakeChain("Wide", [FakeDevice("Delay"), inner]), FakeChain("Dry", [])],
                      return_chains=[FakeChain("FX", [FakeDevice("Reverb")])])
    kit = FakeDevice("Drum Rack", dev_type=1, chains=[], drum_pads=[FakePad(n, "Pad {0}".format(n), []) for n in range(128)])
    kit.drum_pads[36] = FakePad(36, "Kick", [FakeChain("Kick", [FakeDevice("Kick Synth", dev_type=1)])])
    kit.chains = [kit.drum_pads[36].chains[0]]
    track = FakeTrack("Rack", with_clips=False)
    track.devices = [rack, kit, FakeDevice("Plain")]
    return track


class FakeReturnTrack(FakeTrack):
    """Like Live: touching arrangement_clips / clip_slots on return and master tracks raises RuntimeError."""

    @property
    def arrangement_clips(self):
        raise RuntimeError("Main, Group and Return Tracks have no arrangement clips")

    @property
    def clip_slots(self):
        raise RuntimeError("Main, Group and Return Tracks have no clip slots")


def make_song():
    ret = FakeReturnTrack("Return A", with_clips=False)
    ret.devices = [FakeDevice("Return Reverb")]
    master = FakeReturnTrack("Master", with_clips=False)
    master.devices = [FakeDevice("Limiter")]
    master.mixer_device = make_mixer(sends=False)
    del master.mute, master.solo
    song = types.SimpleNamespace(tempo=120.0, signature_numerator=4, signature_denominator=4, scenes=[],
                                 tracks=[FakeTrack("A"), FakeTrack("B"), make_rack_track()],
                                 return_tracks=[ret], master_track=master, undo_log=[])
    song.begin_undo_step = lambda: song.undo_log.append("begin")
    song.end_undo_step = lambda: song.undo_log.append("end")
    return song


# ---------------------------------------------------------------- module loading

def free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def load_module():
    live = types.ModuleType("Live")
    live.Base = types.SimpleNamespace(Timer=FakeTimer)
    framework = types.ModuleType("_Framework")
    control_surface = types.ModuleType("_Framework.ControlSurface")
    control_surface.ControlSurface = FakeControlSurface
    sys.modules.update({"Live": live, "_Framework": framework, "_Framework.ControlSurface": control_surface})
    spec = importlib.util.spec_from_file_location("AbletonMCP_under_test", os.path.join(ROOT, "remote-script", "__init__.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = load_module()


class FakeClock(object):
    def __init__(self):
        self.now = 1000.0

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def make_script(port=None):
    mod.DEFAULT_PORT = port or free_port()
    FakeTimer.instances = []
    c_instance = types.SimpleNamespace(song=make_song(), app=types.SimpleNamespace())
    return mod.AbletonMCP(c_instance)


# ---------------------------------------------------------------- pure helpers

class HelperTests(unittest.TestCase):
    def test_ease_endpoints_and_midpoints(self):
        for curve in ("linear", "smooth", "ease_in", "ease_out"):
            self.assertAlmostEqual(mod._ease(curve, 0.0), 0.0)
            self.assertAlmostEqual(mod._ease(curve, 1.0), 1.0)
        self.assertAlmostEqual(mod._ease("linear", 0.25), 0.25)
        self.assertAlmostEqual(mod._ease("smooth", 0.5), 0.5)
        self.assertAlmostEqual(mod._ease("ease_in", 0.5), 0.25)
        self.assertAlmostEqual(mod._ease("ease_out", 0.5), 0.75)
        with self.assertRaises(ValueError):
            mod._ease("bogus", 0.5)

    def test_as_index(self):
        self.assertEqual(mod._as_index(3, "x"), 3)
        self.assertEqual(mod._as_index(3.0, "x"), 3)
        for bad in (None, True, 1.5, "1", [1]):
            with self.assertRaises(ValueError):
                mod._as_index(bad, "x")

    def test_normalize_points_validation(self):
        good = [{"time": 1, "value": 0.5}]
        self.assertEqual(mod._normalize_points(good, 4, 0, 1)[0]["time"], 1.0)
        bad_cases = [
            ([], "non-empty"), ("x", "non-empty"), ([1], "object"), ([{"time": "1", "value": 0}], "numeric"),
            ([{"time": 1}], "numeric"), ([{"time": True, "value": 0}], "numeric"),
            ([{"time": float("nan"), "value": 0}], "numeric"), ([{"time": 5, "value": 0}], "outside the clip"),
            ([{"time": -1, "value": 0}], "outside the clip"), ([{"time": 1, "value": 2}], "outside the parameter range"),
            ([{"time": 1, "value": 0, "curve": "zig"}], "curve"),
        ]
        for points, fragment in bad_cases:
            with self.assertRaises(ValueError, msg=str(points)) as ctx:
                mod._normalize_points(points, 4, 0, 1)
            self.assertIn(fragment, str(ctx.exception))

    def test_normalize_points_sorts_and_keeps_order_for_ties(self):
        pts = mod._normalize_points([{"time": 2, "value": 1}, {"time": 0, "value": 0}, {"time": 2, "value": 0.5}], 4, 0, 1)
        self.assertEqual([(p["time"], p["value"]) for p in pts], [(0.0, 0.0), (2.0, 1.0), (2.0, 0.5)])

    def steps(self, points, curve="linear", resolution=1.0, length=4.0, hold=True, lo=0.0, hi=1.0):
        return mod._build_steps(mod._normalize_points(points, length, lo, hi), curve, resolution, length, hold)

    def test_linear_ramp_steps(self):
        steps = self.steps([{"time": 0, "value": 0}, {"time": 4, "value": 1}])
        self.assertEqual([round(v, 6) for _s, _l, v in steps], [0.0, 0.333333, 0.666667, 1.0])  # first = a, last = b
        self.assertEqual(len(steps), 4)  # last point is at the clip end: no tail

    def test_hold_fills_both_edges(self):
        steps = self.steps([{"time": 1, "value": 0.2}, {"time": 3, "value": 0.8}])
        self.assertEqual(steps[0], (0.0, 1.0, 0.2))
        self.assertEqual(steps[-1], (3.0, 1.0, 0.8))

    def test_steps_are_contiguous_and_cover_the_clip(self):
        for curve in mod.CURVES:
            steps = self.steps([{"time": 0.5, "value": 0.1}, {"time": 2.3, "value": 0.9}, {"time": 3, "value": 0.3}], curve, 0.3)
            cursor = 0.0
            for start, length, _value in steps:
                self.assertAlmostEqual(start, cursor, places=9)
                self.assertGreater(length, 0)
                cursor = start + length
            self.assertAlmostEqual(cursor, 4.0, places=9)

    def test_step_curve_holds_until_next_point(self):
        steps = self.steps([{"time": 0, "value": 0.1}, {"time": 2, "value": 0.9}], "step", length=4)
        self.assertEqual(steps, [(0.0, 2.0, 0.1), (2.0, 2.0, 0.9)])

    def test_per_point_curve_overrides_default(self):
        steps = self.steps([{"time": 0, "value": 0, "curve": "step"}, {"time": 2, "value": 1}, {"time": 4, "value": 0}])
        self.assertEqual(steps[0], (0.0, 2.0, 0.0))
        self.assertEqual(len(steps), 3)  # one held step, then two ramp steps

    def test_jump_between_equal_times(self):
        steps = self.steps([{"time": 0, "value": 0}, {"time": 2, "value": 0}, {"time": 2, "value": 1}, {"time": 4, "value": 1}])
        values = {round(v, 6) for s, _l, v in steps if s >= 2}
        self.assertEqual(values, {1.0})

    def test_without_hold_reaches_last_value(self):
        steps = self.steps([{"time": 0, "value": 0}, {"time": 2, "value": 1}], hold=False)
        self.assertEqual(steps[-1][2], 1.0)
        self.assertEqual(steps[-1][0], 2.0)
        self.assertLessEqual(steps[-1][1], 1.0)

    def test_single_point_needs_hold(self):
        steps = self.steps([{"time": 1, "value": 0.4}], hold=True)
        self.assertEqual({v for _s, _l, v in steps}, {0.4})
        with self.assertRaises(ValueError):
            self.steps([{"time": 1, "value": 0.4}, {"time": 1, "value": 0.5}], hold=False, length=1)

    def test_resolution_and_limits(self):
        with self.assertRaises(ValueError):
            self.steps([{"time": 0, "value": 0}, {"time": 4, "value": 1}], resolution=0)
        with self.assertRaises(ValueError):
            self.steps([{"time": 0, "value": 0}, {"time": 4, "value": 1}], resolution=0.0001)
        with self.assertRaises(ValueError):
            self.steps([{"time": 0, "value": 0}, {"time": 4, "value": 1}], curve="wobble")


# ---------------------------------------------------------------- automation

class AutomationTests(unittest.TestCase):
    def setUp(self):
        self.script = make_script()
        self.addCleanup(self.script._stop_server)
        self.track = self.script._song.tracks[0]
        self.clip = self.track.clip_slots[0].clip
        self.freq = self.track.devices[0].parameters[1]

    def draw(self, **overrides):
        params = {"track_index": 0, "clip_index": 0, "device_index": 0, "parameter_index": 1,
                  "points": [{"time": 0, "value": 0.2}, {"time": 8, "value": 0.9}]}
        params.update(overrides)
        return self.script._draw_automation(params)

    def test_draw_linear_ramp_and_readback(self):
        result = self.draw()
        self.assertEqual(result["parameter"], "Freq")
        self.assertEqual(result["range"], [0.0, 1.0])
        self.assertEqual(result["steps"], 64)
        for row in result["readback"]:
            self.assertAlmostEqual(row["actual"], row["expected"], places=6)
        self.assertTrue(self.clip.has_envelopes)

    def test_drawn_values_follow_the_curve(self):
        self.draw()
        env = self.clip.automation_envelope(self.freq)
        self.assertAlmostEqual(env.value_at_time(0.06), 0.2)
        self.assertAlmostEqual(env.value_at_time(4.06), 0.2 + 0.7 * 0.5, delta=0.7 / 63)
        self.assertAlmostEqual(env.value_at_time(7.99), 0.9)  # the drawn endpoint is reached

    def test_replace_discards_previous_envelope(self):
        self.draw(points=[{"time": 0, "value": 0.9}, {"time": 8, "value": 0.9}])
        self.draw(points=[{"time": 0, "value": 0.1}, {"time": 8, "value": 0.1}])
        env = self.clip.automation_envelope(self.freq)
        self.assertEqual({round(v, 6) for _s, _l, v in env.events}, {0.1})

    def test_merge_only_touches_the_drawn_range(self):
        self.draw(points=[{"time": 0, "value": 0.9}, {"time": 8, "value": 0.9}], curve="step")
        self.draw(mode="merge", hold=False, curve="step", points=[{"time": 2, "value": 0.1}, {"time": 4, "value": 0.1}])
        env = self.clip.automation_envelope(self.freq)
        self.assertAlmostEqual(env.value_at_time(1.0), 0.9)
        self.assertAlmostEqual(env.value_at_time(3.0), 0.1)
        self.assertAlmostEqual(env.value_at_time(6.0), 0.9)

    def test_native_range_parameters(self):
        result = self.draw(parameter_index=2, points=[{"time": 0, "value": 10}, {"time": 8, "value": 90}])
        self.assertEqual(result["range"], [0.0, 100.0])
        with self.assertRaises(ValueError):
            self.draw(parameter_index=2, points=[{"time": 0, "value": 101}])

    def test_mixer_targets(self):
        self.draw(device_index=None, parameter_index=None, mixer_parameter="volume")
        self.assertIsNotNone(self.clip.automation_envelope(self.track.mixer_device.volume))
        self.draw(device_index=None, parameter_index=None, mixer_parameter="pan", points=[{"time": 0, "value": -1}, {"time": 8, "value": 1}])
        self.draw(device_index=None, parameter_index=None, mixer_parameter="send:1", points=[{"time": 0, "value": 0.5}])
        self.assertIsNotNone(self.clip.automation_envelope(self.track.mixer_device.sends[1]))

    def test_short_clip_length_is_respected(self):
        with self.assertRaises(ValueError):
            self.draw(clip_index=2, points=[{"time": 0, "value": 0}, {"time": 4, "value": 1}])
        result = self.draw(clip_index=2, points=[{"time": 0, "value": 0}, {"time": 2, "value": 1}])
        self.assertEqual(result["clip_length"], 2.0)

    def test_errors(self):
        cases = [
            (dict(clip_index=1), "empty"), (dict(clip_index=9), "Clip index out of range"),
            (dict(track_index=9), "Track index out of range"), (dict(device_index=9), "Device index out of range"),
            (dict(parameter_index=99), "Parameter index out of range"), (dict(source="arrangement"), "Session clips"),
            (dict(mode="append"), "mode"), (dict(hold="yes"), "hold"), (dict(points=[]), "non-empty"),
            (dict(track_index="0"), "integer"), (dict(mixer_parameter="volume"), "either mixer_parameter"),
            (dict(device_index=None, parameter_index=None, mixer_parameter="reverb"), "mixer_parameter must be"),
            (dict(device_index=None, parameter_index=None, mixer_parameter="send:9"), "Send index"),
            (dict(device_index=None, parameter_index=None, mixer_parameter="sendX"), "send must look like"),
        ]
        for overrides, fragment in cases:
            with self.assertRaises((ValueError, IndexError), msg=str(overrides)) as ctx:
                self.draw(**overrides)
            self.assertIn(fragment, str(ctx.exception))
        self.assertFalse(self.clip.has_envelopes)  # failed draws leave nothing behind

    def test_clear_one_and_all(self):
        self.draw()
        self.draw(parameter_index=2, points=[{"time": 0, "value": 5}])
        one = self.script._clear_automation({"track_index": 0, "clip_index": 0, "device_index": 0, "parameter_index": 1})
        self.assertTrue(one["had_envelope"])
        self.assertEqual(one["cleared"], "Freq")
        self.assertTrue(one["clip_has_envelopes"])
        again = self.script._clear_automation({"track_index": 0, "clip_index": 0, "device_index": 0, "parameter_index": 1})
        self.assertFalse(again["had_envelope"])
        everything = self.script._clear_automation({"track_index": 0, "clip_index": 0})
        self.assertEqual(everything["cleared"], "all")
        self.assertFalse(everything["clip_has_envelopes"])


# ---------------------------------------------------------------- ramps

class RampTests(unittest.TestCase):
    def setUp(self):
        self.script = make_script()
        self.addCleanup(self.script._stop_server)
        self.clock = FakeClock()
        self.original_time = mod.time
        mod.time = self.clock
        self.addCleanup(setattr, mod, "time", self.original_time)
        self.freq = self.script._song.tracks[0].devices[0].parameters[1]

    def ramp(self, **overrides):
        params = {"track_index": 0, "device_index": 0, "parameter_index": 1, "to": 1.0, "seconds": 2.0}
        params.update(overrides)
        return self.script._ramp_parameter(params)

    def advance(self, seconds):
        self.clock.now += seconds
        self.script._tick_ramps()

    def test_linear_ramp_progress_and_exact_end(self):
        info = self.ramp(**{"from": 0.0})
        self.assertEqual(info["seconds"], 2.0)
        self.assertEqual(self.freq.value, 0.0)
        self.advance(0.5)
        self.assertAlmostEqual(self.freq.value, 0.25)
        self.advance(1.0)
        self.assertAlmostEqual(self.freq.value, 0.75)
        self.advance(5.0)
        self.assertEqual(self.freq.value, 1.0)
        self.assertEqual(self.script._ramps, {})

    def test_default_start_is_current_value_without_a_jump(self):
        self.freq.value = 0.5
        self.ramp(to=0.0)
        self.assertEqual(self.freq.value, 0.5)
        self.advance(1.0)
        self.assertAlmostEqual(self.freq.value, 0.25)

    def test_beats_convert_with_tempo(self):
        info = self.ramp(seconds=None, beats=4)
        self.assertAlmostEqual(info["seconds"], 2.0)  # 4 beats at 120 bpm

    def test_curves(self):
        for curve, expected in (("ease_in", 0.25), ("ease_out", 0.75), ("smooth", 0.5), ("linear", 0.5)):
            self.freq.value = 0.0
            self.ramp(**{"from": 0.0, "curve": curve})
            self.clock.now += 1.0
            self.script._tick_ramps()
            want = {"ease_in": 0.25, "ease_out": 0.75, "smooth": 0.5, "linear": 0.5}[curve]
            self.assertAlmostEqual(self.freq.value, want, msg=curve)
            self.script._cancel_ramps({})

    def test_new_ramp_replaces_old_on_same_parameter(self):
        self.ramp(**{"from": 0.0, "to": 1.0})
        self.advance(1.0)
        self.ramp(**{"from": 0.5, "to": 0.0})
        self.assertEqual(len(self.script._ramps), 1)
        self.advance(1.0)
        self.assertAlmostEqual(self.freq.value, 0.25)

    def test_independent_parameters_ramp_together(self):
        self.ramp(**{"from": 0.0})
        self.ramp(device_index=None, parameter_index=None, mixer_parameter="volume", to=0.0, **{"from": 1.0})
        self.assertEqual(len(self.script._ramps), 2)
        self.advance(1.0)
        self.assertAlmostEqual(self.freq.value, 0.5)
        self.assertAlmostEqual(self.script._song.tracks[0].mixer_device.volume.value, 0.5)

    def test_cancel_specific_and_all(self):
        self.ramp(**{"from": 0.0})
        self.ramp(device_index=None, parameter_index=None, mixer_parameter="pan", to=1.0)
        cancelled = self.script._cancel_ramps({"track_index": 0, "device_index": 0, "parameter_index": 1})
        self.assertEqual(cancelled, {"cancelled": 1, "active_ramps": 1})
        self.assertEqual(self.script._cancel_ramps({"track_index": 0, "device_index": 0, "parameter_index": 1})["cancelled"], 0)
        self.assertEqual(self.script._cancel_ramps({}), {"cancelled": 1, "active_ramps": 0})
        self.advance(5.0)
        self.assertLess(self.freq.value, 0.9)  # frozen where it was cancelled

    def test_errors(self):
        cases = [
            (dict(to=2.0), "to must"), (dict(to="1"), "to must"), (dict(**{"from": -1}), "from must"),
            (dict(seconds=None), "exactly one"), (dict(beats=4), "exactly one"), (dict(seconds=0), "duration"),
            (dict(seconds=99999), "duration"), (dict(curve="step"), "curve"), (dict(curve="zig"), "curve"),
            (dict(parameter_index=3), "not enabled"), (dict(track_index=9), "Track index"),
            (dict(seconds=None, beats="x"), "beats must"),
        ]
        for overrides, fragment in cases:
            with self.assertRaises((ValueError, IndexError), msg=str(overrides)) as ctx:
                self.ramp(**overrides)
            self.assertIn(fragment, str(ctx.exception))
        self.assertEqual(self.script._ramps, {})

    def test_ramp_survives_a_parameter_that_became_invalid(self):
        self.ramp(**{"from": 0.0})
        self.freq._valid = False
        self.advance(0.5)
        self.assertEqual(self.script._ramps, {})  # dropped, no exception escapes

    def test_out_of_order_or_late_ticks_never_overshoot(self):
        self.ramp(**{"from": 0.0})
        self.advance(100.0)
        self.assertEqual(self.freq.value, 1.0)
        self.assertTrue(all(0.0 <= w <= 1.0 for w in self.freq.writes))


# ---------------------------------------------------------------- dispatcher: registry, errors, undo steps

class DispatcherTests(unittest.TestCase):
    def setUp(self):
        self.script = make_script()
        self.addCleanup(self.script._stop_server)
        self.song = self.script._song

    def run_command(self, command_type, params=None):
        return self.script._process_command({"type": command_type, "params": params or {}})

    def test_every_registered_command_has_a_handler_and_is_advertised(self):
        self.assertGreater(len(mod._COMMANDS), 40)
        capabilities = self.script._get_script_info()["capabilities"]
        for name, entry in mod._COMMANDS.items():
            self.assertTrue(callable(entry["fn"]), name)
            self.assertIn(name, capabilities)
        for feature in ("track_types", "device_paths", "parameter_details", "undo_steps", "error_codes"):
            self.assertIn(feature, capabilities)

    def test_previously_dispatchable_commands_still_exist_and_the_dead_one_is_gone(self):
        expected = """add_notes_to_clip bulk_create_clips bulk_set_clip_names bulk_set_device_parameters cancel_ramps
            clear_automation clear_notes_from_clip create_clip create_midi_track delete_clip draw_automation eval fire_clip
            fire_scene get_audio_clip_path get_browser_categories get_browser_item get_browser_items get_browser_items_at_path
            get_browser_tree get_bulk_session_structure get_clip_notes get_device_parameters get_script_info get_session_info
            get_track_info load_browser_item ramp_parameter set_clip_color set_clip_name set_device_parameter set_scene_name
            set_scene_tempo set_tempo set_track_arm set_track_color set_track_mute set_track_name set_track_solo
            start_playback stop_all_clips stop_clip stop_playback""".split()
        for name in expected:
            self.assertIn(name, mod._COMMANDS)
        self.assertNotIn("load_instrument_or_effect", mod._COMMANDS)

    def test_responses_carry_elapsed_time(self):
        for response in (self.run_command("get_script_info"), self.run_command("nope")):
            self.assertIsInstance(response["elapsed_ms"], float)
            self.assertGreaterEqual(response["elapsed_ms"], 0)

    def test_error_codes(self):
        cases = [
            ({"type": "nope"}, "UNKNOWN_COMMAND"),
            ({"type": "get_track_info", "params": {"track_index": 99}}, "OUT_OF_RANGE"),
            ({"type": "get_track_info", "params": {"track_index": 0, "track_type": "bus"}}, "INVALID_ARGUMENT"),
            ({"type": "get_track_info", "params": {"track_index": "x"}}, "INVALID_ARGUMENT"),
            ({"type": "eval", "params": {"code": "1 +"}}, "INTERNAL_ERROR"),
            ({"type": "eval", "params": {"code": "{}['missing']"}}, "NOT_FOUND"),
            ({"type": "eval", "params": {"code": "[].pop()"}}, "OUT_OF_RANGE"),
            ({"type": "eval", "params": {"code": "1 + 'a'"}}, "TYPE_ERROR"),
            ({"type": "get_track_info", "params": []}, "INVALID_REQUEST"),
        ]
        for command, code in cases:
            response = self.script._process_command(command)
            self.assertEqual(response["status"], "error", command)
            self.assertEqual(response["code"], code, command)
            self.assertTrue(response["message"])
        self.assertEqual(self.script._process_command([1, 2])["code"], "INVALID_REQUEST")

    def test_bridge_error_codes_and_live_errors(self):
        self.assertEqual(mod._error_code(mod.BridgeError("x", "GUARD_FAILED")), "GUARD_FAILED")
        self.assertEqual(mod._error_code(RuntimeError("Cannot set LoopEnd before LoopStart")), "LIVE_ERROR")
        self.assertEqual(mod._error_code(ValueError("Device X not found.")), "NOT_FOUND")
        self.assertEqual(mod._error_code(ZeroDivisionError()), "INTERNAL_ERROR")

    def test_eval_errors_are_errors_not_success_strings(self):
        ok = self.run_command("eval", {"code": "6 * 7"})
        self.assertEqual((ok["status"], ok["result"]), ("success", 42))
        bad = self.run_command("eval", {"code": "undefined_name"})
        self.assertEqual(bad["status"], "error")
        self.assertIn("undefined_name", bad["message"])

    def test_writing_commands_run_inside_exactly_one_undo_step(self):
        self.song.undo_log.clear()
        self.assertEqual(self.run_command("set_tempo", {"tempo": 130.0})["status"], "success")
        self.assertEqual(self.song.undo_log, ["begin", "end"])
        self.song.undo_log.clear()
        self.run_command("set_track_name", {"track_index": 0, "name": "X"})
        self.run_command("set_track_name", {"track_index": 1, "name": "Y"})
        self.assertEqual(self.song.undo_log, ["begin", "end", "begin", "end"])  # one step per command, not one giant step

    def test_undo_step_is_closed_when_the_command_fails(self):
        self.song.undo_log.clear()
        response = self.run_command("set_track_name", {"track_index": 99, "name": "X"})
        self.assertEqual(response["status"], "error")
        self.assertEqual(self.song.undo_log, ["begin", "end"])

    def test_read_commands_open_no_undo_step(self):
        self.song.undo_log.clear()
        for name in ("get_session_info", "get_script_info", "get_bulk_session_structure"):
            self.run_command(name)
        self.run_command("get_track_info", {"track_index": 0})
        self.run_command("cancel_ramps")
        self.assertEqual(self.song.undo_log, [])

    def test_destructive_commands_are_flagged(self):
        for name in ("delete_clip", "clear_notes_from_clip", "clear_automation"):
            self.assertTrue(mod._COMMANDS[name]["destructive"], name)
        self.assertFalse(mod._COMMANDS["set_tempo"]["destructive"])

    def test_errors_are_no_longer_hidden_inside_success_payloads(self):
        response = self.run_command("set_scene_tempo", {"scene_index": 99, "tempo": 120})
        self.assertEqual(response["status"], "error")
        self.assertEqual(response["code"], "OUT_OF_RANGE")
        response = self.run_command("set_clip_color", {"track_index": 0, "clip_index": 1, "color": 5})  # empty slot
        self.assertEqual(response["status"], "error")
        self.assertIn("No clip in slot", response["message"])


# ---------------------------------------------------------------- addressing: track types, device paths, details

class AddressingTests(unittest.TestCase):
    def setUp(self):
        self.script = make_script()
        self.addCleanup(self.script._stop_server)
        self.song = self.script._song
        self.rack_track = 2

    def test_track_by(self):
        self.assertIs(self.script._track_by("track", 1), self.song.tracks[1])
        self.assertIs(self.script._track_by(None, 0), self.song.tracks[0])
        self.assertIs(self.script._track_by("return", 0), self.song.return_tracks[0])
        self.assertIs(self.script._track_by("master", None), self.song.master_track)
        self.assertIs(self.script._track_by("master", 99), self.song.master_track)  # index ignored
        for args, fragment in ((("track", 9), "Track index out of range"), (("return", 1), "Return track index out of range"),
                               (("return", -1), "Return track index out of range"), (("bus", 0), "track_type must be"),
                               (("track", None), "integer"), (("track", 1.5), "integer")):
            with self.assertRaises((ValueError, IndexError), msg=str(args)) as ctx:
                self.script._track_by(*args)
            self.assertIn(fragment, str(ctx.exception))

    def path(self, *path):
        return self.script._device_by(self.song.tracks[self.rack_track], None, list(path)).name

    def test_device_path_through_chains(self):
        self.assertEqual(self.path(0), "Audio Effect Rack")
        self.assertEqual(self.path(0, 0, 0), "Delay")
        self.assertEqual(self.path(0, 0, 1), "Inner Rack")
        self.assertEqual(self.path(0, 0, 1, 0, 0), "Deep Effect")
        self.assertEqual(self.path(0, {"return": 0}, 0), "Reverb")
        self.assertEqual(self.path(1, {"pad": 36}, 0), "Kick Synth")
        self.assertEqual(self.path(1, 0, 0), "Kick Synth")  # chain index into a drum rack's chains
        self.assertEqual(self.path(2), "Plain")

    def test_device_path_errors(self):
        cases = [
            ([], "alternate device and chain"), ([0, 0], "alternate device and chain"), ("0", "alternate device and chain"),
            ([9], "Device index out of range at device_path[0]"), ([0, 5, 0], "Chain index out of range at device_path[1]"),
            ([0, 1, 0], "Device index out of range at device_path[2]"), ([2, 0, 0], "has no chains"),
            ([0, {"pad": 36}, 0], "has no drum pads"), ([1, {"pad": 40}, 0], "drum pad 40 is empty"),
            ([1, {"pad": 999}, 0], "note out of range"), ([0, {"return": 4}, 0], "Chain index out of range"),
            ([0, {"other": 1}, 0], "needs 'pad' or 'return'"), ([0, "x", 0], "integer"), ([0, 0, 1.5], "integer"),
            ([1, {"pad": 36, "chain": 3}, 0], "Chain index out of range"),
        ]
        for path, fragment in cases:
            with self.assertRaises((ValueError, IndexError), msg=str(path)) as ctx:
                self.script._device_by(self.song.tracks[self.rack_track], None, path)
            self.assertIn(fragment, str(ctx.exception))

    def test_device_index_and_path_are_exclusive(self):
        with self.assertRaises(ValueError):
            self.script._device_by(self.song.tracks[0], 0, [0])
        with self.assertRaises(IndexError):
            self.script._device_by(self.song.tracks[0], 5)

    def test_describe_parameter(self):
        quantized = self.script._describe_parameter(4, FakeParam("Mode", 1, 0, 2, items=["A", "B", "C"]))
        self.assertTrue(quantized["is_quantized"])
        self.assertEqual(quantized["value_items"], ["A", "B", "C"])
        self.assertEqual(quantized["display"], "B")
        self.assertNotIn("default", quantized)  # default_value raises for quantized parameters
        plain = self.script._describe_parameter(1, FakeParam("Freq", 0.5, 0, 1))
        self.assertFalse(plain["is_quantized"])
        self.assertEqual((plain["default"], plain["display"], plain["is_enabled"]), (0.0, "0.5 units", True))
        self.assertNotIn("value_items", plain)
        self.assertFalse(self.script._describe_parameter(3, FakeParam("Off", enabled=False))["is_enabled"])

    def test_describe_device_structure(self):
        tree = self.script._describe_device_structure(self.song.tracks[self.rack_track].devices[0])
        self.assertTrue(tree["can_have_chains"] and not tree["can_have_drum_pads"])
        self.assertEqual([c["name"] for c in tree["chains"]], ["Wide", "Dry"])
        self.assertEqual(tree["chains"][0]["devices"], ["Delay", "Inner Rack"])
        self.assertEqual(tree["return_chains"][0]["devices"], ["Reverb"])
        drum = self.script._describe_device_structure(self.song.tracks[self.rack_track].devices[1])
        self.assertEqual(drum["drum_pads"], [{"note": 36, "name": "Kick", "chain_count": 1, "device_count": 1}])
        self.assertEqual(self.script._describe_device_structure(self.song.tracks[0].devices[0]),
                         {"can_have_chains": False, "can_have_drum_pads": False})

    def test_device_type_uses_live_enum_and_racks(self):
        devices = self.song.tracks[self.rack_track].devices
        self.assertEqual(self.script._get_device_type(devices[0]), "rack")
        self.assertEqual(self.script._get_device_type(devices[1]), "drum_machine")
        self.assertEqual(self.script._get_device_type(FakeDevice("Synth", dev_type=1)), "instrument")
        self.assertEqual(self.script._get_device_type(FakeDevice("Fx", dev_type=2)), "audio_effect")
        self.assertEqual(self.script._get_device_type(FakeDevice("Arp", dev_type=4)), "midi_effect")
        self.assertEqual(self.script._get_device_type(FakeDevice("Odd", dev_type=0)), "unknown")

    def test_get_device_parameters_for_every_target(self):
        base = self.script._get_device_parameters(0, 0)
        self.assertEqual(base["track_type"], "track")
        self.assertEqual(base["device_type"], "audio_effect")
        self.assertEqual([p["name"] for p in base["parameters"]], ["Device On", "Freq", "Drive", "Off", "Mode"])
        self.assertEqual(base["parameters"][4]["value_items"], ["A", "B", "C"])
        ret = self.script._get_device_parameters(0, 0, "return")
        self.assertEqual((ret["device_name"], ret["track_type"]), ("Return Reverb", "return"))
        master = self.script._get_device_parameters(None, 0, "master")
        self.assertEqual(master["device_name"], "Limiter")
        nested = self.script._get_device_parameters(self.rack_track, None, "track", [0, 0, 1, 0, 0])
        self.assertEqual((nested["device_name"], nested["device_path"]), ("Deep Effect", [0, 0, 1, 0, 0]))
        rack = self.script._get_device_parameters(self.rack_track, 0)
        self.assertEqual(rack["device_type"], "rack")
        self.assertEqual([c["name"] for c in rack["chains"]], ["Wide", "Dry"])

    def test_set_device_parameter_for_every_target(self):
        out = self.script._set_device_parameter(0, 0, 1, 0.7)
        self.assertEqual((out["old_value"], out["value"]), (0.5, 0.7))
        self.assertEqual(out["display"], "0.7 units")
        self.script._set_device_parameter(0, 0, 1, 0.1, "return")
        self.assertEqual(self.song.return_tracks[0].devices[0].parameters[1].value, 0.1)
        self.script._set_device_parameter(None, 0, 1, 0.2, "master")
        self.assertEqual(self.song.master_track.devices[0].parameters[1].value, 0.2)
        self.script._set_device_parameter(self.rack_track, None, 1, 0.9, "track", [0, {"return": 0}, 0])
        self.assertEqual(self.song.tracks[self.rack_track].devices[0].return_chains[0].devices[0].parameters[1].value, 0.9)
        with self.assertRaises(IndexError):
            self.script._set_device_parameter(0, 0, 99, 0.1)
        with self.assertRaises(Exception):
            self.script._set_device_parameter(0, 0, 3, 0.1)  # disabled

    def test_bulk_set_with_types_and_paths(self):
        result = self.script._bulk_set_device_parameters([
            {"track_index": 0, "device_index": 0, "parameter_index": 1, "value": 0.6},
            {"track_index": 0, "track_type": "return", "device_index": 0, "parameter_index": 1, "value": 0.3},
            {"track_type": "master", "device_index": 0, "parameter_index": 1, "value": 0.4},
            {"track_index": self.rack_track, "device_path": [0, 0, 0], "parameter_index": 1, "value": 0.8},
            {"track_index": 0, "device_path": [0, 0, 0], "parameter_index": 1, "value": 0.8},
            {"track_index": 0, "track_type": "return", "device_index": 3, "parameter_index": 1, "value": 0.3},
            {"track_index": 0, "device_index": 0, "device_path": [0], "parameter_index": 1, "value": 0.3},
            {"track_type": "master", "parameter_index": 1, "value": 0.3},
        ])
        self.assertEqual(result["count"], 4)
        self.assertEqual([s["item"] for s in result["skipped"]], [4, 5, 6, 7])
        self.assertEqual(result["updated"][1]["track_type"], "return")
        self.assertEqual(result["updated"][3]["device_path"], [0, 0, 0])
        self.assertIn("Device index out of range", result["skipped"][1]["reason"])
        self.assertIn("not both", result["skipped"][2]["reason"])

    def test_get_track_info_for_return_and_master(self):
        ret = self.script._get_track_info(0, "return")
        self.assertEqual((ret["track_type"], ret["index"], ret["name"]), ("return", 0, "Return A"))
        self.assertEqual(ret["clip_slots"], [])
        self.assertEqual(ret["devices"][0]["name"], "Return Reverb")
        master = self.script._get_track_info(None, "master")
        self.assertEqual((master["track_type"], master["index"]), ("master", None))
        self.assertEqual(master["devices"][0]["type"], "audio_effect")
        rack = self.script._get_track_info(self.rack_track)
        self.assertEqual([d["type"] for d in rack["devices"]], ["rack", "drum_machine", "audio_effect"])
        self.assertTrue(rack["devices"][0]["can_have_chains"])
        with self.assertRaises(IndexError):
            self.script._get_track_info(5, "return")

    def test_track_setters_on_return_and_master(self):
        self.script._set_track_name(0, "Space", "return")
        self.assertEqual(self.song.return_tracks[0].name, "Space")
        self.script._set_track_mute(0, True, "return")
        self.assertTrue(self.song.return_tracks[0].mute)
        self.script._set_track_solo(0, True, "return")
        self.assertTrue(self.song.return_tracks[0].solo)
        self.script._set_track_color(0, 123, "return")
        self.assertEqual(self.song.return_tracks[0].color, 123)
        for setter in (self.script._set_track_mute, self.script._set_track_solo):
            with self.assertRaises(ValueError) as ctx:
                setter(None, True, "master")
            self.assertIn("master track cannot", str(ctx.exception))
        with self.assertRaises(Exception) as ctx:
            self.script._set_track_arm(0, True, "return")  # returns cannot be armed
        self.assertIn("cannot be armed", str(ctx.exception))

    def test_bulk_session_structure_lists_returns_and_master(self):
        structure = self.script._get_bulk_session_structure()
        self.assertEqual(structure["return_tracks"][0]["name"], "Return A")
        self.assertEqual(structure["return_tracks"][0]["track_type"], "return")
        self.assertEqual(structure["master"]["device_count"], 1)
        self.assertIsNone(structure["master"]["index"])
        self.assertEqual(structure["session"]["return_track_count"], 1)

    def test_load_browser_item_selects_the_right_track(self):
        # _load_browser_item needs Live's browser; verify only the track resolution and the error path
        self.script._song.view = types.SimpleNamespace(selected_track=None)
        self.script.application = lambda: types.SimpleNamespace(browser=types.SimpleNamespace())
        with self.assertRaises(Exception):
            self.script._load_browser_item(0, "nope", "return")
        self.assertIs(self.script._song.view.selected_track, None)  # failed lookup happens before selecting
        with self.assertRaises(IndexError):
            self.script._load_browser_item(9, "nope", "return")

    def test_parameter_resolution_for_ramps_and_automation(self):
        idx, track, param, target = self.script._resolve_parameter({"track_index": 0, "track_type": "return", "device_index": 0, "parameter_index": 1})
        self.assertIs(param, self.song.return_tracks[0].devices[0].parameters[1])
        self.assertEqual(target, {"track_type": "return", "device_index": 0, "parameter_index": 1})
        idx, track, param, target = self.script._resolve_parameter({"track_type": "master", "mixer_parameter": "volume"})
        self.assertIs(param, self.song.master_track.mixer_device.volume)
        self.assertIsNone(idx)
        self.assertEqual(target, {"track_type": "master", "mixer_parameter": "volume"})
        idx, track, param, target = self.script._resolve_parameter({"track_index": self.rack_track, "device_path": [0, 0, 0], "parameter_index": 2})
        self.assertIs(param, self.song.tracks[self.rack_track].devices[0].chains[0].devices[0].parameters[2])
        self.assertEqual(target, {"device_path": [0, 0, 0], "parameter_index": 2})
        self.assertEqual(self.script._resolve_parameter({"track_index": 1, "device_index": 0, "parameter_index": 1})[3],
                         {"device_index": 0, "parameter_index": 1})  # regular tracks keep the compact target
        for params, fragment in (
                ({"track_type": "master", "mixer_parameter": "send:0"}, "Send index out of range"),
                ({"track_index": 0, "track_type": "return", "mixer_parameter": "send:1"}, None),
                ({"track_index": 0, "device_path": [0], "device_index": 0, "parameter_index": 1}, "not both"),
                ({"track_index": 0, "mixer_parameter": "volume", "device_path": [0]}, "not both"),
                ({"track_index": 0, "device_path": [0], "parameter_index": 99}, "Parameter index out of range")):
            if fragment is None:
                self.script._resolve_parameter(params)  # returns do have sends
                continue
            with self.assertRaises((ValueError, IndexError), msg=str(params)) as ctx:
                self.script._resolve_parameter(params)
            self.assertIn(fragment, str(ctx.exception))

    def test_ramps_on_return_master_and_nested_devices_are_independent(self):
        clock = FakeClock()
        original = mod.time
        mod.time = clock
        self.addCleanup(setattr, mod, "time", original)
        common = {"to": 1.0, "from": 0.0, "seconds": 2.0}
        self.script._ramp_parameter(dict(common, track_index=0, device_index=0, parameter_index=1))
        self.script._ramp_parameter(dict(common, track_index=0, track_type="return", device_index=0, parameter_index=1))
        self.script._ramp_parameter(dict(common, track_type="master", mixer_parameter="volume"))
        self.script._ramp_parameter(dict(common, track_index=self.rack_track, device_path=[0, 0, 0], parameter_index=1))
        self.assertEqual(len(self.script._ramps), 4)
        clock.now += 1.0
        self.script._tick_ramps()
        self.assertAlmostEqual(self.song.tracks[0].devices[0].parameters[1].value, 0.5)
        self.assertAlmostEqual(self.song.return_tracks[0].devices[0].parameters[1].value, 0.5)
        self.assertAlmostEqual(self.song.master_track.mixer_device.volume.value, 0.5)
        self.assertAlmostEqual(self.song.tracks[self.rack_track].devices[0].chains[0].devices[0].parameters[1].value, 0.5)
        cancelled = self.script._cancel_ramps({"track_index": 0, "track_type": "return", "device_index": 0, "parameter_index": 1})
        self.assertEqual(cancelled, {"cancelled": 1, "active_ramps": 3})
        self.assertEqual(self.script._cancel_ramps({"track_type": "master", "mixer_parameter": "volume"})["cancelled"], 1)

    def test_automation_is_for_regular_tracks_only(self):
        for track_type in ("return", "master"):
            with self.assertRaises(ValueError) as ctx:
                self.script._draw_automation({"track_index": 0, "track_type": track_type, "clip_index": 0, "device_index": 0,
                                              "parameter_index": 1, "points": [{"time": 0, "value": 0.5}]})
            self.assertIn("Only regular tracks have clips", str(ctx.exception))
            with self.assertRaises(ValueError):
                self.script._clear_automation({"track_index": 0, "track_type": track_type, "clip_index": 0})

    def test_draw_automation_on_a_nested_device_parameter(self):
        self.song.tracks[self.rack_track].clip_slots = [FakeSlot(FakeClip("rack clip", 4.0))]
        result = self.script._draw_automation({"track_index": self.rack_track, "clip_index": 0, "device_path": [0, 0, 0], "parameter_index": 1,
                                               "points": [{"time": 0, "value": 0.2}, {"time": 4, "value": 0.8}]})
        self.assertEqual(result["target"], {"device_path": [0, 0, 0], "parameter_index": 1})
        self.assertEqual(result["parameter"], "Freq")
        for row in result["readback"]:
            self.assertAlmostEqual(row["actual"], row["expected"], places=6)


# ---------------------------------------------------------------- pumped server

class PumpServerTests(unittest.TestCase):
    """Real sockets; a helper thread plays the role of Live.Base.Timer by calling _pump()."""

    def setUp(self):
        self.port = free_port()
        self.script = make_script(self.port)
        self.timer = FakeTimer.instances[-1]
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run_pump, daemon=True)
        self.thread.start()
        self.addCleanup(self.shutdown)

    def run_pump(self):
        while not self.stop.is_set():
            self.script._pump()
            real_time.sleep(0.002)

    def shutdown(self):
        self.stop.set()
        self.thread.join(2)
        self.script._stop_server()

    def connect(self):
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        return sock

    def read_json(self, sock):
        buffer = b""
        while True:
            chunk = sock.recv(1 << 20)
            if not chunk:
                raise AssertionError("connection closed early: " + repr(buffer[:200]))
            buffer += chunk
            try:
                return json.loads(buffer.decode("utf-8"))
            except ValueError:
                continue

    def call(self, command_type, params=None, sock=None):
        sock = sock or self.connect()
        sock.sendall(json.dumps({"type": command_type, "params": params or {}}).encode("utf-8"))
        try:
            return self.read_json(sock)
        finally:
            sock.close()

    def test_server_uses_the_timer_pump(self):
        self.assertTrue(self.timer.running)
        self.assertEqual(self.timer.interval, mod.PUMP_INTERVAL_MS)

    def test_read_and_write_commands_round_trip_without_deadlock(self):
        info = self.call("get_script_info")
        self.assertEqual(info["status"], "success")
        self.assertIn("draw_automation", info["result"]["capabilities"])
        self.assertEqual(info["result"]["script_version"], "1.11.0")
        tempo = self.call("set_tempo", {"tempo": 133.0})
        self.assertEqual(tempo["status"], "success")
        self.assertEqual(self.script._song.tempo, 133.0)

    def test_fast_round_trips(self):
        timings = []
        for _ in range(30):
            start = real_time.time()
            self.call("get_script_info")
            timings.append(real_time.time() - start)
        self.assertLess(sorted(timings)[len(timings) // 2], 0.05)

    def test_request_split_across_packets(self):
        sock = self.connect()
        payload = json.dumps({"type": "get_script_info", "params": {}}).encode("utf-8")
        sock.sendall(payload[:10])
        real_time.sleep(0.05)
        sock.sendall(payload[10:])
        self.assertEqual(self.read_json(sock)["status"], "success")
        sock.close()

    def test_multibyte_character_split_across_packets(self):
        sock = self.connect()
        payload = json.dumps({"type": "eval", "params": {"code": "'héllo ✓'"}}, ensure_ascii=False).encode("utf-8")
        cut = payload.index("✓".encode("utf-8")) + 1
        sock.sendall(payload[:cut])
        real_time.sleep(0.05)
        sock.sendall(payload[cut:])
        self.assertEqual(self.read_json(sock)["result"], "héllo ✓")
        sock.close()

    def test_large_response_is_flushed_completely(self):
        response = self.call("eval", {"code": "'x' * 5000000"})
        self.assertEqual(len(response["result"]), 5000000)

    def test_concurrent_clients(self):
        socks = [self.connect() for _ in range(6)]
        for i, sock in enumerate(socks):
            sock.sendall(json.dumps({"type": "eval", "params": {"code": str(i) + " * 10"}}).encode("utf-8"))
        self.assertEqual([self.read_json(sock)["result"] for sock in socks], [i * 10 for i in range(6)])
        for sock in socks:
            sock.close()

    def test_unknown_command_and_handler_error_are_reported(self):
        unknown = self.call("nope")
        self.assertEqual(unknown["status"], "error")
        self.assertIn("Unknown command", unknown["message"])
        bad = self.call("draw_automation", {"track_index": 0, "clip_index": 1, "device_index": 0, "parameter_index": 1,
                                            "points": [{"time": 0, "value": 0}]})
        self.assertEqual(bad["status"], "error")
        self.assertIn("empty", bad["message"])
        self.assertEqual(self.call("get_script_info")["status"], "success")  # still serving

    def test_malformed_json_does_not_break_the_server(self):
        sock = self.connect()
        sock.sendall(b'{"type": "get_scr')
        real_time.sleep(0.1)
        sock.close()
        self.assertEqual(self.call("get_script_info")["status"], "success")
        deadline = real_time.time() + 2
        while self.script._clients and real_time.time() < deadline:
            real_time.sleep(0.01)
        self.assertEqual(len(self.script._clients), 0)

    def test_client_disconnecting_before_the_response_is_survivable(self):
        sock = self.connect()
        sock.sendall(json.dumps({"type": "eval", "params": {"code": "'x' * 3000000"}}).encode("utf-8"))
        sock.close()
        real_time.sleep(0.2)
        self.assertEqual(self.call("get_script_info")["status"], "success")

    def test_idle_clients_are_closed(self):
        original = mod.CLIENT_IDLE_SECONDS
        mod.CLIENT_IDLE_SECONDS = 0.05
        self.addCleanup(setattr, mod, "CLIENT_IDLE_SECONDS", original)
        sock = self.connect()
        real_time.sleep(0.3)
        sock.settimeout(1)
        self.assertEqual(sock.recv(10), b"")
        sock.close()

    def test_oversized_request_gets_an_error(self):
        original = mod.MAX_REQUEST_BYTES
        mod.MAX_REQUEST_BYTES = 1000
        self.addCleanup(setattr, mod, "MAX_REQUEST_BYTES", original)
        sock = self.connect()
        sock.sendall(b"x" * 5000)
        self.assertIn("too large", self.read_json(sock)["message"])
        sock.close()

    def test_ramp_advances_between_pump_ticks(self):
        response = self.call("ramp_parameter", {"track_index": 0, "device_index": 0, "parameter_index": 1,
                                                "to": 1.0, "from": 0.0, "seconds": 0.4})
        self.assertEqual(response["status"], "success")
        param = self.script._song.tracks[0].devices[0].parameters[1]
        real_time.sleep(0.2)
        self.assertTrue(0.2 < param.value < 0.8, param.value)
        real_time.sleep(0.5)
        self.assertEqual(param.value, 1.0)
        self.assertGreater(len(param.writes), 20)  # smooth: many small updates, not a jump
        self.assertEqual(self.call("cancel_ramps")["result"], {"cancelled": 0, "active_ramps": 0})

    def test_bulk_set_reports_actual_values_and_skips(self):
        response = self.call("bulk_set_device_parameters", {"items": [
            {"track_index": 0, "device_index": 0, "parameter_index": 1, "value": 0.7},
            {"track_index": 0, "device_index": 0, "parameter_index": 3, "value": 1},
            {"track_index": 9, "device_index": 0, "parameter_index": 1, "value": 1},
            {"track_index": 0}]})["result"]
        self.assertEqual(response["count"], 1)
        self.assertEqual([s["item"] for s in response["skipped"]], [1, 2, 3])
        self.assertIn("not enabled", response["skipped"][0]["reason"])

    def test_disconnect_stops_everything(self):
        self.stop.set()
        self.thread.join(2)
        self.script.disconnect()
        self.assertFalse(self.timer.running)
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", self.port), timeout=1)


class NoTimerTests(unittest.TestCase):
    """Live 12+ only: without Live.Base.Timer the server refuses to start instead of falling back to threads."""

    def test_missing_timer_is_reported_not_faked(self):
        timer = sys.modules["Live"].Base.Timer
        del sys.modules["Live"].Base.Timer
        try:
            script = make_script()
            self.assertIsNone(script._pump_timer)
            self.assertIsNone(script.server)
            self.assertTrue(any("requires Live 12" in message for message in script.logs))
            script.disconnect()
        finally:
            sys.modules["Live"].Base.Timer = timer


if __name__ == "__main__":
    unittest.main()
