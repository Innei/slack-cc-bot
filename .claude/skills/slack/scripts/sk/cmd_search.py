"""``search`` subcommand — full-workspace message search via ``search.messages``.

Slack's ``search.messages`` is only exposed to user tokens (xoxp); bot tokens
return ``not_allowed_token_type``.  :meth:`Config.token_for("search")` already
enforces the xoxp chain, so here we just call through.

Query syntax is whatever Slack supports — ``from:@alice``, ``in:#eng``,
``has:link``, ``before:2026-01-01``, etc. — we pass the raw string through
without trying to parse or mangle it.  This is an explicit design choice: AI
agents can consult Slack's own docs and compose modifiers without the skill
acting as a lossy translator.
"""

from __future__ import annotations

import argparse
from typing import Any

from . import cache
from .client import SlackClient
from .config import Config
from .errors import InvalidArgument
from .lookups import build_lookups
from .mentions import collect_user_ids_from_messages, preload_users
from .message import normalise_message, workspace_base_from_permalink
from .output import emit


DEFAULT_LIMIT = 20
# Slack's documented max per_page for search.messages is 100.  Pagination via
# the (older) ``page`` param is capped at 100 pages total.
MAX_LIMIT_PER_PAGE = 100
MAX_PAGES_HARD = 100

_VALID_SORT = ("score", "timestamp")
_VALID_SORT_DIR = ("asc", "desc")


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "search",
        help="search workspace messages via search.messages (needs SLACK_USER_TOKEN)",
        description=(
            "Run a Slack workspace search.  Query string is passed to "
            "search.messages verbatim so Slack's native modifiers "
            "(from:@alice, in:#eng, has:link, before:YYYY-MM-DD, ...) "
            "work as-is.  Requires SLACK_USER_TOKEN (xoxp); bot tokens "
            "are rejected by Slack for this endpoint."
        ),
    )
    p.add_argument("query", help="raw Slack search query (quoted in shell)")
    p.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIMIT,
        help=(
            f"maximum matches to return (default: {DEFAULT_LIMIT}).  "
            f"Pages are fetched automatically up to this count, capped by "
            f"--max-pages.  Slack caps per-page at {MAX_LIMIT_PER_PAGE}."
        ),
    )
    p.add_argument(
        "--sort",
        choices=_VALID_SORT,
        default="timestamp",
        help="sort order (default: timestamp = newest-first)",
    )
    p.add_argument(
        "--sort-dir",
        choices=_VALID_SORT_DIR,
        default="desc",
        help="sort direction (default: desc)",
    )
    p.add_argument(
        "--max-pages",
        type=int,
        default=5,
        help=(
            "safety cap on how many pages of results to fetch "
            "(default: 5; Slack's hard cap is 100)"
        ),
    )
    p.add_argument(
        "--output",
        default=None,
        help='write JSON to this file instead of stdout ("-" = stdout)',
    )
    p.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    query = (args.query or "").strip()
    if not query:
        raise InvalidArgument("search query cannot be empty")
    if args.limit <= 0:
        raise InvalidArgument("--limit must be positive")
    if args.max_pages <= 0 or args.max_pages > MAX_PAGES_HARD:
        raise InvalidArgument(
            f"--max-pages must be between 1 and {MAX_PAGES_HARD}"
        )

    cfg = Config()
    # token_for("search") enforces xoxp; bot tokens raise TokenMissingError.
    client = SlackClient(cfg.token_for("search"), timeout=cfg.timeout)

    per_page = min(args.limit, MAX_LIMIT_PER_PAGE)
    matches: list[dict[str, Any]] = []
    total: int | None = None
    pagination: dict[str, Any] = {}

    page = 1
    pages_fetched = 0
    while len(matches) < args.limit and pages_fetched < args.max_pages:
        payload = client.call(
            "search.messages",
            query=query,
            count=per_page,
            page=page,
            sort=args.sort,
            sort_dir=args.sort_dir,
        )
        block = payload.get("messages") or {}
        if total is None:
            total = int(block.get("total") or 0)
        pagination = block.get("pagination") or pagination
        page_matches = block.get("matches") or []
        matches.extend(page_matches)

        pages_fetched += 1

        # Slack returns no further pages once we've exhausted results.
        if not page_matches:
            break
        paging = block.get("paging") or {}
        if page >= int(paging.get("pages") or page):
            break
        page += 1

    matches = matches[: args.limit]

    # --- rendering + name resolution -----------------------------------
    cache_users = cache.load_users(cfg.cache_dir)
    user_ids = collect_user_ids_from_messages(matches)
    user_names = preload_users(client, user_ids, cache_users=cache_users)
    user_lookup, channel_lookup, subteam_lookup, _ = build_lookups(cfg, user_names)

    rendered: list[dict[str, Any]] = []
    for m in matches:
        channel_block = m.get("channel") or {}
        channel_id = channel_block.get("id") or ""
        channel_name = channel_block.get("name")
        permalink = m.get("permalink")

        normalised = normalise_message(
            m,
            channel_id=channel_id,
            user_names=user_names,
            user_lookup=user_lookup,
            channel_lookup=channel_lookup,
            subteam_lookup=subteam_lookup,
            workspace_base=workspace_base_from_permalink(permalink)
            if permalink
            else None,
        )
        # search.messages already gives us a permalink per match — prefer it
        # over a reconstructed one.
        if permalink:
            normalised["permalink"] = permalink
        # Preserve channel name as Slack reported it, for UI convenience.
        if channel_name:
            normalised["channel_name"] = channel_name

        rendered.append(normalised)

    result = {
        "query": query,
        "sort": args.sort,
        "sort_dir": args.sort_dir,
        "total": total,
        "returned": len(rendered),
        "pages_fetched": pages_fetched,
        "pagination": pagination,
        "matches": rendered,
    }

    emit(result, output=args.output)
    return 0


__all__ = ["register", "run"]
