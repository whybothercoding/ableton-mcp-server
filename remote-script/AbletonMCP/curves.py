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
