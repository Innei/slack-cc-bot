"""``cache_refresh`` subcommand — populate the local users/channels cache."""

from __future__ import annotations

import argparse
import time
from typing import Any

from . import cache
from .client import SlackClient
from .config import Config
from .errors import SlackAPIError
from .output import emit


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "cache_refresh",
        help="refresh local users/channels/usergroups cache (read-only)",
        description=(
            "Page through users.list, conversations.list and usergroups.list "
            "to populate the on-disk cache.  Subsequent channels / users / "
            "resolve commands (and #name resolution in history/replies) will "
            "hit the cache instead of making live API calls.\n\n"
            "Cache directory defaults to $PWD/.agent-slack/cache/slack/; "
            "override via SLACK_SKILL_CACHE_DIR.  Default TTL is 24h, "
            "override via SLACK_SKILL_CACHE_TTL (seconds)."
        ),
    )
    p.add_argument(
        "--skip-users",
        action="store_true",
        help="do not refresh users.json (useful when only channels changed)",
    )
    p.add_argument(
        "--skip-channels",
        action="store_true",
        help="do not refresh channels.json",
    )
    p.add_argument(
        "--skip-subteams",
        action="store_true",
        help=(
            "do not refresh subteams.json (usergroups).  Some workspaces "
            "don't have usergroups enabled; that case is handled gracefully "
            "anyway."
        ),
    )
    p.add_argument(
        "--output",
        default=None,
        help='write refresh summary JSON to file instead of stdout ("-" = stdout)',
    )
    p.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    cfg = Config()
    cfg.ensure_dirs()
    client = SlackClient(cfg.token_for("read"), timeout=cfg.timeout)

    started = time.time()
    summary: dict[str, Any] = {
        "cache_dir": str(cfg.cache_dir),
        "users": {"refreshed": False},
        "channels": {"refreshed": False},
        "subteams": {"refreshed": False},
    }

    if not args.skip_users:
        users = _fetch_users(client)
        cache.save_users(cfg.cache_dir, users)
        summary["users"] = {"refreshed": True, "count": len(users)}

    if not args.skip_channels:
        channels = _fetch_channels(client)
        cache.save_channels(cfg.cache_dir, channels)
        summary["channels"] = {"refreshed": True, "count": len(channels)}

    if not args.skip_subteams:
        try:
            subteams = _fetch_subteams(client)
            cache.save_subteams(cfg.cache_dir, subteams)
            summary["subteams"] = {"refreshed": True, "count": len(subteams)}
        except SlackAPIError as err:
            # usergroups is an Enterprise Grid / Plus feature; tolerate.
            summary["subteams"] = {
                "refreshed": False,
                "skipped_reason": err.error or str(err),
            }

    summary["elapsed_seconds"] = round(time.time() - started, 3)
    emit(summary, output=args.output)
    return 0


# ---------------------------------------------------------------------------
# Fetchers
# ---------------------------------------------------------------------------

def _fetch_users(client: SlackClient) -> dict[str, dict[str, Any]]:
    items: dict[str, dict[str, Any]] = {}
    cursor = ""
    while True:
        params: dict[str, Any] = {"limit": 1000}
        if cursor:
            params["cursor"] = cursor
        payload = client.call("users.list", **params)
        for u in payload.get("members") or []:
            uid = u.get("id")
            if uid:
                items[uid] = _slim_user(u)
        cursor = (
            (payload.get("response_metadata") or {}).get("next_cursor") or ""
        ).strip()
        if not cursor:
            break
    return items


def _fetch_channels(client: SlackClient) -> dict[str, dict[str, Any]]:
    items: dict[str, dict[str, Any]] = {}
    cursor = ""
    while True:
        params: dict[str, Any] = {
            "limit": 1000,
            "types": "public_channel,private_channel,mpim,im",
            "exclude_archived": False,
        }
        if cursor:
            params["cursor"] = cursor
        payload = client.call("conversations.list", **params)
        for c in payload.get("channels") or []:
            cid = c.get("id")
            if cid:
                items[cid] = _slim_channel(c)
        cursor = (
            (payload.get("response_metadata") or {}).get("next_cursor") or ""
        ).strip()
        if not cursor:
            break
    return items


def _fetch_subteams(client: SlackClient) -> dict[str, dict[str, Any]]:
    payload = client.call("usergroups.list", include_count=True)
    items: dict[str, dict[str, Any]] = {}
    for s in payload.get("usergroups") or []:
        sid = s.get("id")
        if sid:
            items[sid] = _slim_subteam(s)
    return items


# ---------------------------------------------------------------------------
# Trimmers — we only keep the fields that Chunk 4+ commands need, to keep
# the JSON file small and reduce disk usage.  Anyone wanting the full raw
# payload can re-run the live API call.
# ---------------------------------------------------------------------------

_USER_KEEP = (
    "id",
    "team_id",
    "name",
    "real_name",
    "deleted",
    "is_bot",
    "is_admin",
    "is_owner",
    "updated",
    "tz",
)
_USER_PROFILE_KEEP = (
    "display_name",
    "display_name_normalized",
    "real_name",
    "real_name_normalized",
    "email",
    "title",
    "image_72",
)


def _slim_user(u: dict[str, Any]) -> dict[str, Any]:
    out = {k: u.get(k) for k in _USER_KEEP if k in u}
    profile = u.get("profile") or {}
    out["profile"] = {k: profile.get(k) for k in _USER_PROFILE_KEEP if k in profile}
    return out


_CHANNEL_KEEP = (
    "id",
    "name",
    "name_normalized",
    "is_channel",
    "is_group",
    "is_im",
    "is_mpim",
    "is_private",
    "is_archived",
    "is_shared",
    "num_members",
    "created",
    "creator",
    "user",  # for IM channels
)


def _slim_channel(c: dict[str, Any]) -> dict[str, Any]:
    out = {k: c.get(k) for k in _CHANNEL_KEEP if k in c}
    topic = (c.get("topic") or {}).get("value")
    purpose = (c.get("purpose") or {}).get("value")
    if topic:
        out["topic"] = topic
    if purpose:
        out["purpose"] = purpose
    return out


_SUBTEAM_KEEP = (
    "id",
    "team_id",
    "handle",
    "name",
    "description",
    "date_create",
    "date_update",
    "user_count",
    "deleted_by",
)


def _slim_subteam(s: dict[str, Any]) -> dict[str, Any]:
    return {k: s.get(k) for k in _SUBTEAM_KEEP if k in s}


__all__ = ["register", "run"]
