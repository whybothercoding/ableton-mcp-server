"""Read-only introspection of Live's Python API, used to generate docs/live-api/<version>.json and the registry.

Only CLASS-level information is read (property descriptors, function docstrings, enum tables): no instance is touched,
nothing is called, so it cannot change the Set. Types come from the getter/setter signatures Boost.Python puts in the
docstrings ("-> float", "(int)arg2").
"""
import inspect
import re

import Live

from .registry import BridgeError, command

_RETURN_TYPE = re.compile(r"\)\s*->\s*([^\s:]+)\s*:")
_SETTER_ARG = re.compile(r"\(([^)]+)\)\s*arg2")
_SIGNATURE_LINE = re.compile(r"^\s*\w+\(.*\)\s*->\s*\S+\s*:?\s*$")
_LISTENER = re.compile(r"^(add|remove)_(\w+)_listener$")


def _first_line(text):
    for line in (text or "").strip().splitlines():
        line = line.strip()
        if line and not line.startswith("C++ signature"):
            return line[:200]
    return ""


def _property_record(prop):
    record = {"get": None, "set": None, "doc": _first_line(getattr(prop, "__doc__", None))}
    getter, setter = getattr(prop, "fget", None), getattr(prop, "fset", None)
    if getter is not None:
        match = _RETURN_TYPE.search(getter.__doc__ or "")
        record["get"] = match.group(1) if match else "?"
    if setter is not None:
        match = _SETTER_ARG.search(setter.__doc__ or "")
        record["set"] = match.group(1) if match else "?"
    return record


def _method_record(func):
    doc = getattr(func, "__doc__", None) or ""
    signatures = [line.strip().rstrip(":").strip() for line in doc.splitlines() if _SIGNATURE_LINE.match(line)]
    described = [line.strip() for line in doc.splitlines() if line.strip() and not _SIGNATURE_LINE.match(line)
                 and not line.strip().startswith(("C++ signature", "void ", "float ", "double ", "int ", "bool "))
                 and "TPyHandle" not in line and "std::" not in line]
    return {"signatures": signatures[:4], "doc": (described[0] if described else "")[:200]}


def _is_enum(cls):
    return hasattr(cls, "names") and hasattr(cls, "values") and isinstance(getattr(cls, "names"), dict)


def describe_class(cls, qualname, depth=0):
    """Describe a class: properties, methods, listener names, enums and nested classes."""
    properties, methods, listeners, nested, enums = {}, {}, set(), {}, {}
    for name in sorted(dir(cls)):
        if name.startswith("_"):
            continue
        try:
            value = getattr(cls, name)
        except Exception:
            continue
        listener = _LISTENER.match(name)
        if listener:
            listeners.add(listener.group(2))
            continue
        if name.endswith("_has_listener"):
            continue
        if isinstance(value, property):
            properties[name] = _property_record(value)
        elif inspect.isclass(value):
            if _is_enum(value):
                enums[name] = dict((k, int(v)) for k, v in value.names.items())
            elif depth < 2 and name not in ("canonical_parent",):
                nested[name] = describe_class(value, qualname + "." + name, depth + 1)
        elif callable(value):
            methods[name] = _method_record(value)
        elif isinstance(value, (int, float, str)):
            methods[name] = {"constant": value}
    record = {"qualname": qualname, "properties": properties, "methods": methods, "listeners": sorted(listeners)}
    if enums:
        record["enums"] = enums
    if nested:
        record["nested"] = nested
    return record


def describe_module(module, name):
    classes, enums, functions = {}, {}, {}
    for attr in sorted(dir(module)):
        if attr.startswith("_"):
            continue
        value = getattr(module, attr)
        if inspect.isclass(value):
            if _is_enum(value):
                enums[attr] = dict((k, int(v)) for k, v in value.names.items())
            else:
                classes[attr] = describe_class(value, "Live.{0}.{1}".format(name, attr))
        elif callable(value) and not inspect.ismodule(value):
            functions[attr] = _method_record(value)
    return {"module": name, "classes": classes, "enums": enums, "functions": functions}


class IntrospectMixin(object):
    """introspect_api: list modules, or describe one."""

    @staticmethod
    def _api_modules():
        return sorted(n for n in dir(Live) if not n.startswith("_") and inspect.ismodule(getattr(Live, n)))

    @command("introspect_api")
    def _cmd_introspect_api(self, params):
        module = params.get("module")
        app = self.application()
        if module is None:
            return {"live_version": app.get_version_string(), "build": app.get_build_id(), "modules": self._api_modules()}
        if module not in self._api_modules():
            raise BridgeError("Unknown module '{0}'. Modules: {1}".format(module, self._api_modules()), "NOT_FOUND")
        return describe_module(getattr(Live, module), module)
