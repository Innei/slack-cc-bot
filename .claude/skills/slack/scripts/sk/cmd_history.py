"""``history`` subcommand — browse a channel's recent messages."""

from __future__ import annotations

import argparse
from typing import Any

from .channels import resolve_channel
from .client import SlackClient
from .config import Config
from .errors import InvalidArgument, SlackAPIError
from .lookups import build_lookups
from .mentions import (
    collect_user_ids_from_messages,
    preload_users,
)
from .message import normalise_message
from .output import emit
from .shared import add_download_flags, maybe_download_files
from .timex import DEFAULT_COUNT_LIMIT, parse_limit


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "history",
        help="list recent messages from a channel (read-only)",
        description=(
            "Fetch the most recent messages from a channel in reverse "
            "chronological order (newest first).  --limit accepts either a "
            "count (e.g. '20') or a duration window (e.g. '1d', '2h', "
            "'30m', '1w')."
        ),
    )
    p.add_argument(
        "--channel",
        required=True,
        help=(
            "Channel ID (C0...) or #name / name.  For #name, the skill will "
            "scan conversations.list once to resolve the id (Chunk 4 will "
            "add caching)."
        ),
    )
    p.add_argument(
        "--limit",
        default=str(DEFAULT_COUNT_LIMIT),
        help=(
            "Count (e.g. '20') or duration window (e.g. '1d', '2h', '30m', "
            f"'1w').  Default: '{DEFAULT_COUNT_LIMIT}' (last 20 messages)."
        ),
    )
    p.add_argument(
        "--include-thread-replies",
        action="store_true",
        help=(
            "By default only top-level channel messages are returned "
            "(matching Slack's UI).  Pass this flag to also include "
            "thread replies, which requires one extra API call per thread root."
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
    try:
        count, oldest_ts = parse_limit(args.limit)
    except ValueError as err:
        raise InvalidArgument(str(err))

    cfg = Config()
    client = SlackClient(cfg.token_for("read"), timeout=cfg.timeout)

    ch = resolve_channel(client, args.channel, cfg=cfg)
    channel_id = ch.get("id")
    if not channel_id:
        raise InvalidArgument(f"resolved channel has no id: {ch!r}")

    if cfg.allowed_channels and channel_id not in cfg.allowed_channels:
        raise InvalidArgument(
            f"channel {channel_id!r} is not in SLACK_SKILL_ALLOWED_CHANNELS"
        )

    raw_messages = _fetch_history(
        client,
        channel_id=channel_id,
        count=count,
        oldest_ts=oldest_ts,
    )

    if args.include_thread_replies:
        raw_messages = _expand_thread_replies(client, channel_id, raw_messages)

    user_ids = collect_user_ids_from_messages(raw_messages)
    from . import cache
    cache_users = cache.load_users(cfg.cache_dir)
    user_names = preload_users(client, user_ids, cache_users=cache_users)
    user_lookup, channel_lookup, subteam_lookup, _ = build_lookups(cfg, user_names)

    normalised = [
        normalise_message(
            msg,
            channel_id=channel_id,
            user_names=user_names,
            user_lookup=user_lookup,
            channel_lookup=channel_lookup,
            subteam_lookup=subteam_lookup,
            workspace_base=None,
        )
        for msg in raw_messages
    ]

    result: dict[str, Any] = {
        "channel": {
            "id": channel_id,
            "name": ch.get("name"),
            "is_private": ch.get("is_private"),
            "is_archived": ch.get("is_archived"),
            "topic": (ch.get("topic") or {}).get("value"),
            "purpose": (ch.get("purpose") or {}).get("value"),
            "num_members": ch.get("num_members"),
        },
        "limit": {
            "raw": args.limit,
            "count": count,
            "oldest_ts": oldest_ts,
        },
        "message_count": len(normalised),
        "messages": normalised,
    }

    download_report = maybe_download_files(args, cfg=cfg, messages=normalised)
    if download_report is not None:
        result["downloads"] = download_report

    emit(result, output=args.output)
    return 0


def _fetch_history(
    client: SlackClient,
    *,
    channel_id: str,
    count: int | None,
    oldest_ts: float | None,
) -> list[dict[str, Any]]:
    """Return top-level channel messages in **reverse chronological** order.

    - Count-mode: returns the most recent *count* messages.
    - Time-mode: returns every message with ``ts >= oldest_ts``.
    """
    messages: list[dict[str, Any]] = []
    cursor = ""

    # Slack's per-call cap is 1000 for conversations.history; use 200 to keep
    # individual requests snappy and pageable.
    page_size = min(200, count or 200)

    while True:
        params: dict[str, Any] = {
            "channel": channel_id,
            "limit": page_size,
        }
        if cursor:
            params["cursor"] = cursor
        if oldest_ts is not None:
            params["oldest"] = f"{oldest_ts:.6f}"

        try:
            payload = client.call("conversations.history", **params)
        except SlackAPIError as err:
            if err.error == "not_in_channel":
                raise InvalidArgument(
                    f"bot is not a member of channel {channel_id}. "
                    f"Invite the bot (/invite @your-bot) or use a different channel."
                ) from err
            raise

        page = payload.get("messages") or []
        messages.extend(page)

        if count is not None and len(messages) >= count:
            messages = messages[:count]
            break

        cursor = (
            (payload.get("response_metadata") or {}).get("next_cursor") or ""
        ).strip()
        if not cursor:
            break

    return messages


def _expand_thread_replies(
    client: SlackClient,
    channel_id: str,
    messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """For each message with a thread, inline fetch all replies.

    The returned list stays roughly newest-first, but replies within each
    thread are ordered chronologically (Slack's native order), placed
    immediately after their root message in the output stream.
    """
    out: list[dict[str, Any]] = []
    for msg in messages:
        out.append(msg)
        if not msg.get("thread_ts"):
            continue
        if msg.get("ts") != msg.get("thread_ts"):
            # Not a thread root; already going to appear separately.
            continue
        # Only bother if there are actual replies.
        if not (msg.get("reply_count") or 0) > 0:
            continue

        cursor = ""
        while True:
            params: dict[str, Any] = {
                "channel": channel_id,
                "ts": msg["thread_ts"],
                "limit": 200,
            }
            if cursor:
                params["cursor"] = cursor
            try:
                payload = client.call("conversations.replies", **params)
            except SlackAPIError:
                break
            replies = payload.get("messages") or []
            # The first message is the root itself (already added above).
            for r in replies:
                if r.get("ts") == msg["thread_ts"]:
                    continue
                out.append(r)
            cursor = (
                (payload.get("response_metadata") or {}).get("next_cursor") or ""
            ).strip()
            if not cursor:
                break
    return out


__all__ = ["register", "run"]
