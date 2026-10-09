"""Browsing, searching-support and loading from Live's browser.

Live has no browser search and its tree is huge (tens of thousands of presets), so listing is paged and the walk that
feeds a search index is chunked: browser_walk visits nodes for a few milliseconds per call and hands back a token to continue,
which keeps Live's main thread responsive. The search index itself lives in the MCP server (TypeScript).

Loading goes through Live's own selection: the target track (or clip slot, or device for a hot-swap) is selected first, then
Browser.load_item runs, so loading changes what is selected in Live's window.
"""
from . import clock
from .helpers import _safe_attr
from .registry import BridgeError, command

DEFAULT_WALK_ROOTS = ("instruments", "audio_effects", "midi_effects", "drums", "sounds", "max_for_live", "user_library", "packs")
# Browser properties that are plain lists of items, not roots with children: the folders added to Live's sidebar, old libraries and the
# colour collections (Favorites). They are wrapped as roots so they list, search and load like the rest.
VECTOR_ROOTS = ("user_folders", "legacy_libraries", "colors")
ALL_ROOTS = ("instruments", "sounds", "drums", "audio_effects", "midi_effects", "samples", "user_library", "current_project", "clips",
             "packs", "plugins", "max_for_live") + VECTOR_ROOTS
MAX_WALK_DEPTH = 12
LOAD_ACTIONS = ("load", "preview", "stop_preview")


def _item_record(item, path):
    return {"name": item.name, "path": path, "uri": _safe_attr(item, "uri"), "is_folder": bool(_safe_attr(item, "is_folder", False)),
            "is_device": bool(_safe_attr(item, "is_device", False)), "is_loadable": bool(_safe_attr(item, "is_loadable", False))}


class _ListRoot(object):
    """A list of browser items presented as a root folder."""
    is_folder, is_loadable, is_device, uri = True, False, False, None

    def __init__(self, name, items):
        self.name, self.children = name, list(items)


class BrowseMixin(object):
    """browse, browser_walk, load_item."""

    _walks = None

    def _browser(self):
        app = self.application()
        browser = _safe_attr(app, "browser")
        if browser is None:
            raise BridgeError("The browser is not available", "UNAVAILABLE")
        return browser

    def _root_items(self, browser, names=ALL_ROOTS):
        roots = []
        for name in names:
            root = _safe_attr(browser, name)
            if root is not None and name in VECTOR_ROOTS:
                roots.append((name, _ListRoot(name, root)))
            elif root is not None and hasattr(root, "children"):
                roots.append((name, root))
        return roots

    def _navigate(self, browser, path):
        """The browser item at 'root/folder/item' (names compared without regard to case) and its canonical path."""
        parts = [p for p in (path or "").strip().strip("/").split("/") if p]
        if not parts:
            raise BridgeError("path must start with a root: {0}".format(", ".join(n for n, _ in self._root_items(browser))), "INVALID_ARGUMENT")
        roots = dict(self._root_items(browser))
        root_name = parts[0].lower()
        if root_name not in roots:
            raise BridgeError("Unknown browser root '{0}'. Roots: {1}".format(parts[0], ", ".join(sorted(roots))), "NOT_FOUND")
        item, canonical = roots[root_name], [root_name]
        for part in parts[1:]:
            children = list(item.children)
            exact = [c for c in children if c.name == part]
            match = exact or [c for c in children if c.name.lower() == part.lower()]
            if not match:
                near = [c.name for c in children if part.lower() in c.name.lower()][:8]
                raise BridgeError("'{0}' not found in '{1}'.{2}".format(part, "/".join(canonical),
                                                                        " Similar: {0}".format(near) if near else ""), "NOT_FOUND")
            item = match[0]
            canonical.append(item.name)
        return item, "/".join(canonical)

    # ---- browse

    @command("browse")
    def _cmd_browse(self, params):
        browser = self._browser()
        path = params.get("path", "")
        limit, offset, kind = params.get("limit", 100), params.get("offset", 0), params.get("kind", "all")
        for name, value, low in (("limit", limit, 1), ("offset", offset, 0)):
            if isinstance(value, bool) or not isinstance(value, int) or value < low:
                raise BridgeError("{0} must be a whole number from {1}".format(name, low), "INVALID_ARGUMENT")
        if kind not in ("all", "folders", "loadable", "devices"):
            raise BridgeError("kind must be one of: all, folders, loadable, devices", "INVALID_ARGUMENT")
        if not path or not path.strip("/"):
            return {"path": "", "roots": [{"name": n, "path": n, "uri": _safe_attr(r, "uri"), "child_count": len(list(r.children))}
                                          for n, r in self._root_items(browser)]}
        item, canonical = self._navigate(browser, path)
        children = list(item.children)
        wanted = {"all": lambda r: True, "folders": lambda r: r["is_folder"] or r["has_children"], "loadable": lambda r: r["is_loadable"],
                  "devices": lambda r: r["is_device"]}[kind]
        records = []
        for child in children:
            record = _item_record(child, "{0}/{1}".format(canonical, child.name))
            record["has_children"] = len(list(child.children)) > 0 if len(children) <= 400 else None
            if wanted(record):
                records.append(record)
        page = records[offset:offset + limit]
        return {"path": canonical, "name": item.name, "uri": _safe_attr(item, "uri"), "is_loadable": bool(_safe_attr(item, "is_loadable", False)),
                "total": len(records), "offset": offset, "truncated": offset + len(page) < len(records), "items": page}

    # ---- browser_walk

    @command("browser_walk")
    def _cmd_browser_walk(self, params):
        """A slice of a depth-first walk: a few milliseconds of visiting per call, so Live stays responsive. Start without a
        token; keep calling with the returned token until `done`."""
        if self._walks is None:
            self._walks = {}
        budget_ms = params.get("budget_ms", 20)
        max_items = params.get("max_items", 1000)
        for name, value, low, high in (("budget_ms", budget_ms, 1, 200), ("max_items", max_items, 10, 5000)):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
                raise BridgeError("{0} must be a number from {1} to {2}".format(name, low, high), "INVALID_ARGUMENT")
        token = params.get("token")
        if token is None:
            names = params.get("roots") or list(DEFAULT_WALK_ROOTS)
            if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
                raise BridgeError("roots must be a list of root names", "INVALID_ARGUMENT")
            unknown = [n for n in names if n not in ALL_ROOTS]
            if unknown:
                raise BridgeError("Unknown roots {0}. Roots: {1}".format(unknown, ", ".join(ALL_ROOTS)), "INVALID_ARGUMENT")
            depth = params.get("max_depth", 8)
            if isinstance(depth, bool) or not isinstance(depth, int) or not 1 <= depth <= MAX_WALK_DEPTH:
                raise BridgeError("max_depth must be a whole number from 1 to {0}".format(MAX_WALK_DEPTH), "INVALID_ARGUMENT")
            browser = self._browser()
            available = self._root_items(browser, names)
            token = "walk{0}".format(len(self._walks) + int(clock.now() * 1000) % 100000)
            self._walks = dict(list(self._walks.items())[-3:])                  # abandoned walks do not pile up
            self._walks[token] = {"stack": [(root, name, 1) for name, root in reversed(available)], "max_depth": depth, "visited": 0}
        state = self._walks.get(token)
        if state is None:
            raise BridgeError("The walk '{0}' expired: start a new one".format(token), "NOT_FOUND")
        started, out = clock.now(), []
        while state["stack"] and len(out) < max_items and (clock.now() - started) * 1000.0 < budget_ms:
            item, path, depth = state["stack"].pop()
            out.append(_item_record(item, path))
            if depth < state["max_depth"]:
                children = list(item.children)
                for child in reversed(children):
                    state["stack"].append((child, "{0}/{1}".format(path, child.name), depth + 1))
        state["visited"] += len(out)
        done = not state["stack"]
        if done:
            self._walks.pop(token, None)
        return {"token": token, "done": done, "visited": state["visited"], "pending": len(state["stack"]), "items": out}

    # ---- load_item

    def _find_item(self, browser, params):
        path, uri = params.get("path"), params.get("uri")
        if (path is None) == (uri is None):
            raise BridgeError("give exactly one of path (from browse or search) or uri", "INVALID_ARGUMENT")
        if path is not None:
            return self._navigate(browser, path)[0]
        item = self._find_browser_item_by_uri(browser, uri)
        if item is None:
            raise BridgeError("No browser item with uri '{0}'. Use a path from browse/search: finding an item by uri walks the whole browser and is slow".format(uri),
                              "NOT_FOUND")
        return item

    @command("load_item", writes=True)
    def _cmd_load_item(self, params):
        action = params.get("action", "load")
        if action not in LOAD_ACTIONS:
            raise BridgeError("action must be one of: {0}".format(", ".join(LOAD_ACTIONS)), "INVALID_ARGUMENT")
        browser = self._browser()
        if action == "stop_preview":
            browser.stop_preview()
            return {"action": action}
        item = self._find_item(browser, params)
        if action == "preview":
            browser.preview_item(item)
            return {"action": action, "name": item.name, "is_loadable": bool(_safe_attr(item, "is_loadable", False))}
        if not _safe_attr(item, "is_loadable", False):
            raise BridgeError("'{0}' cannot be loaded: it is a folder or category (browse into it for loadable items)".format(item.name), "INVALID_ARGUMENT")
        kind, target, canonical = self._resolve(params.get("target"))
        view = self._song.view
        if kind == "track":
            before = list(target.devices)
            view.selected_track = target
            browser.load_item(item)
            added = [d for d in target.devices if not any(d == b for b in before)]
            return {"action": "load", "name": item.name, "target": canonical, "added": [{"address": self._address_of(d), "name": d.name} for d in added],
                    "devices": [d.name for d in target.devices]}
        if kind == "slot":
            track_address = canonical.rsplit("/slots/", 1)[0]
            view.selected_track = self._resolve(track_address)[1]
            view.highlighted_clip_slot = target
            browser.load_item(item)
            return {"action": "load", "name": item.name, "target": canonical, "has_clip": bool(target.has_clip),
                    "clip": canonical + "/clip" if target.has_clip else None}
        if kind == "device":
            host, _index = self._host(target, canonical)
            before = [d.name for d in host.devices]
            browser.hotswap_target = target
            try:
                browser.load_item(item)
            finally:
                try:
                    browser.hotswap_target = None
                except Exception:
                    pass
            return {"action": "load", "name": item.name, "target": canonical, "hotswapped": True, "devices_before": before,
                    "devices": [d.name for d in host.devices]}
        raise BridgeError("target must be a track, return track, master (loads a device or preset), a clip slot (loads a sample) "
                          "or a device (hot-swap), got '{0}' which is a {1}".format(canonical, kind), "INVALID_ARGUMENT")
