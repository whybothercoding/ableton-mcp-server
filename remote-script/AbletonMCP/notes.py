"""MIDI notes through Live's extended note API: stable note ids, probability, velocity deviation, release velocity.

Reading returns every field plus the id; writing validates every note before anything is touched (Live's own messages for
a bad value are terse and arrive halfway through a batch). Modifying existing notes goes through apply_note_modifications,
which keeps per-note events; replacing content is one command so a failure cannot leave the clip half-written.

Live never lets notes of one pitch overlap: a new note shortens an earlier note that runs into it (that note ends where
the new one starts), and a note starting at exactly the same time as an existing one of that pitch replaces it. So the
number of notes after a write can be lower than the number written, and durations can change. Results report the real count.
"""
import Live

from .helpers import _is_number
from .registry import BridgeError, command

MAX_NOTES = 5000
DEFAULT_LIMIT = 2000
# Live's accepted ranges (probed on 12.4): velocity 1..127, probability 0..1, deviation -127..127, release velocity 0..127
NOTE_FIELDS = {
    "pitch": {"type": "int", "min": 0, "max": 127},
    "start_time": {"type": "float"},
    "duration": {"type": "float", "above": 0.0},
    "velocity": {"type": "float", "min": 1.0, "max": 127.0},
    "mute": {"type": "bool"},
    "probability": {"type": "float", "min": 0.0, "max": 1.0},
    "velocity_deviation": {"type": "float", "min": -127.0, "max": 127.0},
    "release_velocity": {"type": "float", "min": 0.0, "max": 127.0},
}
REQUIRED_ON_ADD = ("pitch", "start_time", "duration")
DEFAULTS = {"velocity": 100.0, "mute": False, "probability": 1.0, "velocity_deviation": 0.0, "release_velocity": 64.0}
EDIT_ACTIONS = ("replace", "modify", "remove", "duplicate", "duplicate_region", "select")
# "everything" for the range-taking calls: notes may sit before the clip start or after its end
_ALL_TIME_START, _ALL_TIME_SPAN = -1.0e5, 2.0e5


def _field(label, name, value):
    """Validate and coerce one note field."""
    rule = NOTE_FIELDS[name]
    where = "{0}{1}".format(label + ": " if label else "", name)
    if rule["type"] == "bool":
        if not isinstance(value, bool):
            raise BridgeError("{0} must be true or false".format(where), "TYPE_ERROR")
        return value
    if rule["type"] == "int":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
            raise BridgeError("{0} must be a whole number".format(where), "TYPE_ERROR")
        value = int(value)
    else:
        if not _is_number(value):
            raise BridgeError("{0} must be a number".format(where), "TYPE_ERROR")
        value = float(value)
    if "above" in rule and not value > rule["above"]:
        raise BridgeError("{0} must be greater than {1:g}".format(where, rule["above"]), "OUT_OF_RANGE")
    if "min" in rule and (value < rule["min"] or value > rule["max"]):
        raise BridgeError("{0} {1:g} is outside {2:g} to {3:g}".format(where, value, rule["min"], rule["max"]), "OUT_OF_RANGE")
    return value


def _note_spec(label, note, require_all):
    """A validated dict of note fields from caller input (defaults applied when require_all)."""
    if not isinstance(note, dict):
        raise BridgeError("{0} must be an object with pitch, start_time and duration".format(label), "TYPE_ERROR")
    unknown = sorted(set(note) - set(NOTE_FIELDS) - {"id"})
    if unknown:
        raise BridgeError("{0}: unknown note fields {1}. Valid: {2}".format(label, unknown, sorted(NOTE_FIELDS)), "INVALID_ARGUMENT")
    if require_all:
        missing = [name for name in REQUIRED_ON_ADD if name not in note]
        if missing:
            raise BridgeError("{0}: missing {1}".format(label, ", ".join(missing)), "INVALID_ARGUMENT")
    values = dict((name, _field(label, name, value)) for name, value in note.items() if name != "id")
    if require_all:
        for name, default in DEFAULTS.items():
            values.setdefault(name, default)
    return values


def _note_dict(note):
    return {"id": note.note_id, "pitch": note.pitch, "start_time": note.start_time, "duration": note.duration,
            "velocity": note.velocity, "mute": bool(note.mute), "probability": note.probability,
            "velocity_deviation": note.velocity_deviation, "release_velocity": note.release_velocity}


def _sorted(notes):
    return sorted((_note_dict(n) for n in notes), key=lambda n: (n["start_time"], n["pitch"], n["id"]))


def _spec_of(note):
    """A MidiNoteSpecification from a note as read (used to restore notes after a failed replace)."""
    return Live.Clip.MidiNoteSpecification(pitch=note.pitch, start_time=note.start_time, duration=note.duration,
                                           velocity=note.velocity, mute=bool(note.mute), probability=note.probability,
                                           velocity_deviation=note.velocity_deviation, release_velocity=note.release_velocity)


def _new_spec(values):
    return Live.Clip.MidiNoteSpecification(**values)


class NotesMixin(object):
    """get_notes, write_notes, edit_notes."""

    def _midi_clip(self, params):
        kind, clip, canonical = self._resolve(params.get("address"))
        if kind != "clip":
            raise BridgeError("address must be a clip (tracks/N/slots/M/clip), got '{0}'".format(canonical), "INVALID_ARGUMENT")
        if not clip.is_midi_clip:
            raise BridgeError("'{0}' is an audio clip: notes exist only in MIDI clips".format(canonical), "INVALID_ARGUMENT")
        return clip, canonical

    @staticmethod
    def _note_ids(value, clip, label="ids"):
        """A validated list of note ids that all exist in the clip."""
        if not isinstance(value, list) or not value:
            raise BridgeError("{0} must be a non-empty list of note ids".format(label), "INVALID_ARGUMENT")
        if len(value) > MAX_NOTES:
            raise BridgeError("At most {0} notes per call ({1} given)".format(MAX_NOTES, len(value)), "INVALID_ARGUMENT")
        if any(isinstance(i, bool) or not isinstance(i, int) for i in value):
            raise BridgeError("{0} must be whole numbers (the id of each note as get_notes returns it)".format(label), "TYPE_ERROR")
        present = set(n.note_id for n in clip.get_all_notes_extended())
        missing = sorted(set(value) - present)
        if missing:
            raise BridgeError("No notes with ids {0} in this clip: they were removed or the clip changed. "
                              "Read the notes again.".format(missing), "NOT_FOUND")
        return list(dict.fromkeys(value))

    @staticmethod
    def _note_range(params):
        """(from_pitch, pitch_span, from_time, time_span) if the caller gave any range, else None."""
        names = ("from_pitch", "pitch_span", "from_time", "time_span")
        if not any(params.get(n) is not None for n in names):
            return None
        for name in names:
            value = params.get(name)
            if value is not None and not _is_number(value):
                raise BridgeError("{0} must be a number".format(name), "TYPE_ERROR")
        from_pitch, pitch_span = params.get("from_pitch"), params.get("pitch_span")
        from_time, time_span = params.get("from_time"), params.get("time_span")
        if time_span is not None and time_span <= 0 or pitch_span is not None and pitch_span <= 0:
            raise BridgeError("time_span and pitch_span must be greater than 0", "INVALID_ARGUMENT")
        return (int(from_pitch) if from_pitch is not None else 0, int(pitch_span) if pitch_span is not None else 128,
                float(from_time) if from_time is not None else _ALL_TIME_START,
                float(time_span) if time_span is not None else _ALL_TIME_SPAN)

    @staticmethod
    def _clip_summary(clip):
        return {"length": clip.length, "loop_start": clip.loop_start, "loop_end": clip.loop_end}

    # ---- get_notes

    @command("get_notes")
    def _cmd_get_notes(self, params):
        clip, canonical = self._midi_clip(params)
        limit = params.get("limit", DEFAULT_LIMIT)
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
            raise BridgeError("limit must be a whole number from 1", "INVALID_ARGUMENT")
        ids, note_range = params.get("ids"), self._note_range(params)
        if ids is not None:
            notes = clip.get_notes_by_id(self._note_ids(ids, clip))
        elif params.get("selected"):
            notes = clip.get_selected_notes_extended()
        elif note_range is not None:
            notes = clip.get_notes_extended(*note_range)
        else:
            notes = clip.get_all_notes_extended()
        listed = _sorted(notes)
        return {"address": canonical, "count": len(listed), "truncated": len(listed) > limit, "notes": listed[:limit],
                "clip": self._clip_summary(clip)}

    # ---- write_notes

    @command("write_notes", writes=True)
    def _cmd_write_notes(self, params):
        clip, canonical = self._midi_clip(params)
        self._guard(clip, params.get("expect"), canonical)
        notes = params.get("notes")
        if not isinstance(notes, list) or not notes:
            raise BridgeError("notes must be a non-empty list of {pitch, start_time, duration, ...}", "INVALID_ARGUMENT")
        if len(notes) > MAX_NOTES:
            raise BridgeError("At most {0} notes per call ({1} given)".format(MAX_NOTES, len(notes)), "INVALID_ARGUMENT")
        specs = [_new_spec(_note_spec("notes[{0}]".format(i), n, True)) for i, n in enumerate(notes)]
        ids = list(clip.add_new_notes(tuple(specs)))
        return {"address": canonical, "written": len(ids), "ids": ids, "note_count": len(clip.get_all_notes_extended()),
                "clip": self._clip_summary(clip)}

    # ---- edit_notes

    @command("edit_notes", writes=True, destructive=True)
    def _cmd_edit_notes(self, params):
        action = params.get("action")
        if action not in EDIT_ACTIONS:
            raise BridgeError("action must be one of: {0}".format(", ".join(EDIT_ACTIONS)), "INVALID_ARGUMENT")
        clip, canonical = self._midi_clip(params)
        self._guard(clip, params.get("expect"), canonical)
        result = getattr(self, "_edit_" + action)(clip, params)
        result.update({"address": canonical, "action": action, "note_count": len(clip.get_all_notes_extended()),
                       "clip": self._clip_summary(clip)})
        return result

    def _edit_replace(self, clip, params):
        """Replace the notes in a range (everything when no range is given) with `notes`; all or nothing."""
        notes = params.get("notes", [])
        if not isinstance(notes, list) or len(notes) > MAX_NOTES:
            raise BridgeError("notes must be a list of at most {0} notes".format(MAX_NOTES), "INVALID_ARGUMENT")
        specs = [_new_spec(_note_spec("notes[{0}]".format(i), n, True)) for i, n in enumerate(notes)]
        note_range = self._note_range(params) or (0, 128, _ALL_TIME_START, _ALL_TIME_SPAN)
        old = list(clip.get_notes_extended(*note_range))
        if old:
            clip.remove_notes_by_id([n.note_id for n in old])
        try:
            ids = list(clip.add_new_notes(tuple(specs))) if specs else []
        except Exception:
            if old:
                clip.add_new_notes(tuple(_spec_of(n) for n in old))
            raise
        return {"removed": len(old), "written": len(ids), "ids": ids}

    def _edit_modify(self, clip, params):
        """Change fields of existing notes by id; per-note events (MPE) are kept."""
        changes, ids, uniform = params.get("changes"), params.get("ids"), params.get("set")
        wanted = {}
        if changes is not None:
            if ids is not None or uniform is not None:
                raise BridgeError("modify takes either `changes` or `ids` with `set`, not both", "INVALID_ARGUMENT")
            if not isinstance(changes, list) or not changes:
                raise BridgeError("changes must be a non-empty list of {id, <fields to change>}", "INVALID_ARGUMENT")
            for i, change in enumerate(changes):
                label = "changes[{0}]".format(i)
                if not isinstance(change, dict) or "id" not in change:
                    raise BridgeError("{0} needs the note's id".format(label), "INVALID_ARGUMENT")
                if isinstance(change["id"], bool) or not isinstance(change["id"], int):
                    raise BridgeError("{0}: id must be a whole number (the id get_notes returns)".format(label), "TYPE_ERROR")
                fields = _note_spec(label, change, False)
                if not fields:
                    raise BridgeError("{0} changes nothing: give at least one field".format(label), "INVALID_ARGUMENT")
                if change["id"] in wanted:
                    raise BridgeError("{0}: note {1} appears twice".format(label, change["id"]), "INVALID_ARGUMENT")
                wanted[change["id"]] = fields
            self._note_ids(list(wanted), clip, "changes")
        else:
            if not isinstance(uniform, dict) or not uniform:
                raise BridgeError("modify needs `changes`, or `ids` with `set`: {field: value}", "INVALID_ARGUMENT")
            fields = _note_spec("set", uniform, False)
            wanted = dict((i, fields) for i in self._note_ids(ids, clip))
        vector = clip.get_notes_by_id(list(wanted))
        for note in vector:
            for name, value in wanted[note.note_id].items():
                setattr(note, name, value)
        clip.apply_note_modifications(vector)
        return {"modified": len(wanted), "notes": _sorted(clip.get_notes_by_id(list(wanted)))}

    def _edit_remove(self, clip, params):
        ids, note_range, everything = params.get("ids"), self._note_range(params), params.get("all")
        chosen = [x for x in (ids is not None, note_range is not None, everything is True) if x]
        if len(chosen) != 1:
            raise BridgeError("remove needs exactly one of: `ids`, a range (from_time/time_span/from_pitch/pitch_span) "
                              "or all: true", "INVALID_ARGUMENT")
        if ids is not None:
            doomed = self._note_ids(ids, clip)
        else:
            doomed = [n.note_id for n in (clip.get_notes_extended(*note_range) if note_range else clip.get_all_notes_extended())]
        if doomed:
            clip.remove_notes_by_id(doomed)
        return {"removed": len(doomed)}

    def _edit_duplicate(self, clip, params):
        ids = self._note_ids(params.get("ids"), clip)
        destination, transposition = params.get("destination_time"), params.get("transposition", 0)
        if destination is not None and not _is_number(destination):
            raise BridgeError("destination_time must be a number of beats", "TYPE_ERROR")
        if isinstance(transposition, bool) or not isinstance(transposition, int):
            raise BridgeError("transposition must be a whole number of semitones", "TYPE_ERROR")
        new_ids = list(clip.duplicate_notes_by_id(ids, None if destination is None else float(destination), transposition))
        return {"duplicated": len(new_ids), "ids": new_ids}

    def _edit_duplicate_region(self, clip, params):
        start, length, destination = params.get("start"), params.get("length"), params.get("destination_time")
        if not all(_is_number(v) for v in (start, length, destination)):
            raise BridgeError("duplicate_region needs start, length and destination_time (beats)", "INVALID_ARGUMENT")
        if length <= 0:
            raise BridgeError("length must be greater than 0", "INVALID_ARGUMENT")
        pitch, transposition = params.get("pitch", -1), params.get("transposition", 0)
        if isinstance(pitch, bool) or not isinstance(pitch, int) or not -1 <= pitch <= 127:
            raise BridgeError("pitch must be -1 (all pitches) or a MIDI note number 0 to 127", "INVALID_ARGUMENT")
        if isinstance(transposition, bool) or not isinstance(transposition, int):
            raise BridgeError("transposition must be a whole number of semitones", "TYPE_ERROR")
        before = set(n.note_id for n in clip.get_all_notes_extended())
        clip.duplicate_region(float(start), float(length), float(destination), pitch, transposition)
        created = [n for n in clip.get_all_notes_extended() if n.note_id not in before]
        return {"duplicated": len(created), "ids": sorted(n.note_id for n in created)}

    def _edit_select(self, clip, params):
        ids, everything, none = params.get("ids"), params.get("all"), params.get("none")
        if [ids is not None, everything is True, none is True].count(True) != 1:
            raise BridgeError("select needs exactly one of: `ids`, all: true, none: true", "INVALID_ARGUMENT")
        if ids is not None:
            clip.select_notes_by_id(self._note_ids(ids, clip))
        elif everything is True:
            clip.select_all_notes()
        else:
            clip.deselect_all_notes()
        return {"selected": sorted(n.note_id for n in clip.get_selected_notes_extended())}
