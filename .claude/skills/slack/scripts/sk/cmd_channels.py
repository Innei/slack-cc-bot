"""``channels`` subcommand — search/list channels from the local cache."""

from __future__ import annotations

import argparse
from typing import Any

from . import cache
from .config import Config
from .errors import InvalidArgument
from .output import emit


_VALID_TYPES = ("public", "private", "im", "mpim", "any")
_VALID_SORT = ("name", "popularity", "recent")


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "channels",
        help="list/search channels from the local cache (read-only)",
        description=(
            "Search the local channels cache populated by cache_refresh.  "
            "The cache is a slim subset of conversations.list — if the cache "
            "is missing or stale, the command still answers from whatever is "
            "there but reports ``stale_cache=true`` and tells you to run "
            "cache_refresh."
        ),
    )
    p.add_argument(
        "--query",
        default=None,
        help="case-insensitive substring match against name / topic / purpose",
    )
    p.add_argument(
        "--type",
        dest="ch_type",
        choices=_VALID_TYPES,
        default="any",
        help="filter by channel type (default: any)",
    )
    p.add_argument(
        "--sort",
        choices=_VALID_SORT,
        default="name",
        help="sort mode (default: name alphabetically)",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=50,
        help="cap on results returned (default: 50)",
    )
    p.add_argument(
        "--include-archived",
        action="store_true",
        help="include archived channels in results (default: excluded)",
    )
    p.add_argument(
        "--output",
        default=None,
        help='write JSON to this file instead of stdout ("-" = stdout)',
    )
    p.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    if args.limit <= 0:
        raise InvalidArgument("--limit must be positive")

    cfg = Config()
    refresh_report = cache.ensure_fresh(cfg, ["channels"])
    items = cache.load_channels(cfg.cache_dir)

    stale = cache.is_stale(cfg.cache_dir, "channels")
    empty = not items

    filtered = _filter(items, args)
    filtered = _sort(filtered, args.sort)
    limited = filtered[: args.limit]

    result: dict[str, Any] = {
        "cache_dir": str(cfg.cache_dir),
        "refreshed_at": cache.refreshed_at(cfg.cache_dir, "channels"),
        "cache_refresh": refresh_report,
        "stale_cache": stale,
        "cache_empty": empty,
        "total_in_cache": len(items),
        "match_count": len(filtered),
        "returned": len(limited),
        "channels": limited,
    }
    if empty:
        result["hint"] = (
            "cache still empty after ensure_fresh — see cache_refresh.reason; "
            "try `slack.py cache_refresh` manually for the full error"
        )
    elif stale and not refresh_report.get("channels", {}).get("refreshed"):
        result["hint"] = "cache stale — run `slack.py cache_refresh` for fresh data"

    emit(result, output=args.output)
    return 0


def _type_matches(ch: dict[str, Any], ch_type: str) -> bool:
    if ch_type == "any":
        return True
    if ch_type == "public":
        return bool(ch.get("is_channel")) and not ch.get("is_private")
    if ch_type == "private":
        return bool(ch.get("is_private")) and not (ch.get("is_im") or ch.get("is_mpim"))
    if ch_type == "im":
        return bool(ch.get("is_im"))
    if ch_type == "mpim":
        return bool(ch.get("is_mpim"))
    return True


def _filter(
    items: dict[str, dict[str, Any]], args: argparse.Namespace
) -> list[dict[str, Any]]:
    q = (args.query or "").strip().lower().lstrip("#")
    include_archived = args.include_archived

    out: list[dict[str, Any]] = []
    for ch in items.values():
        if not include_archived and ch.get("is_archived"):
            continue
        if not _type_matches(ch, args.ch_type):
            continue
        if q:
            haystack = " ".join(
                [
                    (ch.get("name") or ""),
                    (ch.get("name_normalized") or ""),
                    (ch.get("topic") or ""),
                    (ch.get("purpose") or ""),
                ]
            ).lower()
            if q not in haystack:
                continue
        out.append(ch)
    return out


def _sort(items: list[dict[str, Any]], mode: str) -> list[dict[str, Any]]:
    if mode == "popularity":
        return sorted(items, key=lambda c: -(c.get("num_members") or 0))
    if mode == "recent":
        return sorted(items, key=lambda c: -(c.get("created") or 0))
    # default: alphabetical by name
    return sorted(items, key=lambda c: (c.get("name") or "").lower())


__all__ = ["register", "run"]
