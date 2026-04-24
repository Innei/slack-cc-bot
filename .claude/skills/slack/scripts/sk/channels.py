"""Channel resolution helpers.

Chunk 3 provides on-demand lookup via ``conversations.list``.  Chunk 4
layers a persistent cache on top via :func:`resolve_channel`:

1. If the token is a channel id, try ``cache.load_channels`` first.
2. If the token is a ``#name`` / ``name``, scan the cache dict.
3. Fall back to live ``conversations.info`` / ``conversations.list``.

Callers of :func:`resolve_channel` need not change.
"""

from __future__ import annotations

from typing import Any, Optional

from . import cache
from .client import SlackClient
from .config import Config
from .errors import InvalidArgument, SlackAPIError


# Cap the live lookup.  A workspace with > ~10k channels is unusual, and
# `conversations.list` pages at 1000 per call.  This is a safety brake so a
# misconfigured ``#name`` lookup doesn't silently scan the whole workspace.
_MAX_LIST_PAGES = 15
_LIST_PAGE_SIZE = 1000


def normalise_channel_token(token: str) -> str:
    """Strip the leading ``#`` from a user-typed channel reference."""
    token = token.strip()
    if token.startswith("#"):
        return token[1:]
    return token


def looks_like_channel_id(token: str) -> bool:
    """``True`` iff *token* has the shape of a Slack channel id."""
    if not token:
        return False
    return token[0] in ("C", "G", "D") and token[1:].isalnum() and token.isupper()


def resolve_channel(
    client: SlackClient,
    channel: str,
    *,
    cfg: Optional[Config] = None,
) -> dict[str, Any]:
    """Resolve a user-supplied channel reference to a channel object.

    Accepts:
    - ``C0XXXX`` / ``G0XXXX`` / ``D0XXXX`` (cache → ``conversations.info`` fallback)
    - ``#name`` or bare ``name`` (cache scan → ``conversations.list`` fallback)

    Raises :class:`InvalidArgument` if the channel cannot be found.
    """
    if not channel:
        raise InvalidArgument("--channel cannot be empty")

    cfg = cfg or Config()
    cached = cache.load_channels(cfg.cache_dir)

    if looks_like_channel_id(channel):
        hit = cached.get(channel)
        if hit:
            return hit
        try:
            payload = client.call("conversations.info", channel=channel)
        except SlackAPIError as err:
            raise InvalidArgument(
                f"channel {channel!r} not accessible: {err.error}"
            ) from err
        ch = payload.get("channel") or {}
        if not ch:
            raise InvalidArgument(f"channel {channel!r} not found")
        return ch

    name = normalise_channel_token(channel)
    if not name:
        raise InvalidArgument(f"channel name {channel!r} is empty after stripping '#'")

    # Cache scan first.
    for ch in cached.values():
        if ch.get("name") == name or ch.get("name_normalized") == name:
            return ch

    # Live scan fallback (also populates nothing — caller runs cache_refresh
    # separately if they want to persist).
    cursor = ""
    scanned = 0
    for _page in range(_MAX_LIST_PAGES):
        params: dict[str, Any] = {
            "types": "public_channel,private_channel",
            "limit": _LIST_PAGE_SIZE,
            "exclude_archived": True,
        }
        if cursor:
            params["cursor"] = cursor
        payload = client.call("conversations.list", **params)
        for ch in payload.get("channels") or []:
            scanned += 1
            if ch.get("name") == name or ch.get("name_normalized") == name:
                return ch
        cursor = (
            (payload.get("response_metadata") or {}).get("next_cursor") or ""
        ).strip()
        if not cursor:
            break

    hint = "" if cached else " (cache empty — run `slack.py cache_refresh` once)"
    raise InvalidArgument(
        f"channel #{name} not found after scanning {scanned} channels{hint}. "
        f"Check the spelling, make sure the bot is invited, or pass the "
        f"channel ID (C0...) directly."
    )


__all__ = [
    "resolve_channel",
    "normalise_channel_token",
    "looks_like_channel_id",
]
