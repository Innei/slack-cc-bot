"""``files_download`` subcommand.

Two entry shapes:

- ``--file-id F012ABC``  → ``files.info`` → download that one file
- ``--url  <permalink>`` → fetch the message (same path as ``get``) → download
                           every file attached to it

Both honour ``--types``, which filters by category (``text`` / ``image`` /
``video`` / ``audio`` / ``pdf`` / ``archive`` / ``other`` / ``all``).

Downloads land in ``$PWD/.agent-slack/cache/slack/files/`` by default (or
whatever ``SLACK_SKILL_FILES_DIR`` points to); ``--out <dir>`` overrides for
one invocation.  File naming is ``{file_id}{ext}`` so repeated runs are
idempotent and cross-message refs dedupe naturally.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any, Optional

from .client import SlackClient
from .config import Config
from .errors import InvalidArgument, SlackAPIError, SlackSkillError
from .files import download_file, download_files_for_messages, parse_types
from .output import emit
from .urls import parse_permalink


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "files_download",
        help="download a Slack file (by id or by message permalink) to disk",
        description=(
            "Fetch private Slack files using the Bearer token.  Use --file-id "
            "for a single file, or --url to download every attachment on a "
            "specific message.  Downloads are idempotent: same file id → same "
            "local filename → skipped on re-run."
        ),
    )
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--file-id", dest="file_id", help="Slack file ID (F...)")
    group.add_argument(
        "--url",
        dest="url",
        help="Slack message permalink; downloads every file attached to that message",
    )

    p.add_argument(
        "--types",
        default=None,
        help=(
            "comma-separated categories to download: text,image,video,audio,"
            "pdf,archive,other,all.  Default: SLACK_SKILL_DOWNLOAD_TYPES or "
            "'text' (safer for AI contexts; switch to 'all' to grab images too)."
        ),
    )
    p.add_argument(
        "--out",
        default=None,
        help=(
            "destination directory for downloaded files.  Default: "
            "SLACK_SKILL_FILES_DIR or $PWD/.agent-slack/cache/slack/files/"
        ),
    )
    p.add_argument(
        "--output",
        default=None,
        help='write JSON report to this file instead of stdout ("-" = stdout)',
    )
    p.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    cfg = Config()
    client = SlackClient(cfg.token_for("read"), timeout=cfg.timeout)
    token = cfg.token_for("read")

    raw_types = args.types if args.types is not None else cfg.download_types_default
    categories = parse_types(raw_types)

    files_dir = Path(args.out).expanduser().resolve() if args.out else cfg.files_dir
    files_dir.mkdir(parents=True, exist_ok=True)

    if args.file_id:
        result = _run_by_file_id(
            client,
            file_id=args.file_id,
            token=token,
            files_dir=files_dir,
            categories=categories,
            timeout=cfg.timeout,
        )
    else:
        result = _run_by_url(
            client,
            url=args.url,
            cfg=cfg,
            token=token,
            files_dir=files_dir,
            categories=categories,
        )

    result["types"] = sorted(categories)
    result["files_dir"] = str(files_dir)
    emit(result, output=args.output)
    return 0


def _run_by_file_id(
    client: SlackClient,
    *,
    file_id: str,
    token: str,
    files_dir: Path,
    categories: set[str],
    timeout: int,
) -> dict[str, Any]:
    if not file_id.startswith("F"):
        raise InvalidArgument(f"--file-id should start with 'F', got {file_id!r}")

    payload = client.call("files.info", file=file_id)
    file_obj = payload.get("file") or {}
    if not file_obj.get("id"):
        raise SlackAPIError("files.info", "file_not_found")

    report = download_file(
        file_obj,
        token=token,
        files_dir=files_dir,
        categories=categories,
        timeout=timeout,
    )
    return {
        "source": "file-id",
        "file": report,
        "summary": _summary_from_single(report),
    }


def _run_by_url(
    client: SlackClient,
    *,
    url: str,
    cfg: Config,
    token: str,
    files_dir: Path,
    categories: set[str],
) -> dict[str, Any]:
    # Delayed import avoids a circular dependency (cmd_get also imports this
    # module indirectly through the CLI registration, and we want a clean
    # tree regardless of import order).
    from .cmd_get import _fetch_single
    from .message import normalise_message, workspace_base_from_permalink
    from .lookups import build_lookups
    from .mentions import collect_user_ids_from_message, preload_users
    from . import cache as cache_mod

    parsed = parse_permalink(url)
    channel_id = parsed["channel_id"]
    ts = parsed["ts"]
    thread_ts = parsed["thread_ts"]

    if cfg.allowed_channels and channel_id not in cfg.allowed_channels:
        raise InvalidArgument(
            f"channel {channel_id!r} is not in SLACK_SKILL_ALLOWED_CHANNELS"
        )

    message = _fetch_single(client, channel_id=channel_id, ts=ts, thread_ts=thread_ts)
    if message is None:
        raise SlackAPIError("conversations.history", "message_not_found")

    # Normalise so callers get the same message shape the other commands emit,
    # and the download step gets a clean `files` list.
    cache_users = cache_mod.load_users(cfg.cache_dir)
    user_ids = collect_user_ids_from_message(message)
    user_names = preload_users(client, user_ids, cache_users=cache_users)
    user_lookup, channel_lookup, subteam_lookup, _ = build_lookups(cfg, user_names)
    normalised = normalise_message(
        message,
        channel_id=channel_id,
        user_names=user_names,
        user_lookup=user_lookup,
        channel_lookup=channel_lookup,
        subteam_lookup=subteam_lookup,
        workspace_base=workspace_base_from_permalink(url),
    )
    normalised["permalink"] = url

    summary = download_files_for_messages(
        [normalised],
        token=token,
        files_dir=files_dir,
        categories=categories,
        timeout=cfg.timeout,
    )

    return {
        "source": "url",
        "message_permalink": url,
        "channel_id": channel_id,
        "files": normalised.get("files") or [],
        "summary": summary,
    }


def _summary_from_single(report: dict[str, Any]) -> dict[str, Any]:
    return {
        "total_files": 1,
        "downloaded": 1 if not report.get("skipped") and not report.get("error") else 0,
        "skipped": 1 if report.get("skipped") else 0,
        "errored": 1 if report.get("error") else 0,
    }


__all__ = ["register", "run"]
