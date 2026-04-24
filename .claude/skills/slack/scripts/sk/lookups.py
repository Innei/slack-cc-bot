"""Cache-aware lookup factory used by every read command.

Centralises the logic for ``channel_lookup`` / ``subteam_lookup`` /
``user_lookup`` construction so cmd_get, cmd_replies, cmd_history and
future commands all behave identically.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from . import cache
from .config import Config


def build_lookups(
    cfg: Config,
    user_names: dict[str, str],
) -> tuple[
    Callable[[str], Optional[str]],
    Callable[[str], Optional[str]],
    Callable[[str], Optional[str]],
    dict[str, dict[str, Any]],
]:
    """Return ``(user_lookup, channel_lookup, subteam_lookup, cache_users)``.

    - ``user_lookup`` prefers in-memory *user_names* from :func:`sk.mentions
      .preload_users` (already cache-backed when available) and falls back
      to the on-disk cache for ids the command didn't bother preloading.
    - ``channel_lookup`` / ``subteam_lookup`` are cache-only — the render
      pass must stay fast and these names are stable enough that a stale
      cache is better than a live API call per mention.
    - ``cache_users`` is returned so callers can thread it into
      ``preload_users`` for the next message batch.
    """
    cache_users = cache.load_users(cfg.cache_dir)
    cache_channels = cache.load_channels(cfg.cache_dir)
    cache_subteams = cache.load_subteams(cfg.cache_dir)

    def user_lookup(uid: str) -> Optional[str]:
        name = user_names.get(uid)
        if name:
            return name
        return cache.user_display_name(cache_users.get(uid) or {})

    def channel_lookup(cid: str) -> Optional[str]:
        return cache.channel_display_name(cache_channels.get(cid) or {})

    def subteam_lookup(sid: str) -> Optional[str]:
        return cache.subteam_handle(cache_subteams.get(sid) or {})

    return user_lookup, channel_lookup, subteam_lookup, cache_users


__all__ = ["build_lookups"]
