"""Pure curve and automation-step math (unit-tested without Live)."""
import math


CURVES = ("linear", "step", "smooth", "ease_in", "ease_out")
MAX_AUTOMATION_STEPS = 20000
_EPS = 1e-9


from .helpers import _is_number


def _ease(curve, x):
    """Map progress x in [0, 1] to eased progress for the named curve."""
    if curve == "linear":
        return x
    if curve == "smooth":
        return x * x * (3.0 - 2.0 * x)
    if curve == "ease_in":
        return x * x
    if curve == "ease_out":
        return 1.0 - (1.0 - x) * (1.0 - x)
    raise ValueError("curve must be one of: " + ", ".join(CURVES))


def _normalize_points(points, clip_length, lo, hi):
    """Validate and time-sort automation points ({time, value[, curve]})."""
    if not isinstance(points, list) or not points:
        raise ValueError("points must be a non-empty list of {time, value} objects")
    cleaned = []
    for i, point in enumerate(points):
        if not isinstance(point, dict):
            raise ValueError("points[{0}] must be an object with time and value".format(i))
        time_beats, value = point.get("time"), point.get("value")
        if not _is_number(time_beats) or not _is_number(value):
            raise ValueError("points[{0}] needs numeric time and value".format(i))
        if time_beats < -_EPS or time_beats > clip_length + _EPS:
            raise ValueError("points[{0}].time {1} is outside the clip (0 to {2} beats)".format(i, time_beats, clip_length))
        if value < lo - _EPS or value > hi + _EPS:
            raise ValueError("points[{0}].value {1} is outside the parameter range {2} to {3}".format(i, value, lo, hi))
        curve = point.get("curve")
        if curve is not None and curve not in CURVES:
            raise ValueError("points[{0}].curve must be one of: {1}".format(i, ", ".join(CURVES)))
        cleaned.append({"time": min(max(float(time_beats), 0.0), float(clip_length)),
                        "value": min(max(float(value), lo), hi), "curve": curve, "order": i})
    cleaned.sort(key=lambda point: (point["time"], point["order"]))
    return cleaned


def _build_steps(points, default_curve, resolution, clip_length, hold):
    """Turn normalized points into [(start, length, value)] envelope steps.

    A ramp segment is a staircase whose first step is exactly its start value and whose last
    step is exactly its end value. With hold, the clip's edges are filled so the whole clip
    is defined."""
    if default_curve not in CURVES:
        raise ValueError("curve must be one of: " + ", ".join(CURVES))
    if not _is_number(resolution) or resolution <= 0:
        raise ValueError("resolution must be a positive number of beats")
    steps = []
    first, last = points[0], points[-1]
    if hold and first["time"] > _EPS:
        steps.append((0.0, first["time"], first["value"]))
    for i in range(len(points) - 1):
        a, b = points[i], points[i + 1]
        segment = b["time"] - a["time"]
        if segment <= _EPS:
            continue
        curve = a["curve"] or default_curve
        if curve == "step":
            steps.append((a["time"], segment, a["value"]))
            continue
        count = max(1, int(math.ceil(segment / resolution - 1e-9)))
        length = segment / count
        for k in range(count):
            # First step is exactly a, last step exactly b (a lone step takes a)
            progress = k / float(count - 1) if count > 1 else 0.0
            steps.append((a["time"] + k * length, length, a["value"] + (b["value"] - a["value"]) * _ease(curve, progress)))
    tail = clip_length - last["time"]
    if tail > _EPS:
        steps.append((last["time"], tail if hold else min(resolution, tail), last["value"]))
    if not steps:
        raise ValueError("nothing to draw: give at least two points at different times, or one point with hold enabled")
    if len(steps) > MAX_AUTOMATION_STEPS:
        raise ValueError("{0} steps exceeds the {1} limit; use a larger resolution".format(len(steps), MAX_AUTOMATION_STEPS))
    return steps


def _build_breakpoints(points, default_curve, resolution, clip_length, hold):
    """Turn normalized points into envelope breakpoints [(time, value)], joined by straight lines in Live.

    A linear segment is just its two ends; smooth/ease segments get a breakpoint every `resolution` beats (Live draws
    straight lines between breakpoints, so this is a smooth curve, unlike a staircase). A step segment holds its start value
    up to the next point, where two breakpoints at the same time make the jump. With hold, the clip's edges are filled."""
    if default_curve not in CURVES:
        raise ValueError("curve must be one of: " + ", ".join(CURVES))
    if not _is_number(resolution) or resolution <= 0:
        raise ValueError("resolution must be a positive number of beats")
    events = []

    def add(time, value):
        if events and abs(events[-1][0] - time) <= _EPS and abs(events[-1][1] - value) <= _EPS:
            return
        events.append((time, value))

    first, last = points[0], points[-1]
    if hold and first["time"] > _EPS:
        add(0.0, first["value"])
    add(first["time"], first["value"])
    for i in range(len(points) - 1):
        a, b = points[i], points[i + 1]
        segment = b["time"] - a["time"]
        curve = a["curve"] or default_curve
        if segment <= _EPS:
            add(b["time"], b["value"])
            continue
        if curve == "step":
            add(b["time"], a["value"])
            add(b["time"], b["value"])
            continue
        if curve != "linear":
            count = max(1, int(math.ceil(segment / resolution - 1e-9)))
            for k in range(1, count):
                progress = k / float(count)
                add(a["time"] + segment * progress, a["value"] + (b["value"] - a["value"]) * _ease(curve, progress))
        add(b["time"], b["value"])
    if hold and clip_length - last["time"] > _EPS:
        add(clip_length, last["value"])
    if len(events) < 2 and not hold:
        raise ValueError("nothing to draw: give at least two points at different times, or one point with hold enabled")
    if len(events) < 2:
        events.append((min(clip_length, events[0][0] + max(resolution, _EPS)), events[0][1]))
    if len(events) > MAX_AUTOMATION_STEPS:
        raise ValueError("{0} breakpoints exceeds the {1} limit; use a larger resolution".format(len(events), MAX_AUTOMATION_STEPS))
    return events


def _eval_breakpoints(events, time):
    """The value a piecewise-linear breakpoint list has at `time` (at a jump: the value after it)."""
    if time <= events[0][0]:
        return events[0][1]
    for i in range(len(events) - 1):
        (t0, v0), (t1, v1) = events[i], events[i + 1]
        if t0 - _EPS <= time < t1 - _EPS or (abs(t1 - t0) <= _EPS and time <= t1 + _EPS and i == len(events) - 2):
            if t1 - t0 <= _EPS:
                return v1
            return v0 + (v1 - v0) * (time - t0) / (t1 - t0)
    return events[-1][1]
