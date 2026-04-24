"""Time / limit parsing helpers for Slack subcommands."""

from __future__ import annotations

import re
import time
from typing import Optional


# ``--limit 20``  → count-mode (20 messages, no time bound)
# ``--limit 1d``  → time-mode  (last 1 day, no count bound)
# ``--limit 7d``  → time-mode  (last 7 days)
# ``--limit 2h``  → time-mode  (last 2 hours)  [bonus, cheap to support]
# ``--limit 30m`` → time-mode  (last 30 minutes)
#
# The unit suffixes are intentionally a small whitelist; anything else raises
# InvalidArgument upstream so typos don't silently become valid counts.

_UNIT_SECONDS = {
    "m": 60,
    "h": 60 * 60,
    "d": 60 * 60 * 24,
    "w": 60 * 60 * 24 * 7,
}

_TIME_RE = re.compile(r"^(?P<n>\d+)(?P<unit>[mhdw])$")
_COUNT_RE = re.compile(r"^\d+$")

# Default when the user doesn't pass --limit at all.  20 matches Slack's
# default "unread" batch size.
DEFAULT_COUNT_LIMIT = 20


def parse_limit(raw: Optional[str]) -> tuple[Optional[int], Optional[float]]:
    """Parse a ``--limit`` argument.

    Returns ``(count, oldest_ts)`` where:
    - ``count`` is an int message cap (or ``None`` if time-mode)
    - ``oldest_ts`` is a Slack-style epoch float (or ``None`` if count-mode)

    Exactly one of the two will be non-None.  Passing ``None`` / empty returns
    ``(DEFAULT_COUNT_LIMIT, None)``.

    Raises ``ValueError`` for unrecognised formats — callers should wrap into
    :class:`sk.errors.InvalidArgument` with a helpful hint.
    """
    if not raw:
        return DEFAULT_COUNT_LIMIT, None

    s = raw.strip().lower()

    if _COUNT_RE.match(s):
        n = int(s)
        if n <= 0:
            raise ValueError(f"--limit must be positive, got {raw!r}")
        return n, None

    m = _TIME_RE.match(s)
    if m:
        n = int(m.group("n"))
        unit = m.group("unit")
        if n <= 0:
            raise ValueError(f"--limit must be positive, got {raw!r}")
        oldest = time.time() - n * _UNIT_SECONDS[unit]
        return None, oldest

    raise ValueError(
        f"--limit {raw!r} is not a count (e.g. '20') or a duration "
        f"(e.g. '1d', '2h', '30m', '1w')"
    )


__all__ = ["parse_limit", "DEFAULT_COUNT_LIMIT"]
