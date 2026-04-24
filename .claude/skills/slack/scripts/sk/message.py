"""Shared message normaliser.

Takes one raw Slack message (as returned by ``conversations.history`` or
``conversations.replies``) plus a preloaded ``user_names`` dict, and produces
the canonical output shape every ``cmd_*`` module emits.

This keeps ``get`` / ``replies`` / ``history`` outputs field-for-field
identical, so AI consumers don't have to branch on which command produced
the JSON.
"""

from __future__ import annotations

import urllib.parse
from typing import Any, Callable, Optional

from .render import render_blocks, render_mrkdwn


NameLookup = Callable[[str], Optional[str]]


def _ts_to_permalink_frag(ts: Optional[str]) -> Optional[str]:
    if not ts:
        return None
    return ts.replace(".", "")


def _compose_permalink(
    workspace_base: Optional[str],
    channel_id: str,
    ts: Optional[str],
    thread_ts: Optional[str],
) -> Optional[str]:
    frag = _ts_to_permalink_frag(ts)
    if not workspace_base or not frag:
        return None
    base = workspace_base.rstrip("/")
    url = f"{base}/archives/{channel_id}/p{frag}"
    if thread_ts and thread_ts != ts:
        qs = urllib.parse.urlencode({"thread_ts": thread_ts, "cid": channel_id})
        url = f"{url}?{qs}"
    return url


def build_author(
    message: dict[str, Any], user_names: dict[str, str]
) -> dict[str, Any]:
    user_id = message.get("user") or None
    bot_id = message.get("bot_id")

    if not user_id or not user_id.startswith(("U", "W")):
        # Bot message without a real user id.
        return {
            "id": user_id or bot_id,
            "name": message.get("username") or user_id or bot_id,
            "display_name": None,
            "is_bot": bool(bot_id),
        }

    name = user_names.get(user_id)
    return {
        "id": user_id,
        "name": name or user_id,
        "display_name": name,
        "is_bot": False,
    }


def normalise_message(
    message: dict[str, Any],
    *,
    channel_id: str,
    user_names: dict[str, str],
    user_lookup: NameLookup,
    channel_lookup: NameLookup,
    subteam_lookup: NameLookup,
    workspace_base: Optional[str] = None,
) -> dict[str, Any]:
    """Return the canonical dict representation of *message*."""
    ts = message.get("ts")
    thread_ts = message.get("thread_ts") or ts
    text_raw = message.get("text") or ""

    rendered_text = render_mrkdwn(
        text_raw,
        user_lookup=user_lookup,
        channel_lookup=channel_lookup,
        subteam_lookup=subteam_lookup,
    )
    rendered_blocks = render_blocks(
        message.get("blocks"),
        user_lookup=user_lookup,
        channel_lookup=channel_lookup,
        subteam_lookup=subteam_lookup,
    )

    # Prefer the richer of the two renderings; ``text_rendered`` is what
    # AI/humans should actually read.  Keep blocks text distinct for
    # transparency.
    text_rendered = rendered_text or rendered_blocks

    return {
        "channel_id": channel_id,
        "ts": ts,
        "thread_ts": thread_ts,
        "is_thread_root": (thread_ts == ts),
        "permalink": message.get("permalink")
        or _compose_permalink(workspace_base, channel_id, ts, thread_ts),
        "author": build_author(message, user_names),
        "subtype": message.get("subtype"),
        "text_raw": text_raw,
        "text_rendered": text_rendered,
        "blocks_rendered": rendered_blocks or None,
        "reply_count": message.get("reply_count"),
        "reply_users_count": message.get("reply_users_count"),
        "reactions": message.get("reactions") or [],
        "files": _extract_files(message.get("files")),
        "attachments": _extract_attachments(message.get("attachments")),
        "raw": message,
    }


def _extract_files(files: Any) -> list[dict[str, Any]]:
    if not isinstance(files, list):
        return []
    out: list[dict[str, Any]] = []
    for f in files:
        if not isinstance(f, dict):
            continue
        out.append(
            {
                "id": f.get("id"),
                "name": f.get("name"),
                "title": f.get("title"),
                "mimetype": f.get("mimetype"),
                "filetype": f.get("filetype"),
                "size": f.get("size"),
                "url_private": f.get("url_private"),
                "url_private_download": f.get("url_private_download"),
                # filled in by --download-files (Chunk 6)
                "local_path": None,
            }
        )
    return out


def _extract_attachments(attachments: Any) -> list[dict[str, Any]]:
    if not isinstance(attachments, list):
        return []
    out: list[dict[str, Any]] = []
    for a in attachments:
        if not isinstance(a, dict):
            continue
        out.append(
            {
                "id": a.get("id"),
                "title": a.get("title"),
                "title_link": a.get("title_link"),
                "fallback": a.get("fallback"),
                "text": a.get("text"),
                "pretext": a.get("pretext"),
                "color": a.get("color"),
                "service_name": a.get("service_name"),
                "from_url": a.get("from_url"),
            }
        )
    return out


def workspace_base_from_permalink(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return None
    if not parsed.scheme or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}"


__all__ = [
    "normalise_message",
    "build_author",
    "workspace_base_from_permalink",
]
