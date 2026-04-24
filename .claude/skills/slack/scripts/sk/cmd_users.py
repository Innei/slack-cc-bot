"""``users`` subcommand — look up users from the local cache."""

from __future__ import annotations

import argparse
from typing import Any

from . import cache
from .client import SlackClient
from .config import Config
from .errors import InvalidArgument, SlackAPIError
from .output import emit


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "users",
        help="search users by name/id/email from the local cache (read-only)",
        description=(
            "Resolve a user from the local users cache.  Supports: "
            "\n  --id U...    exact id lookup"
            "\n  --email a@b  exact email lookup (falls back to live "
            "users.lookupByEmail if not cached)"
            "\n  --query str  case-insensitive fuzzy match against "
            "display_name / real_name / name / email / title."
        ),
    )
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--id", dest="uid", help="exact user id (U...)")
    g.add_argument("--email", help="exact email lookup")
    g.add_argument(
        "--query",
        help="case-insensitive substring match (display_name/real_name/name/email/title)",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=20,
        help="cap on fuzzy --query matches (default: 20; ignored for --id/--email)",
    )
    p.add_argument(
        "--include-deleted",
        action="store_true",
        help="include deleted / deactivated users (default: excluded)",
    )
    p.add_argument(
        "--include-bots",
        action="store_true",
        help="include bot users (default: excluded from --query, always shown for --id)",
    )
    p.add_argument(
        "--output",
        default=None,
        help='write JSON to this file instead of stdout ("-" = stdout)',
    )
    p.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    cfg = Config()
    refresh_report: dict[str, dict[str, Any]] = {}
    # Only the --query branch truly needs the full users dict; --id /
    # --email have live single-lookup fallbacks that are cheaper than a
    # full users.list refresh.
    if args.query is not None:
        refresh_report = cache.ensure_fresh(cfg, ["users"])

    items = cache.load_users(cfg.cache_dir)
    stale = cache.is_stale(cfg.cache_dir, "users")
    empty = not items

    matches: list[dict[str, Any]] = []

    if args.uid:
        user = items.get(args.uid)
        if not user:
            # fall back to live users.info
            try:
                client = SlackClient(cfg.token_for("read"), timeout=cfg.timeout)
                payload = client.call("users.info", user=args.uid)
                user = payload.get("user")
            except SlackAPIError as err:
                raise InvalidArgument(
                    f"user id {args.uid!r} not in cache and live lookup failed: "
                    f"{err.error}"
                ) from err
        if user:
            matches.append(user)

    elif args.email:
        email = args.email.strip().lower()
        for u in items.values():
            if _user_email(u).lower() == email:
                matches.append(u)
        if not matches:
            # fall back to live users.lookupByEmail
            try:
                client = SlackClient(cfg.token_for("read"), timeout=cfg.timeout)
                payload = client.call("users.lookupByEmail", email=args.email)
                user = payload.get("user")
                if user:
                    matches.append(user)
            except SlackAPIError as err:
                raise InvalidArgument(
                    f"no user with email {args.email!r} in cache; live lookup "
                    f"also failed: {err.error}"
                ) from err

    else:  # --query
        if args.limit <= 0:
            raise InvalidArgument("--limit must be positive")
        q = (args.query or "").strip().lstrip("@").lower()
        if not q:
            raise InvalidArgument("--query cannot be empty")
        for u in items.values():
            if not args.include_deleted and u.get("deleted"):
                continue
            if not args.include_bots and u.get("is_bot"):
                continue
            if not _user_matches(u, q):
                continue
            matches.append(u)
        # stable rank: exact display_name / name / email match first
        matches.sort(key=lambda u: _rank(u, q))
        matches = matches[: args.limit]

    result: dict[str, Any] = {
        "cache_dir": str(cfg.cache_dir),
        "refreshed_at": cache.refreshed_at(cfg.cache_dir, "users"),
        "cache_refresh": refresh_report,
        "stale_cache": stale,
        "cache_empty": empty,
        "total_in_cache": len(items),
        "match_count": len(matches),
        "users": [_shape_user(u) for u in matches],
    }
    if empty and args.query is not None:
        result["hint"] = (
            "cache still empty after ensure_fresh — see cache_refresh.reason; "
            "try `slack.py cache_refresh` manually for the full error"
        )
    elif stale and not refresh_report.get("users", {}).get("refreshed"):
        result["hint"] = "cache stale — run `slack.py cache_refresh` for fresh data"

    emit(result, output=args.output)
    return 0


def _user_email(u: dict[str, Any]) -> str:
    return ((u.get("profile") or {}).get("email") or "").strip()


def _user_matches(u: dict[str, Any], q: str) -> bool:
    profile = u.get("profile") or {}
    haystack = " ".join(
        [
            u.get("name") or "",
            u.get("real_name") or "",
            profile.get("display_name") or "",
            profile.get("display_name_normalized") or "",
            profile.get("real_name") or "",
            profile.get("real_name_normalized") or "",
            profile.get("email") or "",
            profile.get("title") or "",
        ]
    ).lower()
    return q in haystack


def _rank(u: dict[str, Any], q: str) -> tuple[int, str]:
    """Lower is better.  Exact matches beat substring matches."""
    profile = u.get("profile") or {}
    dn = (profile.get("display_name") or "").lower()
    name = (u.get("name") or "").lower()
    rn = (u.get("real_name") or "").lower()
    email = (profile.get("email") or "").lower()
    if q in (dn, name, rn, email):
        return (0, dn or name)
    # starts-with rank
    if dn.startswith(q) or name.startswith(q):
        return (1, dn or name)
    return (2, dn or name)


def _shape_user(u: dict[str, Any]) -> dict[str, Any]:
    profile = u.get("profile") or {}
    return {
        "id": u.get("id"),
        "name": u.get("name"),
        "real_name": u.get("real_name") or profile.get("real_name"),
        "display_name": profile.get("display_name"),
        "email": profile.get("email"),
        "title": profile.get("title"),
        "is_bot": bool(u.get("is_bot")),
        "is_admin": bool(u.get("is_admin")),
        "is_owner": bool(u.get("is_owner")),
        "deleted": bool(u.get("deleted")),
        "tz": u.get("tz"),
    }


__all__ = ["register", "run"]
