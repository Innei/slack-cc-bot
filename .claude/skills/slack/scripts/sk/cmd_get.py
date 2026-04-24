"""``get`` subcommand — fetch a single Slack message by permalink."""

from __future__ import annotations

import argparse
from typing import Any

from .client import SlackClient
from .config import Config
from .errors import InvalidArgument, SlackAPIError
from .lookups import build_lookups
from .mentions import (
    collect_user_ids_from_message,
    preload_users,
)
from .message import normalise_message, workspace_base_from_permalink
from .output import emit
from .shared import add_download_flags, maybe_download_files
from .urls import parse_permalink


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "get",
        help="fetch a single Slack message by permalink (read-only)",
        description=(
            "Fetch a single message by its Slack permalink.  Returns the raw "
            "message fields plus a rendered text_rendered where <@U>/<#C>/links "
            "are resolved to human-readable strings."
        ),
    )
    p.add_argument(
        "--url",
        required=True,
        help="Slack message permalink, e.g. https://xxx.slack.com/archives/C0.../p1712345678901234",
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
    ts = parsed["ts"]
    thread_ts = parsed["thread_ts"]

    cfg = Config()
    client = SlackClient(cfg.token_for("read"), timeout=cfg.timeout)

    if cfg.allowed_channels and channel_id not in cfg.allowed_channels:
        raise InvalidArgument(
            f"channel {channel_id!r} is not in SLACK_SKILL_ALLOWED_CHANNELS"
        )

    message = _fetch_single(client, channel_id=channel_id, ts=ts, thread_ts=thread_ts)
    if message is None:
        raise SlackAPIError("conversations.history", "message_not_found")

    user_ids = collect_user_ids_from_message(message)
    user_names = preload_users(
        client,
        user_ids,
        cache_users=_peek_cache_users(cfg),
    )
    user_lookup, channel_lookup, subteam_lookup, _ = build_lookups(cfg, user_names)

    result = normalise_message(
        message,
        channel_id=channel_id,
        user_names=user_names,
        user_lookup=user_lookup,
        channel_lookup=channel_lookup,
        subteam_lookup=subteam_lookup,
        workspace_base=workspace_base_from_permalink(args.url),
    )
    # The caller explicitly supplied a permalink — keep it verbatim.
    result["permalink"] = args.url

    download_report = maybe_download_files(args, cfg=cfg, messages=[result])
    if download_report is not None:
        result["downloads"] = download_report

    emit(result, output=args.output)
    return 0


def _peek_cache_users(cfg: Config):
    # Tiny indirection so tests can patch out disk access.
    from . import cache

    return cache.load_users(cfg.cache_dir)


def _fetch_single(
    client: SlackClient, *, channel_id: str, ts: str, thread_ts: str
) -> dict[str, Any] | None:
    """Return the single message at *ts* in *channel_id*.

    Uses ``conversations.replies`` for thread replies (which
    ``conversations.history`` does not return) and ``conversations.history``
    for root messages.
    """
    if thread_ts and thread_ts != ts:
        payload = client.call(
            "conversations.replies",
            channel=channel_id,
            ts=thread_ts,
            latest=ts,
            inclusive=True,
            limit=1,
        )
        for m in payload.get("messages") or []:
            if m.get("ts") == ts:
                return m
        return None

    payload = client.call(
        "conversations.history",
        channel=channel_id,
        latest=ts,
        inclusive=True,
        limit=1,
    )
    msgs = payload.get("messages") or []
    for m in msgs:
        if m.get("ts") == ts:
            return m
    return msgs[0] if msgs else None


__all__ = ["register", "run"]

