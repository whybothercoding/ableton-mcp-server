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


class FakeEnvelopeEvent(object):
    def __init__(self, time, value, control_coefficients=None):
        self.time, self.value, self.control_coefficients = time, value, control_coefficients


class FakeEnvelope(object):
    """Steps are (start, length, value); like Live, value_at_time(t) is the step with start < t <= end. Breakpoints made with
    create_event are joined by straight lines, and two at one time make a jump."""

    def __init__(self, parameter):
        self.parameter, self.events, self.breakpoints = parameter, [], []

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

    def create_event(self, event):
        self.breakpoints.append((event.time, event.value))
        self.breakpoints.sort(key=lambda b: b[0])            # stable: same-time events keep their creation order

    def delete_events_in_range(self, start, end):
        self._carve(start, end)
        self.breakpoints = [b for b in self.breakpoints if not start - 1e-12 <= b[0] < end - 1e-12 and not (b[0] == end == start)]

    def events_in_range(self, start, end):
        return [types.SimpleNamespace(time=t, value=v) for t, v in self.breakpoints if start - 1e-12 <= t <= end + 1e-12] + \
               [types.SimpleNamespace(time=t, value=v) for s0, l0, v0 in self.events for t, v in ((s0, v0), (s0 + l0, v0))
                if start - 1e-12 <= t <= end + 1e-12]

    def value_at_time(self, t):
        if self.breakpoints:
            points = self.breakpoints
            if t <= points[0][0]:
                return points[0][1]
            for i in range(len(points) - 1):
                (t0, v0), (t1, v1) = points[i], points[i + 1]
                if t0 <= t < t1:
                    return v0 + (v1 - v0) * (t - t0) / (t1 - t0)
            return points[-1][1]
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
        self.calls = []
        self.is_playing = self.is_triggered = self.is_recording = False

    def fire(self, *args):
        self.calls.append(("fire",) + args)
        self.is_triggered = True

    def stop(self):
        self.calls.append(("stop",))

    def create_clip(self, length):
        self.clip, self.has_clip = PropClip("", length), True


class Typed(object):
    """Setters mimic Boost.Python: exact C++ types (float takes int/bool, int takes bool but not float, str only str)."""
    _types = {}

    def __setattr__(self, key, value):
        expected = self._types.get(key)
        if expected is not None:
            accepted = {float: isinstance(value, (int, float)), int: isinstance(value, int) and not isinstance(value, float),
                        str: isinstance(value, str), bool: isinstance(value, (bool, int))}[expected]
            if not accepted:
                raise TypeError("Python argument types in\n    None.None({0}, {1})\ndid not match C++ signature".format(
                    type(self).__name__, type(value).__name__))
        object.__setattr__(self, key, value)


class PropClip(Typed, FakeClip):
    """A MIDI clip with Live-like property behaviour: loop marker ordering, launch mode validation, audio-only errors."""
    _types = {"name": str, "color": int, "muted": bool, "looping": bool, "loop_start": float, "loop_end": float,
              "start_marker": float, "end_marker": float, "position": float, "legato": bool, "velocity_amount": float,
              "pitch_coarse": int, "launch_mode": int, "launch_quantization": int, "signature_numerator": int}

    def __init__(self, name="clip", length=4.0):
        FakeClip.__init__(self, name, length)
        self._loop_start, self._loop_end, self._launch_mode = 0.0, length, 0
        self.color, self.muted, self.looping, self.legato = 0, False, True, False
        self.start_marker, self.end_marker, self.position = 0.0, length, 0.0
        self.velocity_amount, self.launch_quantization, self.signature_numerator = 0.0, 0, 4
        self.is_audio_clip, self.is_midi_clip = False, True
        self.scale_intervals = (0, 2, 4)
        self.calls = []
        self.groove = None
        self.has_groove = True

    def _record(name):
        def method(self, *args):
            self.calls.append((name,) + args)
        return method

    crop = _record("crop")
    duplicate_loop = _record("duplicate_loop")
    quantize = _record("quantize")
    quantize_pitch = _record("quantize_pitch")
    scrub = _record("scrub")
    stop_scrub = _record("stop_scrub")
    move_playing_pos = _record("move_playing_pos")
    del _record

    @property
    def loop_start(self):
        return self._loop_start

    @loop_start.setter
    def loop_start(self, value):
        if value > self._loop_end:
            raise RuntimeError("Cannot set LoopStart behind LoopEnd")
        self._loop_start = value

    @property
    def loop_end(self):
        return self._loop_end

    @loop_end.setter
    def loop_end(self, value):
        if value < self._loop_start:
            raise RuntimeError("Cannot set LoopEnd before LoopStart")
        self._loop_end = value

    @property
    def launch_mode(self):
        return self._launch_mode

    @launch_mode.setter
    def launch_mode(self, value):
        if value not in (0, 1, 2, 3):
            raise RuntimeError("Invalid launch mode {0}".format(value))
        self._launch_mode = value

    @property
    def gain(self):
        raise RuntimeError("Not an audio clip")


class PropScene(Typed):
    _types = {"name": str, "tempo": float, "tempo_enabled": bool, "time_signature_numerator": int}

    def __init__(self, name):
        self.name, self.color, self.tempo, self.tempo_enabled = name, 0, 120.0, False
        self.time_signature_numerator, self.time_signature_denominator, self.time_signature_enabled = 4, 4, False
        self.is_empty, self.is_triggered = True, False
        self.calls = []

    def fire(self, *args):
        self.calls.append(("fire",) + args)


class FakeGroove(Typed):
    _types = {"name": str, "base": int, "timing_amount": float, "quantization_amount": float, "random_amount": float,
              "velocity_amount": float}

    def __init__(self, name, base=3, timing=100.0):
        self.name, self.base, self.timing_amount = name, base, timing
        self.quantization_amount, self.random_amount, self.velocity_amount = 0.0, 0.0, 0.0


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
    mixer = types.SimpleNamespace(volume=FakeParam("Volume", 0.85, 0, 1), panning=FakeParam("Pan", 0, -1, 1), crossfade_assign=1, panning_mode=0)
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


class FakeNoteVector(list):
    """Like Live's MidiNoteVector: apply_note_modifications accepts only this type, not a plain list."""


class FakeMidiNote(object):
    """A note with Live's validation: setters raise IndexError for out-of-range values (Live's message style)."""
    _ranges = {"pitch": (0, 127), "velocity": (1, 127), "probability": (0.0, 1.0), "velocity_deviation": (-127, 127),
               "release_velocity": (0, 127)}

    def __init__(self, pitch, start_time, duration, velocity=100.0, mute=False, probability=1.0, velocity_deviation=0.0,
                 release_velocity=64.0, note_id=None):
        object.__setattr__(self, "note_id", note_id)
        for name, value in (("pitch", pitch), ("start_time", start_time), ("duration", duration), ("velocity", velocity),
                            ("mute", mute), ("probability", probability), ("velocity_deviation", velocity_deviation),
                            ("release_velocity", release_velocity)):
            object.__setattr__(self, name, value)

    def validate(self):
        for name, (low, high) in self._ranges.items():
            if not low <= getattr(self, name) <= high:
                raise IndexError("Invalid note {0} {1}".format(name.replace("_", " "), getattr(self, name)))
        if self.duration < 0:
            raise IndexError("A negative note duration is not allowed")

    def __setattr__(self, name, value):
        if name == "note_id":
            raise AttributeError("note_id is read-only")
        object.__setattr__(self, name, value)
        self.validate()

    def copy(self):
        return FakeMidiNote(self.pitch, self.start_time, self.duration, self.velocity, self.mute, self.probability,
                            self.velocity_deviation, self.release_velocity, self.note_id)


class NoteClip(PropClip):
    """A MIDI clip with the extended note API: ids, one note per pitch at any time, vectors, selection."""

    def __init__(self, name="notes", length=4.0):
        PropClip.__init__(self, name, length)
        self._notes, self._next_id, self._selected = [], 1, set()
        self.add_calls = 0

    def _store(self, spec):
        note = FakeMidiNote(spec.pitch, spec.start_time, spec.duration, spec.velocity, spec.mute, spec.probability,
                            spec.velocity_deviation, spec.release_velocity, self._next_id)
        note.validate()
        self._next_id += 1
        kept = []
        for n in self._notes:                          # Live: same start replaces, an earlier note running into the new one is cut short
            if n.pitch == note.pitch and n.start_time == note.start_time:
                continue
            if n.pitch == note.pitch and n.start_time < note.start_time < n.start_time + n.duration:
                n = n.copy()
                n.duration = note.start_time - n.start_time
            kept.append(n)
        self._notes = kept + [note]
        return note.note_id

    def add_new_notes(self, specs):
        self.add_calls += 1
        return [self._store(spec) for spec in specs]

    def _vector(self, notes):
        return FakeNoteVector(n.copy() for n in sorted(notes, key=lambda n: (n.pitch, n.start_time)))

    def get_all_notes_extended(self):
        return self._vector(self._notes)

    def get_notes_extended(self, from_pitch, pitch_span, from_time, time_span):
        return self._vector(n for n in self._notes if from_pitch <= n.pitch < from_pitch + pitch_span
                            and from_time <= n.start_time < from_time + time_span)

    def get_notes_by_id(self, ids):
        found = [n for n in self._notes if n.note_id in ids]
        if len(found) != len(set(ids)):
            raise ValueError("All given IDs must be present in clip")
        return self._vector(found)

    def apply_note_modifications(self, vector):
        if not isinstance(vector, FakeNoteVector):
            raise TypeError("Python argument types did not match C++ signature: apply_note_modifications(Clip, list)")
        by_id = dict((n.note_id, n) for n in self._notes)
        for note in vector:
            if note.note_id not in by_id:
                raise ValueError("All given IDs must be present in clip")
        for note in vector:
            self._notes[self._notes.index(by_id[note.note_id])] = note.copy()

    def remove_notes_by_id(self, ids):
        if set(ids) - set(n.note_id for n in self._notes):
            raise ValueError("All given IDs must be present in clip")
        self._notes = [n for n in self._notes if n.note_id not in ids]

    def duplicate_notes_by_id(self, ids, destination_time=None, transposition=0):
        sources = self.get_notes_by_id(ids)
        offset = (destination_time - min(n.start_time for n in sources)) if destination_time is not None else self.length
        return [self._store(FakeMidiNote(n.pitch + transposition, n.start_time + offset, n.duration, n.velocity, n.mute,
                                         n.probability, n.velocity_deviation, n.release_velocity)) for n in sources]

    def duplicate_region(self, start, length, destination, pitch=-1, transposition=0):
        for n in list(self.get_notes_extended(0, 128, start, length)):
            if pitch in (-1, n.pitch):
                self._store(FakeMidiNote(n.pitch + transposition, destination + (n.start_time - start), n.duration, n.velocity))

    def select_notes_by_id(self, ids):
        self._selected = set(ids)

    def select_all_notes(self):
        self._selected = set(n.note_id for n in self._notes)

    def deselect_all_notes(self):
        self._selected = set()

    def get_selected_notes_extended(self):
        return self._vector(n for n in self._notes if n.note_id in self._selected)


def make_song():
    ret = FakeReturnTrack("Return A", with_clips=False)
    ret.devices = [FakeDevice("Return Reverb")]
    master = FakeReturnTrack("Master", with_clips=False)
    master.devices = [FakeDevice("Limiter")]
    master.mixer_device = make_mixer(sends=False)
    del master.mute, master.solo
    song = types.SimpleNamespace(tempo=120.0, signature_numerator=4, signature_denominator=4, scenes=[],
                                 tracks=[FakeTrack("A"), FakeTrack("B"), make_rack_track()],
                                 return_tracks=[ret], master_track=master, undo_log=[],
                                 groove_pool=types.SimpleNamespace(grooves=[]), stops=[], cue_points=[])
    song.stop_all_clips = lambda quantized=True: song.stops.append(("song", quantized))
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


class FakeEnum(object):
    """Like a Boost.Python enum class: `.names` maps name -> int (and may include a 'count' sentinel)."""

    def __init__(self, **names):
        self.names = dict(names)


def load_module():
    live = types.ModuleType("Live")
    live.Base = types.SimpleNamespace(Timer=FakeTimer)
    live.Clip = types.SimpleNamespace(
        LaunchMode=FakeEnum(trigger=0, gate=1, toggle=2, repeat=3),
        ClipLaunchQuantization=FakeEnum(q_global=0, q_none=1, q_8_bars=2, q_4_bars=3, q_2_bars=4, q_bar=5, q_half=6),
        WarpMode=FakeEnum(beats=0, tones=1, texture=2, repitch=3, complex=4, rex=5, complex_pro=6, count=7))
    live.ClipSlot = types.SimpleNamespace(ClipSlotPlayingState=FakeEnum(stopped=0, started=1, recording=2))
    live.Device = types.SimpleNamespace(Device=FakeDevice, DeviceType=FakeEnum(undefined=0, instrument=1, audio_effect=2, midi_effect=4))
    live.Envelope = types.SimpleNamespace(EnvelopeEvent=FakeEnvelopeEvent)
    live.Chain = types.SimpleNamespace(Chain=FakeChain)
    live.DrumPad = types.SimpleNamespace(DrumPad=FakePad)
    live.DeviceParameter = types.SimpleNamespace(DeviceParameter=FakeParam)
    live.Song = types.SimpleNamespace(
        SessionRecordStatus=FakeEnum(off=0, on=1, transition=2),
        Quantization=FakeEnum(q_no_q=0, q_8_bars=1, q_4_bars=2, q_2_bars=3, q_bar=4, q_half=5),
        RecordingQuantization=FakeEnum(rec_q_no_q=0, rec_q_quarter=1, rec_q_eight=2, rec_q_eight_triplet=3,
                                       rec_q_sixtenth=5, rec_q_thirtysecond=8))
    live.Clip.MidiNoteSpecification = FakeMidiNote
    live.Groove = types.SimpleNamespace(Base=FakeEnum(gb_four=0, gb_eight=1, gb_eight_triplet=2, gb_sixteen=3, count=6))
    live.Track = types.SimpleNamespace(Track=types.SimpleNamespace(monitoring_states=FakeEnum(IN=0, AUTO=1, OFF=2)),
                                       RoutingTypeCategory=FakeEnum(external=0, rewire=1, resampling=2, master=3, track=4, parent_group_track=5, none=6, invalid=7),
                                       RoutingChannelLayout=FakeEnum(midi=0, mono=1, stereo=2))
    live.MixerDevice = types.SimpleNamespace(MixerDevice=types.SimpleNamespace(
        crossfade_assignments=FakeEnum(A=0, NONE=1, B=2), panning_modes=FakeEnum(stereo=0, stereo_split=1)))
    live.Application = types.SimpleNamespace(UnavailableFeature=FakeEnum(note_velocity_ranges_and_probabilities=0))
    framework = types.ModuleType("_Framework")
    control_surface = types.ModuleType("_Framework.ControlSurface")
    control_surface.ControlSurface = FakeControlSurface
    sys.modules.update({"Live": live, "_Framework": framework, "_Framework.ControlSurface": control_surface})
    sys.path.insert(0, os.path.join(ROOT, "remote-script"))
    return importlib.import_module("AbletonMCP")


mod = load_module()


class FakeClock(object):
    def __init__(self):
        self.now = 1000.0

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def make_script(port=None):
    mod.config.DEFAULT_PORT = port or free_port()
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
        params = {"track_index": 0, "clip_index": 0, "device_index": 0, "parameter_index": 1, "style": "steps",
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
        self.original_now = mod.clock.now
        mod.clock.now = self.clock.time
        self.addCleanup(setattr, mod.clock, "now", self.original_now)
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


# ---------------------------------------------------------------- addressing and properties

class AddressAndPropertyTests(unittest.TestCase):
    def setUp(self):
        self.script = make_script()
        self.addCleanup(self.script._stop_server)
        song = make_song()
        song.tracks = [FakeTrack("A"), FakeTrack("B"), FakeTrack("Twin"), FakeTrack("Twin")]
        song.tracks[0].clip_slots = [FakeSlot(PropClip("loop", 4.0)), FakeSlot()]
        song.scenes = [PropScene("Verse"), PropScene("Chorus")]
        song.metronome, song.loop, song.loop_start, song.loop_length = False, False, 0.0, 4.0
        song.root_note, song.scale_name, song.scale_mode, song.scale_intervals = 0, "Major", True, [0, 2, 4, 5, 7, 9, 11]
        song.clip_trigger_quantization, song.groove_amount, song.swing_amount = 4, 0.0, 0.0
        song.is_playing, song.can_undo, song.can_redo = False, True, False
        self.script._song = self.song = song
        self.clip = song.tracks[0].clip_slots[0].clip

    def run_command(self, command_type, params):
        return self.script._process_command({"type": command_type, "params": params})

    def code_of(self, fn, *args):
        with self.assertRaises(mod.BridgeError) as ctx:
            fn(*args)
        return ctx.exception.code

    # ---- addresses
    def test_resolve_every_address_form(self):
        r = self.script._resolve
        self.assertEqual(r("song")[0::2], ("song", "song"))
        self.assertEqual((r("master")[0], r("master")[2]), ("track", "master"))
        self.assertEqual((r("tracks/1")[1].name, r("tracks/1")[2]), ("B", "tracks/1"))
        self.assertEqual((r("tracks/name:B")[1].name, r("tracks/name:B")[2]), ("B", "tracks/1"))
        self.assertEqual(r("returns/0")[2], "returns/0")
        self.assertEqual((r("scenes/1")[1].name, r("scenes/1")[2]), ("Chorus", "scenes/1"))
        self.assertEqual((r("scenes/name:Verse")[2]), "scenes/0")
        self.assertEqual((r("tracks/0/slots/1")[0], r("tracks/0/slots/1")[2]), ("slot", "tracks/0/slots/1"))
        kind, clip, canonical = r("tracks/0/slots/0/clip")
        self.assertEqual((kind, clip is self.clip, canonical), ("clip", True, "tracks/0/slots/0/clip"))
        self.assertEqual(r(" /tracks/1/ ")[2], "tracks/1")  # whitespace and stray slashes are tolerated

    def test_resolve_errors_carry_codes(self):
        cases = [("", "INVALID_ARGUMENT"), (None, "INVALID_ARGUMENT"), (5, "INVALID_ARGUMENT"), ("bogus", "NOT_FOUND"),
                 ("tracks/9", "OUT_OF_RANGE"), ("tracks/-1", "OUT_OF_RANGE"), ("tracks/x", "INVALID_ARGUMENT"),
                 ("tracks/name:Nope", "NOT_FOUND"), ("tracks/name:Twin", "AMBIGUOUS"), ("returns/3", "OUT_OF_RANGE"),
                 ("scenes/7", "OUT_OF_RANGE"), ("tracks/0/slots/9", "OUT_OF_RANGE"), ("tracks/0/slots/1/clip", "NOT_FOUND"),
                 ("tracks/0/slots/0/other", "NOT_FOUND"), ("returns/0/slots/0", "NOT_FOUND"), ("song/extra", "NOT_FOUND")]
        for address, code in cases:
            self.assertEqual(self.code_of(self.script._resolve, address), code, address)

    def test_ambiguous_and_missing_names_say_what_exists(self):
        with self.assertRaises(mod.BridgeError) as ctx:
            self.script._resolve("tracks/name:Twin")
        self.assertIn("[2, 3]", str(ctx.exception))
        with self.assertRaises(mod.BridgeError) as ctx:
            self.script._resolve("tracks/name:Nope")
        self.assertIn("'A'", str(ctx.exception))

    def test_address_of_round_trips(self):
        for address in ("song", "master", "tracks/2", "returns/0", "scenes/1", "tracks/0/slots/0", "tracks/0/slots/0/clip"):
            self.assertEqual(self.script._address_of(self.script._resolve(address)[1]), address)
        self.assertIsNone(self.script._address_of(object()))

    def test_guard(self):
        track = self.song.tracks[1]
        self.script._guard(track, None, "tracks/1")
        self.script._guard(track, {"name": "B"}, "tracks/1")
        self.assertEqual(self.code_of(self.script._guard, track, {"name": "Z"}, "tracks/1"), "GUARD_FAILED")
        self.assertEqual(self.code_of(self.script._guard, track, {"colour": 1}, "tracks/1"), "INVALID_ARGUMENT")
        self.assertEqual(self.code_of(self.script._guard, track, ["name"], "tracks/1"), "INVALID_ARGUMENT")

    # ---- reading
    def test_get_named_properties(self):
        out = self.script._get_properties("tracks/0", ["name", "mute", "volume", "panning"])
        self.assertEqual(out["kind"], "track")
        self.assertEqual(out["properties"], {"name": "A", "mute": False, "volume": 0.85, "panning": 0})

    def test_enums_are_read_as_names_and_lists_as_lists(self):
        self.assertEqual(self.script._get_properties("song", ["clip_trigger_quantization", "scale_intervals"])["properties"],
                         {"clip_trigger_quantization": "q_bar", "scale_intervals": [0, 2, 4, 5, 7, 9, 11]})
        self.assertEqual(self.script._get_properties("tracks/0/slots/0/clip", ["launch_mode"])["properties"], {"launch_mode": "trigger"})

    def test_get_all_reports_unavailable_instead_of_failing(self):
        out = self.script._get_properties("tracks/0/slots/0/clip")
        self.assertIn("name", out["properties"])
        self.assertIn("gain", out["unavailable"])  # audio-only property raising RuntimeError on a MIDI clip
        self.assertNotIn("gain", out["properties"])
        ret = self.script._get_properties("returns/0")
        self.assertIn("arm", ret["unavailable"])   # return tracks have no arm

    def test_get_named_property_that_is_unavailable_raises(self):
        with self.assertRaises(RuntimeError):
            self.script._get_properties("tracks/0/slots/0/clip", ["gain"])

    def test_get_unknown_property_names_valid_ones(self):
        with self.assertRaises(mod.BridgeError) as ctx:
            self.script._get_properties("tracks/0", ["nope"])
        self.assertEqual(ctx.exception.code, "NOT_FOUND")
        self.assertIn("name", str(ctx.exception))
        self.assertEqual(self.code_of(self.script._get_properties, "tracks/0", "name"), "INVALID_ARGUMENT")

    # ---- writing
    def test_set_reports_from_and_to(self):
        out = self.script._set_properties("tracks/1", {"name": "Bass", "mute": True, "volume": 0.5})
        self.assertEqual(out["applied"]["name"], {"from": "B", "to": "Bass"})
        self.assertEqual(out["applied"]["mute"], {"from": False, "to": True})
        self.assertEqual(out["applied"]["volume"], {"from": 0.85, "to": 0.5})
        self.assertEqual((self.song.tracks[1].name, self.song.tracks[1].mixer_device.volume.value), ("Bass", 0.5))

    def test_type_checks_are_strict_and_come_back_as_type_errors(self):
        cases = [("tracks/1", {"mute": 1}), ("tracks/1", {"mute": "true"}), ("tracks/1", {"name": 5}),
                 ("tracks/1", {"color": 1.5}), ("tracks/1", {"color": True}), ("tracks/1", {"volume": "loud"}),
                 ("tracks/1", {"volume": True}), ("song", {"tempo": None}), ("song", {"root_note": "C"})]
        for address, values in cases:
            self.assertEqual(self.code_of(self.script._set_properties, address, values), "TYPE_ERROR", str(values))

    def test_ranges(self):
        for values in ({"tempo": 10.0}, {"tempo": 1000}, {"groove_amount": 2.0}, {"root_note": 12}):
            self.assertEqual(self.code_of(self.script._set_properties, "song", values), "OUT_OF_RANGE", str(values))
        self.assertEqual(self.code_of(self.script._set_properties, "tracks/1", {"volume": 1.5}), "OUT_OF_RANGE")
        self.script._set_properties("song", {"tempo": 20})          # inclusive bounds; int accepted for float
        self.assertEqual(self.song.tempo, 20.0)

    def test_enums_by_name(self):
        self.script._set_properties("song", {"clip_trigger_quantization": "q_half"})
        self.assertEqual(self.song.clip_trigger_quantization, 5)
        self.script._set_properties("tracks/0/slots/0/clip", {"launch_mode": "gate"})
        self.assertEqual(self.clip.launch_mode, 1)
        with self.assertRaises(mod.BridgeError) as ctx:
            self.script._set_properties("tracks/0/slots/0/clip", {"launch_mode": "sideways"})
        self.assertEqual(ctx.exception.code, "INVALID_ARGUMENT")
        self.assertIn("trigger, gate, toggle, repeat", str(ctx.exception))          # valid names, in value order
        self.assertEqual(self.code_of(self.script._set_properties, "tracks/0/slots/0/clip", {"launch_mode": 1}), "INVALID_ARGUMENT")
        self.assertEqual(self.code_of(self.script._set_properties, "tracks/0/slots/0/clip", {"warp_mode": "count"}), "INVALID_ARGUMENT")  # sentinel hidden

    def test_read_only_and_unknown_properties_are_refused(self):
        self.assertEqual(self.code_of(self.script._set_properties, "song", {"can_undo": False}), "INVALID_ARGUMENT")
        self.assertEqual(self.code_of(self.script._set_properties, "tracks/0/slots/0/clip", {"length": 9.0}), "INVALID_ARGUMENT")
        self.assertEqual(self.code_of(self.script._set_properties, "tracks/0", {"nope": 1}), "NOT_FOUND")
        self.assertEqual(self.code_of(self.script._set_properties, "tracks/0", {}), "INVALID_ARGUMENT")
        self.assertEqual(self.code_of(self.script._set_properties, "tracks/0", None), "INVALID_ARGUMENT")

    def test_dependent_writes_order_themselves(self):
        # loop_start=3 needs loop_end raised first; the reverse dict order forces a retry pass
        self.script._set_properties("tracks/0/slots/0/clip", {"loop_start": 3.0, "loop_end": 8.0})
        self.assertEqual((self.clip.loop_start, self.clip.loop_end), (3.0, 8.0))
        self.script._set_properties("tracks/0/slots/0/clip", {"loop_end": 1.0, "loop_start": 0.5})
        self.assertEqual((self.clip.loop_start, self.clip.loop_end), (0.5, 1.0))

    def test_a_failing_write_restores_what_was_already_written(self):
        with self.assertRaises(RuntimeError):
            self.script._set_properties("tracks/0/slots/0/clip", {"name": "Renamed", "muted": True, "loop_end": -1.0})
        self.assertEqual((self.clip.name, self.clip.muted, self.clip.loop_end), ("loop", False, 4.0))

    def test_expect_guard_blocks_a_stale_target(self):
        with self.assertRaises(mod.BridgeError) as ctx:
            self.script._set_properties("tracks/1", {"mute": True}, {"name": "Someone Else"})
        self.assertEqual(ctx.exception.code, "GUARD_FAILED")
        self.assertFalse(self.song.tracks[1].mute)
        self.script._set_properties("tracks/1", {"mute": True}, {"name": "B"})
        self.assertTrue(self.song.tracks[1].mute)

    def test_scene_and_song_writes(self):
        self.script._set_properties("scenes/name:Chorus", {"tempo": 90, "tempo_enabled": True, "time_signature_numerator": 7})
        scene = self.song.scenes[1]
        self.assertEqual((scene.tempo, scene.tempo_enabled, scene.time_signature_numerator), (90.0, True, 7))
        self.script._set_properties("song", {"metronome": True, "scale_name": "Minor", "loop_length": 8})
        self.assertEqual((self.song.metronome, self.song.scale_name, self.song.loop_length), (True, "Minor", 8.0))

    # ---- listing
    def test_list_properties(self):
        out = self.script._list_properties(kind="clip")
        self.assertEqual(out["properties"]["launch_mode"]["values"], ["trigger", "gate", "toggle", "repeat"])
        self.assertTrue(out["properties"]["name"]["writable"])
        self.assertFalse(out["properties"]["length"]["writable"])
        self.assertNotIn("count", out["properties"]["warp_mode"]["values"])
        self.assertEqual(self.script._list_properties("tracks/0")["kind"], "track")
        self.assertEqual(self.code_of(self.script._list_properties, None, "nonsense"), "INVALID_ARGUMENT")

    # ---- commands
    def test_commands_and_undo_behaviour(self):
        self.song.undo_log.clear()
        ok = self.run_command("get_properties", {"address": "tracks/0", "names": ["name"]})
        self.assertEqual(ok["result"]["properties"], {"name": "A"})
        self.assertEqual(self.song.undo_log, [])                                     # reads open no undo step
        ok = self.run_command("set_properties", {"address": "tracks/0", "properties": {"name": "Lead"}})
        self.assertEqual(ok["status"], "success")
        self.assertEqual(self.song.undo_log, ["begin", "end"])                       # one write = one undo step
        batch = self.run_command("set_properties", {"items": [
            {"address": "tracks/0", "properties": {"mute": True}}, {"address": "scenes/0", "properties": {"name": "Intro"}}]})
        self.assertEqual([r["address"] for r in batch["result"]["results"]], ["tracks/0", "scenes/0"])
        bad = self.run_command("set_properties", {"address": "tracks/0", "properties": {"mute": "yes"}})
        self.assertEqual((bad["status"], bad["code"]), ("error", "TYPE_ERROR"))
        listing = self.run_command("list_properties", {"kind": "scene"})
        self.assertIn("tempo", listing["result"]["properties"])

    def test_new_commands_are_registered_and_advertised(self):
        for name in ("get_properties", "set_properties", "list_properties"):
            self.assertIn(name, mod._COMMANDS)
            self.assertIn(name, self.script._get_script_info()["capabilities"])
        self.assertTrue(mod._COMMANDS["set_properties"]["writes"])
        self.assertFalse(mod._COMMANDS["get_properties"]["writes"])


# ---------------------------------------------------------------- structure, capabilities, transport, history

def children(*names):
    return types.SimpleNamespace(children=[types.SimpleNamespace(name=n) for n in names])


class StructureTests(unittest.TestCase):
    def setUp(self):
        self.script = make_script()
        self.addCleanup(self.script._stop_server)
        song = make_song()
        song.tracks = [FakeTrack("Lead"), FakeTrack("Bass"), FakeTrack("Group")]
        song.tracks[0].has_midi_input = True
        song.tracks[0].clip_slots = [FakeSlot(PropClip("riff", 4.0)), FakeSlot()]
        song.tracks[2].is_foldable = True
        song.tracks[2].clip_slots = [FakeSlot(), FakeSlot()]
        song.scenes = [PropScene("Verse"), PropScene("Chorus")]
        song.is_playing, song.current_song_time, song.can_undo, song.can_redo = False, 0.0, True, False
        song.metronome, song.loop, song.loop_start, song.loop_length = False, False, 0.0, 4.0
        song.root_note, song.scale_name, song.scale_mode, song.groove_amount, song.swing_amount = 0, "Major", True, 0.0, 0.0
        song.calls, song.can_capture_midi = [], True
        song.can_jump_to_next_cue = song.can_jump_to_prev_cue = True
        for name in ("start_playing", "continue_playing", "stop_playing", "stop_all_clips", "tap_tempo", "jump_to_next_cue",
                     "jump_to_prev_cue", "set_or_delete_cue", "capture_midi", "capture_and_insert_scene"):
            setattr(song, name, (lambda n: lambda *a: song.calls.append(n))(name))
        song.jump_by = lambda beats: song.calls.append(("jump_by", beats))
        song.undo_stack = ["Undo A", "Undo B", "Undo C"]
        song.redo_stack = []

        def undo():
            name = song.undo_stack.pop()
            song.redo_stack.append(name)
            song.can_undo, song.can_redo = bool(song.undo_stack), True
            return name

        def redo():
            name = song.redo_stack.pop()
            song.undo_stack.append(name)
            song.can_undo, song.can_redo = True, bool(song.redo_stack)
            return name
        song.undo, song.redo = undo, redo
        self.script._song = self.song = song
        self.app = types.SimpleNamespace(
            get_variant=lambda: "Beta", get_version_string=lambda: "12.4.15b4", get_build_id=lambda: "Live 12.4.15b4 Build: x",
            unavailable_features=[], browser=types.SimpleNamespace(
                instruments=children("Drift", "Meld"), audio_effects=children("Reverb"), max_for_live=children("Max Audio Effect")))
        self.script.application = lambda: self.app

    def run_command(self, command_type, params=None):
        return self.script._process_command({"type": command_type, "params": params or {}})

    # ---- describe_set
    def test_describe_set_structure(self):
        out = self.script._describe_set()
        self.assertEqual([t["address"] for t in out["tracks"]], ["tracks/0", "tracks/1", "tracks/2"])
        self.assertEqual([t["kind"] for t in out["tracks"]], ["midi", "audio", "group"])
        self.assertEqual(out["returns"][0]["address"], "returns/0")
        self.assertEqual(out["master"]["kind"], "master")
        self.assertEqual([s["address"] for s in out["scenes"]], ["scenes/0", "scenes/1"])
        lead = out["tracks"][0]
        self.assertEqual(lead["clip_count"], 1)
        self.assertEqual(lead["clips"][0]["slot"], 0)
        self.assertEqual((lead["clips"][0]["name"], lead["clips"][0]["kind"]), ("riff", "midi"))
        self.assertEqual(lead["devices"], ["Dev"])
        self.assertIn("tempo", out["song"])
        self.assertEqual(len(out["fingerprint"]), 12)
        self.assertNotIn("clips", out["returns"][0])  # return tracks have no clip slots

    def test_include_clips_false_keeps_counts_and_hashes(self):
        summary = self.script._describe_set(include_clips=False)
        self.assertNotIn("clips", summary["tracks"][0])
        self.assertEqual(summary["tracks"][0]["clip_count"], 1)
        self.assertEqual(summary["fingerprint"], self.script._describe_set()["fingerprint"])

    def test_fingerprint_is_stable_and_ignores_volatile_state(self):
        base = self.script._describe_set()["fingerprint"]
        self.assertEqual(self.script._describe_set()["fingerprint"], base)
        self.song.is_playing, self.song.current_song_time = True, 12.5
        self.song.tracks[0].clip_slots[0].clip.is_playing = True
        self.assertEqual(self.script._describe_set()["fingerprint"], base)

    def test_fingerprint_changes_when_the_set_changes(self):
        base = self.script._describe_set()["fingerprint"]
        mutations = [
            lambda: setattr(self.song.tracks[1], "name", "Renamed"),
            lambda: setattr(self.song.tracks[0].clip_slots[0].clip, "name", "other"),
            lambda: self.song.tracks[1].devices.append(FakeDevice("Extra")),
            lambda: setattr(self.song.tracks[1].mixer_device.volume, "value", 0.4),
            lambda: setattr(self.song.scenes[0], "tempo_enabled", True),
            lambda: setattr(self.song, "tempo", 99.0),
            lambda: setattr(self.song.tracks[0], "mute", True),
            lambda: setattr(self.song.return_tracks[0], "name", "Return B"),
            lambda: setattr(self.song.master_track.mixer_device.volume, "value", 0.7),
        ]
        seen = {base}
        for mutate in mutations:
            mutate()
            fingerprint = self.script._describe_set()["fingerprint"]
            self.assertNotIn(fingerprint, seen)
            seen.add(fingerprint)

    def test_a_change_only_moves_the_affected_track_hash(self):
        before = self.script._describe_set()
        self.song.tracks[1].name = "Renamed"
        after = self.script._describe_set()
        self.assertEqual(before["tracks"][0]["hash"], after["tracks"][0]["hash"])
        self.assertNotEqual(before["tracks"][1]["hash"], after["tracks"][1]["hash"])
        self.assertEqual(before["master"]["hash"], after["master"]["hash"])

    # ---- get_capabilities
    def test_capabilities_probe_features_instead_of_trusting_the_variant(self):
        out = self.script._get_capabilities()
        self.assertEqual(out["live"]["variant"], "Beta")
        self.assertEqual(out["live"]["edition"], "unknown")
        self.assertEqual(out["live"]["version"], "12.4.15b4")
        self.assertEqual(out["features"], {"max_for_live": True, "conversions": False,
                                           "note_probabilities": True, "devices": {"Meld": True, "Roar": False}})
        self.assertEqual(out["script"]["version"], mod.config.SCRIPT_VERSION)
        self.assertIn("describe_set", out["commands"])

    def test_capabilities_map_unavailable_features_by_name(self):
        self.app.unavailable_features = [0]
        out = self.script._get_capabilities()
        self.assertEqual(out["live"]["unavailable_features"], ["note_velocity_ranges_and_probabilities"])
        self.assertFalse(out["features"]["note_probabilities"])
        self.app.get_variant = lambda: "Suite"
        self.assertEqual(self.script._get_capabilities()["live"]["edition"], "Suite")

    # ---- transport
    def test_every_transport_action_does_its_thing(self):
        expectations = {"play": "start_playing", "continue": "continue_playing", "stop": "stop_playing",
                        "stop_all_clips": "stop_all_clips", "tap_tempo": "tap_tempo", "next_cue": "jump_to_next_cue",
                        "prev_cue": "jump_to_prev_cue", "toggle_cue": "set_or_delete_cue", "capture_midi": "capture_midi",
                        "capture_and_insert_scene": "capture_and_insert_scene"}
        for action, call in expectations.items():
            self.song.calls.clear()
            response = self.run_command("transport", {"action": action})
            self.assertEqual(response["status"], "success", action)
            self.assertEqual(self.song.calls, [call], action)
            self.assertEqual(response["result"]["action"], action)
        self.song.calls.clear()
        self.run_command("transport", {"action": "jump_by", "amount": -4})
        self.assertEqual(self.song.calls, [("jump_by", -4.0)])

    def test_transport_errors(self):
        cases = [({"action": "rewind"}, "INVALID_ARGUMENT"), ({}, "INVALID_ARGUMENT"), ({"action": "jump_by"}, "INVALID_ARGUMENT"),
                 ({"action": "jump_by", "amount": "4"}, "INVALID_ARGUMENT")]
        for params, code in cases:
            response = self.run_command("transport", params)
            self.assertEqual((response["status"], response["code"]), ("error", code), str(params))
        self.song.can_jump_to_next_cue = self.song.can_jump_to_prev_cue = self.song.can_capture_midi = False
        for action in ("next_cue", "prev_cue", "capture_midi"):
            self.assertEqual(self.run_command("transport", {"action": action})["code"], "UNAVAILABLE", action)

    def test_transport_runs_in_one_undo_step_and_reports_state(self):
        self.song.undo_log.clear()
        out = self.run_command("transport", {"action": "play"})["result"]
        self.assertEqual(self.song.undo_log, ["begin", "end"])
        self.assertEqual(set(out), {"action", "is_playing", "current_song_time", "tempo", "can_undo", "can_redo"})

    # ---- history
    def test_undo_and_redo_report_the_steps(self):
        out = self.run_command("history", {"action": "undo", "steps": 2})["result"]
        self.assertEqual((out["performed"], out["steps"], out["can_undo"], out["can_redo"]), (2, ["Undo C", "Undo B"], True, True))
        out = self.run_command("history", {"action": "redo"})["result"]
        self.assertEqual((out["performed"], out["steps"]), (1, ["Undo B"]))

    def test_undo_stops_at_the_end_of_history(self):
        out = self.run_command("history", {"action": "undo", "steps": 10})["result"]
        self.assertEqual((out["performed"], out["can_undo"]), (3, False))
        empty = self.run_command("history", {"action": "undo"})
        self.assertEqual((empty["status"], empty["code"], empty["message"]), ("error", "UNAVAILABLE", "Nothing to undo"))
        self.assertEqual(self.run_command("history", {"action": "redo", "steps": 5})["result"]["performed"], 3)
        self.assertEqual(self.run_command("history", {"action": "redo"})["code"], "UNAVAILABLE")

    def test_history_argument_errors_and_no_undo_step_around_undo(self):
        for params in ({"action": "rewind"}, {}, {"action": "undo", "steps": 0}, {"action": "undo", "steps": 51},
                       {"action": "undo", "steps": 1.5}, {"action": "undo", "steps": True}, {"action": "undo", "steps": "2"}):
            self.assertEqual(self.run_command("history", params)["code"], "INVALID_ARGUMENT", str(params))
        self.song.undo_log.clear()
        self.run_command("history", {"action": "undo"})
        self.assertEqual(self.song.undo_log, [])  # undo must not run inside a step of its own

    def test_commands_are_registered_with_the_right_flags(self):
        for name, writes in (("describe_set", False), ("get_capabilities", False), ("transport", True), ("history", False)):
            self.assertEqual(mod._COMMANDS[name]["writes"], writes, name)
            self.assertIn(name, self.script._get_script_info()["capabilities"])


# ---------------------------------------------------------------- lifecycle: create, duplicate, delete

class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.script = make_script()
        self.addCleanup(self.script._stop_server)
        song = make_song()
        song.tracks = [FakeTrack("A"), FakeTrack("B"), FakeTrack("C")]
        song.tracks[0].clip_slots = [FakeSlot(PropClip("riff", 4.0)), FakeSlot(), FakeSlot()]
        song.scenes = [PropScene("S0"), PropScene("S1")]
        song.calls = []
        self.count = 0

        def add(target, item, index):
            target.insert(len(target) if index == -1 else index, item)
            return item

        def make_track(label, kind_index=None):
            def create(index=-1):
                self.count += 1
                return add(song.tracks, FakeTrack("{0} {1}".format(label, self.count)), index)
            return create

        song.create_audio_track = make_track("Audio")
        song.create_midi_track = make_track("MIDI")
        song.create_return_track = lambda: add(song.return_tracks, FakeReturnTrack("Return New", with_clips=False), -1)
        song.create_scene = lambda index=-1: add(song.scenes, PropScene("Scene New"), index)
        song.delete_track = lambda i: song.tracks.pop(i)
        song.delete_return_track = lambda i: song.return_tracks.pop(i)
        song.delete_scene = lambda i: song.scenes.pop(i)

        def duplicate_track(i):
            copy = FakeTrack(song.tracks[i].name)
            song.tracks.insert(i + 1, copy)

        def duplicate_scene(i):
            song.scenes.insert(i + 1, PropScene(song.scenes[i].name))

        song.duplicate_track, song.duplicate_scene = duplicate_track, duplicate_scene

        def duplicate_clip_slot(i):
            slot = song.tracks[0].clip_slots[i]
            song.tracks[0].clip_slots.insert(i + 1, FakeSlot(PropClip(slot.clip.name, slot.clip.length)))
            return i + 1
        song.tracks[0].duplicate_clip_slot = duplicate_clip_slot
        for track in song.tracks:
            for slot in track.clip_slots:
                slot.delete_clip = (lambda s: lambda: (setattr(s, "clip", None), setattr(s, "has_clip", False)))(slot)
        self.script._song = self.song = song

    def run_command(self, command_type, params):
        return self.script._process_command({"type": command_type, "params": params})

    def code_of(self, command_type, params):
        response = self.run_command(command_type, params)
        self.assertEqual(response["status"], "error", str(params))
        return response["code"]

    # ---- create
    def test_create_each_kind_returns_a_reusable_address(self):
        audio = self.run_command("create", {"kind": "audio_track", "name": "Vox", "color": 123})["result"]
        self.assertEqual((audio["address"], audio["name"]), ("tracks/3", "Vox"))
        self.assertEqual((self.song.tracks[3].name, self.song.tracks[3].color), ("Vox", 123))
        self.assertEqual(audio["color"], 123)
        midi = self.run_command("create", {"kind": "midi_track", "index": 0})["result"]
        self.assertEqual(midi["address"], "tracks/0")                       # inserted at the front, everything shifts
        self.assertIs(self.script._resolve(midi["address"])[1], self.song.tracks[0])
        ret = self.run_command("create", {"kind": "return_track", "name": "Space"})["result"]
        self.assertEqual((ret["address"], self.song.return_tracks[-1].name), ("returns/1", "Space"))
        scene = self.run_command("create", {"kind": "scene", "index": 1, "name": "Bridge"})["result"]
        self.assertEqual((scene["address"], self.song.scenes[1].name), ("scenes/1", "Bridge"))

    def test_create_a_midi_clip_in_an_empty_slot(self):
        made = self.run_command("create", {"kind": "midi_clip", "address": "tracks/0/slots/1", "length": 8, "name": "Riff", "color": 55})["result"]
        self.assertEqual((made["address"], made["name"], made["length"], made["kind"]), ("tracks/0/slots/1/clip", "Riff", 8.0, "midi_clip"))
        self.assertEqual((self.song.tracks[0].clip_slots[1].clip.color, made["color"]), (55, 55))
        default = self.run_command("create", {"kind": "midi_clip", "address": "tracks/0/slots/2"})["result"]
        self.assertEqual(default["length"], 4.0)

    def test_create_a_midi_clip_errors(self):
        cases = [({"kind": "midi_clip"}, "INVALID_ARGUMENT"), ({"kind": "midi_clip", "address": "tracks/0"}, "INVALID_ARGUMENT"),
                 ({"kind": "midi_clip", "address": "tracks/0/slots/0"}, "INVALID_ARGUMENT"),                     # occupied
                 ({"kind": "midi_clip", "address": "tracks/0/slots/1", "length": 0}, "INVALID_ARGUMENT"),
                 ({"kind": "midi_clip", "address": "tracks/0/slots/1", "length": "4"}, "INVALID_ARGUMENT"),
                 ({"kind": "midi_clip", "address": "tracks/0/slots/9"}, "OUT_OF_RANGE")]
        for params, code in cases:
            self.assertEqual(self.code_of("create", params), code, str(params))
        self.assertFalse(self.song.tracks[0].clip_slots[1].has_clip)

    def test_create_appends_by_default_and_by_minus_one(self):
        self.assertEqual(self.run_command("create", {"kind": "scene"})["result"]["address"], "scenes/2")
        self.assertEqual(self.run_command("create", {"kind": "scene", "index": -1})["result"]["address"], "scenes/3")
        self.assertEqual(self.run_command("create", {"kind": "midi_track", "index": None})["result"]["address"], "tracks/3")

    def test_create_errors(self):
        cases = [({}, "INVALID_ARGUMENT"), ({"kind": "device"}, "INVALID_ARGUMENT"),
                 ({"kind": "scene", "name": 5}, "TYPE_ERROR"), ({"kind": "scene", "color": True}, "TYPE_ERROR"),
                 ({"kind": "scene", "color": 1.5}, "TYPE_ERROR"), ({"kind": "midi_track", "index": -2}, "INVALID_ARGUMENT"),
                 ({"kind": "midi_track", "index": 1.5}, "INVALID_ARGUMENT"), ({"kind": "midi_track", "index": True}, "INVALID_ARGUMENT"),
                 ({"kind": "midi_track", "index": "0"}, "INVALID_ARGUMENT"), ({"kind": "midi_track", "index": 9}, "OUT_OF_RANGE"),
                 ({"kind": "scene", "index": 9}, "OUT_OF_RANGE"), ({"kind": "return_track", "index": 0}, "INVALID_ARGUMENT")]
        for params, code in cases:
            self.assertEqual(self.code_of("create", params), code, str(params))
        self.assertEqual((len(self.song.tracks), len(self.song.scenes), len(self.song.return_tracks)), (3, 2, 1))  # nothing created

    # ---- duplicate
    def test_duplicate_track_scene_and_slot(self):
        out = self.run_command("duplicate", {"address": "tracks/1"})["result"]
        self.assertEqual((out["source"], out["address"], out["name"]), ("tracks/1", "tracks/2", "B"))
        self.assertEqual([t.name for t in self.song.tracks], ["A", "B", "B", "C"])
        out = self.run_command("duplicate", {"address": "scenes/name:S0"})["result"]
        self.assertEqual((out["address"], [s.name for s in self.song.scenes]), ("scenes/1", ["S0", "S0", "S1"]))
        out = self.run_command("duplicate", {"address": "tracks/0/slots/0"})["result"]
        self.assertEqual(out["address"], "tracks/0/slots/1")
        self.assertEqual(self.song.tracks[0].clip_slots[1].clip.name, "riff")

    def test_duplicate_errors(self):
        for address, code in (("master", "INVALID_ARGUMENT"), ("returns/0", "INVALID_ARGUMENT"), ("song", "INVALID_ARGUMENT"),
                              ("tracks/0/slots/0/clip", "INVALID_ARGUMENT"), ("tracks/9", "OUT_OF_RANGE"), (None, "INVALID_ARGUMENT")):
            self.assertEqual(self.code_of("duplicate", {"address": address}), code, str(address))
        self.assertEqual(len(self.song.tracks), 3)

    # ---- delete
    def test_delete_requires_an_expect_guard(self):
        for expect in (None, {}, {"class_name": "X"}, "B", ["name"]):
            self.assertEqual(self.code_of("delete", {"address": "tracks/1", "expect": expect}), "INVALID_ARGUMENT", str(expect))
        self.assertEqual(self.code_of("delete", {"address": "tracks/1"}), "INVALID_ARGUMENT")
        self.assertEqual(len(self.song.tracks), 3)

    def test_delete_refuses_a_stale_index(self):
        # the caller read the Set when "B" was track 1; then track 0 was deleted, so index 1 is now "C"
        self.run_command("delete", {"address": "tracks/0", "expect": {"name": "A"}})
        self.assertEqual(self.song.tracks[1].name, "C")
        self.assertEqual(self.code_of("delete", {"address": "tracks/1", "expect": {"name": "B"}}), "GUARD_FAILED")
        self.assertEqual([t.name for t in self.song.tracks], ["B", "C"])      # nothing was removed
        self.run_command("delete", {"address": "tracks/name:B", "expect": {"name": "B"}})
        self.assertEqual([t.name for t in self.song.tracks], ["C"])

    def test_delete_each_kind_reports_what_remains(self):
        out = self.run_command("delete", {"address": "tracks/1", "expect": {"name": "B"}})["result"]
        self.assertEqual((out["deleted"], out["name"], out["tracks"]), ("tracks/1", "B", 2))
        out = self.run_command("delete", {"address": "returns/0", "expect": {"name": "Return A"}})["result"]
        self.assertEqual((out["deleted"], out["returns"]), ("returns/0", 0))
        out = self.run_command("delete", {"address": "scenes/1", "expect": {"name": "S1"}})["result"]
        self.assertEqual((out["deleted"], out["scenes"]), ("scenes/1", 1))
        out = self.run_command("delete", {"address": "tracks/0/slots/0/clip", "expect": {"name": "riff"}})["result"]
        self.assertEqual(out["deleted"], "tracks/0/slots/0/clip")
        self.assertFalse(self.song.tracks[0].clip_slots[0].has_clip)

    def test_delete_refusals(self):
        self.assertEqual(self.code_of("delete", {"address": "master", "expect": {"name": "Master"}}), "INVALID_ARGUMENT")
        self.assertEqual(self.code_of("delete", {"address": "tracks/0/slots/0", "expect": {"name": "x"}}), "GUARD_FAILED")
        self.assertEqual(self.code_of("delete", {"address": "tracks/9", "expect": {"name": "x"}}), "OUT_OF_RANGE")
        self.assertEqual(self.code_of("delete", {"address": "tracks/0/slots/1/clip", "expect": {"name": "x"}}), "NOT_FOUND")  # empty slot
        self.assertEqual(self.code_of("delete", {"address": "tracks/0", "expect": {"name": "A", "colour": 1}}), "INVALID_ARGUMENT")
        self.assertEqual(len(self.song.tracks), 3)

    def test_delete_with_an_empty_clip_name_needs_the_name_key(self):
        self.song.tracks[0].clip_slots[0].clip.name = ""
        self.run_command("delete", {"address": "tracks/0/slots/0/clip", "expect": {"name": ""}})
        self.assertFalse(self.song.tracks[0].clip_slots[0].has_clip)

    # ---- flags and undo
    def test_flags_and_one_undo_step_per_call(self):
        self.assertTrue(mod._COMMANDS["create"]["writes"] and mod._COMMANDS["duplicate"]["writes"])
        self.assertTrue(mod._COMMANDS["delete"]["destructive"] and mod._COMMANDS["delete"]["writes"])
        self.assertFalse(mod._COMMANDS["create"]["destructive"])
        self.song.undo_log.clear()
        self.run_command("create", {"kind": "scene", "name": "X"})
        self.run_command("delete", {"address": "tracks/2", "expect": {"name": "C"}})
        self.assertEqual(self.song.undo_log, ["begin", "end", "begin", "end"])
        self.song.undo_log.clear()
        self.run_command("delete", {"address": "tracks/9", "expect": {"name": "x"}})   # a failing call still closes its step
        self.assertEqual(self.song.undo_log, ["begin", "end"])


# ---------------------------------------------------------------- launch, clip actions and grooves

class ClipActionTests(unittest.TestCase):
    def setUp(self):
        self.script = make_script()
        self.addCleanup(self.script._stop_server)
        song = make_song()
        self.clip = PropClip("loop", 4.0)
        song.tracks[0].clip_slots = [FakeSlot(self.clip), FakeSlot()]
        song.tracks[0].playing_slot_index, song.tracks[0].fired_slot_index = -2, -1
        song.tracks[0].stop_all_clips = lambda quantized=True: song.stops.append(("track", quantized))
        song.scenes = [PropScene("Verse"), PropScene("Chorus")]
        song.groove_pool.grooves = [FakeGroove("Swing"), FakeGroove("MPC", base=1, timing=50.0)]
        self.script._song = self.song = song
        self.slot = song.tracks[0].clip_slots[0]

    def run_command(self, command_type, params):
        return self.script._process_command({"type": command_type, "params": params})

    def code(self, command_type, params):
        response = self.run_command(command_type, params)
        self.assertEqual(response["status"], "error", response)
        return response["code"]

    # ---- launch
    def test_fire_a_slot_or_its_clip_without_options_takes_no_arguments(self):
        for address in ("tracks/0/slots/0", "tracks/0/slots/0/clip"):
            self.slot.calls.clear()
            response = self.run_command("launch", {"address": address})
            self.assertEqual(response["status"], "success", response)
            self.assertEqual(self.slot.calls, [("fire",)])
            self.assertEqual(response["result"]["address"], "tracks/0/slots/0")
            self.assertTrue(response["result"]["state"]["is_triggered"])

    def test_fire_options_are_passed_with_lives_not_passed_sentinels(self):
        self.run_command("launch", {"address": "tracks/0/slots/0", "quantization": "q_bar", "legato": True})
        self.assertEqual(self.slot.calls[-1], ("fire", 1.7976931348623157e+308, 4, True))
        self.run_command("launch", {"address": "tracks/0/slots/1", "record_length": 8})
        self.assertEqual(self.song.tracks[0].clip_slots[1].calls[-1], ("fire", 8.0, -2147483648, False))

    def test_stop_a_slot(self):
        self.run_command("launch", {"address": "tracks/0/slots/0", "action": "stop"})
        self.assertEqual(self.slot.calls, [("stop",)])

    def test_scenes_fire_with_legato_and_select_and_cannot_be_stopped(self):
        self.run_command("launch", {"address": "scenes/1"})
        self.assertEqual(self.song.scenes[1].calls, [("fire", False, True)])
        self.run_command("launch", {"address": "scenes/name:Verse", "legato": True, "select": False})
        self.assertEqual(self.song.scenes[0].calls, [("fire", True, False)])
        self.assertEqual(self.code("launch", {"address": "scenes/0", "action": "stop"}), "INVALID_ARGUMENT")
        self.assertEqual(self.code("launch", {"address": "scenes/0", "record_length": 4}), "INVALID_ARGUMENT")

    def test_stopping_a_track_or_the_song(self):
        self.run_command("launch", {"address": "tracks/0", "action": "stop", "quantized": False})
        self.run_command("launch", {"address": "song", "action": "stop"})
        self.assertEqual(self.song.stops, [("track", False), ("song", True)])
        self.assertEqual(self.code("launch", {"address": "tracks/0"}), "INVALID_ARGUMENT")        # a track cannot be fired
        self.assertEqual(self.code("launch", {"address": "song"}), "INVALID_ARGUMENT")
        self.assertEqual(self.code("launch", {"address": "returns/0", "action": "stop"}), "INVALID_ARGUMENT")
        self.assertEqual(self.code("launch", {"address": "master", "action": "stop"}), "INVALID_ARGUMENT")

    def test_launch_validates_its_arguments(self):
        cases = [({"address": "tracks/0/slots/0", "action": "jump"}, "INVALID_ARGUMENT"),
                 ({"address": "tracks/0/slots/0", "legato": "yes"}, "TYPE_ERROR"),
                 ({"address": "tracks/0/slots/0", "record_length": -1}, "INVALID_ARGUMENT"),
                 ({"address": "tracks/0/slots/0", "record_length": "4"}, "INVALID_ARGUMENT"),
                 ({"address": "tracks/0/slots/0", "quantization": "q_never"}, "INVALID_ARGUMENT"),
                 ({"address": "tracks/0", "action": "stop", "quantized": "no"}, "TYPE_ERROR"),
                 ({"address": "scenes/0", "select": 1}, "TYPE_ERROR"),
                 ({"address": "tracks/0/slots/1/clip"}, "NOT_FOUND"), ({"address": "nowhere"}, "NOT_FOUND")]
        for params, code in cases:
            self.assertEqual(self.code("launch", params), code, params)

    # ---- clip_action
    def act(self, action, **params):
        return self.run_command("clip_action", dict(params, action=action, address="tracks/0/slots/0/clip"))

    def test_crop_and_duplicate_loop(self):
        self.assertEqual(self.act("crop")["status"], "success")
        result = self.act("duplicate_loop")["result"]
        self.assertEqual(self.clip.calls, [("crop",), ("duplicate_loop",)])
        self.assertEqual((result["address"], result["length"], result["loop_end"]), ("tracks/0/slots/0/clip", 4.0, 4.0))

    def test_quantize_takes_a_named_grid_and_an_amount(self):
        self.act("quantize", grid="rec_q_sixtenth")
        self.act("quantize", grid="rec_q_eight", amount=0.5)
        self.act("quantize_pitch", grid="rec_q_quarter", pitch=36, amount=0.25)
        self.assertEqual(self.clip.calls, [("quantize", 5, 1.0), ("quantize", 2, 0.5), ("quantize_pitch", 36, 1, 0.25)])
        for params, code in [({"grid": "sixteenth"}, "INVALID_ARGUMENT"), ({"grid": "rec_q_no_q"}, "INVALID_ARGUMENT"),
                             ({}, "INVALID_ARGUMENT"), ({"grid": "rec_q_eight", "amount": 2}, "OUT_OF_RANGE"),
                             ({"grid": "rec_q_eight", "amount": "half"}, "TYPE_ERROR")]:
            self.assertEqual(self.code("clip_action", dict(params, action="quantize", address="tracks/0/slots/0/clip")), code, params)
        for pitch in (None, 128, -1, "C3", True):
            self.assertEqual(self.code("clip_action", {"action": "quantize_pitch", "address": "tracks/0/slots/0/clip",
                                                       "grid": "rec_q_eight", "pitch": pitch}), "INVALID_ARGUMENT", pitch)

    def test_scrub_and_move_playing_position(self):
        self.act("scrub", position=1.5)
        self.act("stop_scrub")
        self.act("move_playing_pos", amount=-2)
        self.assertEqual(self.clip.calls, [("scrub", 1.5), ("stop_scrub",), ("move_playing_pos", -2.0)])
        self.assertEqual(self.code("clip_action", {"action": "scrub", "address": "tracks/0/slots/0/clip"}), "INVALID_ARGUMENT")
        self.assertEqual(self.code("clip_action", {"action": "scrub", "position": -1, "address": "tracks/0/slots/0/clip"}), "INVALID_ARGUMENT")
        self.assertEqual(self.code("clip_action", {"action": "move_playing_pos", "address": "tracks/0/slots/0/clip"}), "INVALID_ARGUMENT")

    def test_clip_action_guards_and_addresses(self):
        self.assertEqual(self.act("crop", expect={"name": "loop"})["status"], "success")
        self.clip.calls.clear()
        self.assertEqual(self.code("clip_action", {"action": "crop", "address": "tracks/0/slots/0/clip", "expect": {"name": "other"}}),
                         "GUARD_FAILED")
        self.assertEqual(self.clip.calls, [])
        self.assertEqual(self.code("clip_action", {"action": "crop", "address": "tracks/0/slots/0"}), "INVALID_ARGUMENT")
        self.assertEqual(self.code("clip_action", {"action": "explode", "address": "tracks/0/slots/0/clip"}), "INVALID_ARGUMENT")

    def test_live_errors_from_a_clip_action_reach_the_caller_with_their_message(self):
        def refuse(*args):
            raise RuntimeError("Duplicating a loop is not available for audio clips")
        self.clip.duplicate_loop = refuse
        response = self.act("duplicate_loop")
        self.assertEqual(response["status"], "error")
        self.assertIn("not available for audio clips", response["message"])

    def test_launch_and_clip_action_run_in_their_own_undo_step(self):
        self.song.undo_log.clear()
        self.act("crop")
        self.run_command("launch", {"address": "tracks/0/slots/0"})
        self.assertEqual(self.song.undo_log, ["begin", "end", "begin", "end"])

    # ---- grooves
    def test_grooves_have_addresses(self):
        kind, groove, canonical = self.script._resolve("grooves/1")
        self.assertEqual((kind, groove.name, canonical), ("groove", "MPC", "grooves/1"))
        self.assertEqual(self.script._resolve("grooves/name:Swing")[2], "grooves/0")
        self.assertEqual(self.script._address_of(self.song.groove_pool.grooves[1]), "grooves/1")
        self.assertEqual(self.run_command("get_properties", {"address": "grooves/9"})["code"], "OUT_OF_RANGE")

    def test_groove_properties_read_and_write_with_the_usual_checks(self):
        got = self.run_command("get_properties", {"address": "grooves/1"})["result"]["properties"]
        self.assertEqual((got["name"], got["base"], got["timing_amount"]), ("MPC", "gb_eight", 50.0))
        result = self.run_command("set_properties", {"address": "grooves/1", "properties": {"timing_amount": 80, "base": "gb_sixteen"}})
        self.assertEqual(result["status"], "success", result)
        self.assertEqual(self.song.groove_pool.grooves[1].timing_amount, 80.0)
        self.assertEqual(self.song.groove_pool.grooves[1].base, 3)
        self.assertEqual(self.run_command("set_properties", {"address": "grooves/1", "properties": {"base": "gb_seven"}})["code"], "INVALID_ARGUMENT")

    def test_a_clips_groove_is_read_and_assigned_by_address(self):
        self.clip.groove = self.song.groove_pool.grooves[0]
        self.assertEqual(self.run_command("get_properties", {"address": "tracks/0/slots/0/clip", "names": ["groove", "has_groove"]})
                         ["result"]["properties"], {"groove": "grooves/0", "has_groove": True})
        result = self.run_command("set_properties", {"address": "tracks/0/slots/0/clip", "properties": {"groove": "grooves/name:MPC"}})
        self.assertEqual(result["result"]["applied"]["groove"], {"from": "grooves/0", "to": "grooves/1"})
        self.assertIs(self.clip.groove, self.song.groove_pool.grooves[1])

    def test_groove_assignment_rejects_anything_but_a_groove_address(self):
        for value, code in [("tracks/0", "TYPE_ERROR"), (3, "TYPE_ERROR"), (None, "TYPE_ERROR"), ("grooves/7", "OUT_OF_RANGE"),
                            ("nowhere", "NOT_FOUND")]:
            response = self.run_command("set_properties", {"address": "tracks/0/slots/0/clip", "properties": {"groove": value}})
            self.assertEqual(response["code"], code, value)

    def test_a_failed_multi_property_write_puts_the_groove_back(self):
        self.clip.groove = self.song.groove_pool.grooves[0]
        response = self.run_command("set_properties", {"address": "tracks/0/slots/0/clip",
                                                       "properties": {"groove": "grooves/1", "loop_start": 100.0}})
        self.assertEqual(response["status"], "error")
        self.assertIs(self.clip.groove, self.song.groove_pool.grooves[0])

    def test_list_properties_marks_references(self):
        listing = self.run_command("list_properties", {"kind": "clip"})["result"]["properties"]
        self.assertEqual(listing["groove"]["refers_to"], "groove")
        self.assertIn("base", self.run_command("list_properties", {"kind": "groove"})["result"]["properties"])


# ---------------------------------------------------------------- notes

class NotesTests(unittest.TestCase):
    ADDR = "tracks/0/slots/0/clip"

    def setUp(self):
        self.script = make_script()
        self.addCleanup(self.script._stop_server)
        song = make_song()
        self.clip = NoteClip("notes", 4.0)
        audio = PropClip("audio", 4.0)
        audio.is_midi_clip, audio.is_audio_clip = False, True
        song.tracks[0].clip_slots = [FakeSlot(self.clip), FakeSlot(audio)]
        self.script._song = self.song = song

    def call(self, name, **params):
        response = self.script._process_command({"type": name, "params": dict({"address": self.ADDR}, **params)})
        return response

    def ok(self, name, **params):
        response = self.call(name, **params)
        self.assertEqual(response["status"], "success", response)
        return response["result"]

    def code(self, name, **params):
        response = self.call(name, **params)
        self.assertEqual(response["status"], "error", response)
        return response["code"]

    def seed(self):
        return self.ok("write_notes", notes=[
            {"pitch": 64, "start_time": 1.0, "duration": 0.5, "velocity": 80, "probability": 0.5},
            {"pitch": 60, "start_time": 0.0, "duration": 1.0},
            {"pitch": 67, "start_time": 1.0, "duration": 0.25, "mute": True, "velocity_deviation": -20, "release_velocity": 10}])["ids"]

    # ---- write_notes / get_notes
    def test_write_applies_defaults_and_reports_ids_and_count(self):
        result = self.ok("write_notes", notes=[{"pitch": 60, "start_time": 0, "duration": 1}])
        self.assertEqual((result["written"], result["ids"], result["note_count"]), (1, [1], 1))
        note = self.ok("get_notes")["notes"][0]
        self.assertEqual(note, {"id": 1, "pitch": 60, "start_time": 0.0, "duration": 1.0, "velocity": 100.0, "mute": False,
                                "probability": 1.0, "velocity_deviation": 0.0, "release_velocity": 64.0})

    def test_get_notes_returns_every_field_sorted_by_time_then_pitch(self):
        self.seed()
        got = self.ok("get_notes")
        self.assertEqual([(n["start_time"], n["pitch"]) for n in got["notes"]], [(0.0, 60), (1.0, 64), (1.0, 67)])
        self.assertEqual((got["count"], got["truncated"], got["clip"]["length"]), (3, False, 4.0))
        by_pitch = dict((n["pitch"], n) for n in got["notes"])
        self.assertEqual((by_pitch[64]["probability"], by_pitch[64]["velocity"]), (0.5, 80.0))
        self.assertEqual((by_pitch[67]["mute"], by_pitch[67]["velocity_deviation"], by_pitch[67]["release_velocity"]), (True, -20.0, 10.0))

    def test_get_notes_by_range_ids_selection_and_limit(self):
        ids = self.seed()
        self.assertEqual([n["pitch"] for n in self.ok("get_notes", from_time=1.0, time_span=1.0)["notes"]], [64, 67])
        self.assertEqual([n["pitch"] for n in self.ok("get_notes", from_pitch=64, pitch_span=1)["notes"]], [64])
        self.assertEqual([n["id"] for n in self.ok("get_notes", ids=ids[:1])["notes"]], ids[:1])
        self.ok("edit_notes", action="select", ids=[ids[1]])
        self.assertEqual([n["id"] for n in self.ok("get_notes", selected=True)["notes"]], [ids[1]])
        limited = self.ok("get_notes", limit=2)
        self.assertEqual((limited["count"], limited["truncated"], len(limited["notes"])), (3, True, 2))
        self.assertEqual(self.code("get_notes", limit=0), "INVALID_ARGUMENT")
        self.assertEqual(self.code("get_notes", ids=[999]), "NOT_FOUND")
        self.assertEqual(self.code("get_notes", time_span=-1), "INVALID_ARGUMENT")
        self.assertEqual(self.code("get_notes", from_time="soon"), "TYPE_ERROR")

    def test_only_midi_clips_have_notes(self):
        self.assertEqual(self.code("get_notes", address="tracks/0/slots/1/clip"), "INVALID_ARGUMENT")
        self.assertEqual(self.code("write_notes", address="tracks/0/slots/1/clip", notes=[{"pitch": 60, "start_time": 0, "duration": 1}]), "INVALID_ARGUMENT")
        self.assertEqual(self.code("get_notes", address="tracks/0"), "INVALID_ARGUMENT")
        self.assertEqual(self.code("get_notes", address="tracks/0/slots/1"), "INVALID_ARGUMENT")

    def test_write_validates_every_note_before_writing_any(self):
        good = {"pitch": 60, "start_time": 0, "duration": 1}
        cases = [({"pitch": 128, "start_time": 0, "duration": 1}, "OUT_OF_RANGE"), ({"pitch": 60.5, "start_time": 0, "duration": 1}, "TYPE_ERROR"),
                 ({"pitch": True, "start_time": 0, "duration": 1}, "TYPE_ERROR"), ({"pitch": 60, "start_time": "0", "duration": 1}, "TYPE_ERROR"),
                 ({"pitch": 60, "start_time": 0, "duration": 0}, "OUT_OF_RANGE"), ({"pitch": 60, "start_time": 0, "duration": -1}, "OUT_OF_RANGE"),
                 ({**good, "velocity": 0}, "OUT_OF_RANGE"), ({**good, "velocity": 128}, "OUT_OF_RANGE"),
                 ({**good, "probability": 1.5}, "OUT_OF_RANGE"), ({**good, "probability": -0.1}, "OUT_OF_RANGE"),
                 ({**good, "velocity_deviation": 128}, "OUT_OF_RANGE"), ({**good, "release_velocity": -1}, "OUT_OF_RANGE"),
                 ({**good, "mute": 1}, "TYPE_ERROR"), ({**good, "colour": 3}, "INVALID_ARGUMENT"),
                 ({"pitch": 60, "duration": 1}, "INVALID_ARGUMENT"), ("C3", "TYPE_ERROR")]
        for bad, code in cases:
            self.assertEqual(self.code("write_notes", notes=[good, bad]), code, bad)
            self.assertEqual(self.clip.add_calls, 0, "a rejected batch must not reach Live: {0}".format(bad))
        for notes in ([], None, "x"):
            self.assertEqual(self.code("write_notes", notes=notes), "INVALID_ARGUMENT")
        self.assertEqual(self.code("write_notes", notes=[good] * 5001), "INVALID_ARGUMENT")
        self.assertEqual(self.ok("get_notes")["count"], 0)

    def test_the_error_names_the_note_and_the_field(self):
        response = self.call("write_notes", notes=[{"pitch": 60, "start_time": 0, "duration": 1}, {"pitch": 60, "start_time": 0, "duration": 1, "velocity": 300}])
        self.assertIn("notes[1]: velocity 300 is outside 1 to 127", response["message"])

    def test_overlapping_notes_of_one_pitch_are_trimmed_or_replaced_and_the_count_says_so(self):
        result = self.ok("write_notes", notes=[{"pitch": 60, "start_time": 0, "duration": 2}, {"pitch": 60, "start_time": 1, "duration": 2}])
        self.assertEqual((result["written"], result["note_count"]), (2, 2))
        self.assertEqual([(n["start_time"], n["duration"]) for n in self.ok("get_notes")["notes"]], [(0.0, 1.0), (1.0, 2.0)])
        result = self.ok("write_notes", notes=[{"pitch": 60, "start_time": 1, "duration": 0.5}])
        self.assertEqual((result["written"], result["note_count"]), (1, 2))            # same start time: replaced

    def test_write_guard(self):
        self.assertEqual(self.code("write_notes", notes=[{"pitch": 60, "start_time": 0, "duration": 1}], expect={"name": "other"}), "GUARD_FAILED")
        self.assertEqual(self.clip.add_calls, 0)

    # ---- edit_notes: modify
    def test_modify_changes_only_the_given_fields_through_a_note_vector(self):
        ids = self.seed()
        result = self.ok("edit_notes", action="modify", changes=[{"id": ids[0], "velocity": 20, "start_time": 1.5}, {"id": ids[1], "probability": 0.25}])
        self.assertEqual(result["modified"], 2)
        notes = dict((n["id"], n) for n in self.ok("get_notes")["notes"])
        self.assertEqual((notes[ids[0]]["velocity"], notes[ids[0]]["start_time"], notes[ids[0]]["probability"]), (20.0, 1.5, 0.5))
        self.assertEqual((notes[ids[1]]["probability"], notes[ids[1]]["pitch"]), (0.25, 60))
        self.assertEqual(notes[ids[2]]["mute"], True)                       # untouched
        self.assertEqual(sorted(notes), sorted(ids))                          # ids survive a modification

    def test_modify_many_notes_with_one_set(self):
        ids = self.seed()
        self.ok("edit_notes", action="modify", ids=ids, set={"velocity": 64, "mute": False})
        self.assertEqual(set((n["velocity"], n["mute"]) for n in self.ok("get_notes")["notes"]), {(64.0, False)})

    def test_modify_validates_before_touching_anything(self):
        ids = self.seed()
        before = self.ok("get_notes")["notes"]
        cases = [dict(changes=[{"id": ids[0], "velocity": 5}, {"id": 999, "velocity": 5}]),
                 dict(changes=[{"id": ids[0], "velocity": 500}]), dict(changes=[{"id": ids[0]}]), dict(changes=[{"velocity": 5}]),
                 dict(changes=[{"id": ids[0], "velocity": 5}, {"id": ids[0], "velocity": 6}]), dict(changes=[{"id": "1", "velocity": 5}]),
                 dict(changes=[]), dict(ids=ids, set={}), dict(ids=ids), dict(changes=[{"id": ids[0], "velocity": 5}], ids=ids, set={"velocity": 5})]
        for params in cases:
            response = self.call("edit_notes", action="modify", **params)
            self.assertEqual(response["status"], "error", params)
        self.assertEqual(self.ok("get_notes")["notes"], before)
        self.assertEqual(self.code("edit_notes", action="modify", changes=[{"id": 999, "velocity": 5}]), "NOT_FOUND")

    # ---- remove
    def test_remove_by_ids_by_range_or_everything(self):
        ids = self.seed()
        self.assertEqual(self.ok("edit_notes", action="remove", ids=[ids[0]])["removed"], 1)
        self.assertEqual(self.ok("edit_notes", action="remove", from_time=0.0, time_span=0.5)["removed"], 1)
        self.assertEqual(self.ok("edit_notes", action="remove", from_time=50.0, time_span=1.0)["removed"], 0)
        result = self.ok("edit_notes", action="remove", all=True)
        self.assertEqual((result["removed"], result["note_count"]), (1, 0))

    def test_remove_needs_exactly_one_selector_so_nothing_is_cleared_by_accident(self):
        self.seed()
        for params in (dict(), dict(all=False), dict(ids=[1], all=True), dict(ids=[1], from_time=0.0), dict(ids=[])):
            self.assertEqual(self.code("edit_notes", action="remove", **params), "INVALID_ARGUMENT", params)
        self.assertEqual(self.code("edit_notes", action="remove", ids=[404]), "NOT_FOUND")
        self.assertEqual(self.ok("get_notes")["count"], 3)

    # ---- duplicate
    def test_duplicate_copies_notes_to_a_time_with_transposition(self):
        ids = self.seed()
        result = self.ok("edit_notes", action="duplicate", ids=[ids[1]], destination_time=2.0, transposition=12)
        self.assertEqual(result["duplicated"], 1)
        copy = [n for n in self.ok("get_notes")["notes"] if n["id"] == result["ids"][0]][0]
        self.assertEqual((copy["pitch"], copy["start_time"]), (72, 2.0))
        self.assertEqual(self.code("edit_notes", action="duplicate", ids=[ids[1]], destination_time="x"), "TYPE_ERROR")
        self.assertEqual(self.code("edit_notes", action="duplicate", ids=[ids[1]], transposition=1.5), "TYPE_ERROR")
        self.assertEqual(self.code("edit_notes", action="duplicate", ids=[]), "INVALID_ARGUMENT")

    def test_duplicate_region_reports_the_new_ids(self):
        self.seed()
        result = self.ok("edit_notes", action="duplicate_region", start=0.0, length=1.0, destination_time=3.0, transposition=2)
        self.assertEqual(result["duplicated"], 1)
        copy = [n for n in self.ok("get_notes")["notes"] if n["id"] in result["ids"]][0]
        self.assertEqual((copy["pitch"], copy["start_time"]), (62, 3.0))
        for params in (dict(start=0, length=0, destination_time=1), dict(start=0, length=1), dict(start=0, length=1, destination_time=1, pitch=200),
                       dict(start=0, length=1, destination_time=1, transposition=True)):
            self.assertIn(self.code("edit_notes", action="duplicate_region", **params), ("INVALID_ARGUMENT", "TYPE_ERROR"), params)

    # ---- select
    def test_select_by_ids_all_or_none(self):
        ids = self.seed()
        self.assertEqual(self.ok("edit_notes", action="select", ids=ids[:2])["selected"], sorted(ids[:2]))
        self.assertEqual(self.ok("edit_notes", action="select", all=True)["selected"], sorted(ids))
        self.assertEqual(self.ok("edit_notes", action="select", none=True)["selected"], [])
        self.assertEqual(self.code("edit_notes", action="select"), "INVALID_ARGUMENT")
        self.assertEqual(self.code("edit_notes", action="select", ids=ids, all=True), "INVALID_ARGUMENT")

    # ---- replace
    def test_replace_swaps_all_notes_in_one_call(self):
        self.seed()
        result = self.ok("edit_notes", action="replace", notes=[{"pitch": 72, "start_time": 0, "duration": 1}, {"pitch": 74, "start_time": 1, "duration": 1}])
        self.assertEqual((result["removed"], result["written"], result["note_count"]), (3, 2, 2))
        self.assertEqual([n["pitch"] for n in self.ok("get_notes")["notes"]], [72, 74])

    def test_replace_a_range_leaves_the_rest_alone_and_no_notes_clears(self):
        self.seed()
        result = self.ok("edit_notes", action="replace", from_time=1.0, time_span=1.0, notes=[{"pitch": 70, "start_time": 1.5, "duration": 0.25}])
        self.assertEqual((result["removed"], result["written"], result["note_count"]), (2, 1, 2))
        self.assertEqual(sorted(n["pitch"] for n in self.ok("get_notes")["notes"]), [60, 70])
        self.assertEqual(self.ok("edit_notes", action="replace")["note_count"], 0)

    def test_a_replace_that_fails_inside_live_puts_the_old_notes_back(self):
        ids = self.seed()
        before = [dict(n, id=None) for n in self.ok("get_notes")["notes"]]
        real_add, calls = self.clip.add_new_notes, []

        def flaky(specs):
            calls.append(len(specs))
            if len(calls) == 1:
                raise RuntimeError("Live refused the notes")
            return real_add(specs)
        self.clip.add_new_notes = flaky
        response = self.call("edit_notes", action="replace", notes=[{"pitch": 72, "start_time": 0, "duration": 1}])
        self.assertEqual(response["status"], "error")
        self.assertIn("Live refused", response["message"])
        after = [dict(n, id=None) for n in self.ok("get_notes")["notes"]]
        self.assertEqual(after, before)
        self.assertEqual(calls, [1, 3])

    def test_an_invalid_replacement_note_removes_nothing(self):
        self.seed()
        self.assertEqual(self.code("edit_notes", action="replace", notes=[{"pitch": 72, "start_time": 0, "duration": 1}, {"pitch": 300, "start_time": 0, "duration": 1}]), "OUT_OF_RANGE")
        self.assertEqual(self.ok("get_notes")["count"], 3)

    def test_edit_guard_and_action_validation(self):
        self.seed()
        self.assertEqual(self.code("edit_notes", action="remove", all=True, expect={"name": "other"}), "GUARD_FAILED")
        self.assertEqual(self.ok("get_notes")["count"], 3)
        self.assertEqual(self.code("edit_notes", action="explode"), "INVALID_ARGUMENT")
        self.assertEqual(self.code("edit_notes"), "INVALID_ARGUMENT")

    def test_note_writes_are_one_undo_step_each(self):
        self.song.undo_log.clear()
        ids = self.seed()
        self.ok("edit_notes", action="modify", changes=[{"id": ids[0], "velocity": 10}])
        self.ok("get_notes")
        self.assertEqual(self.song.undo_log, ["begin", "end", "begin", "end"])

    def test_the_note_field_table_matches_what_live_reports_for_a_note(self):
        live = mod.api_registry.class_properties("Live.Clip.MidiNote")
        self.assertEqual(set(mod.notes.NOTE_FIELDS) | {"note_id"}, set(live))
        kinds = {"int": "int", "float": "float", "bool": "bool"}
        for name, rule in mod.notes.NOTE_FIELDS.items():
            self.assertEqual(mod.api_registry.family(live[name]["get"]), kinds[rule["type"]], name)
            self.assertEqual(mod.api_registry.family(live[name]["set"]), kinds[rule["type"]], name)
        self.assertIsNone(live["note_id"]["set"])


# ---------------------------------------------------------------- batch

class BatchTests(unittest.TestCase):
    setUp = LifecycleTests.setUp
    run_command = LifecycleTests.run_command

    def batch(self, ops, **extra):
        return self.run_command("batch", dict({"ops": ops}, **extra))

    def op(self, command, **params):
        return {"command": command, "params": params}

    def test_a_batch_runs_every_op_in_order_and_returns_each_result(self):
        response = self.batch([self.op("create", kind="scene", name="Bridge"), self.op("create", kind="midi_track", name="Bass"),
                               self.op("get_properties", address="scenes/2", names=["name"])])
        self.assertEqual(response["status"], "success", response)
        result = response["result"]
        self.assertEqual((result["ok"], result["applied"], [r["command"] for r in result["results"]]), (True, 3, ["create", "create", "get_properties"]))
        self.assertEqual(result["results"][0]["result"]["address"], "scenes/2")
        self.assertEqual(result["results"][2]["result"]["properties"], {"name": "Bridge"})
        self.assertEqual((len(self.song.scenes), self.song.tracks[-1].name), (3, "Bass"))

    def test_the_whole_batch_is_one_undo_step(self):
        self.song.undo_log.clear()
        self.batch([self.op("create", kind="scene"), self.op("create", kind="scene"), self.op("create", kind="midi_track")])
        self.assertEqual(self.song.undo_log, ["begin", "end"])

    def test_later_ops_can_use_earlier_results(self):
        response = self.batch([self.op("create", kind="scene", name="First"),
                               self.op("set_properties", address="$0.address", properties={"name": "Renamed", "tempo": 100}),
                               self.op("duplicate", address="$0.address"),
                               self.op("get_properties", address="$2.address", names=["name"])])
        self.assertEqual(response["status"], "success", response)
        self.assertEqual([s.name for s in self.song.scenes][-2:], ["Renamed", "Renamed"])
        self.assertEqual(self.song.scenes[2].tempo, 100.0)

    def test_references_keep_types_and_work_inside_strings_lists_and_objects(self):
        response = self.batch([self.op("create", kind="scene", name="Verse"),
                               self.op("set_properties", address="scenes/$0.name", properties={"tempo": "$0.color"}),
                               ])
        self.assertEqual(response["status"], "error")
        self.assertEqual(response["details"]["results"][1]["code"], "INVALID_ARGUMENT")      # 'scenes/Verse' is not an address: the text was substituted
        ok = self.batch([self.op("create", kind="scene", name="Chorus"),
                         self.op("set_properties", address="scenes/name:$0.name", properties={"tempo": 90})])
        self.assertEqual(ok["status"], "success", ok)
        self.assertEqual(self.song.scenes[-1].tempo, 90.0)
        typed = self.batch([self.op("create", kind="midi_track", color=77), self.op("create", kind="scene", color="$0.color")])
        self.assertEqual(typed["result"]["results"][1]["result"]["color"], 77)                # a whole-string reference keeps its number type

    def test_an_error_stops_the_batch_keeps_what_was_applied_and_reports_everything(self):
        response = self.batch([self.op("create", kind="scene", name="A"), self.op("create", kind="scene", index=99),
                               self.op("create", kind="scene", name="Never")])
        self.assertEqual((response["status"], response["code"]), ("error", "BATCH_FAILED"))
        self.assertIn("Batch stopped at op 1 (create)", response["message"])
        self.assertIn("1 op(s) before it were applied as ONE undo step", response["message"])
        details = response["details"]
        self.assertEqual((details["applied"], details["failed"], details["not_run"]), (1, [1], [2]))
        self.assertEqual([r["status"] for r in details["results"]], ["success", "error"])
        self.assertEqual(details["results"][1]["code"], "OUT_OF_RANGE")
        self.assertEqual([s.name for s in self.song.scenes], ["S0", "S1", "A"])                # op 0 stays, op 2 never ran
        self.assertEqual(self.song.undo_log[-2:], ["begin", "end"])                             # the step is closed even on failure

    def test_on_error_continue_runs_the_rest(self):
        response = self.batch([self.op("create", kind="scene", index=99), self.op("create", kind="scene", name="Later")], on_error="continue")
        self.assertEqual(response["code"], "BATCH_FAILED")
        self.assertIn("1 of 2 ops failed", response["message"])
        self.assertEqual((response["details"]["applied"], response["details"]["failed"], response["details"]["not_run"]), (1, [0], []))
        self.assertEqual(self.song.scenes[-1].name, "Later")

    def test_bad_batches_are_refused_before_anything_runs(self):
        cases = [({"ops": []}, "INVALID_ARGUMENT"), ({"ops": "x"}, "INVALID_ARGUMENT"), ({}, "INVALID_ARGUMENT"),
                 ({"ops": [self.op("create", kind="scene"), {"params": {}}]}, "INVALID_ARGUMENT"),
                 ({"ops": [self.op("create", kind="scene"), self.op("no_such_command")]}, "NOT_FOUND"),
                 ({"ops": [self.op("create", kind="scene"), {"command": "get_properties", "params": []}]}, "INVALID_ARGUMENT"),
                 ({"ops": [self.op("create", kind="scene")], "on_error": "explode"}, "INVALID_ARGUMENT"),
                 ({"ops": [self.op("create", kind="scene")] * 101}, "INVALID_ARGUMENT")]
        for command in ("batch", "history", "eval", "transport", "launch", "ramp_parameter", "cancel_ramps"):
            cases.append(({"ops": [self.op("create", kind="scene"), self.op(command)]}, "INVALID_ARGUMENT"))
        for params, code in cases:
            response = self.run_command("batch", params)
            self.assertEqual((response["status"], response["code"]), ("error", code), str(params)[:80])
        self.assertEqual(len(self.song.scenes), 2)

    def test_reference_errors_are_specific(self):
        for ops, fragment in [([self.op("create", kind="scene", name="$1.name"), self.op("create", kind="scene")], "has not run yet"),
                              ([self.op("create", kind="scene"), self.op("set_properties", address="$0.nope", properties={"name": "x"})], "does not exist in the result of op 0"),
                              ([self.op("create", kind="scene", index=99), self.op("delete", address="$0.address", expect={"name": "x"})], "refers to an op that failed"),
                              ([self.op("create", kind="scene"), self.op("set_properties", address="$0.ids[3]", properties={"name": "x"})], "does not exist")]:
            response = self.batch(ops, on_error="continue")
            messages = " ".join(r.get("message", "") for r in response["details"]["results"])
            self.assertIn(fragment, messages, ops)

    def test_the_error_response_carries_elapsed_time_and_details_only_for_batches(self):
        response = self.batch([self.op("create", kind="scene", index=99)])
        self.assertIn("elapsed_ms", response)
        self.assertIn("details", response)
        plain = self.run_command("create", {"kind": "scene", "index": 99})
        self.assertNotIn("details", plain)

    def test_a_batch_is_listed_as_a_writing_command(self):
        self.assertTrue(mod._COMMANDS["batch"]["writes"])


# ---------------------------------------------------------------- cue points and the application

class FakeCue(Typed):
    _types = {"name": str}

    def __init__(self, name, time):
        self.name, self.time, self.jumped = name, time, 0

    def jump(self):
        self.jumped += 1


class CueTests(unittest.TestCase):
    def setUp(self):
        self.script = make_script()
        self.addCleanup(self.script._stop_server)
        song = make_song()
        song.is_playing, song.current_song_time, song.can_jump_to_next_cue = False, 6.5, True
        song.cue_points = [FakeCue("Intro", 0.0), FakeCue("Chorus", 16.0)]
        self.times_seen = []

        def toggle():
            self.times_seen.append(song.current_song_time)
            here = [c for c in song.cue_points if abs(c.time - song.current_song_time) < 1e-9]
            if here:
                song.cue_points.remove(here[0])
            else:
                song.cue_points.append(FakeCue("", song.current_song_time))
                song.cue_points.sort(key=lambda c: c.time)
        song.set_or_delete_cue = toggle
        app = self.script._c_instance.app
        app.average_process_usage, app.peak_process_usage, app.open_dialog_count = 0.12, 0.4, 0
        app.current_dialog_message, app.current_dialog_button_count, app.number_of_push_apps_running = "", 0, 0
        self.script._song = self.song = song

    def run_command(self, name, params):
        return self.script._process_command({"type": name, "params": params})

    def test_cue_points_have_addresses_and_properties(self):
        self.assertEqual(self.script._resolve("cue_points/1")[2], "cue_points/1")
        self.assertEqual(self.script._resolve("cue_points/name:Intro")[2], "cue_points/0")
        self.assertEqual(self.script._address_of(self.song.cue_points[1]), "cue_points/1")
        got = self.run_command("get_properties", {"address": "cue_points/1"})["result"]["properties"]
        self.assertEqual(got, {"name": "Chorus", "time": 16.0})
        self.assertEqual(self.run_command("set_properties", {"address": "cue_points/0", "properties": {"name": "Start"}})["status"], "success")
        self.assertEqual(self.song.cue_points[0].name, "Start")
        self.assertEqual(self.run_command("set_properties", {"address": "cue_points/0", "properties": {"time": 3.0}})["code"], "INVALID_ARGUMENT")
        self.assertEqual(self.run_command("get_properties", {"address": "cue_points/7"})["code"], "OUT_OF_RANGE")

    def test_create_a_cue_point_sets_it_at_a_time_and_puts_the_playhead_back(self):
        made = self.run_command("create", {"kind": "cue_point", "time": 8, "name": "Verse"})["result"]
        self.assertEqual((made["address"], made["name"], made["time"], made["kind"]), ("cue_points/1", "Verse", 8.0, "cue_point"))
        self.assertEqual(self.times_seen, [8.0])
        self.assertEqual(self.song.current_song_time, 6.5)
        self.assertEqual([c.name for c in self.song.cue_points], ["Intro", "Verse", "Chorus"])

    def test_create_a_cue_point_refuses_bad_requests_and_leaves_the_playhead_alone(self):
        for params, code in [({"kind": "cue_point"}, "INVALID_ARGUMENT"), ({"kind": "cue_point", "time": -1}, "INVALID_ARGUMENT"),
                             ({"kind": "cue_point", "time": "8"}, "INVALID_ARGUMENT"), ({"kind": "cue_point", "time": 16}, "INVALID_ARGUMENT"),
                             ({"kind": "cue_point", "time": 4, "color": 5}, "INVALID_ARGUMENT")]:
            self.assertEqual(self.run_command("create", params)["code"], code, params)
        self.song.is_playing = True
        self.assertEqual(self.run_command("create", {"kind": "cue_point", "time": 4})["code"], "UNAVAILABLE")
        self.assertEqual((len(self.song.cue_points), self.song.current_song_time, self.times_seen), (2, 6.5, []))

    def test_delete_a_cue_point_needs_the_guard_and_a_stopped_transport(self):
        self.assertEqual(self.run_command("delete", {"address": "cue_points/1", "expect": {"name": "Nope"}})["code"], "GUARD_FAILED")
        out = self.run_command("delete", {"address": "cue_points/1", "expect": {"name": "Chorus"}})["result"]
        self.assertEqual((out["deleted"], out["cue_points"]), ("cue_points/1", 1))
        self.assertEqual((self.times_seen, self.song.current_song_time), ([16.0], 6.5))
        self.song.is_playing = True
        self.assertEqual(self.run_command("delete", {"address": "cue_points/0", "expect": {"name": "Intro"}})["code"], "UNAVAILABLE")
        self.assertEqual(len(self.song.cue_points), 1)

    def test_launching_a_cue_point_jumps_and_cannot_be_stopped(self):
        self.assertEqual(self.run_command("launch", {"address": "cue_points/1"})["status"], "success")
        self.assertEqual(self.song.cue_points[1].jumped, 1)
        self.assertEqual(self.run_command("launch", {"address": "cue_points/1", "action": "stop"})["code"], "INVALID_ARGUMENT")

    def test_describe_set_lists_cue_points_and_they_change_the_fingerprint(self):
        self.script._song.scenes = [PropScene("S")]
        before = self.run_command("describe_set", {})["result"]
        self.assertEqual([(c["address"], c["name"], c["time"]) for c in before["cue_points"]], [("cue_points/0", "Intro", 0.0), ("cue_points/1", "Chorus", 16.0)])
        self.run_command("create", {"kind": "cue_point", "time": 4})
        after = self.run_command("describe_set", {})["result"]
        self.assertNotEqual(before["fingerprint"], after["fingerprint"])
        self.run_command("delete", {"address": "cue_points/1", "expect": {"name": ""}})
        self.assertEqual(self.run_command("describe_set", {})["result"]["fingerprint"], before["fingerprint"])

    def test_the_application_is_addressable_and_read_only(self):
        got = self.run_command("get_properties", {"address": "app", "names": ["average_process_usage", "open_dialog_count"]})["result"]
        self.assertEqual((got["kind"], got["properties"]), ("app", {"average_process_usage": 0.12, "open_dialog_count": 0}))
        self.assertEqual(self.run_command("set_properties", {"address": "app", "properties": {"average_process_usage": 0.5}})["code"], "INVALID_ARGUMENT")
        listing = self.run_command("list_properties", {"kind": "app"})["result"]
        self.assertTrue(all(not p["writable"] for p in listing["properties"].values()))
        self.assertIn("view", listing["not_exposed"])

    def test_song_and_track_read_only_state_is_readable(self):
        self.song.session_record_status = 2
        self.song.is_counting_in, self.song.record_mode = True, False
        got = self.run_command("get_properties", {"address": "song", "names": ["session_record_status", "is_counting_in", "can_jump_to_next_cue"]})["result"]["properties"]
        self.assertEqual(got, {"session_record_status": "transition", "is_counting_in": True, "can_jump_to_next_cue": True})
        self.assertEqual(self.run_command("set_properties", {"address": "song", "properties": {"record_mode": True}})["code"], "INVALID_ARGUMENT")
        slot = self.song.tracks[0].clip_slots[0]
        slot.playing_status, slot.color_index = 1, 5
        self.assertEqual(self.run_command("get_properties", {"address": "tracks/0/slots/0", "names": ["playing_status", "color_index"]})["result"]["properties"],
                         {"playing_status": "started", "color_index": 5})


# ---------------------------------------------------------------- devices, racks and parameters

class DevHost(object):
    """Like Live's tracks and rack chains: an ordered device list you can insert into, delete from and duplicate."""

    def _init_host(self):
        self.devices = []

    def adopt(self, devices):
        for device in devices:
            device.canonical_parent = self
        self.devices.extend(devices)
        return self

    def insert_device(self, name, index=-1):
        if name == "Nope":
            raise RuntimeError("Could not find a device named 'Nope'")
        if name in ("EQ Eight", "Utility") and self.devices and self.devices[0].type != 1 and index == 0 and any(d.type == 1 for d in self.devices):
            raise RuntimeError("Insert audio effects after instruments")
        device = DevDevice(name, dev_type=1 if name in ("Wavetable", "Drift") else 2)
        device.canonical_parent = self
        device.link_parameters()
        if name.endswith("Rack"):
            device.make_rack(drum=name == "Drum Rack")
        self.devices.insert(len(self.devices) if index == -1 else index, device)
        return device

    def delete_device(self, index):
        self.devices.pop(index)

    def duplicate_device(self, index):
        source = self.devices[index]
        if source.type == 1:
            raise RuntimeError("Can not duplicate instrument.")
        copy = DevDevice(source.name, dev_type=source.type)
        copy.canonical_parent = self
        copy.link_parameters()
        self.devices.insert(index + 1, copy)


class DevChain(FakeChain, DevHost):
    def __init__(self, name):
        FakeChain.__init__(self, name, [])
        self._init_host()
        self.mute = self.solo = False
        self.color, self.color_index, self.is_auto_colored = 0, 0, True
        self.muted_via_solo = False
        self.has_audio_input = self.has_audio_output = True
        self.has_midi_input = self.has_midi_output = False
        self.mixer_device = make_mixer(sends=False)
        self.mixer_device.canonical_parent = self
        for prm in (self.mixer_device.volume, self.mixer_device.panning):
            prm.canonical_parent = self.mixer_device


class DevPad(FakePad):
    def __init__(self, note, name):
        FakePad.__init__(self, note, name, [])
        self.mute = self.solo = False
        self.cleared = 0

    def delete_all_chains(self):
        self.cleared += 1
        self.chains = []


class DevDevice(FakeDevice):
    def __init__(self, name, dev_type=2):
        FakeDevice.__init__(self, name, dev_type=dev_type)
        self.canonical_parent = None
        self.class_display_name = name
        self.can_compare_ab, self.is_using_compare_preset_b, self.is_active = True, False, True
        self.view = types.SimpleNamespace(is_collapsed=False)
        self.saved_ab = 0
        self.rack_calls = []

    def link_parameters(self):
        for prm in self.parameters:
            prm.canonical_parent = self

    def save_preset_to_compare_ab_slot(self):
        self.saved_ab += 1

    def make_rack(self, drum=False):
        self.can_have_chains, self.can_have_drum_pads = True, drum
        self.chains, self.return_chains = [], []
        self.drum_pads = [DevPad(n, "Pad {0}".format(n)) for n in range(128)] if drum else None
        if not drum:
            del self.drum_pads
        self.visible_macro_count, self.variation_count, self.selected_variation_index = 8, 0, -1
        self.macros_mapped = (False,) * 8
        self.has_macro_mappings = False
        self.can_show_chains, self.is_showing_chains = True, False

    def insert_chain(self, index=-1):
        chain = DevChain("Chain {0}".format(len(self.chains) + 1))
        chain.canonical_parent = self
        self.chains.insert(len(self.chains) if index == -1 else index, chain)
        return chain

    def add_macro(self):
        self.visible_macro_count += 1

    def remove_macro(self):
        self.visible_macro_count -= 1

    def randomize_macros(self):
        self.rack_calls.append("randomize")

    def store_variation(self):
        self.variation_count += 1

    def recall_selected_variation(self):
        self.rack_calls.append("recall_selected")

    def recall_last_used_variation(self):
        self.rack_calls.append("recall_last")

    def delete_selected_variation(self):
        self.variation_count -= 1

    def copy_pad(self, source, destination):
        self.rack_calls.append(("copy_pad", source, destination))


class DevTrack(FakeTrack, DevHost):
    def __init__(self, name):
        FakeTrack.__init__(self, name, with_clips=False)
        self._init_host()
        self.mixer_device.canonical_parent = self
        for prm in [self.mixer_device.volume, self.mixer_device.panning] + list(self.mixer_device.sends):
            prm.canonical_parent = self.mixer_device


class DeviceTests(unittest.TestCase):
    """Track 'Synth': 0 Wavetable, 1 Audio Effect Rack (chains Wide [Delay, Inner Rack [Deep [Deep Effect]]], Dry []; return FX [Reverb]),
    2 Drum Rack (pad 36 'Kick' with one chain [Kick Synth]), 3 EQ Eight.  Return track 'Return A' [Return Reverb], master [Limiter]."""

    def setUp(self):
        self.script = make_script()
        self.addCleanup(self.script._stop_server)
        song = make_song()
        synth = DevTrack("Synth")
        wavetable = DevDevice("Wavetable", dev_type=1)
        rack = DevDevice("Audio Effect Rack")
        rack.make_rack()
        inner = DevDevice("Inner Rack")
        inner.make_rack()
        deep = inner.insert_chain()
        deep.name = "Deep"
        deep.adopt([DevDevice("Deep Effect")])
        wide = rack.insert_chain()
        wide.name = "Wide"
        wide.adopt([DevDevice("Delay"), inner])
        dry = rack.insert_chain()
        dry.name = "Dry"
        fx = DevChain("FX")
        fx.canonical_parent = rack
        fx.adopt([DevDevice("Reverb")])
        rack.return_chains.append(fx)
        kit = DevDevice("Drum Rack", dev_type=1)
        kit.make_rack(drum=True)
        kick_chain = DevChain("Kick")
        kick_chain.canonical_parent = kit.drum_pads[36]
        kick_chain.adopt([DevDevice("Kick Synth", dev_type=1)])
        kit.drum_pads[36].name = "Kick"
        kit.drum_pads[36].chains = [kick_chain]
        kit.chains = [kick_chain]
        for pad in kit.drum_pads:
            pad.canonical_parent = kit
        synth.adopt([wavetable, rack, kit, DevDevice("EQ Eight")])
        for device in [wavetable, rack, inner, kit, synth.devices[3]] + list(wide.devices) + list(fx.devices) + list(deep.devices) + list(kick_chain.devices):
            device.link_parameters()
        song.tracks = [synth]
        ret = DevTrack("Return A")
        ret.adopt([DevDevice("Return Reverb")])
        song.return_tracks = [ret]
        master = DevTrack("Master")
        master.adopt([DevDevice("Limiter")])
        song.master_track = master
        for track in (ret, master):
            track.devices[0].link_parameters()
        song.move_device = lambda device, target, position: self.move(device, target, position)
        self.script._song = self.song = song
        self.synth, self.rack, self.inner, self.kit, self.wide = synth, rack, inner, kit, wide

    def move(self, device, target, position):
        host = device.canonical_parent
        host.devices.remove(device)
        landed = min(position, len(target.devices))
        target.devices.insert(landed, device)
        device.canonical_parent = target
        return landed

    def run_command(self, name, params):
        return self.script._process_command({"type": name, "params": params})

    def ok(self, command_name, /, **params):
        response = self.run_command(command_name, params)
        self.assertEqual(response["status"], "success", response)
        return response["result"]

    def code(self, command_name, /, **params):
        response = self.run_command(command_name, params)
        self.assertEqual(response["status"], "error", response)
        return response["code"]

    # ---- addresses
    def test_resolve_devices_parameters_chains_pads_and_mixers(self):
        r = self.script._resolve
        self.assertEqual((r("tracks/0/devices/1")[0], r("tracks/0/devices/1")[1].name), ("device", "Audio Effect Rack"))
        self.assertEqual(r("tracks/0/devices/name:EQ Eight")[2], "tracks/0/devices/3")
        self.assertEqual(r("tracks/name:Synth/devices/0")[2], "tracks/0/devices/0")
        self.assertEqual(r("returns/0/devices/0")[1].name, "Return Reverb")
        self.assertEqual(r("master/devices/0")[1].name, "Limiter")
        self.assertEqual((r("tracks/0/devices/0/parameters/1")[0], r("tracks/0/devices/0/parameters/1")[1].name), ("parameter", "Freq"))
        self.assertEqual(r("tracks/0/devices/0/parameters/name:Drive")[2], "tracks/0/devices/0/parameters/2")
        self.assertEqual((r("tracks/0/devices/1/chains/1")[0], r("tracks/0/devices/1/chains/name:Wide")[2]), ("chain", "tracks/0/devices/1/chains/0"))
        self.assertEqual(r("tracks/0/devices/1/return_chains/0/devices/0")[1].name, "Reverb")
        self.assertEqual(r("tracks/0/devices/1/chains/0/devices/1/chains/0/devices/0")[1].name, "Deep Effect")
        self.assertEqual((r("tracks/0/devices/2/drum_pads/36")[0], r("tracks/0/devices/2/drum_pads/36")[1].name), ("pad", "Kick"))
        self.assertEqual(r("tracks/0/devices/2/drum_pads/36/chains/0/devices/0")[1].name, "Kick Synth")
        self.assertEqual(r("tracks/0/mixer/volume")[2], "tracks/0/mixer/volume")
        self.assertEqual(r("tracks/0/mixer/sends/1")[1].name, "Send B")
        self.assertEqual(r("master/mixer/panning")[0], "parameter")
        self.assertEqual(r("tracks/0/devices/1/chains/0/mixer/volume")[2], "tracks/0/devices/1/chains/0/mixer/volume")

    def test_device_address_errors_carry_codes(self):
        cases = [("tracks/0/devices/9", "OUT_OF_RANGE"), ("tracks/0/devices/name:Nope", "NOT_FOUND"), ("tracks/0/devices/0/parameters/99", "OUT_OF_RANGE"),
                 ("tracks/0/devices/0/chains/0", "INVALID_ARGUMENT"), ("tracks/0/devices/0/drum_pads/36", "INVALID_ARGUMENT"),
                 ("tracks/0/devices/1/chains/9", "OUT_OF_RANGE"), ("tracks/0/devices/1/drum_pads/36", "INVALID_ARGUMENT"),
                 ("tracks/0/devices/2/drum_pads/200", "OUT_OF_RANGE"), ("tracks/0/devices/2/drum_pads/35/chains/0", "NOT_FOUND"),
                 ("tracks/0/devices/0/bogus", "NOT_FOUND"), ("tracks/0/devices", "NOT_FOUND"), ("tracks/0/mixer/nonsense", "NOT_FOUND"),
                 ("tracks/0/mixer/sends/5", "OUT_OF_RANGE"), ("tracks/0/bogus/0", "NOT_FOUND"), ("master/bogus", "NOT_FOUND"),
                 ("tracks/0/devices/1/chains/0/devices/9", "OUT_OF_RANGE")]
        for address, code in cases:
            self.assertEqual(self.code("get_properties", address=address), code, address)

    def test_every_device_level_object_can_be_named_again(self):
        addresses = ["tracks/0/devices/0", "tracks/0/devices/1", "tracks/0/devices/1/chains/0", "tracks/0/devices/1/chains/1", "returns/0/devices/0",
                     "tracks/0/devices/1/return_chains/0", "tracks/0/devices/1/chains/0/devices/1", "tracks/0/devices/1/chains/0/devices/1/chains/0/devices/0",
                     "tracks/0/devices/2/drum_pads/36", "tracks/0/devices/2/drum_pads/36/chains/0", "tracks/0/devices/2/drum_pads/36/chains/0/devices/0",
                     "tracks/0/devices/0/parameters/3", "tracks/0/devices/1/chains/0/devices/0/parameters/2", "master/devices/0/parameters/1",
                     "tracks/0/mixer/volume", "tracks/0/mixer/panning", "tracks/0/mixer/sends/1", "master/mixer/volume", "returns/0/mixer/volume",
                     "tracks/0/devices/1/chains/0/mixer/volume", "tracks/0/devices/1/chains/0/mixer/panning", "master/devices/0"]
        for address in addresses:
            kind, obj, canonical = self.script._resolve(address)
            self.assertEqual(self.script._address_of(obj), canonical, address)

    # ---- properties
    def test_device_properties_read_and_write(self):
        got = self.ok("get_properties", address="tracks/0/devices/0", names=["name", "class_name", "type", "on", "collapsed", "can_have_chains", "is_active"])["properties"]
        self.assertEqual(got, {"name": "Wavetable", "class_name": "Wavetable", "type": "instrument", "on": True, "collapsed": False,
                               "can_have_chains": False, "is_active": True})
        result = self.ok("set_properties", address="tracks/0/devices/0", properties={"name": "Lead", "on": False, "collapsed": True})["applied"]
        self.assertEqual((result["name"]["to"], result["on"]["to"], result["collapsed"]["to"]), ("Lead", False, True))
        self.assertEqual(self.synth.devices[0].parameters[0].value, 0.0)
        self.assertTrue(self.synth.devices[0].view.is_collapsed)
        self.assertEqual(self.code("set_properties", address="tracks/0/devices/0", properties={"class_name": "X"}), "INVALID_ARGUMENT")
        self.assertEqual(self.code("set_properties", address="tracks/0/devices/0", properties={"on": "yes"}), "TYPE_ERROR")

    def test_rack_only_properties_are_unavailable_on_plain_devices(self):
        plain = self.ok("get_properties", address="tracks/0/devices/0")
        self.assertIn("visible_macro_count", plain["unavailable"])
        rack = self.ok("get_properties", address="tracks/0/devices/1")
        self.assertEqual((rack["properties"]["visible_macro_count"], rack["properties"]["variation_count"]), (8, 0))
        self.assertNotIn("visible_macro_count", rack.get("unavailable", {}))

    def test_a_device_without_an_on_switch_says_so(self):
        self.synth.devices[0].parameters = [FakeParam("Freq", 0.5)]
        self.assertEqual(self.code("set_properties", address="tracks/0/devices/0", properties={"on": True}), "LIVE_ERROR")

    def test_parameter_values_are_checked_against_the_parameters_own_range(self):
        address = "tracks/0/devices/0/parameters/2"        # Drive: 0..100
        self.assertEqual(self.ok("set_properties", address=address, properties={"value": 75})["applied"]["value"], {"from": 50, "to": 75.0})
        self.assertEqual(self.code("set_properties", address=address, properties={"value": 101}), "OUT_OF_RANGE")
        self.assertEqual(self.code("set_properties", address=address, properties={"value": -1}), "OUT_OF_RANGE")
        self.assertEqual(self.code("set_properties", address=address, properties={"value": "loud"}), "TYPE_ERROR")
        self.assertEqual(self.code("set_properties", address=address, properties={"value": True}), "TYPE_ERROR")
        self.assertEqual(self.synth.devices[0].parameters[2].value, 75.0)

    def test_quantized_parameters_take_their_labels(self):
        address = "tracks/0/devices/0/parameters/4"        # Mode: A, B, C
        self.ok("set_properties", address=address, properties={"value": "C"})
        self.assertEqual(self.synth.devices[0].parameters[4].value, 2.0)
        self.assertEqual(self.code("set_properties", address=address, properties={"value": "D"}), "INVALID_ARGUMENT")
        self.assertEqual(self.ok("get_properties", address=address, names=["value_items", "display", "is_quantized"])["properties"],
                         {"value_items": ["A", "B", "C"], "display": "C", "is_quantized": True})

    def test_disabled_and_macro_mapped_parameters_refuse_writes(self):
        self.assertEqual(self.code("set_properties", address="tracks/0/devices/0/parameters/3", properties={"value": 1}), "UNAVAILABLE")

    def test_parameter_reads_include_display_and_range(self):
        got = self.ok("get_properties", address="tracks/0/devices/0/parameters/1", names=["name", "value", "min", "max", "display", "default_value"])["properties"]
        self.assertEqual(got, {"name": "Freq", "value": 0.5, "min": 0.0, "max": 1.0, "display": "0.5 units", "default_value": 0.0})

    def test_mixer_parameters_are_parameters_too(self):
        self.ok("set_properties", address="tracks/0/mixer/volume", properties={"value": 0.5})
        self.assertEqual(self.synth.mixer_device.volume.value, 0.5)
        self.assertEqual(self.code("set_properties", address="tracks/0/mixer/volume", properties={"value": 2}), "OUT_OF_RANGE")

    def test_chain_and_pad_properties(self):
        self.ok("set_properties", address="tracks/0/devices/1/chains/0", properties={"name": "Bright", "mute": True, "volume": 0.6, "panning": -0.5})
        self.assertEqual((self.wide.name, self.wide.mute, self.wide.mixer_device.volume.value, self.wide.mixer_device.panning.value), ("Bright", True, 0.6, -0.5))
        self.assertEqual(self.code("set_properties", address="tracks/0/devices/1/chains/0", properties={"volume": 3}), "OUT_OF_RANGE")
        self.ok("set_properties", address="tracks/0/devices/2/drum_pads/36", properties={"mute": True, "solo": True})
        self.assertEqual((self.kit.drum_pads[36].mute, self.kit.drum_pads[36].solo), (True, True))
        self.assertEqual(self.code("set_properties", address="tracks/0/devices/2/drum_pads/36", properties={"name": "Snare"}), "INVALID_ARGUMENT")
        self.assertEqual(self.ok("get_properties", address="tracks/0/devices/2/drum_pads/36", names=["note", "name"])["properties"], {"note": 36, "name": "Kick"})

    # ---- get_device
    def test_get_device_lists_parameters_children_and_addresses(self):
        info = self.ok("get_device", address="tracks/0/devices/1")
        self.assertEqual((info["address"], info["name"], info["device_type"]), ("tracks/0/devices/1", "Audio Effect Rack", "rack"))
        self.assertEqual([c["name"] for c in info["chains"]], ["Wide", "Dry"])
        self.assertEqual(info["chains"][0]["devices"], [{"address": "tracks/0/devices/1/chains/0/devices/0", "name": "Delay", "class_name": "Delay"},
                                                        {"address": "tracks/0/devices/1/chains/0/devices/1", "name": "Inner Rack", "class_name": "InnerRack"}])
        self.assertEqual(info["return_chains"][0]["address"], "tracks/0/devices/1/return_chains/0")
        self.assertEqual(info["macros"], {"visible": 8, "variations": 0, "selected_variation": -1})
        plain = self.ok("get_device", address="tracks/0/devices/0")
        self.assertEqual(plain["parameters"][1]["address"], "tracks/0/devices/0/parameters/1")
        self.assertEqual(plain["parameters"][4]["value_items"], ["A", "B", "C"])
        self.assertNotIn("chains", plain)

    def test_get_device_lists_only_occupied_drum_pads(self):
        info = self.ok("get_device", address="tracks/0/devices/2")
        self.assertEqual([(p["note"], p["name"]) for p in info["drum_pads"]], [(36, "Kick")])
        self.assertEqual(info["drum_pads"][0]["chains"][0]["devices"][0]["address"], "tracks/0/devices/2/drum_pads/36/chains/0/devices/0")
        self.assertEqual(self.code("get_device", address="tracks/0"), "INVALID_ARGUMENT")
        self.assertEqual(self.code("get_device", address="tracks/0/devices/9"), "OUT_OF_RANGE")

    # ---- device_action
    def test_insert_a_device_into_a_track_or_a_chain(self):
        nested = self.ok("device_action", action="insert", address="tracks/0/devices/2/drum_pads/36/chains/0", name="Utility", position=0)
        self.assertEqual(nested["address"], "tracks/0/devices/2/drum_pads/36/chains/0/devices/0")
        master = self.ok("device_action", action="insert", address="master", name="EQ Eight")
        self.assertEqual(master["address"], "master/devices/1")
        end = self.ok("device_action", action="insert", address="returns/0", name="Utility")
        self.assertEqual(end["address"], "returns/0/devices/1")
        made = self.ok("device_action", action="insert", address="tracks/0", name="Utility", position=1)
        self.assertEqual((made["address"], made["name"]), ("tracks/0/devices/1", "Utility"))          # everything after it shifts
        self.assertEqual([d.name for d in self.synth.devices][:3], ["Wavetable", "Utility", "Audio Effect Rack"])

    def test_insert_errors_come_from_live_or_from_validation(self):
        response = self.run_command("device_action", {"action": "insert", "address": "tracks/0", "name": "Nope"})
        self.assertEqual((response["code"], "Could not find a device named 'Nope'" in response["message"]), ("LIVE_ERROR", True))
        for params, code in [({"address": "tracks/0"}, "INVALID_ARGUMENT"), ({"address": "tracks/0", "name": "  "}, "INVALID_ARGUMENT"),
                             ({"address": "tracks/0", "name": "Utility", "position": -3}, "INVALID_ARGUMENT"),
                             ({"address": "tracks/0", "name": "Utility", "position": "0"}, "INVALID_ARGUMENT"),
                             ({"address": "tracks/0/devices/0", "name": "Utility"}, "INVALID_ARGUMENT"),
                             ({"address": "tracks/0/devices/0/parameters/1", "name": "Utility"}, "INVALID_ARGUMENT")]:
            self.assertEqual(self.code("device_action", action="insert", **params), code, params)
        self.assertEqual(len(self.synth.devices), 4)

    def test_delete_needs_the_guard_and_reports_what_remains(self):
        self.assertEqual(self.code("device_action", action="delete", address="tracks/0/devices/3"), "INVALID_ARGUMENT")
        self.assertEqual(self.code("device_action", action="delete", address="tracks/0/devices/3", expect={"name": "Nope"}), "GUARD_FAILED")
        self.assertEqual(len(self.synth.devices), 4)
        out = self.ok("device_action", action="delete", address="tracks/0/devices/3", expect={"name": "EQ Eight"})
        self.assertEqual((out["deleted"], out["name"], out["remaining"]), ("tracks/0/devices/3", "EQ Eight", 3))
        inner = self.ok("device_action", action="delete", address="tracks/0/devices/1/chains/0/devices/0", expect={"name": "Delay"})
        self.assertEqual(inner["remaining"], 1)
        self.assertEqual(self.code("device_action", action="delete", address="tracks/0", expect={"name": "Synth"}), "INVALID_ARGUMENT")

    def test_duplicate_puts_the_copy_next_to_the_source_and_live_can_refuse(self):
        out = self.ok("device_action", action="duplicate", address="tracks/0/devices/3")
        self.assertEqual((out["source"], out["address"], out["name"]), ("tracks/0/devices/3", "tracks/0/devices/4", "EQ Eight"))
        response = self.run_command("device_action", {"action": "duplicate", "address": "tracks/0/devices/0"})
        self.assertEqual((response["code"], "Can not duplicate instrument" in response["message"]), ("LIVE_ERROR", True))

    def test_move_a_device_to_another_track_or_chain(self):
        out = self.ok("device_action", action="move", address="tracks/0/devices/3", to="returns/0", position=0)
        self.assertEqual((out["address"], out["position"]), ("returns/0/devices/0", 0))
        self.assertEqual([d.name for d in self.song.return_tracks[0].devices], ["EQ Eight", "Return Reverb"])
        end = self.ok("device_action", action="move", address="returns/0/devices/0", to="tracks/0/devices/1/chains/1")
        self.assertEqual(end["address"], "tracks/0/devices/1/chains/1/devices/0")
        self.assertEqual(self.wide.devices[0].name, "Delay")
        clamped = self.ok("device_action", action="move", address="tracks/0/devices/1/chains/1/devices/0", to="tracks/0", position=99)
        self.assertEqual((clamped["position"], clamped["requested_position"]), (3, 99))
        for params, code in [({"to": "song"}, "INVALID_ARGUMENT"), ({}, "INVALID_ARGUMENT"), ({"to": "tracks/0", "position": -5}, "INVALID_ARGUMENT"),
                             ({"to": "tracks/9"}, "OUT_OF_RANGE")]:
            self.assertEqual(self.code("device_action", action="move", address="tracks/0/devices/3", **params), code, params)

    def test_ab_compare(self):
        out = self.ok("device_action", action="save_ab", address="tracks/0/devices/0")
        self.assertEqual((self.synth.devices[0].saved_ab, out["is_using_compare_preset_b"]), (1, False))
        self.synth.devices[3].can_compare_ab = False
        self.assertEqual(self.code("device_action", action="save_ab", address="tracks/0/devices/3"), "UNAVAILABLE")

    def test_rack_actions_chains_macros_variations_and_pads(self):
        chain = self.ok("device_action", action="insert_chain", address="tracks/0/devices/1")
        self.assertEqual((chain["address"], chain["name"]), ("tracks/0/devices/1/chains/2", "Chain 3"))
        self.assertEqual(self.ok("device_action", action="add_macro", address="tracks/0/devices/1")["visible_macro_count"], 9)
        self.assertEqual(self.ok("device_action", action="remove_macro", address="tracks/0/devices/1")["visible_macro_count"], 8)
        self.ok("device_action", action="randomize_macros", address="tracks/0/devices/1")
        self.assertEqual(self.code("device_action", action="recall_variation", address="tracks/0/devices/1"), "UNAVAILABLE")     # none stored
        self.assertEqual(self.code("device_action", action="delete_variation", address="tracks/0/devices/1"), "UNAVAILABLE")
        self.assertEqual(self.ok("device_action", action="store_variation", address="tracks/0/devices/1")["variation_count"], 1)
        self.assertEqual(self.code("device_action", action="recall_variation", address="tracks/0/devices/1"), "UNAVAILABLE")     # stored, none selected
        self.assertEqual(self.code("device_action", action="recall_variation", address="tracks/0/devices/1", index=3), "OUT_OF_RANGE")
        self.assertEqual(self.code("device_action", action="recall_variation", address="tracks/0/devices/1", index=True), "OUT_OF_RANGE")
        self.ok("device_action", action="recall_variation", address="tracks/0/devices/1", index=0)
        self.assertEqual(self.rack.selected_variation_index, 0)
        self.ok("device_action", action="recall_variation", address="tracks/0/devices/1")          # the selection stays
        self.ok("device_action", action="recall_variation", address="tracks/0/devices/1", which="last")
        self.assertEqual(self.rack.rack_calls, ["randomize", "recall_selected", "recall_selected", "recall_last"])
        self.assertEqual(self.code("device_action", action="recall_variation", address="tracks/0/devices/1", which="newest"), "INVALID_ARGUMENT")
        self.assertEqual(self.ok("device_action", action="delete_variation", address="tracks/0/devices/1")["variation_count"], 0)
        for action in ("insert_chain", "add_macro", "store_variation"):
            self.assertEqual(self.code("device_action", action=action, address="tracks/0/devices/0"), "INVALID_ARGUMENT")
        self.assertEqual(self.code("device_action", action="insert_chain", address="tracks/0"), "INVALID_ARGUMENT")

    def test_copy_and_clear_drum_pads(self):
        out = self.ok("device_action", action="copy_pad", address="tracks/0/devices/2", from_note=36, to_note=38)
        self.assertEqual((out["to"], self.kit.rack_calls), ("tracks/0/devices/2/drum_pads/38", [("copy_pad", 36, 38)]))
        for params in ({"from_note": 36}, {"from_note": 36, "to_note": 200}, {"from_note": "36", "to_note": 40}, {"from_note": True, "to_note": 40}):
            self.assertEqual(self.code("device_action", action="copy_pad", address="tracks/0/devices/2", **params), "INVALID_ARGUMENT", params)
        self.assertEqual(self.code("device_action", action="copy_pad", address="tracks/0/devices/1", from_note=1, to_note=2), "INVALID_ARGUMENT")
        self.assertEqual(self.code("device_action", action="clear_pad", address="tracks/0/devices/2/drum_pads/36"), "INVALID_ARGUMENT")
        self.assertEqual(self.code("device_action", action="clear_pad", address="tracks/0/devices/2/drum_pads/36", expect={"name": "Snare"}), "GUARD_FAILED")
        cleared = self.ok("device_action", action="clear_pad", address="tracks/0/devices/2/drum_pads/36", expect={"name": "Kick"})
        self.assertEqual((cleared["cleared_chains"], self.kit.drum_pads[36].cleared), (1, 1))

    def test_unknown_actions_and_targets(self):
        self.assertEqual(self.code("device_action", action="explode", address="tracks/0"), "INVALID_ARGUMENT")
        self.assertEqual(self.code("device_action", address="tracks/0"), "INVALID_ARGUMENT")
        self.assertEqual(self.code("device_action", action="delete", address="nowhere", expect={"name": "x"}), "NOT_FOUND")

    def test_device_actions_are_one_undo_step_each(self):
        self.song.undo_log.clear()
        self.ok("device_action", action="insert", address="tracks/0", name="Utility")
        self.ok("get_device", address="tracks/0/devices/0")
        self.ok("set_properties", address="tracks/0/devices/0/parameters/1", properties={"value": 0.25})
        self.assertEqual(self.song.undo_log, ["begin", "end", "begin", "end"])


# ---------------------------------------------------------------- automation by address, breakpoints

class BreakpointMathTests(unittest.TestCase):
    def points(self, *pairs, curve=None):
        return [{"time": t, "value": v, "curve": curve, "order": i} for i, (t, v) in enumerate(pairs)]

    def test_a_linear_segment_is_just_its_two_ends(self):
        events = mod.curves._build_breakpoints(self.points((0, 0.2), (8, 0.9)), "linear", 0.25, 8.0, True)
        self.assertEqual(events, [(0, 0.2), (8, 0.9)])

    def test_hold_fills_the_clip_edges(self):
        events = mod.curves._build_breakpoints(self.points((2, 0.2), (6, 0.9)), "linear", 0.25, 8.0, True)
        self.assertEqual(events, [(0.0, 0.2), (2, 0.2), (6, 0.9), (8.0, 0.9)])
        without = mod.curves._build_breakpoints(self.points((2, 0.2), (6, 0.9)), "linear", 0.25, 8.0, False)
        self.assertEqual(without, [(2, 0.2), (6, 0.9)])

    def test_curved_segments_get_a_breakpoint_every_resolution_and_hit_both_ends_exactly(self):
        events = mod.curves._build_breakpoints(self.points((0, 0.0), (4, 1.0)), "ease_in", 1.0, 4.0, False)
        self.assertEqual([t for t, v in events], [0, 1, 2, 3, 4])
        self.assertEqual((events[0][1], events[-1][1]), (0.0, 1.0))
        self.assertAlmostEqual(events[2][1], 0.25)                # ease_in: 0.5 progress -> 0.25
        self.assertTrue(all(events[i][1] < events[i + 1][1] for i in range(4)))

    def test_step_segments_hold_and_jump_with_two_breakpoints_at_one_time(self):
        events = mod.curves._build_breakpoints(self.points((0, 0.2), (2, 0.8), (4, 0.4)), "step", 0.25, 4.0, True)
        self.assertEqual(events, [(0, 0.2), (2, 0.2), (2, 0.8), (4, 0.8), (4, 0.4)])

    def test_per_point_curves_and_coincident_points(self):
        pts = self.points((0, 0.0), (2, 1.0), (2, 0.5), (4, 0.5))
        pts[0]["curve"] = "step"
        events = mod.curves._build_breakpoints(pts, "linear", 0.25, 4.0, False)
        self.assertEqual(events, [(0, 0.0), (2, 0.0), (2, 1.0), (2, 0.5), (4, 0.5)])

    def test_eval_follows_lines_and_takes_the_value_after_a_jump(self):
        events = [(0, 0.2), (2, 0.2), (2, 0.8), (4, 0.8)]
        f = mod.curves._eval_breakpoints
        self.assertAlmostEqual(f(events, 1.0), 0.2)
        self.assertAlmostEqual(f(events, 2.0), 0.8)
        self.assertAlmostEqual(f(events, 3.9), 0.8)
        ramp = [(0, 0.0), (4, 1.0)]
        self.assertAlmostEqual(f(ramp, 1.0), 0.25)
        self.assertAlmostEqual(f(ramp, 9.0), 1.0)
        self.assertAlmostEqual(f(ramp, -1.0), 0.0)

    def test_limits_and_errors(self):
        with self.assertRaises(ValueError):
            mod.curves._build_breakpoints(self.points((0, 0.2), (8, 0.9)), "wobble", 0.25, 8.0, True)
        with self.assertRaises(ValueError):
            mod.curves._build_breakpoints(self.points((0, 0.2), (8, 0.9)), "linear", 0, 8.0, True)
        with self.assertRaises(ValueError):
            mod.curves._build_breakpoints(self.points((3, 0.2)), "linear", 0.25, 8.0, False)
        with self.assertRaises(ValueError):
            mod.curves._build_breakpoints(self.points((0, 0.0), (8000, 1.0)), "smooth", 0.25, 8000.0, False)


class AutomationAddressTests(unittest.TestCase):
    setUp = DeviceTests.setUp
    move = DeviceTests.move
    run_command = DeviceTests.run_command
    ok = DeviceTests.ok
    code = DeviceTests.code

    def prepare(self):
        self.clip = FakeClip("auto", 8.0)
        self.synth.clip_slots = [FakeSlot(self.clip)]
        self.parameter = self.synth.devices[0].parameters[1]      # Freq 0..1
        self.clip_address, self.parameter_address = "tracks/0/slots/0/clip", "tracks/0/devices/0/parameters/1"

    def test_draw_by_address_makes_real_breakpoints_and_reads_them_back(self):
        self.prepare()
        result = self.ok("draw_automation", clip=self.clip_address, parameter=self.parameter_address,
                         points=[{"time": 0, "value": 0.2}, {"time": 8, "value": 0.9}])
        self.assertEqual((result["style"], result["breakpoints"], result["target"]), ("breakpoints", 2, {"parameter": self.parameter_address}))
        self.assertEqual(self.clip.envelopes[id(self.parameter)].breakpoints, [(0.0, 0.2), (8.0, 0.9)])
        for row in result["readback"]:
            self.assertAlmostEqual(row["expected"], row["actual"], places=3)

    def test_the_older_track_index_form_still_works_and_gets_breakpoints_too(self):
        self.prepare()
        self.ok("draw_automation", track_index=0, clip_index=0, device_index=0, parameter_index=1, points=[{"time": 0, "value": 0.1}, {"time": 4, "value": 0.5}])
        self.assertEqual(len(self.clip.envelopes[id(self.parameter)].breakpoints), 3)      # 2 points + hold at the clip end

    def test_steps_style_is_still_available(self):
        self.prepare()
        result = self.ok("draw_automation", clip=self.clip_address, parameter=self.parameter_address, style="steps", resolution=1,
                         points=[{"time": 0, "value": 0.2}, {"time": 8, "value": 0.9}])
        self.assertEqual(result["style"], "steps")
        self.assertGreater(len(self.clip.envelopes[id(self.parameter)].events), 4)
        self.assertEqual(self.code("draw_automation", clip=self.clip_address, parameter=self.parameter_address, style="wavy", points=[{"time": 0, "value": 0.2}]), "INVALID_ARGUMENT")

    def test_merge_rewrites_only_the_drawn_range(self):
        self.prepare()
        self.ok("draw_automation", clip=self.clip_address, parameter=self.parameter_address, points=[{"time": 0, "value": 0.1}, {"time": 8, "value": 0.1}])
        self.ok("draw_automation", clip=self.clip_address, parameter=self.parameter_address, mode="merge", hold=False,
                points=[{"time": 2, "value": 0.9}, {"time": 4, "value": 0.9}])
        points = self.clip.envelopes[id(self.parameter)].breakpoints
        # the old value is pinned at both edges of the drawn range, so a jump (two breakpoints at one time) joins old and new
        self.assertEqual(points, [(0.0, 0.1), (2.0, 0.1), (2.0, 0.9), (4.0, 0.9), (4.0, 0.1), (8.0, 0.1)])

    def test_address_errors_are_specific(self):
        self.prepare()
        pts = [{"time": 0, "value": 0.2}]
        self.assertEqual(self.code("draw_automation", clip="tracks/0", parameter=self.parameter_address, points=pts), "INVALID_ARGUMENT")
        self.assertEqual(self.code("draw_automation", clip=self.clip_address, parameter="tracks/0/devices/0", points=pts), "INVALID_ARGUMENT")
        self.assertEqual(self.code("draw_automation", clip=self.clip_address, parameter="tracks/0/devices/0/parameters/99", points=pts), "OUT_OF_RANGE")
        self.assertEqual(self.code("draw_automation", clip="tracks/0/slots/2/clip", parameter=self.parameter_address, points=pts), "OUT_OF_RANGE")

    def test_clear_by_address_one_parameter_or_all(self):
        self.prepare()
        self.ok("draw_automation", clip=self.clip_address, parameter=self.parameter_address, points=[{"time": 0, "value": 0.2}, {"time": 4, "value": 0.6}])
        one = self.ok("clear_automation", clip=self.clip_address, parameter=self.parameter_address)
        self.assertEqual((one["had_envelope"], one["cleared"], one["clip_has_envelopes"]), (True, "Freq", False))
        self.ok("draw_automation", clip=self.clip_address, parameter=self.parameter_address, points=[{"time": 0, "value": 0.2}, {"time": 4, "value": 0.6}])
        all_ = self.ok("clear_automation", clip=self.clip_address)
        self.assertEqual((all_["cleared"], all_["clip_has_envelopes"]), ("all", False))

    def test_get_automation_lists_envelopes_with_breakpoints_in_the_parameters_units(self):
        self.prepare()
        self.clip.automation_envelopes = []
        self.ok("draw_automation", clip=self.clip_address, parameter=self.parameter_address, points=[{"time": 0, "value": 0.2}, {"time": 4, "value": 0.8}, {"time": 6, "value": 0.8}],
                curve="step")
        self.clip.automation_envelopes = [self.clip.envelopes[id(self.parameter)]]
        got = self.ok("get_automation", clip=self.clip_address)
        self.assertEqual((got["clip_length"], got["has_envelopes"], len(got["envelopes"])), (8.0, True, 1))
        env = got["envelopes"][0]
        self.assertEqual((env["parameter"], env["name"], env["min"], env["max"]), (self.parameter_address, "Freq", 0.0, 1.0))
        by_time = dict((b["time"], b) for b in env["breakpoints"])
        self.assertAlmostEqual(by_time[0.0]["value"], 0.2)
        self.assertAlmostEqual(by_time[4.0]["value"], 0.8)
        self.assertAlmostEqual(by_time[4.0]["jump_from"], 0.2)          # a step: the value jumps at beat 4
        one = self.ok("get_automation", clip=self.clip_address, parameter=self.parameter_address)
        self.assertEqual(len(one["envelopes"]), 1)
        none = self.ok("get_automation", clip=self.clip_address, parameter="tracks/0/devices/0/parameters/2")
        self.assertEqual(none["envelopes"], [])
        capped = self.ok("get_automation", clip=self.clip_address, max_points=2)["envelopes"][0]
        self.assertEqual((len(capped["breakpoints"]), capped["truncated"], capped["total_breakpoints"] > 2), (2, True, True))
        self.assertEqual(self.code("get_automation", clip=self.clip_address, max_points=1), "INVALID_ARGUMENT")

    def test_re_enable_automation_for_one_parameter_or_the_whole_song(self):
        self.prepare()
        calls = []
        self.parameter.re_enable_automation = lambda: (calls.append("param"), setattr(self.parameter, "automation_state", 1))
        self.parameter.automation_state = 2
        out = self.ok("device_action", action="re_enable_automation", address=self.parameter_address)
        self.assertEqual((out["automation_state"], calls), (1, ["param"]))
        self.assertEqual(self.code("device_action", action="re_enable_automation", address=self.parameter_address), "UNAVAILABLE")     # no longer overridden
        self.song.re_enable_automation = lambda: calls.append("song")
        self.ok("device_action", action="re_enable_automation", address="song")
        self.assertEqual(calls, ["param", "song"])
        self.assertEqual(self.code("device_action", action="re_enable_automation", address="tracks/0"), "INVALID_ARGUMENT")

    def test_ramps_by_address_replace_and_cancel_each_other_however_the_parameter_was_named(self):
        self.prepare()
        self.ok("ramp_parameter", parameter=self.parameter_address, to=0.9, seconds=5)
        self.ok("ramp_parameter", parameter=self.parameter_address, to=0.1, seconds=5)
        self.assertEqual(len(self.script._ramps), 1)
        cancelled = self.ok("cancel_ramps", parameter=self.parameter_address)
        self.assertEqual((cancelled["cancelled"], cancelled["active_ramps"]), (1, 0))
        self.ok("ramp_parameter", parameter=self.parameter_address, to=0.9, seconds=5)
        self.assertEqual(self.ok("cancel_ramps")["cancelled"], 1)
        self.assertEqual(self.code("ramp_parameter", parameter="tracks/0", to=0.9, seconds=1), "INVALID_ARGUMENT")


# ---------------------------------------------------------------- browser

class FakeBrowserItem(object):
    def __init__(self, name, children=(), uri=None, loadable=False, device=False, folder=None):
        self.name, self.children = name, list(children)
        self.uri = uri or "query:{0}".format(name.replace(" ", ""))
        self.is_loadable, self.is_device = loadable, device
        self.is_folder = bool(self.children) if folder is None else folder


class FakeBrowser(object):
    def __init__(self):
        drift = FakeBrowserItem("Drift", [FakeBrowserItem("Bass", [FakeBrowserItem("Sub Pulse", uri="query:Synths#Drift:Sub", loadable=True),
                                                                  FakeBrowserItem("Deep Wobble", uri="query:Synths#Drift:Wobble", loadable=True)]),
                                          FakeBrowserItem("Lead", [FakeBrowserItem("Glass", uri="query:Synths#Drift:Glass", loadable=True)])],
                                uri="query:Synths#Drift", loadable=True, device=True)
        self.instruments = FakeBrowserItem("Instruments", [drift, FakeBrowserItem("Wavetable", uri="query:Synths#Wavetable", loadable=True, device=True)], uri="query:Synths")
        self.audio_effects = FakeBrowserItem("Audio Effects", [FakeBrowserItem("EQ Eight", uri="query:AudioFx#EQ8", loadable=True, device=True),
                                                               FakeBrowserItem("Utility", uri="query:AudioFx#Utility", loadable=True, device=True)], uri="query:AudioFx")
        self.samples = FakeBrowserItem("Samples", [FakeBrowserItem("Kick 01", uri="query:Samples#Kick01", loadable=True)], uri="query:Samples")
        self.loaded, self.previewed, self.stopped, self.hotswap_target = [], [], 0, None
        self.on_load = None

    def load_item(self, item):
        self.loaded.append((item.name, self.hotswap_target))
        if self.on_load:
            self.on_load(item)

    def preview_item(self, item):
        self.previewed.append(item.name)

    def stop_preview(self):
        self.stopped += 1


class BrowserTests(unittest.TestCase):
    def setUp(self):
        self.script = make_script()
        self.addCleanup(self.script._stop_server)
        song = make_song()
        song.tracks = [DevTrack("Synth"), DevTrack("Vox")]
        song.tracks[0].adopt([DevDevice("Wavetable", dev_type=1)])
        song.tracks[0].clip_slots = [FakeSlot(), FakeSlot()]
        song.view = types.SimpleNamespace(selected_track=None, highlighted_clip_slot=None)
        self.browser = FakeBrowser()
        self.script._c_instance.app.browser = self.browser
        self.script._song = self.song = song

        def load(item):
            track = self.song.view.selected_track
            if item.name == "Kick 01":
                self.song.view.highlighted_clip_slot.clip = PropClip("Kick 01", 1.0)
                self.song.view.highlighted_clip_slot.has_clip = True
            elif self.browser.hotswap_target is not None:
                host = self.browser.hotswap_target.canonical_parent
                index = host.devices.index(self.browser.hotswap_target)
                host.devices[index] = DevDevice(item.name)
                host.devices[index].canonical_parent = host
            else:
                track.insert_device(item.name)
        self.browser.on_load = load

    def run_command(self, name, params):
        return self.script._process_command({"type": name, "params": params})

    def ok(self, command_name, /, **params):
        response = self.run_command(command_name, params)
        self.assertEqual(response["status"], "success", response)
        return response["result"]

    def code(self, command_name, /, **params):
        response = self.run_command(command_name, params)
        self.assertEqual(response["status"], "error", response)
        return response["code"]

    # ---- browse
    def test_no_path_lists_the_roots_that_exist(self):
        roots = self.ok("browse")["roots"]
        self.assertEqual([r["name"] for r in roots], ["instruments", "audio_effects", "samples"])
        self.assertEqual(roots[0]["child_count"], 2)

    def test_browse_lists_children_with_paths_and_flags(self):
        out = self.ok("browse", path="instruments/Drift")
        self.assertEqual((out["path"], out["total"], out["truncated"]), ("instruments/Drift", 2, False))
        self.assertEqual([(i["name"], i["path"], i["has_children"], i["is_loadable"]) for i in out["items"]],
                         [("Bass", "instruments/Drift/Bass", True, False), ("Lead", "instruments/Drift/Lead", True, False)])
        leaf = self.ok("browse", path="instruments/Drift/Bass")["items"]
        self.assertEqual([(i["name"], i["uri"], i["is_loadable"], i["has_children"]) for i in leaf],
                         [("Sub Pulse", "query:Synths#Drift:Sub", True, False), ("Deep Wobble", "query:Synths#Drift:Wobble", True, False)])

    def test_paths_ignore_case_and_are_reported_canonically(self):
        self.assertEqual(self.ok("browse", path="INSTRUMENTS/drift/bass")["path"], "instruments/Drift/Bass")

    def test_paging_and_kind_filters(self):
        first = self.ok("browse", path="instruments", limit=1)
        self.assertEqual((len(first["items"]), first["total"], first["truncated"]), (1, 2, True))
        second = self.ok("browse", path="instruments", limit=1, offset=1)
        self.assertEqual((second["items"][0]["name"], second["truncated"]), ("Wavetable", False))
        self.assertEqual([i["name"] for i in self.ok("browse", path="instruments", kind="folders")["items"]], ["Drift"])
        self.assertEqual([i["name"] for i in self.ok("browse", path="instruments/Drift/Bass", kind="loadable")["items"]], ["Sub Pulse", "Deep Wobble"])
        self.assertEqual([i["name"] for i in self.ok("browse", path="instruments", kind="devices")["items"]], ["Drift", "Wavetable"])

    def test_browse_errors_say_what_exists(self):
        response = self.run_command("browse", {"path": "instruments/Drfit"})
        self.assertEqual(response["code"], "NOT_FOUND")
        self.assertIn("not found in 'instruments'", response["message"])
        self.assertIn("Similar: ['Drift']", self.run_command("browse", {"path": "instruments/rift"})["message"])
        self.assertEqual(self.run_command("browse", {"path": "nothing"})["code"], "NOT_FOUND")
        self.assertIn("Roots: audio_effects, instruments, samples", self.run_command("browse", {"path": "nothing"})["message"])
        for params in ({"path": "instruments", "limit": 0}, {"path": "instruments", "offset": -1}, {"path": "instruments", "kind": "presets"}, {"path": "instruments", "limit": "5"}):
            self.assertEqual(self.run_command("browse", params)["code"], "INVALID_ARGUMENT", params)

    # ---- browser_walk
    def walk_all(self, **params):
        seen, token = [], None
        for _ in range(500):
            response = self.ok("browser_walk", **dict(params, **({"token": token} if token else {})))
            seen.extend(response["items"])
            token = response["token"]
            if response["done"]:
                return seen
        self.fail("the walk never finished")

    def test_a_walk_visits_every_node_of_the_chosen_roots_depth_first_with_paths(self):
        items = self.walk_all(roots=["instruments", "audio_effects"])
        paths = [i["path"] for i in items]
        self.assertEqual(paths[:4], ["instruments", "instruments/Drift", "instruments/Drift/Bass", "instruments/Drift/Bass/Sub Pulse"])
        self.assertIn("audio_effects/EQ Eight", paths)
        self.assertNotIn("samples/Kick 01", paths)
        self.assertEqual(len(paths), len(set(paths)))
        sub = [i for i in items if i["name"] == "Sub Pulse"][0]
        self.assertEqual((sub["uri"], sub["is_loadable"], sub["is_folder"]), ("query:Synths#Drift:Sub", True, False))

    def test_a_walk_is_chunked_by_item_count_and_can_be_resumed(self):
        first = self.ok("browser_walk", roots=["instruments"], max_items=10)
        self.assertEqual(len(first["items"]), 8)                 # the whole small tree fits: 8 nodes
        big = self.ok("browser_walk", roots=["instruments", "audio_effects", "samples"], max_items=10, budget_ms=200)
        self.assertLessEqual(len(big["items"]), 10)
        self.assertFalse(big["done"])
        rest = self.ok("browser_walk", token=big["token"], max_items=100)
        self.assertTrue(rest["done"])
        self.assertEqual(len(big["items"]) + len(rest["items"]), 8 + 3 + 2)

    def test_a_walk_stops_at_the_time_budget(self):
        ticks = iter(range(0, 10000))
        original = mod.clock.now
        mod.clock.now = lambda: next(ticks) * 0.002                          # each read of the clock is 2 ms later
        try:
            partial = self.ok("browser_walk", roots=["instruments"], budget_ms=5)
        finally:
            mod.clock.now = original
        self.assertFalse(partial["done"])
        self.assertLess(len(partial["items"]), 8)
        self.assertGreater(partial["pending"], 0)

    def test_max_depth_limits_the_descent(self):
        items = self.walk_all(roots=["instruments"], max_depth=2)
        self.assertEqual([i["path"] for i in items], ["instruments", "instruments/Drift", "instruments/Wavetable"])

    def test_walk_validation_and_expiry(self):
        for params, code in [({"roots": ["nowhere"]}, "INVALID_ARGUMENT"), ({"roots": "instruments"}, "INVALID_ARGUMENT"), ({"max_depth": 0}, "INVALID_ARGUMENT"),
                             ({"max_depth": 99}, "INVALID_ARGUMENT"), ({"budget_ms": 0}, "INVALID_ARGUMENT"), ({"max_items": 3}, "INVALID_ARGUMENT"),
                             ({"token": "walk-never-issued"}, "NOT_FOUND")]:
            self.assertEqual(self.code("browser_walk", **params), code, params)

    # ---- load_item
    def test_load_a_device_onto_a_track_reports_what_was_added(self):
        out = self.ok("load_item", path="audio_effects/EQ Eight", target="tracks/0")
        self.assertEqual((out["name"], out["target"], out["devices"]), ("EQ Eight", "tracks/0", ["Wavetable", "EQ Eight"]))
        self.assertEqual(out["added"], [{"address": "tracks/0/devices/1", "name": "EQ Eight"}])
        self.assertIs(self.song.view.selected_track, self.song.tracks[0])
        self.assertEqual(self.browser.loaded, [("EQ Eight", None)])

    def test_load_a_sample_into_a_clip_slot(self):
        self.song.tracks[1].clip_slots = [FakeSlot(), FakeSlot()]
        out = self.ok("load_item", path="samples/Kick 01", target="tracks/1/slots/0")
        self.assertEqual((out["has_clip"], out["clip"]), (True, "tracks/1/slots/0/clip"))
        self.assertIs(self.song.view.highlighted_clip_slot, self.song.tracks[1].clip_slots[0])

    def test_hot_swap_replaces_a_device_and_leaves_hot_swap_mode(self):
        out = self.ok("load_item", path="instruments/Wavetable", target="tracks/0/devices/0")
        self.assertEqual((out["hotswapped"], out["devices_before"], out["devices"]), (True, ["Wavetable"], ["Wavetable"]))
        self.assertEqual(self.browser.loaded[-1][1] is not None, True)
        self.assertIsNone(self.browser.hotswap_target)
        self.assertEqual(self.song.tracks[0].devices[0].name, "Wavetable")

    def test_load_by_uri_and_by_path_are_alternatives(self):
        out = self.ok("load_item", uri="query:AudioFx#Utility", target="tracks/1")
        self.assertEqual(out["added"][0]["name"], "Utility")
        self.assertEqual(self.code("load_item", target="tracks/0"), "INVALID_ARGUMENT")
        self.assertEqual(self.code("load_item", path="audio_effects/Utility", uri="query:AudioFx#Utility", target="tracks/0"), "INVALID_ARGUMENT")
        response = self.run_command("load_item", {"uri": "query:Nope", "target": "tracks/0"})
        self.assertEqual(response["code"], "NOT_FOUND")
        self.assertIn("slow", response["message"])

    def test_folders_cannot_be_loaded_and_targets_are_checked(self):
        self.assertEqual(self.code("load_item", path="instruments/Drift/Bass", target="tracks/0"), "INVALID_ARGUMENT")
        self.assertEqual(self.code("load_item", path="audio_effects/EQ Eight", target="song"), "INVALID_ARGUMENT")
        self.assertEqual(self.code("load_item", path="audio_effects/EQ Eight"), "INVALID_ARGUMENT")
        self.assertEqual(self.code("load_item", path="audio_effects/EQ Eight", target="tracks/9"), "OUT_OF_RANGE")
        self.assertEqual(self.browser.loaded, [])

    def test_preview_and_stop_preview(self):
        self.assertEqual(self.ok("load_item", action="preview", path="instruments/Drift/Bass/Sub Pulse")["name"], "Sub Pulse")
        self.assertEqual(self.browser.previewed, ["Sub Pulse"])
        self.ok("load_item", action="stop_preview")
        self.assertEqual(self.browser.stopped, 1)
        self.assertEqual(self.code("load_item", action="rewind"), "INVALID_ARGUMENT")

    def test_loading_is_one_undo_step_and_browsing_is_not(self):
        self.song.undo_log.clear()
        self.ok("browse", path="instruments")
        self.assertEqual(self.song.undo_log, [])
        self.ok("load_item", path="audio_effects/Utility", target="tracks/0")
        self.assertEqual(self.song.undo_log, ["begin", "end"])


# ---------------------------------------------------------------- routing and mixer state

class FakeRoutingType(object):
    def __init__(self, display_name, category):
        self.display_name, self.category = display_name, category


class FakeRoutingChannel(object):
    def __init__(self, display_name, layout=2):
        self.display_name, self.layout = display_name, layout


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.script = make_script()
        self.addCleanup(self.script._stop_server)
        song = make_song()
        self.ext, self.master_out, self.resampling = FakeRoutingType("Ext. In", 0), FakeRoutingType("Master", 3), FakeRoutingType("Resampling", 2)
        self.track_in = FakeRoutingType("2-Bass", 4)
        track = song.tracks[0]
        track.current_monitoring_state = 1
        track.available_input_routing_types = [self.ext, self.resampling, self.master_out, self.track_in]
        track.input_routing_type = self.ext
        track.available_input_routing_channels = [FakeRoutingChannel("1/2"), FakeRoutingChannel("3/4"), FakeRoutingChannel("1", 1)]
        track.input_routing_channel = track.available_input_routing_channels[0]
        track.available_output_routing_types = [self.master_out, FakeRoutingType("Sends Only", 6)]
        track.output_routing_type = self.master_out
        track.available_output_routing_channels = []
        track.output_routing_channel = None
        comp = FakeDevice("Compressor")
        comp.available_input_routing_types = [FakeRoutingType("No Input", 6), FakeRoutingType("1-A", 4)]
        comp.input_routing_type = comp.available_input_routing_types[0]
        comp.available_input_routing_channels = [FakeRoutingChannel("Post FX"), FakeRoutingChannel("Pre FX")]
        comp.input_routing_channel = comp.available_input_routing_channels[0]
        track.devices = [comp]
        self.script._song = self.song = song
        self.track, self.comp = track, comp

    def run_command(self, params):
        return self.script._process_command({"type": "routing", "params": params})

    def ok(self, **params):
        response = self.run_command(params)
        self.assertEqual(response["status"], "success", response)
        return response["result"]

    def code(self, **params):
        response = self.run_command(params)
        self.assertEqual(response["status"], "error", response)
        return response["code"]

    def test_get_describes_the_current_routing_and_what_is_available(self):
        got = self.ok(address="tracks/0", direction="input")
        self.assertEqual(got["type"], {"display_name": "Ext. In", "category": "external"})
        self.assertEqual(got["channel"], {"display_name": "1/2", "layout": "stereo"})
        self.assertEqual([t["display_name"] for t in got["available_types"]], ["Ext. In", "Resampling", "Master", "2-Bass"])
        self.assertEqual([c["layout"] for c in got["available_channels"]], ["stereo", "stereo", "mono"])
        out = self.ok(address="tracks/0", direction="output")
        self.assertEqual((out["type"]["category"], out["channel"], out["available_channels"]), ("master", None, []))

    def test_set_a_type_and_a_channel_by_display_name(self):
        result = self.ok(address="tracks/0", direction="input", action="set", type="2-Bass", channel="3/4")
        self.assertIs(self.track.input_routing_type, self.track_in)
        self.assertEqual(self.track.input_routing_channel.display_name, "3/4")
        self.assertEqual((result["type"]["display_name"], result["channel"]["display_name"], result["from"]), ("2-Bass", "3/4", {"type": "Ext. In", "channel": "1/2"}))
        self.ok(address="tracks/0", direction="input", action="set", channel="1")
        self.assertEqual(self.track.input_routing_channel.display_name, "1")

    def test_unknown_names_list_what_exists_and_change_nothing(self):
        response = self.run_command({"address": "tracks/0", "direction": "input", "action": "set", "type": "Nowhere"})
        self.assertEqual(response["code"], "NOT_FOUND")
        self.assertIn("['Ext. In', 'Resampling', 'Master', '2-Bass']", response["message"])
        self.assertEqual(self.code(address="tracks/0", direction="input", action="set", channel="9/10"), "NOT_FOUND")
        self.assertIs(self.track.input_routing_type, self.ext)

    def test_feedback_prone_input_routing_needs_an_explicit_flag_unless_monitoring_is_off(self):
        for name in ("Resampling", "Master"):
            response = self.run_command({"address": "tracks/0", "direction": "input", "action": "set", "type": name})
            self.assertEqual(response["code"], "GUARD_FAILED", name)
            self.assertIn("allow_feedback", response["message"])
        self.assertIs(self.track.input_routing_type, self.ext)
        self.ok(address="tracks/0", direction="input", action="set", type="Resampling", allow_feedback=True)
        self.assertIs(self.track.input_routing_type, self.resampling)
        self.track.current_monitoring_state = 2
        self.ok(address="tracks/0", direction="input", action="set", type="Master")
        self.assertIs(self.track.input_routing_type, self.master_out)
        self.assertEqual(self.code(address="tracks/0", direction="input", action="set", type="Ext. In", allow_feedback="yes"), "TYPE_ERROR")

    def test_output_routing_is_never_gated(self):
        self.ok(address="tracks/0", direction="output", action="set", type="Sends Only")
        self.assertEqual(self.track.output_routing_type.display_name, "Sends Only")

    def test_a_compressor_side_chain_is_routed_like_a_track(self):
        got = self.ok(address="tracks/0/devices/0", direction="input")
        self.assertEqual(got["type"]["display_name"], "No Input")
        self.ok(address="tracks/0/devices/0", direction="input", action="set", type="1-A", channel="Pre FX")
        self.assertEqual((self.comp.input_routing_type.display_name, self.comp.input_routing_channel.display_name), ("1-A", "Pre FX"))

    def test_validation(self):
        for params, code in [({"address": "tracks/0"}, "INVALID_ARGUMENT"), ({"address": "tracks/0", "direction": "sideways"}, "INVALID_ARGUMENT"),
                             ({"address": "tracks/0", "direction": "input", "action": "toggle"}, "INVALID_ARGUMENT"),
                             ({"address": "tracks/0", "direction": "input", "action": "set"}, "INVALID_ARGUMENT"),
                             ({"address": "tracks/0", "direction": "input", "action": "set", "type": 5}, "TYPE_ERROR"),
                             ({"address": "song", "direction": "input"}, "INVALID_ARGUMENT"), ({"address": "tracks/0/slots/0", "direction": "input"}, "INVALID_ARGUMENT"),
                             ({"address": "master", "direction": "input"}, "UNAVAILABLE"), ({"direction": "input"}, "INVALID_ARGUMENT")]:
            self.assertEqual(self.code(**params), code, params)

    def test_routing_writes_are_one_undo_step(self):
        self.song.undo_log.clear()
        self.ok(address="tracks/0", direction="output", action="set", type="Sends Only")
        self.assertEqual(self.song.undo_log, ["begin", "end"])

    def test_crossfade_assign_and_panning_mode_are_enum_properties_of_tracks(self):
        self.ok_properties("tracks/0", {"crossfade_assign": "B", "panning_mode": "stereo_split"})
        self.assertEqual((self.track.mixer_device.crossfade_assign, self.track.mixer_device.panning_mode), (2, 1))
        got = self.script._process_command({"type": "get_properties", "params": {"address": "tracks/0", "names": ["crossfade_assign", "panning_mode"]}})
        self.assertEqual(got["result"]["properties"], {"crossfade_assign": "B", "panning_mode": "stereo_split"})
        bad = self.script._process_command({"type": "set_properties", "params": {"address": "tracks/0", "properties": {"crossfade_assign": "C"}}})
        self.assertEqual(bad["code"], "INVALID_ARGUMENT")

    def ok_properties(self, address, properties):
        response = self.script._process_command({"type": "set_properties", "params": {"address": address, "properties": properties}})
        self.assertEqual(response["status"], "success", response)


# ---------------------------------------------------------------- generated API registry

class RegistryTests(unittest.TestCase):
    """The curated property table must agree with the registry generated from Live's real API."""

    def setUp(self):
        self.registry = mod.api_registry
        self.specs = mod.properties.PROPERTY_SPECS

    def test_every_curated_property_exists_in_live_with_a_compatible_type(self):
        problems = []
        for kind, specs in self.specs.items():
            live = self.registry.class_properties(self.registry.KIND_CLASSES[kind])
            for name, spec in specs.items():
                if spec["get"]:                       # virtual properties (track volume/panning) are ours
                    continue
                if name not in live:
                    problems.append("{0}.{1}: not in Live's {2}".format(kind, name, self.registry.KIND_CLASSES[kind]))
                    continue
                info = live[name]
                got = self.registry.family(info["get"])
                wanted = {"float": {"float"}, "int": {"int", "object"}, "bool": {"bool"}, "str": {"str", "object"},
                          "list": {"list"}, "enum": {"int", "enum"}, "ref": {"ref"}}[spec["type"]]
                if got not in wanted:
                    problems.append("{0}.{1}: overlay type {2} but Live's getter returns {3}".format(kind, name, spec["type"], info["get"]))
                if spec["rw"] and info["set"] is None:
                    problems.append("{0}.{1}: overlay says writable but Live's property is read-only".format(kind, name))
                if spec["rw"] and info["set"] is not None and spec["type"] != "enum":
                    if self.registry.family(info["set"]) not in (spec["type"], "object"):
                        problems.append("{0}.{1}: overlay type {2} but Live's setter takes {3}".format(kind, name, spec["type"], info["set"]))
        self.assertEqual(problems, [])

    def test_enum_tables_match_what_the_overlay_references(self):
        for kind, specs in self.specs.items():
            for name, spec in specs.items():
                if spec["enum"]:
                    self.assertIn(spec["enum"], self.registry.data()["enums"], "{0}.{1}".format(kind, name))
                    table = self.registry.enum_table(spec["enum"])
                    self.assertGreater(len(table), 1, spec["enum"])

    def test_enum_typed_getters_agree_with_the_overlays_enum(self):
        """Where Live's getter names its enum type (Song.Quantization), the overlay must point at the same enum."""
        for kind, specs in self.specs.items():
            live = self.registry.class_properties(self.registry.KIND_CLASSES[kind])
            for name, spec in specs.items():
                if spec["enum"] and name in live and self.registry.family(live[name]["get"]) == "enum":
                    self.assertEqual("Live." + live[name]["get"], spec["enum"], "{0}.{1}".format(kind, name))

    def test_registry_lists_what_is_not_exposed(self):
        script = make_script()
        self.addCleanup(script._stop_server)
        script._song = make_song()
        listing = script._list_properties(kind="clip")
        self.assertIn("warp_markers", listing["not_exposed"])    # a property we do not expose yet
        self.assertEqual(listing["not_exposed"]["warp_markers"]["writable"], False)
        self.assertNotIn("groove", listing["not_exposed"])       # exposed as a reference
        self.assertNotIn("name", listing["not_exposed"])          # exposed properties are not repeated
        for kind in self.specs:
            self.assertIn("not_exposed", script._list_properties(kind=kind))

    def test_registry_metadata(self):
        self.assertRegex(self.registry.data()["live_version"], r"^12\.")
        for qualname in self.registry.KIND_CLASSES.values():
            self.assertGreaterEqual(len(self.registry.class_properties(qualname)), 2, qualname)

    # ---- sweep: every writable curated property round-trips on fakes generated from the registry
    def make_fake(self, kind, **extra):
        live = self.registry.class_properties(self.registry.KIND_CLASSES[kind])
        types_by_family = {"float": float, "int": int, "bool": bool, "str": str}
        typed = dict((n, types_by_family[self.registry.family(i["set"])]) for n, i in live.items()
                     if i["set"] is not None and self.registry.family(i["set"]) in types_by_family)
        defaults = {"float": 0.0, "int": 0, "bool": False, "str": "", "list": [], "enum": 0, "ref": None, "object": None}
        cls = type(kind.capitalize() + "Fake", (Typed,), {"_types": typed})
        obj = cls()
        for name, info in live.items():
            object.__setattr__(obj, name, defaults[self.registry.family(info["get"])])
        for name, value in extra.items():
            object.__setattr__(obj, name, value)
        return obj

    @staticmethod
    def sample_value(spec):
        kind = spec["type"]
        if kind == "bool":
            return True
        if kind == "str":
            return "sweep"
        if kind == "enum":
            names = mod.properties._enum_names(spec["enum"])
            return sorted(names, key=names.get)[-1]
        if kind == "int":
            low, high = spec["min"], spec["max"]
            return int((low + high) // 2) if low is not None and high is not None else 1
        low, high = spec["min"], spec["max"]
        return (low + high) / 2.0 if low is not None and high is not None else 0.5

    def test_every_writable_property_round_trips_on_registry_generated_fakes(self):
        script = make_script()
        self.addCleanup(script._stop_server)
        clip = self.make_fake("clip")
        slot = self.make_fake("slot", clip=clip, has_clip=True)
        scene = self.make_fake("scene")
        track = self.make_fake("track", clip_slots=[slot], mixer_device=make_mixer())
        master = self.make_fake("track", mixer_device=make_mixer(sends=False))
        groove = self.make_fake("groove")
        cue = self.make_fake("cue")
        parameter = self.make_fake("parameter", is_enabled=True, min=0.0, max=1.0, is_quantized=False)
        on_switch = FakeParam("Device On", 1.0, 0.0, 1.0)
        pad = self.make_fake("pad", note=36)
        chain = self.make_fake("chain", mixer_device=make_mixer(), devices=[])
        device = self.make_fake("device", parameters=[on_switch, parameter], chains=[chain], return_chains=[], drum_pads=[pad],
                                can_have_chains=True, can_have_drum_pads=True, view=types.SimpleNamespace(is_collapsed=False))
        track.devices = [device]
        song = self.make_fake("song", tracks=[track], return_tracks=[], scenes=[scene], master_track=master,
                              groove_pool=types.SimpleNamespace(grooves=[groove]), cue_points=[cue])
        script._song = song
        addresses = {"song": "song", "track": "tracks/0", "scene": "scenes/0", "slot": "tracks/0/slots/0", "clip": "tracks/0/slots/0/clip",
                     "groove": "grooves/0", "cue": "cue_points/0", "app": "app", "device": "tracks/0/devices/0",
                     "chain": "tracks/0/devices/0/chains/0", "pad": "tracks/0/devices/0/drum_pads/36", "parameter": "tracks/0/devices/0/parameters/1"}
        checked = 0
        for kind, specs in self.specs.items():
            for name, spec in sorted(specs.items()):
                if not spec["rw"] or spec["type"] == "ref":       # references are covered by the groove tests; read-only kinds have nothing to write
                    continue
                value = self.sample_value(spec)
                script._set_properties(addresses[kind], {name: value})
                got = script._get_properties(addresses[kind], [name])["properties"][name]
                if spec["type"] == "float":
                    self.assertAlmostEqual(got, value, places=6, msg="{0}.{1}".format(kind, name))
                else:
                    self.assertEqual(got, value, "{0}.{1}".format(kind, name))
                checked += 1
        self.assertGreater(checked, 60)

    def test_generated_fakes_reject_wrong_types_like_boost(self):
        clip = self.make_fake("clip")
        with self.assertRaises(TypeError):
            clip.loop_start = "x"
        with self.assertRaises(TypeError):
            clip.pitch_coarse = 1.5
        clip.velocity_amount = 1                                   # int is accepted for a float property
        clip.muted = 1                                             # so is int for a bool property


# ---------------------------------------------------------------- introspection parsing

class IntrospectTests(unittest.TestCase):
    def test_property_types_come_from_getter_and_setter_signatures(self):
        def fget(self):
            pass

        def fset(self, value):
            pass
        fget.__doc__ = "\nNone( (Clip.Clip)arg1) -> float :\n\n    C++ signature :\n        double None(TPyHandle<AClip>)"
        fset.__doc__ = "\nNone( (Clip.Clip)arg1, (float)arg2) -> None :\n\n    C++ signature :\n        void None(TPyHandle<AClip>,double)"
        record = mod.introspect._property_record(property(fget, fset, doc="Get/Set the loop start.\nMore text."))
        self.assertEqual(record, {"get": "float", "set": "float", "doc": "Get/Set the loop start."})
        readonly = mod.introspect._property_record(property(fget))
        self.assertEqual((readonly["get"], readonly["set"]), ("float", None))

    def test_methods_keep_signatures_and_a_description(self):
        def jump(self):
            pass
        jump.__doc__ = "\njump_by( (Song)arg1, (float)arg2) -> None :\n    Set a new playing pos, relative to the current one.\n\n    C++ signature :\n        void jump_by(TPyHandle<ASong>,double)"
        record = mod.introspect._method_record(jump)
        self.assertEqual(record["signatures"], ["jump_by( (Song)arg1, (float)arg2) -> None"])
        self.assertEqual(record["doc"], "Set a new playing pos, relative to the current one.")

    def test_describe_class_collects_properties_methods_enums_listeners_and_nested_classes(self):
        class Enum(object):
            names = {"a": 0, "b": 1}
            values = {0: "a", 1: "b"}

        class Nested(object):
            width = property(lambda self: 1)

        class Thing(object):
            size = property(lambda self: 1, lambda self, v: None)
            Mode = Enum
            View = Nested

            def fire(self):
                pass

            def add_size_listener(self, fn):
                pass

            def remove_size_listener(self, fn):
                pass

            def size_has_listener(self, fn):
                pass

        record = mod.introspect.describe_class(Thing, "Live.X.Thing")
        self.assertEqual(sorted(record["properties"]), ["size"])
        self.assertEqual(sorted(record["methods"]), ["fire"])
        self.assertEqual(record["listeners"], ["size"])          # add/remove/has_listener collapse into one entry
        self.assertEqual(record["enums"], {"Mode": {"a": 0, "b": 1}})
        self.assertEqual(sorted(record["nested"]["View"]["properties"]), ["width"])
        self.assertEqual(record["qualname"], "Live.X.Thing")

    def test_command_is_registered_and_read_only(self):
        self.assertIn("introspect_api", mod._COMMANDS)
        self.assertFalse(mod._COMMANDS["introspect_api"]["writes"])
        script = make_script()
        self.addCleanup(script._stop_server)
        response = script._process_command({"type": "introspect_api", "params": {"module": "NoSuchModule"}})
        self.assertEqual((response["status"], response["code"]), ("error", "NOT_FOUND"))


# ---------------------------------------------------------------- package hygiene

class PackageTests(unittest.TestCase):
    PACKAGE = os.path.join(ROOT, "remote-script", "AbletonMCP")

    def test_no_module_uses_a_name_it_never_imported_or_defined(self):
        """A verbatim split can lose an import; this catches it without needing Live."""
        import ast
        import builtins
        problems = []
        for filename in sorted(n for n in os.listdir(self.PACKAGE) if n.endswith(".py")):
            with open(os.path.join(self.PACKAGE, filename)) as handle:
                tree = ast.parse(handle.read())
            defined = set(dir(builtins)) | {"__file__", "__name__"}
            for node in ast.walk(tree):
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    defined.update((a.asname or a.name).split(".")[0] for a in node.names)
                elif isinstance(node, (ast.FunctionDef, ast.ClassDef)):
                    defined.add(node.name)
                elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
                    defined.add(node.id)
                elif isinstance(node, ast.ExceptHandler) and node.name:
                    defined.add(node.name)
                elif isinstance(node, ast.arg):
                    defined.add(node.arg)
            for node in ast.walk(tree):
                if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id not in defined:
                    problems.append("{0}:{1} {2}".format(filename, node.lineno, node.id))
        self.assertEqual(problems, [])

    def test_every_command_module_registers_commands_on_import(self):
        for name in ("session", "tracks", "clips", "devices", "automation", "browser"):
            self.assertTrue(hasattr(sys.modules["AbletonMCP." + name], name.capitalize() + "Mixin"), name)
        self.assertGreater(len(mod._COMMANDS), 40)

    def test_settings_are_read_from_config_at_call_time(self):
        with open(os.path.join(self.PACKAGE, "server.py")) as handle:
            source = handle.read()
        for setting in ("MAX_REQUEST_BYTES", "CLIENT_IDLE_SECONDS", "PUMP_INTERVAL_MS", "DEFAULT_PORT"):
            self.assertNotIn(" " + setting, source.replace("config." + setting, ""), setting)

    def test_handshake_reports_version_and_build_id(self):
        script = make_script()
        self.addCleanup(script._stop_server)
        info = script._get_script_info()
        self.assertEqual(info["script_version"], mod.config.SCRIPT_VERSION)
        self.assertRegex(info["build_id"], r"^[0-9a-f]{12}$")
        self.assertEqual(info["build_id"], mod.BUILD_ID)

    def test_build_id_changes_when_a_source_file_changes(self):
        import hashlib
        digest = hashlib.sha1()
        for name in sorted(n for n in os.listdir(self.PACKAGE) if n.endswith((".py", ".json"))):
            with open(os.path.join(self.PACKAGE, name), "rb") as handle:
                digest.update(name.encode("utf-8") + b"\0" + handle.read() + b"\0")
        self.assertEqual(digest.hexdigest()[:12], mod.BUILD_ID)  # the algorithm scripts/deploy.mjs mirrors


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
        original = mod.clock.now
        mod.clock.now = clock.time
        self.addCleanup(setattr, mod.clock, "now", original)
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
        self.assertEqual(self.timer.interval, mod.config.PUMP_INTERVAL_MS)

    def test_read_and_write_commands_round_trip_without_deadlock(self):
        info = self.call("get_script_info")
        self.assertEqual(info["status"], "success")
        self.assertIn("draw_automation", info["result"]["capabilities"])
        self.assertEqual(info["result"]["script_version"], mod.config.SCRIPT_VERSION)
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
        original = mod.config.CLIENT_IDLE_SECONDS
        mod.config.CLIENT_IDLE_SECONDS = 0.05
        self.addCleanup(setattr, mod.config, "CLIENT_IDLE_SECONDS", original)
        sock = self.connect()
        real_time.sleep(0.3)
        sock.settimeout(1)
        self.assertEqual(sock.recv(10), b"")
        sock.close()

    def test_oversized_request_gets_an_error(self):
        original = mod.config.MAX_REQUEST_BYTES
        mod.config.MAX_REQUEST_BYTES = 1000
        self.addCleanup(setattr, mod.config, "MAX_REQUEST_BYTES", original)
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
