"""CLI entry point — argparse with subparsers.

Every subcommand is registered on the same parser so ``slack.py --help``
shows the full surface area.  Errors raised by any subcommand flow through
:func:`main`, which appends a short, actionable hint for well-known Slack
failure codes (``channel_not_found`` → suggest ``channels --query``, etc.).
"""

from __future__ import annotations

import argparse
import sys
from typing import Optional, Sequence

from . import (
    cmd_cache_refresh,
    cmd_channels,
    cmd_files_download,
    cmd_get,
    cmd_history,
    cmd_replies,
    cmd_resolve,
    cmd_search,
    cmd_users,
)
from .errors import SlackAPIError, SlackSkillError


# Known Slack API error codes → short, actionable hint.  Appended to the
# error line printed to stderr so the AI / human reader gets a next step.
_ERROR_HINTS: dict[str, str] = {
    "channel_not_found": (
        "try `slack.py channels --query <name>` to find the right id, "
        "or run `slack.py cache_refresh` if the name is new."
    ),
    "not_in_channel": (
        "the bot token isn't a member of this channel. "
        "Invite it via `/invite @your-bot` in Slack."
    ),
    "user_not_found": (
        "try `slack.py users --query <name>` or pass a full U0... id."
    ),
    "not_allowed_token_type": (
        "this endpoint needs a user token (xoxp). "
        "Set SLACK_USER_TOKEN in slack/.env — see slack/.env.example."
    ),
    "missing_scope": (
        "the token is missing a required OAuth scope. "
        "See slack/.env.example for the scope list and re-install the Slack app."
    ),
    "invalid_auth": (
        "token is invalid / expired. Check slack/.env; xoxp tokens can "
        "also be invalidated by SSO."
    ),
    "not_authed": (
        "no token sent. Set SLACK_BOT_TOKEN (or SLACK_USER_TOKEN for "
        "search) — see slack/.env.example."
    ),
    "ratelimited": (
        "the skill already honours Retry-After; if you keep hitting this, "
        "lower concurrency or wait a minute."
    ),
    "message_not_found": (
        "permalink may be wrong, the message may be deleted, or the token "
        "cannot see that channel. For thread replies, make sure the URL "
        "has `?thread_ts=<root_ts>`."
    ),
    "file_not_found": (
        "the file id is wrong or the token can't see it. "
        "Use the id from a `get`/`replies` response (starts with F...)."
    ),
    "thread_not_found": (
        "this message isn't the root of a thread, or the thread has no "
        "replies yet. Use `get` instead, or pass a reply permalink."
    ),
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="slack.py",
        description=(
            "Read-only Slack skill.  Writes (post messages / reactions / "
            "mark-read) are intentionally not supported — the client layer "
            "enforces a read-only method whitelist.  See slack/SKILL.md for "
            "AI-facing usage, slack/README.md for a human quickstart."
        ),
        epilog=(
            "Tokens live in slack/.env (see slack/.env.example).  "
            "Large results should use --output <file> to avoid flooding "
            "the caller's context."
        ),
    )
    parser.add_argument(
        "--version",
        action="version",
        version="winches-slack-skill 0.7 (read-only; 9 subcommands)",
    )

    sub = parser.add_subparsers(dest="command", metavar="<command>")

    cmd_get.register(sub)
    cmd_replies.register(sub)
    cmd_history.register(sub)
    cmd_channels.register(sub)
    cmd_users.register(sub)
    cmd_resolve.register(sub)
    cmd_search.register(sub)
    cmd_files_download.register(sub)
    cmd_cache_refresh.register(sub)

    return parser


def _format_error(exc: BaseException) -> str:
    """Render an exception as a single-line ``error: ...`` message with hint.

    Hints are looked up on the original :class:`SlackAPIError`; when a
    helper wraps the API error (e.g. ``channels.resolve_channel`` raises
    :class:`InvalidArgument` with ``raise ... from err``), we walk
    ``__cause__`` so the hint still surfaces.
    """
    line = f"error: {exc}"
    api_err: SlackAPIError | None = None
    cursor: BaseException | None = exc
    seen: set[int] = set()
    while cursor is not None and id(cursor) not in seen:
        seen.add(id(cursor))
        if isinstance(cursor, SlackAPIError):
            api_err = cursor
            break
        cursor = cursor.__cause__ or cursor.__context__
    if api_err is not None:
        hint = _ERROR_HINTS.get(api_err.error)
        if hint:
            line = f"{line}\nhint: {hint}"
    return line


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if not getattr(args, "command", None):
        parser.print_help()
        return 0

    try:
        return int(args.func(args) or 0)
    except SlackSkillError as exc:
        print(_format_error(exc), file=sys.stderr)
        return getattr(exc, "exit_code", 1) or 1
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130


__all__ = ["main", "build_parser"]
