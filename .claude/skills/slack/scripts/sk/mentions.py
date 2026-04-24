"""User-mention collection + batch preload.

Used by every read command to:
  1. walk a message (``text`` + ``blocks``) and collect every user id that
     appears in a ``<@U...>`` mention or rich_text ``user`` element;
  2. batch-fetch ``users.info`` for those ids once, not once per message;
  3. expose a ``user_lookup(id) -> display_name | None`` callable that the
     renderer can consume.

Keeps Chunk 3 "cache-backed" preload future-compatible: the only call site
here is ``preload_users``, so swapping in a cache hit is one function edit.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Iterable, Optional

from .client import SlackClient
from .errors import SlackAPIError


_MENTION_RE = re.compile(r"<@([UW][A-Z0-9]+)(?:\|[^>]*)?>")


def collect_user_ids_from_text(text: Optional[str]) -> set[str]:
    if not text:
        return set()
    return {m.group(1) for m in _MENTION_RE.finditer(text)}


def collect_user_ids_from_blocks(blocks: Optional[list[dict[str, Any]]]) -> set[str]:
    """Walk Slack Block Kit structures and return every referenced user id."""
    ids: set[str] = set()
    if not blocks:
        return ids

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            ntype = node.get("type")
            if ntype == "user":
                uid = node.get("user_id")
                if isinstance(uid, str) and uid.startswith(("U", "W")):
                    ids.add(uid)
            # `text`/`mrkdwn`/`plain_text` may also embed <@U...>
            text = node.get("text")
            if isinstance(text, str):
                ids.update(collect_user_ids_from_text(text))
            for value in node.values():
                if isinstance(value, (dict, list)):
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(blocks)
    return ids


def collect_user_ids_from_message(message: dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    author = message.get("user")
    if isinstance(author, str) and author.startswith(("U", "W")):
        ids.add(author)
    parent_user = message.get("parent_user_id")
    if isinstance(parent_user, str) and parent_user.startswith(("U", "W")):
        ids.add(parent_user)
    ids.update(collect_user_ids_from_text(message.get("text")))
    ids.update(collect_user_ids_from_blocks(message.get("blocks")))
    for attach in message.get("attachments") or []:
        if isinstance(attach, dict):
            ids.update(collect_user_ids_from_text(attach.get("text")))
            ids.update(collect_user_ids_from_text(attach.get("pretext")))
            ids.update(collect_user_ids_from_blocks(attach.get("blocks")))
    return ids


def collect_user_ids_from_messages(
    messages: Iterable[dict[str, Any]],
) -> set[str]:
    out: set[str] = set()
    for msg in messages:
        out.update(collect_user_ids_from_message(msg))
    return out


def preload_users(
    client: SlackClient,
    user_ids: Iterable[str],
    *,
    cache_users: Optional[dict[str, dict[str, Any]]] = None,
) -> dict[str, str]:
    """Fetch display names for each id, cache-first.

    If *cache_users* (a ``{id: user_obj}`` dict from :mod:`sk.cache`) is
    provided, ids already present there are satisfied without an API call.
    Any remaining ids fall through to live ``users.info``.  Failures for
    individual ids are swallowed — they simply won't appear in the returned
    mapping, and the renderer will fall back to ``@Uxxxx``.
    """
    names: dict[str, str] = {}
    remaining: list[str] = []

    if cache_users:
        for uid in user_ids:
            cached = cache_users.get(uid)
            name = _name_from_user(cached) if cached else None
            if name:
                names[uid] = name
            else:
                remaining.append(uid)
    else:
        remaining = list(user_ids)

    for uid in remaining:
        try:
            payload = client.call("users.info", user=uid)
        except SlackAPIError:
            continue
        u = payload.get("user") or {}
        name = _name_from_user(u)
        if name:
            names[uid] = name
    return names


def _name_from_user(u: dict[str, Any]) -> str:
    if not u:
        return ""
    profile = u.get("profile") or {}
    return (
        (profile.get("display_name") or "").strip()
        or (u.get("name") or "").strip()
        or (profile.get("real_name") or "").strip()
        or (u.get("real_name") or "").strip()
    )


def make_user_lookup(names: dict[str, str]) -> Callable[[str], Optional[str]]:
    def lookup(uid: str) -> Optional[str]:
        return names.get(uid)

    return lookup


__all__ = [
    "collect_user_ids_from_text",
    "collect_user_ids_from_blocks",
    "collect_user_ids_from_message",
    "collect_user_ids_from_messages",
    "preload_users",
    "make_user_lookup",
]
