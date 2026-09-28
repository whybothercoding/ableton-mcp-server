"""Small pure helpers shared by every module."""
import math


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) \
        and not math.isnan(value) and not math.isinf(value)


def _safe_attr(obj, name, default=None):
    """getattr that also swallows Live's RuntimeError for attributes a track type doesn't have."""
    try:
        return getattr(obj, name)
    except Exception:
        return default


def _as_index(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
        raise ValueError("{0} must be an integer".format(name))
    return int(value)
