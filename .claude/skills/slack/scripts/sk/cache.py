"""Local filesystem cache for users / channels / usergroups.

Chunk 4: ``cache_refresh`` populates the cache by paging through
``users.list`` / ``conversations.list`` / ``usergroups.list``; all other
commands consult :func:`load_users` / :func:`load_channels` /
:func:`load_subteams` opportunistically to avoid live API calls.

Design
------
- One JSON file per dictionary: ``users.json``, ``channels.json``,
  ``subteams.json`` inside ``$PWD/.agent-slack/cache/slack/`` (overridable
  via ``SLACK_SKILL_CACHE_DIR``).
- Atomic writes: write to ``<name>.json.tmp`` then ``os.replace`` to
  target; crash-safe, no partial files.
- Each file stores ``{"refreshed_at": <epoch>, "items": {id: {...}}}``;
  ``refreshed_at`` powers the TTL check in :func:`is_stale`.
- Default TTL: 3 days (override via ``SLACK_SKILL_CACHE_TTL`` seconds).
- The cache layer is **read-only for most commands**.  Only
  ``cmd_cache_refresh`` writes.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Optional


DEFAULT_TTL_SECONDS = 3 * 24 * 60 * 60
ENV_TTL = "SLACK_SKILL_CACHE_TTL"


def _default_ttl() -> int:
    raw = os.environ.get(ENV_TTL, "").strip()
    if not raw:
        return DEFAULT_TTL_SECONDS
    try:
        n = int(raw)
        return n if n > 0 else DEFAULT_TTL_SECONDS
    except ValueError:
        return DEFAULT_TTL_SECONDS


def _path(cache_dir: Path, name: str) -> Path:
    return cache_dir / f"{name}.json"


def _load_file(cache_dir: Path, name: str) -> dict[str, Any]:
    p = _path(cache_dir, name)
    try:
        with p.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {"refreshed_at": 0, "items": {}}
    except (OSError, json.JSONDecodeError):
        # Corrupt file — treat as empty and let cache_refresh overwrite.
        return {"refreshed_at": 0, "items": {}}


def _save_file(cache_dir: Path, name: str, payload: dict[str, Any]) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    target = _path(cache_dir, name)
    tmp = target.with_suffix(target.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    os.replace(tmp, target)


# ---------------------------------------------------------------------------
# Public API — readers
# ---------------------------------------------------------------------------

def load_users(cache_dir: Path) -> dict[str, dict[str, Any]]:
    """Return ``{user_id: user_obj}`` from the on-disk cache."""
    return _load_file(cache_dir, "users").get("items") or {}


def load_channels(cache_dir: Path) -> dict[str, dict[str, Any]]:
    """Return ``{channel_id: channel_obj}`` from the on-disk cache."""
    return _load_file(cache_dir, "channels").get("items") or {}


def load_subteams(cache_dir: Path) -> dict[str, dict[str, Any]]:
    """Return ``{subteam_id: subteam_obj}`` from the on-disk cache."""
    return _load_file(cache_dir, "subteams").get("items") or {}


def refreshed_at(cache_dir: Path, name: str) -> float:
    """Epoch seconds when *name* was last refreshed (0 if never)."""
    return float(_load_file(cache_dir, name).get("refreshed_at") or 0)


def is_stale(cache_dir: Path, name: str, ttl: Optional[int] = None) -> bool:
    """``True`` if *name*'s cache is missing or older than *ttl* seconds."""
    ttl = ttl if ttl is not None else _default_ttl()
    age = time.time() - refreshed_at(cache_dir, name)
    return age > ttl


# ---------------------------------------------------------------------------
# Public API — writers (only used by cmd_cache_refresh)
# ---------------------------------------------------------------------------

def save_users(cache_dir: Path, items: dict[str, dict[str, Any]]) -> None:
    _save_file(
        cache_dir,
        "users",
        {"refreshed_at": time.time(), "count": len(items), "items": items},
    )


def save_channels(cache_dir: Path, items: dict[str, dict[str, Any]]) -> None:
    _save_file(
        cache_dir,
        "channels",
        {"refreshed_at": time.time(), "count": len(items), "items": items},
    )


def save_subteams(cache_dir: Path, items: dict[str, dict[str, Any]]) -> None:
    _save_file(
        cache_dir,
        "subteams",
        {"refreshed_at": time.time(), "count": len(items), "items": items},
    )


# ---------------------------------------------------------------------------
# Lookup helpers that accept a cache dict and return best-effort names
# ---------------------------------------------------------------------------

def user_display_name(user_obj: dict[str, Any]) -> Optional[str]:
    """Best-effort human name from a users.info / users.list object."""
    if not user_obj:
        return None
    profile = user_obj.get("profile") or {}
    candidates = (
        (profile.get("display_name") or "").strip(),
        (user_obj.get("name") or "").strip(),
        (profile.get("real_name") or "").strip(),
        (user_obj.get("real_name") or "").strip(),
    )
    for c in candidates:
        if c:
            return c
    return None


def channel_display_name(channel_obj: dict[str, Any]) -> Optional[str]:
    if not channel_obj:
        return None
    name = (channel_obj.get("name") or channel_obj.get("name_normalized") or "").strip()
    return name or None


def subteam_handle(subteam_obj: dict[str, Any]) -> Optional[str]:
    if not subteam_obj:
        return None
    handle = (subteam_obj.get("handle") or "").strip()
    if handle:
        return handle
    name = (subteam_obj.get("name") or "").strip()
    return name or None


# ---------------------------------------------------------------------------
# Auto-refresh (A+ policy)
# ---------------------------------------------------------------------------

ENV_NO_AUTO = "SLACK_SKILL_CACHE_NO_AUTO"

_REFRESHED_IN_PROCESS: set[str] = set()


def auto_refresh_disabled() -> bool:
    """True when ``SLACK_SKILL_CACHE_NO_AUTO`` is set to a truthy value."""
    raw = (os.environ.get(ENV_NO_AUTO) or "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def ensure_fresh(cfg, needs, *, client=None):
    """Refresh caches named in *needs* that are missing or past TTL.

    *needs* accepts ``'users'`` / ``'channels'`` / ``'subteams'``.  Returns
    a dict ``{name: {'refreshed': bool, 'reason': str, ...}}``; commands
    should attach it to their response so the caller can see when a 3-10s
    refresh happened transparently.  Never raises — refresh failures are
    reported in ``reason`` so the caller can fall back to whatever data
    (if any) is already on disk.

    - Already-fresh cache → no work; reason ``'fresh'``.
    - Missing on disk     → synchronous full refresh; reason ``'missing'``.
    - Past TTL            → synchronous full refresh; reason ``'stale'``.
    - Same process already refreshed it → skipped; reason
      ``'already_refreshed_in_process'``.
    - ``SLACK_SKILL_CACHE_NO_AUTO`` truthy → skipped; reason
      ``'auto_disabled'``.
    """
    # Lazy import to avoid cycle — cmd_cache_refresh imports cache.
    from . import cmd_cache_refresh as _ccr
    from .client import SlackClient

    if client is None:
        cfg.ensure_dirs()
        client = SlackClient(cfg.token_for("read"), timeout=cfg.timeout)

    report: dict[str, dict[str, object]] = {}
    no_auto = auto_refresh_disabled()

    fetchers = {
        "users": (_ccr._fetch_users, save_users),
        "channels": (_ccr._fetch_channels, save_channels),
        "subteams": (_ccr._fetch_subteams, save_subteams),
    }

    for name in needs:
        if name not in fetchers:
            continue
        if name in _REFRESHED_IN_PROCESS:
            report[name] = {"refreshed": False, "reason": "already_refreshed_in_process"}
            continue

        path = cfg.cache_dir / f"{name}.json"
        missing = not path.exists()
        stale = (not missing) and is_stale(cfg.cache_dir, name)

        if not missing and not stale:
            report[name] = {"refreshed": False, "reason": "fresh"}
            continue

        if no_auto:
            report[name] = {
                "refreshed": False,
                "reason": "auto_disabled",
                "missing": missing,
                "stale": stale,
            }
            continue

        fetch, save = fetchers[name]
        try:
            items = fetch(client)
            save(cfg.cache_dir, items)
            _REFRESHED_IN_PROCESS.add(name)
            report[name] = {
                "refreshed": True,
                "reason": "missing" if missing else "stale",
                "count": len(items),
            }
        except Exception as err:  # noqa: BLE001
            report[name] = {
                "refreshed": False,
                "reason": f"refresh_failed: {err.__class__.__name__}: {err}",
            }

    return report


__all__ = [
    "DEFAULT_TTL_SECONDS",
    "ENV_NO_AUTO",
    "ensure_fresh",
    "auto_refresh_disabled",
    "load_users",
    "load_channels",
    "load_subteams",
    "refreshed_at",
    "is_stale",
    "save_users",
    "save_channels",
    "save_subteams",
    "user_display_name",
    "channel_display_name",
    "subteam_handle",
]
