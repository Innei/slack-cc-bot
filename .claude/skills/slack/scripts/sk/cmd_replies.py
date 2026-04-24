"""``replies`` subcommand — fetch an entire Slack thread by permalink."""

from __future__ import annotations

import argparse
from typing import Any

from .client import SlackClient
from .config import Config
from .errors import InvalidArgument, SlackAPIError
from .lookups import build_lookups
from .mentions import (
    collect_user_ids_from_messages,
    preload_users,
)
from .message import normalise_message, workspace_base_from_permalink
from .output import emit
from .shared import add_download_flags, maybe_download_files
from .urls import parse_permalink


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "replies",
        help="fetch every message in a Slack thread by permalink (read-only)",
        description=(
            "Fetch the root message and every reply of a thread.  Returns a "
            "list of normalised messages in chronological order.  Use "
            "--output to save large threads to disk instead of flooding "
            "stdout."
        ),
    )
    p.add_argument(
        "--url",
        required=True,
        help="Permalink to any message in the thread (root or reply).",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=None,
        help=(
            "Cap on total replies returned (after the root).  Default: "
            "return everything; set e.g. --limit 50 for very long threads."
        ),
    )
    p.add_argument(
        "--output",
        default=None,
        help='write JSON to this file instead of stdout ("-" = stdout)',
    )
    add_download_flags(p)
    p.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    parsed = parse_permalink(args.url)
    channel_id = parsed["channel_id"]
    thread_ts = parsed["thread_ts"] or parsed["ts"]

    cfg = Config()
    client = SlackClient(cfg.token_for("read"), timeout=cfg.timeout)

    if cfg.allowed_channels and channel_id not in cfg.allowed_channels:
        raise InvalidArgument(
            f"channel {channel_id!r} is not in SLACK_SKILL_ALLOWED_CHANNELS"
        )

    raw_messages = _fetch_thread(
        client,
        channel_id=channel_id,
        thread_ts=thread_ts,
        limit=args.limit,
    )
    if not raw_messages:
        raise SlackAPIError("conversations.replies", "thread_not_found")

    user_ids = collect_user_ids_from_messages(raw_messages)
    from . import cache
    cache_users = cache.load_users(cfg.cache_dir)
    user_names = preload_users(client, user_ids, cache_users=cache_users)
    user_lookup, channel_lookup, subteam_lookup, _ = build_lookups(cfg, user_names)

    workspace_base = workspace_base_from_permalink(args.url)
    normalised = [
        normalise_message(
            msg,
            channel_id=channel_id,
            user_names=user_names,
            user_lookup=user_lookup,
            channel_lookup=channel_lookup,
            subteam_lookup=subteam_lookup,
            workspace_base=workspace_base,
        )
        for msg in raw_messages
    ]

    root = normalised[0] if normalised else None
    result: dict[str, Any] = {
        "channel_id": channel_id,
        "thread_ts": thread_ts,
        "message_count": len(normalised),
        "root": root,
        "replies": normalised[1:] if len(normalised) > 1 else [],
        "messages": normalised,  # full chronological list
    }

    download_report = maybe_download_files(args, cfg=cfg, messages=normalised)
    if download_report is not None:
        result["downloads"] = download_report

    emit(result, output=args.output)
    return 0


def _fetch_thread(
    client: SlackClient,
    *,
    channel_id: str,
    thread_ts: str,
    limit: int | None,
) -> list[dict[str, Any]]:
    """Return every message in *thread_ts* within *channel_id*.

    ``conversations.replies`` paginates with ``next_cursor``; Slack sorts in
    chronological order and always returns the root as the first element.
    """
    messages: list[dict[str, Any]] = []
    cursor = ""
    page_size = 200

    while True:
        params: dict[str, Any] = {
            "channel": channel_id,
            "ts": thread_ts,
            "limit": page_size,
        }
        if cursor:
            params["cursor"] = cursor

        payload = client.call("conversations.replies", **params)
        page = payload.get("messages") or []
        messages.extend(page)

        if limit is not None and len(messages) >= limit + 1:
            # +1 because limit counts replies, not the root message.
            messages = messages[: limit + 1]
            break

        cursor = (
            (payload.get("response_metadata") or {}).get("next_cursor") or ""
        ).strip()
        if not cursor:
            break

    return messages


__all__ = ["register", "run"]
