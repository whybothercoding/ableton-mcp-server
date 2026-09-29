"""Reading a device with its parameters and children, and changing device structure: insert, delete, duplicate, move,
rack chains, macros, variations, drum pads.

Parameter values are written with set_properties on a parameter address; this module is for what properties cannot express.
Live's own error messages come through unchanged (for example "Insert audio effects after instruments").
"""
from .helpers import _is_number, _safe_attr
from .registry import BridgeError, command

DEVICE_ACTIONS = ("insert", "delete", "duplicate", "move", "save_ab", "insert_chain", "add_macro", "remove_macro",
                  "randomize_macros", "store_variation", "recall_variation", "delete_variation", "copy_pad", "clear_pad")


_LABELS = {"track": "a track, return track or the master", "chain": "a rack chain", "device": "a device", "pad": "a drum pad"}


def _position(params, name="position", default=-1):
    value = params.get(name, default)
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or value < -1:
        raise BridgeError("{0} must be -1 (the end) or a position from 0".format(name), "INVALID_ARGUMENT")
    return value


class DeviceActionsMixin(object):
    """get_device and device_action."""

    # ---- get_device

    def _parameter_summary(self, index, parameter, base):
        info = self._describe_parameter(index, parameter)
        info["address"] = "{0}/parameters/{1}".format(base, index)
        return info

    def _chain_summary(self, chain, base):
        return {"address": base, "name": chain.name, "mute": _safe_attr(chain, "mute"), "solo": _safe_attr(chain, "solo"),
                "devices": [{"address": "{0}/devices/{1}".format(base, i), "name": d.name, "class_name": d.class_name}
                            for i, d in enumerate(chain.devices)]}

    @command("get_device")
    def _cmd_get_device(self, params):
        kind, device, canonical = self._resolve(params.get("address"))
        if kind != "device":
            raise BridgeError("get_device needs the address of a device (tracks/N/devices/M...), got '{0}' which is a {1}".format(canonical, kind),
                              "INVALID_ARGUMENT")
        result = {"address": canonical, "name": device.name, "class_name": device.class_name,
                  "device_type": self._get_device_type(device), "is_active": _safe_attr(device, "is_active"),
                  "parameters": [self._parameter_summary(i, p, canonical) for i, p in enumerate(device.parameters)]}
        if _safe_attr(device, "can_have_chains", False):
            result["chains"] = [self._chain_summary(c, "{0}/chains/{1}".format(canonical, i)) for i, c in enumerate(device.chains)]
            returns = _safe_attr(device, "return_chains")
            if returns is not None:
                result["return_chains"] = [self._chain_summary(c, "{0}/return_chains/{1}".format(canonical, i)) for i, c in enumerate(returns)]
            result["macros"] = {"visible": _safe_attr(device, "visible_macro_count"), "variations": _safe_attr(device, "variation_count"),
                                "selected_variation": _safe_attr(device, "selected_variation_index")}
        if _safe_attr(device, "can_have_drum_pads", False):
            result["drum_pads"] = [{"address": "{0}/drum_pads/{1}".format(canonical, pad.note), "note": pad.note, "name": pad.name,
                                    "chains": [self._chain_summary(c, "{0}/drum_pads/{1}/chains/{2}".format(canonical, pad.note, i))
                                               for i, c in enumerate(pad.chains)]}
                                   for pad in device.drum_pads if len(pad.chains)]
        return result

    # ---- device_action

    @command("device_action", writes=True, destructive=True)
    def _cmd_device_action(self, params):
        action = params.get("action")
        if action not in DEVICE_ACTIONS:
            raise BridgeError("action must be one of: {0}".format(", ".join(DEVICE_ACTIONS)), "INVALID_ARGUMENT")
        kind, obj, canonical = self._resolve(params.get("address"))
        result = getattr(self, "_do_" + action)(kind, obj, canonical, params)
        result.setdefault("action", action)
        return result

    def _expect(self, kind, wanted, action):
        if kind not in wanted:
            raise BridgeError("{0} needs the address of {1}, not of a {2}".format(action, " or ".join(_LABELS[w] for w in wanted), kind), "INVALID_ARGUMENT")

    def _host(self, device, canonical):
        """The track or chain whose device list holds `device`, and the device's index there."""
        parent = _safe_attr(device, "canonical_parent")
        if parent is None:
            raise BridgeError("Cannot find what holds '{0}'".format(canonical), "NOT_FOUND")
        for index, candidate in enumerate(parent.devices):
            if candidate == device:
                return parent, index
        raise BridgeError("'{0}' is no longer in its device chain: re-read the Set".format(canonical), "NOT_FOUND")

    def _do_insert(self, kind, obj, canonical, params):
        self._expect(kind, ("track", "chain"), "insert")
        name = params.get("name")
        if not isinstance(name, str) or not name.strip():
            raise BridgeError("insert needs name: the device's name as in Live's browser (for example 'EQ Eight', 'Drum Rack')", "INVALID_ARGUMENT")
        device = obj.insert_device(name.strip(), _position(params))
        return {"address": self._address_of(device), "name": device.name, "class_name": device.class_name, "into": canonical}

    def _do_delete(self, kind, obj, canonical, params):
        self._expect(kind, ("device",), "delete")
        expect = params.get("expect")
        if not isinstance(expect, dict) or "name" not in expect:
            raise BridgeError("delete needs expect: {\"name\": <the device's current name>}: indices shift after every change", "INVALID_ARGUMENT")
        self._guard(obj, expect, canonical)
        host, index = self._host(obj, canonical)
        name = obj.name
        host.delete_device(index)
        return {"deleted": canonical, "name": name, "remaining": len(host.devices)}

    def _do_duplicate(self, kind, obj, canonical, params):
        self._expect(kind, ("device",), "duplicate")
        host, index = self._host(obj, canonical)
        host.duplicate_device(index)
        copy = host.devices[index + 1]
        return {"source": canonical, "address": self._address_of(copy), "name": copy.name}

    def _do_move(self, kind, obj, canonical, params):
        self._expect(kind, ("device",), "move")
        target_kind, target, target_address = self._resolve(params.get("to"))
        if target_kind not in ("track", "chain"):
            raise BridgeError("to must be the address of a track or a rack chain, got '{0}' which is a {1}".format(target_address, target_kind),
                              "INVALID_ARGUMENT")
        position = _position(params)
        if position == -1:
            position = len(target.devices)
        landed = self._song.move_device(obj, target, position)
        moved = target.devices[landed] if isinstance(landed, int) and 0 <= landed < len(target.devices) else None
        return {"from": canonical, "address": self._address_of(moved) if moved is not None else None, "position": landed,
                "requested_position": position}

    def _do_save_ab(self, kind, obj, canonical, params):
        self._expect(kind, ("device",), "save_ab")
        if not _safe_attr(obj, "can_compare_ab", False):
            raise BridgeError("'{0}' cannot A/B compare presets".format(obj.name), "UNAVAILABLE")
        obj.save_preset_to_compare_ab_slot()
        return {"address": canonical, "is_using_compare_preset_b": _safe_attr(obj, "is_using_compare_preset_b")}

    def _rack(self, kind, obj, canonical, action):
        self._expect(kind, ("device",), action)
        if not _safe_attr(obj, "can_have_chains", False):
            raise BridgeError("'{0}' is not a rack: {1} needs an Instrument, Audio Effect, MIDI Effect or Drum Rack".format(obj.name, action),
                              "INVALID_ARGUMENT")
        return obj

    def _macro_state(self, rack, canonical):
        return {"address": canonical, "visible_macro_count": _safe_attr(rack, "visible_macro_count"),
                "variation_count": _safe_attr(rack, "variation_count"), "selected_variation_index": _safe_attr(rack, "selected_variation_index")}

    def _do_insert_chain(self, kind, obj, canonical, params):
        rack = self._rack(kind, obj, canonical, "insert_chain")
        chain = rack.insert_chain(_position(params))
        return {"address": self._address_of(chain), "name": chain.name, "rack": canonical}

    def _do_add_macro(self, kind, obj, canonical, params):
        rack = self._rack(kind, obj, canonical, "add_macro")
        rack.add_macro()
        return self._macro_state(rack, canonical)

    def _do_remove_macro(self, kind, obj, canonical, params):
        rack = self._rack(kind, obj, canonical, "remove_macro")
        rack.remove_macro()
        return self._macro_state(rack, canonical)

    def _do_randomize_macros(self, kind, obj, canonical, params):
        rack = self._rack(kind, obj, canonical, "randomize_macros")
        rack.randomize_macros()
        return self._macro_state(rack, canonical)

    def _do_store_variation(self, kind, obj, canonical, params):
        rack = self._rack(kind, obj, canonical, "store_variation")
        rack.store_variation()
        return self._macro_state(rack, canonical)

    def _select_variation(self, rack, params, action):
        """Variations are recalled/deleted by selection (Live does nothing when none is selected): `index` selects one first."""
        if not rack.variation_count:
            raise BridgeError("'{0}' has no stored variations".format(rack.name), "UNAVAILABLE")
        index = params.get("index")
        if index is not None:
            if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < rack.variation_count:
                raise BridgeError("index must be a variation number from 0 to {0}".format(rack.variation_count - 1), "OUT_OF_RANGE")
            rack.selected_variation_index = index
        elif not 0 <= rack.selected_variation_index < rack.variation_count:
            raise BridgeError("No variation is selected: give index (0 to {0}) or set selected_variation_index on the rack first".format(
                rack.variation_count - 1), "UNAVAILABLE")

    def _do_recall_variation(self, kind, obj, canonical, params):
        rack = self._rack(kind, obj, canonical, "recall_variation")
        which = params.get("which", "selected")
        if which not in ("selected", "last"):
            raise BridgeError("which must be 'selected' (the variation at `index` or selected_variation_index) or 'last' (the last one recalled)",
                              "INVALID_ARGUMENT")
        if which == "selected":
            self._select_variation(rack, params, "recall_variation")
            rack.recall_selected_variation()
        else:
            if not rack.variation_count:
                raise BridgeError("'{0}' has no stored variations".format(rack.name), "UNAVAILABLE")
            rack.recall_last_used_variation()
        return self._macro_state(rack, canonical)

    def _do_delete_variation(self, kind, obj, canonical, params):
        rack = self._rack(kind, obj, canonical, "delete_variation")
        self._select_variation(rack, params, "delete_variation")
        rack.delete_selected_variation()
        return self._macro_state(rack, canonical)

    def _do_copy_pad(self, kind, obj, canonical, params):
        rack = self._rack(kind, obj, canonical, "copy_pad")
        if not _safe_attr(rack, "can_have_drum_pads", False):
            raise BridgeError("'{0}' is not a Drum Rack".format(rack.name), "INVALID_ARGUMENT")
        notes = []
        for name in ("from_note", "to_note"):
            value = params.get(name)
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 127:
                raise BridgeError("{0} must be a MIDI note number 0 to 127".format(name), "INVALID_ARGUMENT")
            notes.append(value)
        rack.copy_pad(notes[0], notes[1])
        return {"address": canonical, "from_note": notes[0], "to_note": notes[1],
                "to": "{0}/drum_pads/{1}".format(canonical, notes[1])}

    def _do_clear_pad(self, kind, obj, canonical, params):
        self._expect(kind, ("pad",), "clear_pad")
        expect = params.get("expect")
        if not isinstance(expect, dict) or "name" not in expect:
            raise BridgeError("clear_pad needs expect: {\"name\": <the pad's current name>}", "INVALID_ARGUMENT")
        self._guard(obj, expect, canonical)
        chains = len(obj.chains)
        obj.delete_all_chains()
        return {"address": canonical, "cleared_chains": chains}

