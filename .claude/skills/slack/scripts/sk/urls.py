"""Slack permalink / archive-URL parsing."""

from __future__ import annotations

import re
import urllib.parse
from typing import Optional

from .errors import InvalidArgument


# /archives/C0XXX/p1712345678901234  ← message permalink
_MESSAGE_PATH = re.compile(r"^/archives/([A-Z0-9]+)/p(\d+)/?$")
# /archives/C0XXX or /archives/C0XXX/  ← channel root
_CHANNEL_PATH = re.compile(r"^/archives/([A-Z0-9]+)/?$")


def _ts_from_p(raw: str) -> str:
    if len(raw) <= 6:
        raise InvalidArgument(f"invalid Slack permalink timestamp: p{raw}")
    return f"{raw[:-6]}.{raw[-6:]}"


def parse_permalink(url: str) -> dict:
    """Parse a Slack message permalink.

    Returns a dict::

        {"channel_id": "C0...", "ts": "1712345678.901234", "thread_ts": "<parent_ts or same as ts>"}

    ``thread_ts`` comes from the ``?thread_ts=`` query param when present
    (Slack adds it for replies); otherwise it equals ``ts`` (message is root).
    """
    if not url:
        raise InvalidArgument("empty url")

    parsed = urllib.parse.urlparse(url)
    match = _MESSAGE_PATH.match(parsed.path)
    if not match:
        raise InvalidArgument(
            f"not a Slack message permalink (expected /archives/<C>/p<ts>): {url}"
        )

    channel_id = match.group(1)
    ts = _ts_from_p(match.group(2))

    query = urllib.parse.parse_qs(parsed.query)
    thread_ts_raw = (query.get("thread_ts") or [None])[0]
    thread_ts = thread_ts_raw if thread_ts_raw else ts

    return {"channel_id": channel_id, "ts": ts, "thread_ts": thread_ts, "permalink": url}


def parse_channel_url(url: str) -> str:
    """Return channel ID from a ``/archives/<C>`` URL."""
    parsed = urllib.parse.urlparse(url)
    match = _CHANNEL_PATH.match(parsed.path)
    if not match:
        raise InvalidArgument(f"not a Slack channel URL: {url}")
    return match.group(1)


def looks_like_channel_id(value: str) -> bool:
    return bool(value) and bool(re.match(r"^[CGD][A-Z0-9]{6,}$", value))


def looks_like_user_id(value: str) -> bool:
    return bool(value) and bool(re.match(r"^[UW][A-Z0-9]{6,}$", value))


def workspace_base_from_permalink(url: str) -> Optional[str]:
    """Return ``https://foo.slack.com/`` prefix if parseable, else None."""
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return None
    if not parsed.scheme or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}/"


__all__ = [
    "parse_permalink",
    "parse_channel_url",
    "looks_like_channel_id",
    "looks_like_user_id",
    "workspace_base_from_permalink",
]
