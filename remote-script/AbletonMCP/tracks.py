"""Track lookup (regular, return, master) and track commands."""

from .registry import command
from .helpers import _as_index
from .helpers import _safe_attr


class TracksMixin(object):
    """Track lookup (regular, return, master) and track commands."""

    @command("get_track_info")
    def _cmd_get_track_info(self, params):
        return self._get_track_info(params.get("track_index", 0), params.get("track_type", "track"))

    @command("create_midi_track", writes=True)
    def _cmd_create_midi_track(self, params):
        return self._create_midi_track(params.get("index", -1))

    @command("set_track_name", writes=True)
    def _cmd_set_track_name(self, params):
        return self._set_track_name(params.get("track_index", 0), params.get("name", ""), params.get("track_type", "track"))

    @command("set_track_color", writes=True)
    def _cmd_set_track_color(self, params):
        return self._set_track_color(params.get("track_index", 0), params.get("color", 0), params.get("track_type", "track"))

    @command("set_track_mute", writes=True)
    def _cmd_set_track_mute(self, params):
        return self._set_track_mute(params.get("track_index", 0), params.get("mute", False), params.get("track_type", "track"))

    @command("set_track_solo", writes=True)
    def _cmd_set_track_solo(self, params):
        return self._set_track_solo(params.get("track_index", 0), params.get("solo", False), params.get("track_type", "track"))

    @command("set_track_arm", writes=True)
    def _cmd_set_track_arm(self, params):
        return self._set_track_arm(params.get("track_index", 0), params.get("arm", False), params.get("track_type", "track"))

    def _track_by(self, track_type, track_index):
        """Return a regular ('track'), 'return' or 'master' track; master ignores track_index."""
        if track_type == "master":
            return self._song.master_track
        if track_type == "return":
            tracks, label = self._song.return_tracks, "Return track"
        elif track_type in (None, "track"):
            tracks, label = self._song.tracks, "Track"
        else:
            raise ValueError("track_type must be 'track', 'return' or 'master'")
        index = _as_index(track_index, "track_index")
        if not 0 <= index < len(tracks):
            raise IndexError("{0} index out of range".format(label))
        return tracks[index]

    def _get_track_info(self, track_index, track_type="track"):
        """Get information about a regular, return or master track"""
        try:
            track = self._track_by(track_type, track_index)
            is_group = _safe_attr(track, 'is_foldable', False)
            is_grouped = _safe_attr(track, 'is_grouped', False)
            group_track_name = None
            if is_grouped and hasattr(track, 'group_track') and track.group_track:
                group_track_name = track.group_track.name

            can_be_armed = False
            if hasattr(track, 'can_be_armed'):
                try:
                    can_be_armed = track.can_be_armed
                except Exception:
                    can_be_armed = False

            arm = False
            if can_be_armed:
                try:
                    arm = track.arm
                except Exception:
                    arm = False

            # Get clip slots
            clip_slots = []
            track_slots = _safe_attr(track, 'clip_slots')
            if track_slots is not None:
                for slot_index, slot in enumerate(track_slots):
                    clip_info = None
                    if slot.has_clip:
                        clip = slot.clip
                        clip_info = {
                            "name": clip.name,
                            "length": clip.length,
                            "is_playing": clip.is_playing,
                            "is_recording": clip.is_recording
                        }
                    
                    clip_slots.append({
                        "index": slot_index,
                        "has_clip": slot.has_clip,
                        "clip": clip_info
                    })

            # Get arrangement clips if applicable
            arrangement_clips = []
            track_arrangement = None if is_group else _safe_attr(track, 'arrangement_clips')
            if track_arrangement is not None:
                try:
                    for clip in track_arrangement:
                        arrangement_clips.append({
                            "name": clip.name,
                            "start_time": clip.start_time,
                            "length": clip.length,
                            "muted": getattr(clip, 'muted', False),
                            "is_midi_clip": getattr(clip, 'is_midi_clip', False)
                        })
                except Exception:
                    pass
            
            # Get devices
            devices = []
            if hasattr(track, 'devices'):
                for device_index, device in enumerate(track.devices):
                    devices.append({
                        "index": device_index,
                        "name": device.name,
                        "class_name": device.class_name,
                        "type": self._get_device_type(device),
                        "can_have_chains": bool(getattr(device, "can_have_chains", False))
                    })
            
            result = {
                "track_type": track_type,
                "index": None if track_type == "master" else track_index,
                "name": track.name,
                "is_group": is_group,
                "is_grouped": is_grouped,
                "group_track_name": group_track_name,
                "is_audio_track": getattr(track, 'has_audio_input', False),
                "is_midi_track": getattr(track, 'has_midi_input', False),
                "mute": _safe_attr(track, 'mute', False),
                "solo": _safe_attr(track, 'solo', False),
                "can_be_armed": can_be_armed,
                "arm": arm,
                "volume": track.mixer_device.volume.value if hasattr(track, 'mixer_device') and hasattr(track.mixer_device, 'volume') else 0.0,
                "panning": track.mixer_device.panning.value if hasattr(track, 'mixer_device') and hasattr(track.mixer_device, 'panning') else 0.0,
                "clip_slots": clip_slots,
                "arrangement_clips": arrangement_clips,
                "devices": devices
            }
            return result
        except Exception as e:
            self.log_message("Error getting track info: " + str(e))
            raise

    def _create_midi_track(self, index):
        """Create a new MIDI track at the specified index"""
        try:
            # Create the track
            self._song.create_midi_track(index)
            
            # Get the new track
            new_track_index = len(self._song.tracks) - 1 if index == -1 else index
            new_track = self._song.tracks[new_track_index]
            
            result = {
                "index": new_track_index,
                "name": new_track.name
            }
            return result
        except Exception as e:
            self.log_message("Error creating MIDI track: " + str(e))
            raise

    def _set_track_name(self, track_index, name, track_type="track"):
        """Set the name of a track"""
        try:
            track = self._track_by(track_type, track_index)
            track.name = name
            
            result = {
                "name": track.name
            }
            return result
        except Exception as e:
            self.log_message("Error setting track name: " + str(e))
            raise

    def _set_track_color(self, track_index, color, track_type="track"):
        """Set the color of a track (RGB)"""
        try:
            track = self._track_by(track_type, track_index)
            if hasattr(track, 'color'):
                track.color = color
            
            return {
                "color": getattr(track, 'color', None)
            }
        except Exception as e:
            self.log_message("Error setting track color: " + str(e))
            raise

    def _set_track_mute(self, track_index, mute, track_type="track"):
        """Mute or unmute a track"""
        try:
            if track_type == "master":
                raise ValueError("The master track cannot be muted")
            track = self._track_by(track_type, track_index)
            track.mute = bool(mute)

            result = {
                "mute": track.mute
            }
            return result
        except Exception as e:
            self.log_message("Error setting track mute: " + str(e))
            raise

    def _set_track_solo(self, track_index, solo, track_type="track"):
        """Solo or unsolo a track"""
        try:
            if track_type == "master":
                raise ValueError("The master track cannot be soloed")
            track = self._track_by(track_type, track_index)
            track.solo = bool(solo)

            result = {
                "solo": track.solo
            }
            return result
        except Exception as e:
            self.log_message("Error setting track solo: " + str(e))
            raise

    def _set_track_arm(self, track_index, arm, track_type="track"):
        """Arm or disarm a track for recording"""
        try:
            track = self._track_by(track_type, track_index)

            if not getattr(track, "can_be_armed", False):
                raise Exception("Track cannot be armed")

            track.arm = bool(arm)

            result = {
                "arm": track.arm
            }
            return result
        except Exception as e:
            self.log_message("Error setting track arm: " + str(e))
            raise
