"""Held fire buttons: press the fire button of a clip slot or scene, and let the Remote Script's timer release it.

`fire` is a click. A gate clip started that way never gets its release and plays until it is stopped, while `set_fire_button_state`
is the button itself (True pressed, False released) and honours every launch mode: a gate clip plays while the button is down and
stops on release; trigger, toggle and repeat clips keep playing after release (proven against Live, see reference/live-api-quirks.md).

A hold is always released by the pump after its time (default and maximum MAX_HOLD_SECONDS), so a lost caller can never leave a
button down. Stopping the script (Live closing, the script removed) releases every hold at once; a hot-swap keeps the state on the
instance, as it does for a measurement, and the reloaded code goes on releasing holds on time. Holds are in memory only.
"""
from . import clock
from .helpers import _is_number, _safe_attr
from .registry import BridgeError

MAX_HOLD_SECONDS = 120.0


class HoldsMixin(object):
    """The hold side of the launch command."""

    _holds = None

    def _hold_entries(self):
        if self._holds is None:
            self._holds = {}
        return self._holds

    def _hold_seconds(self, params):
        """How long a new hold lasts, in seconds: hold_seconds, or hold_beats at the current tempo, else the maximum."""
        beats, seconds = params.get("hold_beats"), params.get("hold_seconds")
        if beats is not None and seconds is not None:
            raise BridgeError("give hold_beats or hold_seconds, not both", "INVALID_ARGUMENT")
        for name, value in (("hold_beats", beats), ("hold_seconds", seconds)):
            if value is not None and (not _is_number(value) or value <= 0):
                raise BridgeError("{0} must be a positive number".format(name), "INVALID_ARGUMENT")
        if beats is not None:
            seconds = beats * 60.0 / float(self._song.tempo)
        if seconds is None:
            seconds = MAX_HOLD_SECONDS
        if seconds > MAX_HOLD_SECONDS:
            raise BridgeError("a hold lasts at most {0:g} seconds and this one is {1:g}: hold again when it ends, or release it earlier with hold: false".format(
                MAX_HOLD_SECONDS, seconds), "OUT_OF_RANGE")
        return float(seconds)

    def _launch_hold(self, kind, obj, canonical, params, hold):
        """Press (hold: true) or release (hold: false) the fire button of a clip slot or scene."""
        if kind not in ("slot", "scene"):
            raise BridgeError("Only clip slots, clips and scenes have a fire button to hold, got '{0}'".format(canonical), "INVALID_ARGUMENT")
        entries = self._hold_entries()
        key = (kind, _safe_attr(obj, "_live_ptr", id(obj)))
        if hold is False:
            if params.get("hold_beats") is not None or params.get("hold_seconds") is not None:
                raise BridgeError("hold_beats and hold_seconds belong with hold: true", "INVALID_ARGUMENT")
            was_held = entries.pop(key, None) is not None
            obj.set_fire_button_state(False)             # also ends a gate clip that a plain fire started: a release is always forwarded
            return {"address": canonical, "action": "release", "was_held": was_held, "holding": len(entries), "state": self._launch_state(kind, obj)}
        if key in entries:
            raise BridgeError("'{0}' is already held: release it with hold: false first".format(canonical), "INVALID_ARGUMENT")
        seconds = self._hold_seconds(params)
        obj.set_fire_button_state(True)
        entries[key] = {"obj": obj, "address": canonical, "release_at": clock.now() + seconds}
        return {"address": canonical, "action": "hold", "release_in_seconds": round(seconds, 3), "holding": len(entries), "state": self._launch_state(kind, obj)}

    # ---- the engine, called from the pump timer

    def _tick_holds(self):
        entries = self._hold_entries()
        if not entries:
            return
        now = clock.now()
        for key, entry in list(entries.items()):
            if now < entry["release_at"]:
                continue
            entries.pop(key, None)
            try:
                entry["obj"].set_fire_button_state(False)
            except Exception as e:
                self.log_message("Releasing the held fire button of '{0}' failed: {1}".format(entry["address"], e))

    def _holds_release_all(self):
        """Release every held button (the script is stopping)."""
        entries, self._holds = self._hold_entries(), {}
        for entry in list(entries.values()):
            try:
                entry["obj"].set_fire_button_state(False)
            except Exception as e:
                self.log_message("Releasing the held fire button of '{0}' failed: {1}".format(entry["address"], e))
