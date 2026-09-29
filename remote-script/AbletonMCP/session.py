"""Song-level commands: session info, transport, tempo, scenes, script info and eval."""

import Live
from . import config
from .registry import _COMMANDS
from .registry import command
from .registry import gates_status


class SessionMixin(object):
    """Song-level commands: session info, transport, tempo, scenes, script info and eval."""

    @command("get_session_info")
    def _cmd_get_session_info(self, params):
        return self._get_session_info()

    @command("get_script_info")
    def _cmd_get_script_info(self, params):
        return self._get_script_info()

    @command("get_bulk_session_structure")
    def _cmd_get_bulk_session_structure(self, params):
        return self._get_bulk_session_structure()

    @command("set_tempo", writes=True)
    def _cmd_set_tempo(self, params):
        return self._set_tempo(params.get("tempo", 120.0))

    @command("start_playback", writes=True)
    def _cmd_start_playback(self, params):
        return self._start_playback()

    @command("stop_playback", writes=True)
    def _cmd_stop_playback(self, params):
        return self._stop_playback()

    @command("stop_all_clips", writes=True)
    def _cmd_stop_all_clips(self, params):
        return self._stop_all_clips()

    @command("fire_scene", writes=True)
    def _cmd_fire_scene(self, params):
        return self._fire_scene(params.get("scene_index", 0))

    @command("set_scene_name", writes=True)
    def _cmd_set_scene_name(self, params):
        return self._set_scene_name(params.get("scene_index", 0), params.get("name", ""))

    @command("set_scene_tempo", writes=True)
    def _cmd_set_scene_tempo(self, params):
        return self._set_scene_tempo(params.get("scene_index", 0), params.get("tempo", 120.0))

    @command("eval", writes=True, gate="eval")
    def _cmd_eval(self, params):
        # Errors propagate as real error responses (they used to come back as plain success strings)
        return eval(params.get("code", ""), {"self": self})

    def _get_session_info(self):
        """Get information about the current session"""
        try:
            result = {
                "tempo": self._song.tempo,
                "signature_numerator": self._song.signature_numerator,
                "signature_denominator": self._song.signature_denominator,
                "track_count": len(self._song.tracks),
                "return_track_count": len(self._song.return_tracks),
                "master_track": {
                    "name": "Master",
                    "volume": self._song.master_track.mixer_device.volume.value,
                    "panning": self._song.master_track.mixer_device.panning.value
                }
            }
            return result
        except Exception as e:
            self.log_message("Error getting session info: " + str(e))
            raise

    def _get_bulk_session_structure(self):
        """Retrieve full session structure in a single batched call"""
        try:
            tracks_info = []
            for i, track in enumerate(self._song.tracks):
                is_group = getattr(track, 'is_foldable', False)
                is_grouped = getattr(track, 'is_grouped', False)
                group_track_name = None
                if is_grouped and hasattr(track, 'group_track') and track.group_track:
                    group_track_name = track.group_track.name
                
                can_be_armed = False
                if hasattr(track, 'can_be_armed'):
                    try:
                        can_be_armed = track.can_be_armed
                    except Exception:
                        pass
                
                arm = False
                if can_be_armed:
                    try:
                        arm = track.arm
                    except Exception:
                        pass

                playing_slot_index = -1
                clips_summary = []
                if hasattr(track, 'clip_slots'):
                    for slot_index, slot in enumerate(track.clip_slots):
                        if slot.has_clip:
                            c = slot.clip
                            if c.is_playing:
                                playing_slot_index = slot_index
                            clips_summary.append({
                                "slot_index": slot_index,
                                "name": c.name,
                                "is_playing": c.is_playing,
                                "is_recording": c.is_recording
                            })

                tracks_info.append({
                    "index": i,
                    "name": track.name,
                    "is_group": is_group,
                    "is_grouped": is_grouped,
                    "group_track_name": group_track_name,
                    "is_audio_track": getattr(track, 'has_audio_input', False),
                    "is_midi_track": getattr(track, 'has_midi_input', False),
                    "mute": getattr(track, 'mute', False),
                    "solo": getattr(track, 'solo', False),
                    "can_be_armed": can_be_armed,
                    "arm": arm,
                    "volume": track.mixer_device.volume.value if hasattr(track, 'mixer_device') and hasattr(track.mixer_device, 'volume') else 0.0,
                    "panning": track.mixer_device.panning.value if hasattr(track, 'mixer_device') and hasattr(track.mixer_device, 'panning') else 0.0,
                    "playing_slot_index": playing_slot_index,
                    "clips": clips_summary,
                    "device_count": len(track.devices) if hasattr(track, 'devices') else 0
                })

            scenes_info = []
            for idx, scene in enumerate(self._song.scenes):
                scenes_info.append({
                    "index": idx,
                    "name": scene.name
                })

            def mixer_summary(track_type, index, track):
                mixer = track.mixer_device
                return {"track_type": track_type, "index": index, "name": track.name,
                        "mute": getattr(track, 'mute', False) if track_type != "master" else False,
                        "solo": getattr(track, 'solo', False) if track_type != "master" else False,
                        "volume": mixer.volume.value, "panning": mixer.panning.value,
                        "device_count": len(track.devices)}
            
            return {
                "session": self._get_session_info(),
                "scenes": scenes_info,
                "tracks": tracks_info,
                "return_tracks": [mixer_summary("return", i, t) for i, t in enumerate(self._song.return_tracks)],
                "master": mixer_summary("master", None, self._song.master_track)
            }
        except Exception as e:
            self.log_message("Error getting bulk session structure: " + str(e))
            raise

    def _get_script_info(self):
        """Report script version and capabilities (handshake)."""
        # Commands come from the registry; the extra strings advertise features that clients can probe for.
        capabilities = sorted(_COMMANDS.keys()) + ["track_types", "device_paths", "parameter_details", "undo_steps", "error_codes"]
        return {
            "script_version": config.SCRIPT_VERSION,
            "build_id": getattr(self, "build_id", None),
            "capabilities": capabilities,
            "gates": gates_status()
        }

    def _set_tempo(self, tempo):
        """Set the tempo of the session"""
        try:
            self._song.tempo = tempo
            
            result = {
                "tempo": self._song.tempo
            }
            return result
        except Exception as e:
            self.log_message("Error setting tempo: " + str(e))
            raise

    def _start_playback(self):
        """Start playing the session"""
        try:
            self._song.start_playing()
            
            result = {
                "playing": self._song.is_playing
            }
            return result
        except Exception as e:
            self.log_message("Error starting playback: " + str(e))
            raise

    def _stop_playback(self):
        """Stop playing the session"""
        try:
            self._song.stop_playing()
            
            result = {
                "playing": self._song.is_playing
            }
            return result
        except Exception as e:
            self.log_message("Error stopping playback: " + str(e))
            raise

    def _stop_all_clips(self):
        """Stop every currently playing session clip across all tracks"""
        try:
            self._song.stop_all_clips()

            result = {
                "stopped": True
            }
            return result
        except Exception as e:
            self.log_message("Error stopping all clips: " + str(e))
            raise

    def _fire_scene(self, scene_index):
        """Fire a scene -- launches every track's clip in that row at once,
        and stops any track that has no clip in that row, exactly like
        clicking the Scene Launch button in Live's Session View."""
        try:
            if scene_index < 0 or scene_index >= len(self._song.scenes):
                raise IndexError("Scene index out of range")

            scene = self._song.scenes[scene_index]
            scene.fire()

            result = {
                "fired": True,
                "name": scene.name
            }
            return result
        except Exception as e:
            self.log_message("Error firing scene: " + str(e))
            raise

    def _set_scene_name(self, scene_index, name):
        """Set the name of a scene"""
        try:
            if scene_index < 0 or scene_index >= len(self._song.scenes):
                raise IndexError("Scene index out of range")

            scene = self._song.scenes[scene_index]
            scene.name = name

            result = {
                "name": scene.name
            }
            return result
        except Exception as e:
            self.log_message("Error setting scene name: " + str(e))
            raise

    def _set_scene_tempo(self, scene_index, tempo):
        """Set the tempo of a scene"""
        try:
            if scene_index < 0 or scene_index >= len(self._song.scenes):
                raise IndexError("Scene index out of range")
            scene = self._song.scenes[scene_index]
            if hasattr(scene, 'tempo'):
                scene.tempo = tempo
                return {"name": scene.name, "tempo": scene.tempo}
            else:
                raise Exception("Scene tempo property not found in this Live version")
        except Exception as e:
            self.log_message("Error setting scene tempo: " + str(e))
            raise
