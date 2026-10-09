# Live API quirks (proven on Live 12.4.15b4)

Behaviours found against a real Live, not in any documentation. The README records the design; these are the traps.

## Undo
- `begin_undo_step`/`end_undo_step` group a call's edits into one entry, EXCEPT device-parameter writes and track renames, which are always their own entries (a batch with k parameter writes needs k+1 undos). Several begin/end pairs inside one call coalesce into one entry. Empty steps are not recorded.
- Never probe undo or redo from `eval` with several `song.undo()` calls: it can revert the user's earlier work (it happened once and was repaired with `redo()`). Test undo only through the tools, one step at a time, checking state between steps.

## Automation and envelopes
- `Envelope.create_event(EnvelopeEvent(time, value))` makes real linear breakpoints, with values in the parameter's own domain. Control coefficients are ignored, so there are no bezier curves. `events_in_range` returns internal values (gain, for example); use `value_at_time` for parameter units.
- Duplicating a Session clip to the arrangement turns its envelopes into track automation (parameter `automation_state` 1; the copy keeps none).
- A write to a parameter (API `value`, or a ramp) while its Session-clip automation is actually playing sets `automation_state` 2 and `song.re_enable_automation_enabled`; `re_enable_automation` (parameter or song) returns it to 1. `automation_state` turns 1 when the clip is *triggered*, up to a launch-quantization wait before it plays, and a write in that window is lost when the clip takes over: wait for `is_playing` and not `is_triggered`.
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
- `Browser.user_folders`, `legacy_libraries` and `colors` are item lists, not items with `children`: wrap them as roots. `user_folders` (uri `userfolder:/path`) holds the sidebar folders, whose samples load like any; `colors` holds the collections (Favorites). `load_item` also opens the Browser panel (`Application.View.hide_view('Browser')` closes it).
- Root items report `is_folder` False but have children; descend by `children`. Roughly 25 nodes per millisecond; `iter_children` exists. `samples` has 20k+ top-level children: never index it by default.

## Launching and duplicating
- `ClipSlot`/`Scene.set_fire_button_state(bool)` is the button itself. Gate clip: press plays, release stops; toggle: a press toggles; trigger and repeat: release changes nothing. `fire()` on a gate clip is never released (`set_fire_button_state(False)` still stops it). A pressed gate clip reads `is_playing` after ~30 ms while `playing_status` still says `stopped`.
- `ClipSlot.stop()` and `Clip.stop()` always wait for the global launch quantization (the next bar), whatever the clip's `launch_quantization`. `Track.stop_all_clips(False)` stops in 14 to 21 ms; `launch` uses it when the slot's clip is the one playing.
- A launch result read right after the call shows the old state: re-read. `Clip.launch_quantization` takes `ClipLaunchQuantization` names (`q_none`), `launch`'s `quantization` the `Song.Quantization` names (`q_no_q`).
- `ClipSlot.duplicate_clip_to(target)` replaces an occupied target silently; it raises `Incompatible track types for clip duplication` or `Cannot duplicate from empty clip slot.`.
- Not exposed, as nothing observable differs: `Scene.fire_as_selected()` (same as `fire`), `Song.scrub_by` (same as `jump_by`; neither stops playback). `Song.play_selection()` needs an Arrangement time selection the API cannot make (untried).

## Drum Rack chains and CC Control
- Drum Rack chains are `DrumChain`: `choke_group` 0-16, `in_note` and `out_note` 0-127 (Live refuses others). A chain belongs to the pad its `in_note` names: changing it moves the chain and empties `drum_pads/<old>`, so address it by `chains/name:...` meanwhile.
- CC Control (`CcControlDevice`): 12 knob targets and 1 button target, each an index into 120 controller names ("None", "1: Modulation Wheel", ...); the button defaults to "64: Sustain Pedal".

## Views and selection
- Creating a track, inserting a device or loading an item selects it, so any run moves the user's selection; `Song.View` reads and restores it.
- `view.selected_chain` is the highlighted chain of the *selected device* (null unless a rack); a rack's `device.view.selected_chain` is separate. `Song.View` has no selected-device getter: read the selected track's `view.selected_device`. `select_device` also selects its track and appoints the device.
- `detail_clip` takes a Session or arrangement clip and switches the Detail pane to its Clip tab; only `Application.View.show_view('Detail/DeviceChain')` switches back. It once read null after a batch of view writes (not reproduced): read it right after writing.
- `focus_view('Arranger' | 'Session')` is immediate. `Track.View.device_insert_mode` reads a bool but its setter takes an int: unexposed. A Simpler without a sample raises on `selected_slice` and reads -1 for `sample_*`.

## Parameters and stored data
- `DeviceParameter.display_value` (read/write float) is an exact inverse of `str_for_value` in the display's base unit: Hz ("1.50 kHz" is 1500), **ms** for times, dB, %, ratios ("4.00 : 1" is 4), the index for a quantized parameter, -50..50 for a pan. Dry/Wet 35 lands on 0.35, where the bisection gives 0.345. Traps: out of range **clamps silently**, `-inf` sets the **maximum** (a fader went to +6 dB; use `parameter.min`), a string raises. A fast path would need a range check, `-inf` handling and a `str_for_value` verify; the bisection stays.
- `Song` and `Track` (not Clip, Scene, Device) have `set_data`/`get_data`: string keys; str, int, float, bool, list, dict and None round-trip within a session, 100 KB is accepted. Persistence across save and reload is documented by Live but untested.

## Types and devices
- Inserting an instrument on an empty MIDI track arms it (`arm`, `implicit_arm`), which changes its hash and the fingerprint; Live's exclusive arm also disarms the user's other armed tracks when a new instrument track appears.
- Boost setters are strict (int properties reject floats). Non-applicable attributes raise `RuntimeError`, not `AttributeError`, so `hasattr` can raise: use try/except (`_safe_attr`).
- The master track has input routing. `Track.insert_device` accepts native device names, and a chain holds one instrument.
- Rack variations: `store_variation` does not select the new variation; `delete_selected_variation` and `recall_selected_variation` silently do nothing when none is selected.

## Recording
- `song.record_mode = True` (arrangement recording) starts the transport by itself, even when the caller does not ask for playback, and records every playing Session clip onto its own track's timeline, armed or not; the clips appear when recording stops. Sets that show Session clips as playing while the transport is stopped are affected too.
- `song.trigger_session_record(length)` records into the armed track's slot of the SELECTED scene (not slot 0), begins at the next launch-quantization boundary (`session_record` reads false until then), rounds the clip up to that quantization (two beats came out as one 4-beat bar), and starts playing the new clip when it stops.
- Recording flags (`record_mode`, `session_record`, overdub, punch, automation record) take effect a moment after the call that set them: a read-back in the same call shows the old value.
