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
    def __init__(self, name, value=0.0, low=0.0, high=1.0, enabled=True):
        self.name, self.value, self.min, self.max, self.is_enabled = name, value, low, high, enabled
        self.writes = []
        self._valid = True

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


class FakeTrack(object):
    def __init__(self, name):
        self.name = name
        self.devices = [types.SimpleNamespace(name="Dev", parameters=[
            FakeParam("Device On", 1, 0, 1), FakeParam("Freq", 0.5, 0, 1), FakeParam("Drive", 50, 0, 100),
            FakeParam("Off", 0, 0, 1, enabled=False)])]
        self.mixer_device = types.SimpleNamespace(volume=FakeParam("Volume", 0.85, 0, 1), panning=FakeParam("Pan", 0, -1, 1),
                                                  sends=[FakeParam("Send A", 0, 0, 1), FakeParam("Send B", 0, 0, 1)])
        self.clip_slots = [FakeSlot(FakeClip("loop", 8.0)), FakeSlot(), FakeSlot(FakeClip("short", 2.0))]


def make_song():
    return types.SimpleNamespace(tempo=120.0, tracks=[FakeTrack("A"), FakeTrack("B")])


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

    def test_server_uses_the_timer_pump_not_threads(self):
        self.assertIsNone(self.script.server_thread)
        self.assertTrue(self.timer.running)
        self.assertEqual(self.timer.interval, mod.PUMP_INTERVAL_MS)

    def test_read_and_write_commands_round_trip_without_deadlock(self):
        info = self.call("get_script_info")
        self.assertEqual(info["status"], "success")
        self.assertIn("draw_automation", info["result"]["capabilities"])
        self.assertEqual(info["result"]["script_version"], "1.9.0")
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


class ThreadedFallbackTests(unittest.TestCase):
    """Without Live.Base.Timer the original threaded server is used."""

    def test_fallback_serves_requests(self):
        timer = sys.modules["Live"].Base.Timer
        del sys.modules["Live"].Base.Timer
        try:
            script = make_script()
            self.assertIsNone(script._pump_timer)
            self.assertIsNotNone(script.server_thread)
            sock = socket.create_connection(("127.0.0.1", mod.DEFAULT_PORT), timeout=5)
            sock.sendall(json.dumps({"type": "get_script_info", "params": {}}).encode("utf-8"))
            self.assertEqual(json.loads(sock.recv(1 << 16).decode("utf-8"))["status"], "success")
            sock.close()
            script.disconnect()
        finally:
            sys.modules["Live"].Base.Timer = timer


if __name__ == "__main__":
    unittest.main()
