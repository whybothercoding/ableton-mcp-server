"""Addresses below a track: devices, rack chains, drum pads and parameters.

    tracks/3/devices/0                        a device (also returns/N/devices/M and master/devices/M)
    tracks/3/devices/name:EQ Eight            ... by exact name
    <device>/parameters/5                     a parameter by index, or parameters/name:Frequency
    <device>/chains/1                         a rack chain (chains/name:Wide);  <device>/return_chains/0
    <device>/drum_pads/36                     a drum pad, by MIDI note
    <device>/sample                           a Simpler's sample (slices, markers, warp settings)
    <device>/drum_pads/36/chains/0            a chain of that pad
    <chain>/devices/2                         a device inside a chain (racks nest as deep as they go)
    tracks/3/mixer/volume                     mixer parameters of a track or chain: volume, panning, sends/0, crossfader,
                                              cue_volume, track_activator, chain_activator, song_tempo
"""
import Live

from .helpers import _safe_attr
from .registry import BridgeError

MIXER_PARAMETERS = ("volume", "panning", "crossfader", "cue_volume", "track_activator", "chain_activator", "song_tempo",
                    "left_split_stereo", "right_split_stereo")


def _lom_class(module, name):
    try:
        return getattr(getattr(Live, module), name)
    except AttributeError:
        return None


def _is(obj, module, name):
    cls = _lom_class(module, name)
    return cls is not None and isinstance(obj, cls)


class DeviceAddressingMixin(object):
    """Resolve device-level addresses and name device-level objects."""

    def _unknown(self, address):
        return BridgeError("Unknown address '{0}'".format(address), "NOT_FOUND")

    def _resolve_devices(self, owner, canonical, parts, address):
        """`parts` starts at 'devices'; owner is a track or a chain."""
        if len(parts) < 2 or parts[0] != "devices":
            raise self._unknown(address)
        devices = list(owner.devices)
        index = self._select(devices, parts[1], "device", lambda d: d.name)
        return self._resolve_in_device(devices[index], "{0}/devices/{1}".format(canonical, index), parts[2:], address)

    def _resolve_in_device(self, device, canonical, rest, address):
        if not rest:
            return "device", device, canonical
        head = rest[0]
        if head == "view" and len(rest) == 1:
            return "device_view", device.view, canonical + "/view"
        if head == "sample" and len(rest) == 1:
            sample = _safe_attr(device, "sample")
            if sample is None:
                raise BridgeError("'{0}' has no sample loaded".format(device.name), "NOT_FOUND")
            return "sample", sample, canonical + "/sample"
        if head == "parameters" and len(rest) == 2:
            parameters = list(device.parameters)
            index = self._select(parameters, rest[1], "parameter", lambda p: p.name)
            return "parameter", parameters[index], "{0}/parameters/{1}".format(canonical, index)
        if head in ("chains", "return_chains") and len(rest) >= 2:
            if not _safe_attr(device, "can_have_chains", False):
                raise BridgeError("'{0}' is not a rack: it has no {1}".format(device.name, head), "INVALID_ARGUMENT")
            chains = list(device.chains if head == "chains" else device.return_chains)
            index = self._select(chains, rest[1], "chain", lambda c: c.name)
            return self._resolve_in_chain(chains[index], "{0}/{1}/{2}".format(canonical, head, index), rest[2:], address)
        if head == "drum_pads" and len(rest) >= 2:
            if not _safe_attr(device, "can_have_drum_pads", False):
                raise BridgeError("'{0}' is not a Drum Rack: it has no drum pads".format(device.name), "INVALID_ARGUMENT")
            note = self._number(rest[1], address)
            pad = next((p for p in device.drum_pads if p.note == note), None)
            if pad is None:
                raise BridgeError("Drum pad {0} does not exist (notes 0 to 127)".format(note), "OUT_OF_RANGE")
            pad_address = "{0}/drum_pads/{1}".format(canonical, note)
            if len(rest) == 2:
                return "pad", pad, pad_address
            if rest[2] == "chains" and len(rest) >= 4:
                chains = list(pad.chains)
                if not chains:
                    raise BridgeError("Drum pad {0} is empty: it has no chains".format(note), "NOT_FOUND")
                index = self._select(chains, rest[3], "chain", lambda c: c.name)
                return self._resolve_in_chain(chains[index], "{0}/chains/{1}".format(pad_address, index), rest[4:], address)
        raise self._unknown(address)

    def _resolve_in_chain(self, chain, canonical, rest, address):
        if not rest:
            return "chain", chain, canonical
        if rest[0] == "devices":
            return self._resolve_devices(chain, canonical, rest, address)
        if rest[0] == "mixer":
            return self._resolve_mixer(chain, canonical, rest, address)
        raise self._unknown(address)

    def _resolve_mixer(self, owner, canonical, rest, address):
        """`rest` starts at 'mixer': mixer/<name> or mixer/sends/<n>."""
        mixer = owner.mixer_device
        if len(rest) == 2 and rest[1] in MIXER_PARAMETERS:
            parameter = _safe_attr(mixer, rest[1])
            if parameter is None:
                raise BridgeError("'{0}' has no mixer parameter '{1}'".format(canonical, rest[1]), "NOT_FOUND")
            return "parameter", parameter, "{0}/mixer/{1}".format(canonical, rest[1])
        if len(rest) == 3 and rest[1] == "sends":
            sends = list(_safe_attr(mixer, "sends", []))
            index = self._number(rest[2], address)
            if not 0 <= index < len(sends):
                raise BridgeError("Send index {0} out of range (0 to {1})".format(index, len(sends) - 1), "OUT_OF_RANGE")
            return "parameter", sends[index], "{0}/mixer/sends/{1}".format(canonical, index)
        raise self._unknown(address)

    # ---- the reverse: name a device-level object by walking its parents

    def _address_of_lom(self, obj, depth=0):
        """The address of a device, chain, drum pad or parameter, found through canonical_parent; None if it is none of those."""
        if depth > 16:
            return None
        parent = _safe_attr(obj, "canonical_parent")
        if _is(obj, "Device", "Device"):
            base = self._address_of(parent) if parent is not None else None
            if base is None:
                return None
            for index, device in enumerate(parent.devices):
                if device == obj:
                    return "{0}/devices/{1}".format(base, index)
            return None
        if _is(obj, "Chain", "Chain"):
            rack = parent
            base = self._address_of(rack) if rack is not None else None
            if base is None:
                return None
            for group in ("chains", "return_chains"):
                for index, chain in enumerate(_safe_attr(rack, group, [])):
                    if chain == obj:
                        return "{0}/{1}/{2}".format(base, group, index)
            for pad in _safe_attr(rack, "drum_pads", []):
                for index, chain in enumerate(pad.chains):
                    if chain == obj:
                        return "{0}/drum_pads/{1}/chains/{2}".format(base, pad.note, index)
            return None
        if _is(obj, "Sample", "Sample"):
            base = self._address_of(parent) if parent is not None else None
            return None if base is None else base + "/sample"
        if _is(obj, "DrumPad", "DrumPad"):
            base = self._address_of(parent) if parent is not None else None
            return None if base is None else "{0}/drum_pads/{1}".format(base, obj.note)
        if _is(obj, "DeviceParameter", "DeviceParameter"):
            if parent is None:
                return None
            if _is(parent, "Device", "Device"):
                base = self._address_of(parent)
                if base is None:
                    return None
                for index, parameter in enumerate(parent.parameters):
                    if parameter == obj:
                        return "{0}/parameters/{1}".format(base, index)
                return None
            owner = _safe_attr(parent, "canonical_parent")            # a mixer device: its owner is a track or chain
            base = self._address_of(owner) if owner is not None else None
            if base is None:
                return None
            for name in MIXER_PARAMETERS:
                if _safe_attr(parent, name) == obj:
                    return "{0}/mixer/{1}".format(base, name)
            for index, send in enumerate(_safe_attr(parent, "sends", [])):
                if send == obj:
                    return "{0}/mixer/sends/{1}".format(base, index)
        return None
