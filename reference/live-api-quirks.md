# Live API quirks (proven on Live 12.4.15b4)

Behaviours found against a real Live, not in any documentation. The README records the design; these are the traps.

## Undo
- `begin_undo_step`/`end_undo_step` group a call's edits into one entry, EXCEPT device-parameter writes and track renames, which are always their own entries (a batch with k parameter writes needs k+1 undos). Several begin/end pairs inside one call coalesce into one entry. Empty steps are not recorded.
- Never probe undo or redo from `eval` with several `song.undo()` calls: it can revert the user's earlier work (it happened once and was repaired with `redo()`). Test undo only through the tools, one step at a time, checking state between steps.

## Automation and envelopes
- `Envelope.create_event(EnvelopeEvent(time, value))` makes real linear breakpoints, with values in the parameter's own domain. Control coefficients are ignored, so there are no bezier curves. `events_in_range` returns internal values (gain, for example); use `value_at_time` for parameter units.
- Duplicating a Session clip to the arrangement turns its envelopes into track automation (parameter `automation_state` 1; the copy keeps none).
- A write to a parameter (API `value`, or a ramp) while its Session-clip automation is actually playing sets `automation_state` 2 and `song.re_enable_automation_enabled`; `re_enable_automation` (parameter or song) returns it to 1. A write before the clip has taken over (state still 0, up to a launch-quantization wait) is not an override. `quantized: false` still waited about a bar for takeover, so poll `automation_state` for 1.
- Session-clip envelopes on mixer volume or pan sweep the track while the clip plays, and a stop at the loop end can leave them at the envelope's end values. Clear any envelope you draw on a clip that a later step may launch.

## Transport and time
- `song.current_song_time` jumps back when the arrangement loop wraps or the user relocates; Session clips keep their `playing_position` through it. Time anything about a playing Session clip from its own position, never from song time.
- A stopped transport applies a newly set `current_song_time` a moment late (the immediate read-back is stale), and setting it beyond `song_length` raises. Starting and then stopping the transport (a clip launch starts it) leaves the playhead at 0 instead of where it was, so restore it if the run began stopped.
- `song.set_or_delete_cue` toggles at the arrangement insert marker (UI state) while stopped; `current_song_time` and `start_time` do not steer it. Cue points therefore cannot be created or deleted at a chosen time. Reading, renaming, jumping and `transport toggle_cue` work.

## Clips, notes, audio
- Same-pitch note overlaps are trimmed (the earlier note is cut short) and the same start replaces. `apply_note_modifications` needs the MidiNoteVector from `get_notes_by_id`, not a list.
- `WarpMarker(sample_time_seconds, beat_time)` takes the sample time first; a dict is rejected; unwarped clips refuse markers.
- Conversions (`audio_to_midi_clip`) finish in the background: the new track appears after the call returns.

## Browser
- Root items report `is_folder` False but have children; descend by `children`. Roughly 25 nodes per millisecond; `iter_children` exists. `samples` has 20k+ top-level children: never index it by default.

## Types and devices
- Boost setters are strict (int properties reject floats). Non-applicable attributes raise `RuntimeError`, not `AttributeError`, so `hasattr` can raise: use try/except (`_safe_attr`).
- The master track has input routing. `Track.insert_device` accepts native device names, and a chain holds one instrument.
- Rack variations: `store_variation` does not select the new variation; `delete_selected_variation` and `recall_selected_variation` silently do nothing when none is selected.
