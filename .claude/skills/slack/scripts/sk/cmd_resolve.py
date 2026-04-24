"""``resolve`` subcommand — resolve @name / #name / id / email to an object."""

from __future__ import annotations

import argparse
from typing import Any, Optional

from . import cache
from .channels import looks_like_channel_id, resolve_channel
from .client import SlackClient
from .config import Config
from .errors import InvalidArgument, SlackAPIError
from .output import emit


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "resolve",
        help="resolve a @name / #name / id / email to a user or channel object",
        description=(
            "One-shot symbol lookup.  Accepts:\n"
            "  @alice          user by display name / handle\n"
            "  alice@co.com    user by email\n"
            "  U06...          user by id (live fallback)\n"
            "  #eng            channel by name\n"
            "  C08... / G...   channel by id (live fallback)\n"
            "  ^handle         usergroup (subteam) by handle\n"
            "  S0...           usergroup by id\n\n"
            "Returns a single resolved object; for ambiguous matches, "
            "returns the top candidate plus a ``candidates`` list."
        ),
    )
    p.add_argument("token", help="what to resolve (see description)")
    p.add_argument(
        "--output",
        default=None,
        help='write JSON to this file instead of stdout ("-" = stdout)',
    )
    p.set_defaults(func=run)


def run(args: argparse.Namespace) -> int:
    token = args.token.strip()
    if not token:
        raise InvalidArgument("resolve token cannot be empty")

    cfg = Config()

    kind, resolved, candidates, refresh_report = _dispatch(cfg, token)

    result: dict[str, Any] = {
        "input": token,
        "kind": kind,
        "resolved": resolved,
    }
    if candidates:
        result["candidates"] = candidates
    if refresh_report:
        result["cache_refresh"] = refresh_report

    emit(result, output=args.output)
    return 0 if resolved else 1


def _dispatch(
    cfg: Config, token: str
) -> tuple[str, Optional[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    refresh_report: dict[str, Any] = {}

    # ------------------------------------------------------------------
    # Usergroup / subteam: ^handle or S...
    # ------------------------------------------------------------------
    if token.startswith("^") or (token.startswith("S") and token[1:].isalnum() and token.isupper()):
        if token.startswith("^"):
            refresh_report.update(cache.ensure_fresh(cfg, ["subteams"]))
        subteams = cache.load_subteams(cfg.cache_dir)
        handle = token.lstrip("^")
        for s in subteams.values():
            if s.get("id") == handle or s.get("handle") == handle:
                return "usergroup", _shape_subteam(s), [], refresh_report
        return "usergroup", None, [], refresh_report

    # ------------------------------------------------------------------
    # Channel: # prefix, or a bare channel id
    # ------------------------------------------------------------------
    if token.startswith("#") or looks_like_channel_id(token):
        name = token.lstrip("#")
        if not looks_like_channel_id(name):
            # Fuzzy #name search needs the full channels dict
            refresh_report.update(cache.ensure_fresh(cfg, ["channels"]))
        channels = cache.load_channels(cfg.cache_dir)

        if looks_like_channel_id(name):
            ch = channels.get(name)
            if ch:
                return "channel", _shape_channel(ch), [], refresh_report
            # live fallback
            try:
                client = SlackClient(cfg.token_for("read"), timeout=cfg.timeout)
                ch = resolve_channel(client, name)
                return "channel", _shape_channel(ch), [], refresh_report
            except InvalidArgument:
                return "channel", None, [], refresh_report

        # #name
        candidates: list[dict[str, Any]] = []
        for ch in channels.values():
            if ch.get("name") == name or ch.get("name_normalized") == name:
                return "channel", _shape_channel(ch), [], refresh_report
            if (
                name.lower() in (ch.get("name") or "").lower()
                or name.lower() in (ch.get("name_normalized") or "").lower()
            ):
                candidates.append(_shape_channel(ch))
        if not candidates:
            # live fallback (scans conversations.list)
            try:
                client = SlackClient(cfg.token_for("read"), timeout=cfg.timeout)
                ch = resolve_channel(client, "#" + name)
                return "channel", _shape_channel(ch), [], refresh_report
            except InvalidArgument:
                return "channel", None, [], refresh_report
        top = candidates[0]
        return "channel", top, candidates[1:][:10], refresh_report

    # ------------------------------------------------------------------
    # User id: U... / W...
    # ------------------------------------------------------------------
    if token[0] in ("U", "W") and token[1:].isalnum() and token.isupper():
        users = cache.load_users(cfg.cache_dir)
        u = users.get(token)
        if u:
            return "user", _shape_user(u), [], refresh_report
        try:
            client = SlackClient(cfg.token_for("read"), timeout=cfg.timeout)
            payload = client.call("users.info", user=token)
            u = payload.get("user")
            return "user", _shape_user(u) if u else None, [], refresh_report
        except SlackAPIError:
            return "user", None, [], refresh_report

    # ------------------------------------------------------------------
    # Email: contains "@" and a "." after it
    # ------------------------------------------------------------------
    if "@" in token and "." in token.split("@", 1)[1]:
        users = cache.load_users(cfg.cache_dir)
        email = token.strip().lower()
        for u in users.values():
            if ((u.get("profile") or {}).get("email") or "").strip().lower() == email:
                return "user", _shape_user(u), [], refresh_report
        try:
            client = SlackClient(cfg.token_for("read"), timeout=cfg.timeout)
            payload = client.call("users.lookupByEmail", email=token)
            u = payload.get("user")
            return "user", _shape_user(u) if u else None, [], refresh_report
        except SlackAPIError:
            return "user", None, [], refresh_report

    # ------------------------------------------------------------------
    # @handle / bare name → user fuzzy search (needs full users dict)
    # ------------------------------------------------------------------
    refresh_report.update(cache.ensure_fresh(cfg, ["users"]))
    users = cache.load_users(cfg.cache_dir)
    handle = token.lstrip("@").lower()
    exact: list[dict[str, Any]] = []
    partial: list[dict[str, Any]] = []
    for u in users.values():
        if u.get("deleted"):
            continue
        profile = u.get("profile") or {}
        dn = (profile.get("display_name") or "").lower()
        name = (u.get("name") or "").lower()
        rn = (u.get("real_name") or "").lower()
        if handle in (dn, name, rn):
            exact.append(u)
        elif dn.startswith(handle) or name.startswith(handle):
            partial.append(u)
        elif handle in dn or handle in name or handle in rn:
            partial.append(u)

    hits = exact + partial
    if not hits:
        return "user", None, [], refresh_report
    top = _shape_user(hits[0])
    extras = [_shape_user(u) for u in hits[1:11]]
    return "user", top, extras, refresh_report


# ---------------------------------------------------------------------------
# Shape helpers — match output shapes from cmd_users / cmd_channels so
# downstream consumers don't have to key off two shapes.
# ---------------------------------------------------------------------------

def _shape_user(u: dict[str, Any]) -> dict[str, Any]:
    if not u:
        return {}
    profile = u.get("profile") or {}
    return {
        "id": u.get("id"),
        "name": u.get("name"),
        "real_name": u.get("real_name") or profile.get("real_name"),
        "display_name": profile.get("display_name"),
        "email": profile.get("email"),
        "title": profile.get("title"),
        "is_bot": bool(u.get("is_bot")),
        "deleted": bool(u.get("deleted")),
        "tz": u.get("tz"),
    }


def _shape_channel(c: dict[str, Any]) -> dict[str, Any]:
    if not c:
        return {}
    return {
        "id": c.get("id"),
        "name": c.get("name"),
        "is_private": bool(c.get("is_private")),
        "is_archived": bool(c.get("is_archived")),
        "is_im": bool(c.get("is_im")),
        "is_mpim": bool(c.get("is_mpim")),
        "num_members": c.get("num_members"),
        "topic": c.get("topic") or ((c.get("topic") or {}).get("value") if isinstance(c.get("topic"), dict) else None),
        "purpose": c.get("purpose") or ((c.get("purpose") or {}).get("value") if isinstance(c.get("purpose"), dict) else None),
        "creator": c.get("creator"),
    }


def _shape_subteam(s: dict[str, Any]) -> dict[str, Any]:
    if not s:
        return {}
    return {
        "id": s.get("id"),
        "handle": s.get("handle"),
        "name": s.get("name"),
        "description": s.get("description"),
        "user_count": s.get("user_count"),
    }


__all__ = ["register", "run"]
