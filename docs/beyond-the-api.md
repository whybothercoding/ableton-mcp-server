# Beyond Live's Python API: verdicts

What Live 12.4's Python API cannot do, what this server does about it, and what was tried. Each item had a time-boxed spike with a
go/no-go decision. Re-check after Live updates (`npm run test:drift` shows what changed in the API).

| Feature | Verdict | How |
| --- | --- | --- |
| Clip / scene follow actions | **GO, built** | `follow_actions`: an engine on the Remote Script's 10 ms timer launches the next clip when a clip has played its configured length. Proven in Live: three clips chain 0, 1, 2, 0, ... with every new pass starting within about 30 ms of the boundary. In-memory only (lost on Live restart). |
| Arrangement automation | **GO, built** | Draw on a Session clip, then `clip_action to_arrangement`: Live turns the envelopes into the track's arrangement automation (the copy keeps none; the parameters' `automation_state` becomes 1). |
| Curved automation segments | **NO-GO** | `EnvelopeEvent` accepts control coefficients but Live ignores them on `create_event`. Curves are approximated with breakpoints (straight lines between them), which is smooth and light. |
| Bounce / freeze / flatten / consolidate* | **GO in principle, not built** | Route a scratch audio track's input from the source track (`routing`) and record it (`record`, gated) into a slot, then optionally delete the helper. It records a real file into the project's Samples/Recorded folder, so it should only run with the owner's consent; the pieces (`routing`, `record`, `launch`, `create audio_track`) are all there. |
| Stem separation | **Blocked on bounce** | Needs a rendered file; run an external separator on the bounced clip's `file_path`. |
| Export / render the Set | **NO-GO** | Nothing in the API (`Song.file_path` is read-only). |
| Save the Set | **NO-GO** | Not in the API. |
| Group / ungroup tracks, reorder tracks | **NO-GO** | Not in the API; only OS-level UI automation could, which is out of scope. |
| MIDI clock, MTC, MIDI/key mapping, Preferences | **NO-GO** | Not in the API. |
| Splitting, moving or resizing arrangement clips, comp editing | **NO-GO** | Not in the API (create, duplicate and delete exist). |
| Arrangement tempo / time-signature automation | **NO-GO** | Not in the API. |
| MPE per-note data | **NO-GO** | `apply_note_modifications` preserves it but it cannot be read or written. |
| Browser search | **GO, built** | `browse search` over an index the MCP server builds with the chunked `browser_walk`. |
| Create / delete a cue point at a chosen time | **NO-GO** | `Song.set_or_delete_cue` toggles at the arrangement insert marker, which is UI state: setting `current_song_time` (refused beyond the song length, and ignored by the toggle while stopped) does not move it, so a cue lands wherever the user last clicked. Reading, renaming and jumping to cue points works; a first attempt to create them by moving the playhead put a stray cue at the wrong place in a real Set. |
| Groove pool contents | **NO-GO** | Existing grooves can be assigned and edited, but none can be added through the API. |
| A Max for Live helper device as a second bridge | **Deferred** | Would reach Live Object Model corners the Python API lacks; large, and only worth it for a concrete missing feature. |

\* Not built yet. Planned for after the rest of the project is complete.
