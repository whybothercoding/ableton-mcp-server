"""Session clip and MIDI note commands."""

import Live
from .registry import command


class ClipsMixin(object):
    """Session clip and MIDI note commands."""

    @command("get_audio_clip_path")
    def _cmd_get_audio_clip_path(self, params):
        return self._get_audio_clip_path(params.get("track_index", 0), params.get("clip_index", 0), params.get("source", "session"))

    @command("get_clip_notes")
    def _cmd_get_clip_notes(self, params):
        return self._get_clip_notes(params.get("track_index", 0), params.get("clip_index", 0))

    @command("create_clip", writes=True)
    def _cmd_create_clip(self, params):
        return self._create_clip(params.get("track_index", 0), params.get("clip_index", 0), params.get("length", 4.0))

    @command("add_notes_to_clip", writes=True)
    def _cmd_add_notes_to_clip(self, params):
        return self._add_notes_to_clip(params.get("track_index", 0), params.get("clip_index", 0), params.get("notes", []))

    @command("set_clip_name", writes=True)
    def _cmd_set_clip_name(self, params):
        return self._set_clip_name(params.get("track_index", 0), params.get("clip_index", 0), params.get("name", ""))

    @command("fire_clip", writes=True)
    def _cmd_fire_clip(self, params):
        return self._fire_clip(params.get("track_index", 0), params.get("clip_index", 0))

    @command("stop_clip", writes=True)
    def _cmd_stop_clip(self, params):
        return self._stop_clip(params.get("track_index", 0), params.get("clip_index", 0))

    @command("set_clip_color", writes=True)
    def _cmd_set_clip_color(self, params):
        return self._set_clip_color(params.get("track_index", 0), params.get("clip_index", 0), params.get("color", 0))

    @command("delete_clip", writes=True, destructive=True)
    def _cmd_delete_clip(self, params):
        return self._delete_clip(params.get("track_index", 0), params.get("clip_index", 0))

    @command("clear_notes_from_clip", writes=True, destructive=True)
    def _cmd_clear_notes_from_clip(self, params):
        return self._clear_notes_from_clip(params.get("track_index", 0), params.get("clip_index", 0))

    @command("bulk_set_clip_names", writes=True)
    def _cmd_bulk_set_clip_names(self, params):
        return self._bulk_set_clip_names(params.get("items", []))

    @command("bulk_create_clips", writes=True)
    def _cmd_bulk_create_clips(self, params):
        return self._bulk_create_clips(params.get("items", []))

    def _get_audio_clip_path(self, track_index, clip_index, source="session"):
        """Return the source path and useful metadata for an audio clip."""
        if source not in ("session", "arrangement"):
            raise ValueError("source must be 'session' or 'arrangement'")
        if track_index < 0 or track_index >= len(self._song.tracks):
            raise IndexError("Track index out of range")

        track = self._song.tracks[track_index]
        clips = track.clip_slots if source == "session" else getattr(track, "arrangement_clips", [])
        if clip_index < 0 or clip_index >= len(clips):
            raise IndexError("Clip index out of range")

        if source == "session":
            slot = clips[clip_index]
            if not slot.has_clip:
                raise ValueError("The selected Session clip slot is empty")
            clip = slot.clip
        else:
            clip = clips[clip_index]

        if not getattr(clip, "is_audio_clip", False):
            raise ValueError("The selected clip is not an audio clip")

        path = getattr(clip, "file_path", "")
        if not path:
            raise ValueError("The selected audio clip has no accessible source file path")

        return {
            "track_index": track_index,
            "track_name": track.name,
            "clip_index": clip_index,
            "clip_source": source,
            "clip_name": clip.name,
            "file_path": path,
            "sample_length": getattr(clip, "sample_length", None),
            "sample_rate": getattr(clip, "sample_rate", None),
            "gain": getattr(clip, "gain", None),
            "pitch_coarse": getattr(clip, "pitch_coarse", None),
            "pitch_fine": getattr(clip, "pitch_fine", None),
            "warping": getattr(clip, "warping", None)
        }

    def _get_clip_notes(self, track_index, clip_index):
        """Read all MIDI notes from a clip"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")

            track = self._song.tracks[track_index]

            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")

            clip_slot = track.clip_slots[clip_index]

            if not clip_slot.has_clip:
                raise Exception("No clip in slot")

            clip = clip_slot.clip
            notes = []

            if hasattr(clip, "get_notes_extended"):
                raw_notes = clip.get_notes_extended(0, 128, 0.0, max(1000.0, clip.length))
                for note in raw_notes:
                    notes.append({
                        "pitch": getattr(note, "pitch", 60),
                        "start_time": getattr(note, "start_time", 0.0),
                        "duration": getattr(note, "duration", 0.25),
                        "velocity": getattr(note, "velocity", 100),
                        "mute": getattr(note, "mute", False)
                    })
            else:
                raw_notes = clip.get_notes(0, 0, max(1000.0, clip.length), 128)
                for note in raw_notes:
                    notes.append({
                        "pitch": note[0],
                        "start_time": note[1],
                        "duration": note[2],
                        "velocity": note[3],
                        "mute": note[4]
                    })

            result = {
                "notes": notes,
                "note_count": len(notes)
            }
            return result
        except Exception as e:
            self.log_message("Error getting clip notes: " + str(e))
            raise

    def _create_clip(self, track_index, clip_index, length):
        """Create a new MIDI clip in the specified track and clip slot"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")
            
            track = self._song.tracks[track_index]
            
            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")
            
            clip_slot = track.clip_slots[clip_index]
            
            # Check if the clip slot already has a clip
            if clip_slot.has_clip:
                raise Exception("Clip slot already has a clip")
            
            # Create the clip
            clip_slot.create_clip(length)
            
            result = {
                "name": clip_slot.clip.name,
                "length": clip_slot.clip.length
            }
            return result
        except Exception as e:
            self.log_message("Error creating clip: " + str(e))
            raise

    def _add_notes_to_clip(self, track_index, clip_index, notes):
        """Add MIDI notes to a clip"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")
            
            track = self._song.tracks[track_index]
            
            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")
            
            clip_slot = track.clip_slots[clip_index]
            
            if not clip_slot.has_clip:
                raise Exception("No clip in slot")
            
            clip = clip_slot.clip
            
            if hasattr(clip, "add_new_notes") and hasattr(Live.Clip, "MidiNoteSpecification"):
                specs = []
                for note in notes:
                    spec = Live.Clip.MidiNoteSpecification(
                        pitch=int(note.get("pitch", 60)),
                        start_time=float(note.get("start_time", 0.0)),
                        duration=float(note.get("duration", 0.25)),
                        velocity=float(note.get("velocity", 100)),
                        mute=bool(note.get("mute", False))
                    )
                    specs.append(spec)
                clip.add_new_notes(tuple(specs))
            else:
                live_notes = []
                for note in notes:
                    pitch = note.get("pitch", 60)
                    start_time = note.get("start_time", 0.0)
                    duration = note.get("duration", 0.25)
                    velocity = note.get("velocity", 100)
                    mute = note.get("mute", False)
                    live_notes.append((pitch, start_time, duration, velocity, mute))
                clip.set_notes(tuple(live_notes))
            
            result = {
                "note_count": len(notes)
            }
            return result
        except Exception as e:
            self.log_message("Error adding notes to clip: " + str(e))
            raise

    def _set_clip_name(self, track_index, clip_index, name):
        """Set the name of a clip"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")
            
            track = self._song.tracks[track_index]
            
            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")
            
            clip_slot = track.clip_slots[clip_index]
            
            if not clip_slot.has_clip:
                raise Exception("No clip in slot")
            
            clip = clip_slot.clip
            clip.name = name
            
            result = {
                "name": clip.name
            }
            return result
        except Exception as e:
            self.log_message("Error setting clip name: " + str(e))
            raise

    def _fire_clip(self, track_index, clip_index):
        """Fire a clip"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")
            
            track = self._song.tracks[track_index]
            
            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")
            
            clip_slot = track.clip_slots[clip_index]
            
            if not clip_slot.has_clip:
                raise Exception("No clip in slot")
            
            clip_slot.fire()
            
            result = {
                "fired": True
            }
            return result
        except Exception as e:
            self.log_message("Error firing clip: " + str(e))
            raise

    def _stop_clip(self, track_index, clip_index):
        """Stop a clip"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")
            
            track = self._song.tracks[track_index]
            
            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")
            
            clip_slot = track.clip_slots[clip_index]
            
            clip_slot.stop()
            
            result = {
                "stopped": True
            }
            return result
        except Exception as e:
            self.log_message("Error stopping clip: " + str(e))
            raise

    def _set_clip_color(self, track_index, clip_index, color):
        """Set the color of a clip"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")
            track = self._song.tracks[track_index]
            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")
            
            slot = track.clip_slots[clip_index]
            if slot.has_clip and slot.clip:
                if hasattr(slot.clip, 'color'):
                    slot.clip.color = color
                return {"color": getattr(slot.clip, 'color', color)}
            raise ValueError("No clip in slot")
        except Exception as e:
            self.log_message("Error setting clip color: " + str(e))
            raise

    def _delete_clip(self, track_index, clip_index):
        """Delete the clip in the given clip slot, freeing it for reuse"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")

            track = self._song.tracks[track_index]

            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")

            clip_slot = track.clip_slots[clip_index]

            if not clip_slot.has_clip:
                raise Exception("No clip in slot")

            clip_slot.delete_clip()

            result = {
                "deleted": True
            }
            return result
        except Exception as e:
            self.log_message("Error deleting clip: " + str(e))
            raise

    def _clear_notes_from_clip(self, track_index, clip_index):
        """Remove all MIDI notes from a clip"""
        try:
            if track_index < 0 or track_index >= len(self._song.tracks):
                raise IndexError("Track index out of range")

            track = self._song.tracks[track_index]

            if clip_index < 0 or clip_index >= len(track.clip_slots):
                raise IndexError("Clip index out of range")

            clip_slot = track.clip_slots[clip_index]

            if not clip_slot.has_clip:
                raise Exception("No clip in slot")

            clip = clip_slot.clip
            if hasattr(clip, "remove_notes_extended"):
                clip.remove_notes_extended(0, 128, 0.0, max(1000.0, clip.length))
            else:
                clip.remove_notes(0, 0, max(1000.0, clip.length), 128)

            result = {
                "cleared": True
            }
            return result
        except Exception as e:
            self.log_message("Error clearing notes from clip: " + str(e))
            raise

    def _bulk_set_clip_names(self, items):
        """Set multiple clip names in one main thread pass"""
        updated = []
        for item in items:
            t_idx = item.get("track_index")
            c_idx = item.get("clip_index")
            name = item.get("name", "")
            if t_idx is not None and c_idx is not None and 0 <= t_idx < len(self._song.tracks):
                track = self._song.tracks[t_idx]
                if hasattr(track, 'clip_slots') and 0 <= c_idx < len(track.clip_slots):
                    slot = track.clip_slots[c_idx]
                    if slot.has_clip:
                        slot.clip.name = name
                        updated.append({"track_index": t_idx, "clip_index": c_idx, "name": name})
        return {"updated": updated, "count": len(updated)}

    def _bulk_create_clips(self, items):
        """Create multiple clips in one main thread pass"""
        created = []
        for item in items:
            t_idx = item.get("track_index")
            c_idx = item.get("clip_index")
            length = item.get("length", 4.0)
            name = item.get("name", None)
            if t_idx is not None and c_idx is not None and 0 <= t_idx < len(self._song.tracks):
                track = self._song.tracks[t_idx]
                if hasattr(track, 'clip_slots') and 0 <= c_idx < len(track.clip_slots):
                    slot = track.clip_slots[c_idx]
                    if not slot.has_clip:
                        slot.create_clip(length)
                        if name and slot.has_clip:
                            slot.clip.name = name
                        created.append({"track_index": t_idx, "clip_index": c_idx, "length": length, "name": name})
        return {"created": created, "count": len(created)}
