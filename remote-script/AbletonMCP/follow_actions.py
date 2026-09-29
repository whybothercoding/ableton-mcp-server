"""Follow actions, emulated: Live's API has no clip follow actions, so this watches the Session clips it was told about on the
Remote Script's 10 ms timer and launches the next clip when a clip has played for its configured length.

It is deliberately small and contained: it only acts on clips with a configuration, only while the transport runs and the clip
plays, triggers once per pass, and launches through Live's normal clip launch (so Live's launch quantization decides the exact
moment; the trigger fires slightly early to catch the next grid point). Configurations live in memory: they are lost when Live
restarts or the script reloads, and `clear` (or removing the clip) stops them at once.
"""
import random

from . import clock
from .helpers import _is_number, _safe_attr
from .registry import BridgeError, command

FOLLOW_ACTIONS = ("next", "previous", "first", "last", "any", "other", "again", "stop")
LEAD_SECONDS = 0.04          # fire this long before the pass ends, so Live's launch quantization lands on the boundary
MIN_AFTER_BEATS = 0.25


class FollowActionsMixin(object):
    """follow_actions."""

    _follow = None
    _follow_random = random.random

    def _follow_entries(self):
        if self._follow is None:
            self._follow = {}
        return self._follow

    # ---- the command

    @command("follow_actions")
    def _cmd_follow_actions(self, params):
        action = params.get("action", "status")
        if action == "status":
            return self._follow_status()
        if action == "clear":
            if params.get("address") is None:
                cleared = len(self._follow_entries())
                self._follow = {}
                return {"cleared": cleared, "active": 0}
            kind, clip, canonical = self._resolve(params.get("address"))
            removed = self._follow_entries().pop(self._clip_key(clip), None) is not None
            return {"cleared": 1 if removed else 0, "address": canonical, "active": len(self._follow_entries())}
        if action != "set":
            raise BridgeError("action must be one of: set, clear, status", "INVALID_ARGUMENT")
        kind, clip, canonical = self._resolve(params.get("address"))
        if kind != "clip" or "/arrangement/" in canonical:
            raise BridgeError("follow actions belong to Session clips (tracks/N/slots/M/clip), got '{0}'".format(canonical), "INVALID_ARGUMENT")
        config = self._follow_config(clip, params)
        track_address, slot_index = canonical.split("/slots/")[0], int(canonical.split("/slots/")[1].split("/")[0])
        track = self._resolve(track_address)[1]
        self._follow_entries()[self._clip_key(clip)] = {"clip": clip, "track": track, "slot": track.clip_slots[slot_index], "config": config,
                                                        "started_at": None, "fired": False, "pending": False,
                                                        "last_position": None}
        return {"address": canonical, "config": config, "active": len(self._follow_entries())}

    @staticmethod
    def _clip_key(clip):
        return _safe_attr(clip, "_live_ptr", id(clip))

    def _follow_config(self, clip, params):
        actions = params.get("actions")
        if not isinstance(actions, list) or not actions:
            raise BridgeError("actions must be a non-empty list of {{action, weight?}} (or action names): {0}".format(", ".join(FOLLOW_ACTIONS)), "INVALID_ARGUMENT")
        cleaned = []
        for i, entry in enumerate(actions):
            item = {"action": entry, "weight": 1.0} if isinstance(entry, str) else entry
            if not isinstance(item, dict) or item.get("action") not in FOLLOW_ACTIONS:
                raise BridgeError("actions[{0}].action must be one of: {1}".format(i, ", ".join(FOLLOW_ACTIONS)), "INVALID_ARGUMENT")
            weight = item.get("weight", 1.0)
            if not _is_number(weight) or weight <= 0:
                raise BridgeError("actions[{0}].weight must be a positive number".format(i), "INVALID_ARGUMENT")
            cleaned.append({"action": item["action"], "weight": float(weight)})
        beats, bars = params.get("after_beats"), params.get("after_bars")
        if beats is not None and bars is not None:
            raise BridgeError("give after_beats or after_bars, not both", "INVALID_ARGUMENT")
        if beats is None and bars is None:
            after = float(clip.loop_end - clip.loop_start)                     # one pass through the clip
        elif beats is not None:
            after = beats
        else:
            after = bars * clip.signature_numerator * 4.0 / clip.signature_denominator if _is_number(bars) else bars
        if not _is_number(after) or after < MIN_AFTER_BEATS:
            raise BridgeError("the time before the action must be at least {0} beats".format(MIN_AFTER_BEATS), "INVALID_ARGUMENT")
        return {"actions": cleaned, "after_beats": float(after)}

    def _follow_status(self):
        entries = []
        for entry in self._follow_entries().values():
            clip = entry["clip"]
            entries.append({"address": self._address_of(clip), "config": entry["config"], "is_playing": bool(_safe_attr(clip, "is_playing", False)),
                            "fired_this_pass": entry["fired"]})
        return {"active": len(entries), "entries": entries}

    # ---- the engine, called from the pump timer

    def _tick_follow_actions(self):
        entries = self._follow_entries()
        if not entries:
            return
        song = self._song
        if not song.is_playing:
            for entry in entries.values():
                entry["started_at"], entry["fired"] = None, False
            return
        now, tempo = song.current_song_time, float(song.tempo)
        for key, entry in list(entries.items()):
            try:
                self._tick_follow_entry(entry, now, tempo)
            except Exception as e:
                self.log_message("Follow action on '{0}' stopped: {1}".format(_safe_attr(entry["clip"], "name", "?"), e))
                entries.pop(key, None)

    def _tick_follow_entry(self, entry, now, tempo):
        slot, clip = entry["slot"], entry["clip"]
        if not slot.has_clip or slot.clip != clip:                                # the clip was deleted or replaced
            raise RuntimeError("the clip is gone")
        if clip.is_triggered:                                                     # a launch is pending: a new pass starts after it
            entry["pending"] = True
            return
        if entry["pending"]:
            entry["pending"], entry["started_at"], entry["fired"] = False, None, False
        if not clip.is_playing:
            entry["started_at"], entry["fired"], entry["last_position"] = None, False, None
            return
        position, last = clip.playing_position, entry.get("last_position")
        entry["last_position"] = position
        if entry["fired"] and last is not None and position < last - 0.001:    # the clip restarted or looped: a new pass begins
            entry["started_at"], entry["fired"] = None, False
        if entry["started_at"] is None:
            entry["started_at"] = now - max(0.0, position - clip.start_marker)
        lead = LEAD_SECONDS * tempo / 60.0
        if not entry["fired"] and now - entry["started_at"] >= entry["config"]["after_beats"] - lead:
            entry["fired"] = True
            self._perform_follow_action(entry)

    def _perform_follow_action(self, entry):
        actions = entry["config"]["actions"]
        pick = self._follow_random() * sum(a["weight"] for a in actions)
        chosen = actions[-1]["action"]
        for candidate in actions:
            pick -= candidate["weight"]
            if pick < 0:
                chosen = candidate["action"]
                break
        track, current = entry["track"], entry["slot"]
        slots = [s for s in track.clip_slots if s.has_clip]
        position = next(i for i, s in enumerate(slots) if s == current)
        others = [s for s in slots if s != current]
        if chosen == "stop":
            track.stop_all_clips()
            return
        if chosen == "again":
            target = current
        elif chosen == "next":
            target = slots[(position + 1) % len(slots)]
        elif chosen == "previous":
            target = slots[(position - 1) % len(slots)]
        elif chosen == "first":
            target = slots[0]
        elif chosen == "last":
            target = slots[-1]
        elif chosen == "any":
            target = slots[min(int(self._follow_random() * len(slots)), len(slots) - 1)]
        else:
            target = others[min(int(self._follow_random() * len(others)), len(others) - 1)] if others else current
        target.fire()
