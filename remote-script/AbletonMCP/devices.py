"""Device addressing (top-level and rack chains) and device parameter commands."""

import Live
from .registry import command
from .helpers import _as_index
from .helpers import _safe_attr


class DevicesMixin(object):
    """Device addressing (top-level and rack chains) and device parameter commands."""

    @command("get_device_parameters")
    def _cmd_get_device_parameters(self, params):
        device_path = params.get("device_path")
        device_index = params.get("device_index", None if device_path is not None else 0)
        return self._get_device_parameters(params.get("track_index", 0), device_index, params.get("track_type", "track"), device_path)

    @command("set_device_parameter", writes=True)
    def _cmd_set_device_parameter(self, params):
        device_path = params.get("device_path")
        device_index = params.get("device_index", None if device_path is not None else 0)
        return self._set_device_parameter(params.get("track_index", 0), device_index, params.get("parameter_index", 0),
                                          params.get("value", 0.0), params.get("track_type", "track"), device_path)

    @command("bulk_set_device_parameters", writes=True)
    def _cmd_bulk_set_device_parameters(self, params):
        return self._bulk_set_device_parameters(params.get("items", []))

    def _get_device_parameters(self, track_index, device_index, track_type="track", device_path=None):
        """Read a device's parameters with ranges, display strings and labels for quantized ones"""
        try:
            track = self._track_by(track_type, track_index)
            device = self._device_by(track, device_index, device_path)
            
            result = {
                "device_name": device.name,
                "class_name": device.class_name,
                "device_type": self._get_device_type(device),
                "track_type": track_type,
                "parameters": [self._describe_parameter(i, param) for i, param in enumerate(device.parameters)]
            }
            if device_path is not None:
                result["device_path"] = device_path
            result.update(self._describe_device_structure(device))
            return result
        except Exception as e:
            self.log_message("Error getting device parameters: " + str(e))
            raise

    def _set_device_parameter(self, track_index, device_index, parameter_index, value, track_type="track", device_path=None):
        """Set a device parameter to a specific value"""
        try:
            track = self._track_by(track_type, track_index)
            device = self._device_by(track, device_index, device_path)
            parameter_index = _as_index(parameter_index, "parameter_index")
            if not 0 <= parameter_index < len(device.parameters):
                raise IndexError("Parameter index out of range")

            parameter = device.parameters[parameter_index]

            if not parameter.is_enabled:
                raise Exception("Parameter is not enabled")

            old_value = parameter.value
            parameter.value = value

            result = {
                "name": parameter.name,
                "old_value": old_value,
                "value": parameter.value
            }
            try:
                result["display"] = parameter.str_for_value(parameter.value)
            except Exception:
                pass
            return result
        except Exception as e:
            self.log_message("Error setting device parameter: " + str(e))
            raise

    def _bulk_set_device_parameters(self, items):
        """Set multiple device parameters in one main thread pass.

        Items may name a track_type and device_path. Reports the value Live actually holds
        afterwards, and why any item was skipped."""
        updated = []
        skipped = []
        for i, item in enumerate(items):
            try:
                track_type = item.get("track_type", "track")
                device_path = item.get("device_path")
                d_idx = item.get("device_index")
                p_idx = item.get("parameter_index")
                val = item.get("value")
                if (track_type != "master" and item.get("track_index") is None) or (d_idx is None and device_path is None) \
                        or p_idx is None or val is None:
                    raise ValueError("track_index, device_index (or device_path), parameter_index and value are required")
                track = self._track_by(track_type, item.get("track_index"))
                device = self._device_by(track, d_idx, device_path)
                if not 0 <= p_idx < len(device.parameters):
                    raise IndexError("Parameter index out of range")
                param = device.parameters[p_idx]
                if not param.is_enabled:
                    raise ValueError("Parameter is not enabled")
                param.value = val
                entry = {"track_index": item.get("track_index"), "parameter_index": p_idx, "value": param.value}
                for key in ("device_index", "device_path"):
                    if item.get(key) is not None:
                        entry[key] = item[key]
                if track_type != "track":
                    entry["track_type"] = track_type
                updated.append(entry)
            except Exception as e:
                skipped.append({"item": i, "reason": str(e)})
        return {"updated": updated, "count": len(updated), "skipped": skipped}

    def _device_by(self, track, device_index, device_path=None):
        """Locate a device: device_index for a top-level device, or device_path into rack chains."""
        if device_path is not None:
            if device_index is not None:
                raise ValueError("give either device_index or device_path, not both")
            return self._walk_device_path(track, device_path)
        index = _as_index(device_index, "device_index")
        if not 0 <= index < len(track.devices):
            raise IndexError("Device index out of range")
        return track.devices[index]

    def _walk_device_path(self, track, path):
        """Follow [device, chain, device, ...] through rack chains to a device.

        A chain selector is an index into the rack's chains, {"pad": note[, "chain": n]} for a drum
        pad's chain, or {"return": n} for a return chain."""
        if not isinstance(path, list) or not path or len(path) % 2 == 0:
            raise ValueError("device_path must alternate device and chain selectors and end with a device index, e.g. [0, 2, 1]")
        devices = track.devices
        device = None
        for position, step in enumerate(path):
            if position % 2 == 0:
                index = _as_index(step, "device_path[{0}]".format(position))
                if not 0 <= index < len(devices):
                    raise IndexError("Device index out of range at device_path[{0}]".format(position))
                device = devices[index]
            else:
                if not getattr(device, "can_have_chains", False):
                    raise ValueError("device_path[{0}]: '{1}' has no chains".format(position, device.name))
                devices = self._chain_devices(device, step, position)
        return device

    def _chain_devices(self, device, selector, position):
        where = "device_path[{0}]".format(position)
        if isinstance(selector, dict):
            if "pad" in selector:
                if not getattr(device, "can_have_drum_pads", False):
                    raise ValueError("{0}: '{1}' has no drum pads".format(where, device.name))
                note = _as_index(selector["pad"], where + ".pad")
                pads = device.drum_pads
                if not 0 <= note < len(pads):
                    raise IndexError("{0}: drum pad note out of range".format(where))
                chains = pads[note].chains
                if not len(chains):
                    raise IndexError("{0}: drum pad {1} is empty".format(where, note))
                index = _as_index(selector.get("chain", 0), where + ".chain")
            elif "return" in selector:
                chains = device.return_chains
                index = _as_index(selector["return"], where + ".return")
            else:
                raise ValueError("{0}: a chain selector object needs 'pad' or 'return'".format(where))
        else:
            chains = device.chains
            index = _as_index(selector, where)
        if not 0 <= index < len(chains):
            raise IndexError("Chain index out of range at {0}".format(where))
        return chains[index].devices

    def _describe_parameter(self, index, param):
        """Parameter details: value and range, plus labels for quantized parameters and the display string."""
        info = {"index": index, "name": param.name, "value": param.value, "min": param.min, "max": param.max,
                "is_quantized": bool(param.is_quantized), "is_enabled": bool(param.is_enabled)}
        try:
            info["display"] = param.str_for_value(param.value)
        except Exception:
            pass
        if info["is_quantized"]:
            try:
                info["value_items"] = list(param.value_items)
            except Exception:
                pass
        else:
            try:
                info["default"] = param.default_value
            except Exception:
                pass
        return info

    def _describe_device_structure(self, device):
        """For racks: chains, return chains and occupied drum pads, so device_path targets are discoverable."""
        info = {"can_have_chains": bool(getattr(device, "can_have_chains", False)),
                "can_have_drum_pads": bool(getattr(device, "can_have_drum_pads", False))}
        if not info["can_have_chains"]:
            return info
        
        def chain_info(chains):
            return [{"index": i, "name": chain.name, "device_count": len(chain.devices),
                     "devices": [d.name for d in chain.devices]} for i, chain in enumerate(chains)]
        
        info["chains"] = chain_info(device.chains)
        return_chains = _safe_attr(device, "return_chains")
        if return_chains is not None:
            info["return_chains"] = chain_info(return_chains)
        if info["can_have_drum_pads"]:
            info["drum_pads"] = [{"note": pad.note, "name": pad.name, "chain_count": len(pad.chains),
                                  "device_count": sum(len(chain.devices) for chain in pad.chains)}
                                 for pad in device.drum_pads if len(pad.chains)]
        return info

    def _get_device_type(self, device):
        """Classify a device: drum_machine, rack, instrument, audio_effect, midi_effect or unknown."""
        try:
            if device.can_have_drum_pads:
                return "drum_machine"
            if device.can_have_chains:
                return "rack"
            return {1: "instrument", 2: "audio_effect", 4: "midi_effect"}.get(int(device.type), "unknown")
        except Exception:
            return "unknown"
