# Beyond Live's Python API: verdicts

What Live 12.4's Python API cannot do, what this server does about it, and what was tried. Each item had a time-boxed spike with a
go/no-go decision. Re-check after Live updates (`npm run test:drift` shows what changed in the API).

| Feature | Verdict | How |
| --- | --- | --- |
| Clip / scene follow actions | **GO, built** | `follow_actions`: an engine on the Remote Script's 10 ms timer launches the next clip when a clip has played its configured length. Proven in Live: three clips chain 0, 1, 2, 0, ... with every new pass starting within about 30 ms of the boundary. In-memory only (lost on Live restart). |
| Arrangement automation | **GO, built** | Draw on a Session clip, then `clip_action to_arrangement`: Live turns the envelopes into the track's arrangement automation (the copy keeps none; the parameters' `automation_state` becomes 1). |
| Curved automation segments | **NO-GO** | `EnvelopeEvent` accepts control coefficients but Live ignores them on `create_event`. Curves are approximated with breakpoints (straight lines between them), which is smooth and light. |
| Bounce (record what a track or the main output plays) | **GO, built** | `bounce`: a scratch audio track (`MCP BOUNCE`) takes its input from the source (`routing`), records into its own empty first slot and the clip is analyzed; `keep_track` leaves the recording in place. It writes a real file into the project's Samples/Recorded folder, is audible, and needs `confirm_playback: true`. |
| Freeze / flatten / consolidate as Live does them | **NO-GO** | No method in the API (`can_be_frozen` and `is_frozen` are read-only). `bounce` with `keep_track` is the substitute: it leaves rendered audio on a track. |
| Stem separation | **Unblocked, not built** | `bounce` with `keep_track` leaves a rendered clip; run an external separator on its `file_path`. |
| Export / render the Set | **NO-GO** | Nothing in the API (`Song.file_path` is read-only). |
| Save the Set | **NO-GO** | Not in the API. |
| Group / ungroup tracks, reorder tracks | **NO-GO** | Not in the API; only OS-level UI automation could, which is out of scope. |
| Showing, hiding, zooming and scrolling panels | **GO, not built** | `Application.View` has `show_view`, `hide_view`, `zoom_view`, `scroll_view` and `toggle_browse`; only bringing Session or Arranger forward is exposed (`app/view`). The Detail pane's Clip / Device Chain tab is one of them. |
| MIDI clock, MTC, key mapping, Preferences | **NO-GO** | Not in the API. |
| MIDI CC / note mapping onto parameters | **Conditional, untested** | `Live.MidiMap` (`map_midi_cc`, `map_midi_note`, `forward_midi_*`) is in the API dump, but its functions take a `midi_map_handle` that Live passes only to a control surface's `build_midi_map`, which this script does not define, and it maps the MIDI input assigned to the surface (the install steps set Input to None). Worth a spike only to bind a hardware controller through the MCP. |
| Splitting, moving or resizing arrangement clips, comp editing | **NO-GO** | Not in the API (create, duplicate and delete exist). |
| Arrangement tempo / time-signature automation | **NO-GO** | Not in the API. |
| MPE per-note data | **NO-GO** | `apply_note_modifications` preserves it but it cannot be read or written. |
| Browser search | **GO, built** | `browse search` over an index the MCP server builds with the chunked `browser_walk`. |
| Create / delete a cue point at a chosen time | **NO-GO** | `Song.set_or_delete_cue` toggles at the arrangement insert marker, which is UI state: setting `current_song_time` (refused beyond the song length, and ignored by the toggle while stopped) does not move it, so a cue lands wherever the user last clicked. Reading, renaming and jumping to cue points works; a first attempt to create them by moving the playhead put a stray cue at the wrong place in a real Set. |
| Groove pool contents | **NO-GO** | Existing grooves can be assigned and edited, but none can be added through the API. |
| A Max for Live helper device as a second bridge | **Deferred** | Would reach Live Object Model corners the Python API lacks; large, and only worth it for a concrete missing feature. |
