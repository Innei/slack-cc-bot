"""Small cross-command helpers.

Anything that needs to live in two places and would otherwise grow into a
private copy/paste lives here.  Currently just the ``--download-files`` flag
wiring for ``get`` / ``replies`` / ``history``.
"""

from __future__ import annotations

import argparse
from typing import Any, Iterable, Optional

from .config import Config
from .errors import SlackSkillError
from .files import download_files_for_messages, parse_types


def add_download_flags(parser: argparse.ArgumentParser) -> None:
    """Attach ``--download-files`` and ``--types`` to *parser*.

    The same two flags appear on ``get`` / ``replies`` / ``history``; keeping
    the definition here ensures they stay consistent.
    """
    parser.add_argument(
        "--download-files",
        action="store_true",
        help=(
            "After fetching, download every file attachment referenced by "
            "the returned message(s) to SLACK_SKILL_FILES_DIR (default: "
            "$PWD/.agent-slack/cache/slack/files/).  Downloads are "
            "idempotent: same file id → cached path, re-runs are no-ops."
        ),
    )
    parser.add_argument(
        "--types",
        default=None,
        help=(
            "When used with --download-files: comma-separated categories to "
            "include (text,image,video,audio,pdf,archive,other,all).  Default: "
            "SLACK_SKILL_DOWNLOAD_TYPES or 'text'.  Ignored unless "
            "--download-files is set."
        ),
    )


def maybe_download_files(
    args: argparse.Namespace,
    *,
    cfg: Config,
    messages: Iterable[dict[str, Any]],
) -> Optional[dict[str, Any]]:
    """If ``--download-files`` was passed, download and mutate in place.

    Returns the summary dict from :func:`download_files_for_messages` (which
    callers typically attach to the response as ``"downloads"``), or ``None``
    if the flag wasn't set.
    """
    if not getattr(args, "download_files", False):
        return None

    raw_types = getattr(args, "types", None)
    if raw_types is None:
        raw_types = cfg.download_types_default
    categories = parse_types(raw_types)

    cfg.files_dir.mkdir(parents=True, exist_ok=True)
    token = cfg.token_for("read")
    return download_files_for_messages(
        messages,
        token=token,
        files_dir=cfg.files_dir,
        categories=categories,
        timeout=cfg.timeout,
    )


__all__ = ["add_download_flags", "maybe_download_files"]
