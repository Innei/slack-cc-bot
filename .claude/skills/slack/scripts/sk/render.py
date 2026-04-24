"""Block-kit / mrkdwn rendering.

Two public entry points:

- :func:`render_mrkdwn` — string-level substitution of Slack mrkdwn tokens
  (``<@U>`` / ``<#C>`` / ``<!here>`` / ``<url|text>`` / HTML entities).
  Pure function; caller supplies lookup callables.

- :func:`render_blocks` — walks a Slack Block Kit tree and produces a plain
  readable string.  Handles ``section`` / ``header`` / ``divider`` /
  ``context`` / ``actions`` / ``fields`` / ``image`` / ``video`` / ``file``
  / ``input`` and the full ``rich_text`` family (``rich_text_section``,
  ``rich_text_list``, ``rich_text_preformatted``, ``rich_text_quote``).

Both functions are side-effect-free: they never call the Slack API.  Caller
must preload user/channel names (see :mod:`sk.mentions`).
"""

from __future__ import annotations

import re
from typing import Any, Callable, Optional


# <@U123>  or  <@U123|display>
_USER_RE = re.compile(r"<@([UW][A-Z0-9]+)(?:\|([^>]+))?>")
# <#C123>  or  <#C123|channel-name>
_CHANNEL_RE = re.compile(r"<#([CGD][A-Z0-9]+)(?:\|([^>]+))?>")
# <!subteam^S123|@group>  or  <!subteam^S123>
_SUBTEAM_RE = re.compile(r"<!subteam\^([A-Z0-9]+)(?:\|([^>]+))?>")
# <!here>  <!channel>  <!everyone>
_SPECIAL_RE = re.compile(r"<!(here|channel|everyone)(?:\|[^>]+)?>")
# <url>  <url|text>  —  not starting with @ # !
_LINK_RE = re.compile(r"<((?:https?|mailto):[^|>]+)(?:\|([^>]+))?>")

# Slack mrkdwn escapes:  &amp; &lt; &gt;
_HTML_ESC = {"&amp;": "&", "&lt;": "<", "&gt;": ">"}


NameLookup = Callable[[str], Optional[str]]


def _noop(_id: str) -> Optional[str]:
    return None


def render_mrkdwn(
    text: str,
    *,
    user_lookup: NameLookup = _noop,
    channel_lookup: NameLookup = _noop,
    subteam_lookup: NameLookup = _noop,
) -> str:
    """Convert Slack mrkdwn ``text`` to a plain-readable string.

    - ``<@Uxxx>``  → ``@display_name`` (via *user_lookup*, else ``@Uxxx``)
    - ``<#Cxxx|name>``  → ``#name`` (falls back to lookup, then ``#Cxxx``)
    - ``<!subteam^Sxxx|@group>`` → ``@group``
    - ``<!here>`` etc. → ``@here``
    - ``<url|text>`` → ``text (url)``; ``<url>`` → ``url``
    - ``&amp;`` / ``&lt;`` / ``&gt;`` unescaped
    """
    if not text:
        return text or ""

    def sub_user(m: re.Match) -> str:
        uid, label = m.group(1), m.group(2)
        if label:
            return f"@{label}"
        name = user_lookup(uid)
        return f"@{name}" if name else f"@{uid}"

    def sub_channel(m: re.Match) -> str:
        cid, label = m.group(1), m.group(2)
        if label:
            return f"#{label}"
        name = channel_lookup(cid)
        return f"#{name}" if name else f"#{cid}"

    def sub_subteam(m: re.Match) -> str:
        sid, label = m.group(1), m.group(2)
        if label:
            return label if label.startswith("@") else f"@{label}"
        name = subteam_lookup(sid)
        return f"@{name}" if name else f"@{sid}"

    def sub_special(m: re.Match) -> str:
        return f"@{m.group(1)}"

    def sub_link(m: re.Match) -> str:
        url, label = m.group(1), m.group(2)
        if label:
            return f"{label} ({url})"
        return url

    out = _USER_RE.sub(sub_user, text)
    out = _CHANNEL_RE.sub(sub_channel, out)
    out = _SUBTEAM_RE.sub(sub_subteam, out)
    out = _SPECIAL_RE.sub(sub_special, out)
    out = _LINK_RE.sub(sub_link, out)
    for k, v in _HTML_ESC.items():
        out = out.replace(k, v)
    return out


# ----------------------------------------------------------------------
# Block Kit rendering
# ----------------------------------------------------------------------

def render_blocks(
    blocks: Optional[list[dict[str, Any]]],
    *,
    user_lookup: NameLookup = _noop,
    channel_lookup: NameLookup = _noop,
    subteam_lookup: NameLookup = _noop,
) -> str:
    """Render Slack Block Kit ``blocks`` to a plain-text best-effort string.

    Unknown block/element types degrade gracefully to a tag like
    ``[unknown: <type>]`` rather than disappearing silently, so callers can
    spot gaps without breaking pipelines.
    """
    if not blocks:
        return ""

    ctx = _RenderCtx(user_lookup=user_lookup, channel_lookup=channel_lookup, subteam_lookup=subteam_lookup)
    parts: list[str] = []
    for block in blocks:
        rendered = _render_block(block, ctx)
        if rendered:
            parts.append(rendered)
    return "\n\n".join(parts).rstrip()


class _RenderCtx:
    __slots__ = ("user_lookup", "channel_lookup", "subteam_lookup")

    def __init__(self, *, user_lookup: NameLookup, channel_lookup: NameLookup, subteam_lookup: NameLookup) -> None:
        self.user_lookup = user_lookup
        self.channel_lookup = channel_lookup
        self.subteam_lookup = subteam_lookup

    def mrkdwn(self, text: str) -> str:
        return render_mrkdwn(
            text,
            user_lookup=self.user_lookup,
            channel_lookup=self.channel_lookup,
            subteam_lookup=self.subteam_lookup,
        )


def _render_block(block: dict[str, Any], ctx: _RenderCtx) -> str:
    btype = block.get("type") or "unknown"

    if btype == "divider":
        return "---"
    if btype == "header":
        return _render_text_obj(block.get("text"), ctx, as_header=True)
    if btype == "section":
        return _render_section(block, ctx)
    if btype == "context":
        return _render_context(block, ctx)
    if btype == "actions":
        return _render_actions(block, ctx)
    if btype == "rich_text":
        return _render_rich_text(block, ctx)
    if btype == "image":
        return _render_image(block, ctx)
    if btype == "video":
        return _render_video(block, ctx)
    if btype == "file":
        ext = block.get("external_id") or block.get("file_id") or ""
        suffix = f" ({ext})" if ext else ""
        return f"[file{suffix}]"
    if btype == "input":
        label = _render_text_obj(block.get("label"), ctx)
        return f"[input: {label}]" if label else "[input]"
    if btype == "call":
        return "[call]"
    return f"[unknown block: {btype}]"


def _render_text_obj(
    text_obj: Any, ctx: _RenderCtx, *, as_header: bool = False
) -> str:
    if not isinstance(text_obj, dict):
        return ""
    ttype = text_obj.get("type")
    raw = text_obj.get("text") or ""
    if ttype == "mrkdwn":
        rendered = ctx.mrkdwn(raw)
    else:  # plain_text or unknown → keep raw
        rendered = raw
    if as_header and rendered:
        return f"# {rendered}"
    return rendered


def _render_section(block: dict[str, Any], ctx: _RenderCtx) -> str:
    parts: list[str] = []
    main = _render_text_obj(block.get("text"), ctx)
    if main:
        parts.append(main)
    fields = block.get("fields") or []
    for field in fields:
        rendered = _render_text_obj(field, ctx)
        if rendered:
            parts.append(f"• {rendered}")
    accessory = block.get("accessory")
    if isinstance(accessory, dict):
        acc_type = accessory.get("type")
        if acc_type == "image":
            alt = accessory.get("alt_text") or ""
            url = accessory.get("image_url") or ""
            parts.append(f"[image: {alt or url}]".rstrip())
        elif acc_type == "button":
            label = _render_text_obj(accessory.get("text"), ctx) or "button"
            parts.append(f"[button: {label}]")
    return "\n".join(parts).rstrip()


def _render_context(block: dict[str, Any], ctx: _RenderCtx) -> str:
    pieces: list[str] = []
    for el in block.get("elements") or []:
        if not isinstance(el, dict):
            continue
        etype = el.get("type")
        if etype in ("mrkdwn", "plain_text"):
            rendered = _render_text_obj(el, ctx)
            if rendered:
                pieces.append(rendered)
        elif etype == "image":
            alt = el.get("alt_text") or ""
            pieces.append(f"[image: {alt}]" if alt else "[image]")
    return " ".join(pieces).strip()


def _render_actions(block: dict[str, Any], ctx: _RenderCtx) -> str:
    labels: list[str] = []
    for el in block.get("elements") or []:
        if not isinstance(el, dict):
            continue
        etype = el.get("type")
        label = _render_text_obj(el.get("text"), ctx) if etype != "datepicker" else ""
        if etype == "button":
            labels.append(f"[{label or 'button'}]")
        elif etype == "static_select":
            labels.append(f"[select: {label or '...'}]")
        elif etype == "datepicker":
            labels.append("[datepicker]")
        else:
            labels.append(f"[{etype}]")
    return " ".join(labels).strip()


def _render_image(block: dict[str, Any], ctx: _RenderCtx) -> str:
    alt = block.get("alt_text") or ""
    title = _render_text_obj(block.get("title"), ctx)
    url = block.get("image_url") or block.get("slack_file", {}).get("url") or ""
    parts = [p for p in (title, alt, url) if p]
    return f"[image: {' — '.join(parts)}]" if parts else "[image]"


def _render_video(block: dict[str, Any], ctx: _RenderCtx) -> str:
    title = _render_text_obj(block.get("title"), ctx)
    return f"[video: {title}]" if title else "[video]"


# ---- rich_text ----------------------------------------------------------

def _render_rich_text(block: dict[str, Any], ctx: _RenderCtx) -> str:
    out: list[str] = []
    for el in block.get("elements") or []:
        out.append(_render_rich_element(el, ctx, list_depth=0))
    return "\n".join(p for p in out if p).rstrip()


def _render_rich_element(
    element: Any, ctx: _RenderCtx, *, list_depth: int
) -> str:
    if not isinstance(element, dict):
        return ""
    etype = element.get("type")
    if etype == "rich_text_section":
        return _render_rich_section(element.get("elements") or [], ctx)
    if etype == "rich_text_preformatted":
        body = _render_rich_section(element.get("elements") or [], ctx)
        return f"```\n{body}\n```"
    if etype == "rich_text_quote":
        body = _render_rich_section(element.get("elements") or [], ctx)
        return "\n".join(f"> {line}" if line else ">" for line in body.split("\n"))
    if etype == "rich_text_list":
        return _render_rich_list(element, ctx, depth=list_depth)
    return f"[{etype}]"


def _render_rich_list(
    element: dict[str, Any], ctx: _RenderCtx, *, depth: int
) -> str:
    style = element.get("style") or "bullet"
    indent = "  " * max(depth, 0)
    items = element.get("elements") or []
    lines: list[str] = []
    for idx, child in enumerate(items, 1):
        if not isinstance(child, dict):
            continue
        # Each list item is typically a rich_text_section; nested lists
        # appear as rich_text_list siblings with higher "indent".
        if child.get("type") == "rich_text_list":
            lines.append(
                _render_rich_list(child, ctx, depth=depth + 1)
            )
            continue
        body = _render_rich_element(child, ctx, list_depth=depth + 1)
        bullet = "-" if style == "bullet" else f"{idx}."
        for i, line in enumerate(body.split("\n")):
            prefix = f"{indent}{bullet} " if i == 0 else f"{indent}   "
            lines.append(f"{prefix}{line}" if line else prefix.rstrip())
    return "\n".join(lines)


def _render_rich_section(elements: list[Any], ctx: _RenderCtx) -> str:
    parts: list[str] = []
    for el in elements:
        parts.append(_render_inline(el, ctx))
    return "".join(parts)


def _render_inline(el: Any, ctx: _RenderCtx) -> str:
    if not isinstance(el, dict):
        return ""
    etype = el.get("type")
    style = el.get("style") or {}

    if etype == "text":
        return _apply_style(el.get("text") or "", style)
    if etype == "user":
        uid = el.get("user_id") or ""
        name = ctx.user_lookup(uid) if uid else None
        return f"@{name or uid}"
    if etype == "channel":
        cid = el.get("channel_id") or ""
        name = ctx.channel_lookup(cid) if cid else None
        return f"#{name or cid}"
    if etype == "usergroup":
        sid = el.get("usergroup_id") or ""
        name = ctx.subteam_lookup(sid) if sid else None
        return f"@{name or sid}"
    if etype == "broadcast":
        return f"@{el.get('range') or 'channel'}"
    if etype == "link":
        url = el.get("url") or ""
        text = el.get("text") or ""
        if text and text != url:
            return f"{_apply_style(text, style)} ({url})"
        return url
    if etype == "emoji":
        name = el.get("name") or ""
        return f":{name}:" if name else ""
    if etype == "color":
        return el.get("value") or ""
    if etype == "date":
        # `fallback` is plain text for non-Slack renderers.
        return el.get("fallback") or el.get("text") or ""
    return f"[{etype}]"


def _apply_style(text: str, style: dict[str, Any]) -> str:
    if not text or not style:
        return text
    out = text
    if style.get("code"):
        out = f"`{out}`"
    if style.get("bold"):
        out = f"**{out}**"
    if style.get("italic"):
        out = f"*{out}*"
    if style.get("strike"):
        out = f"~~{out}~~"
    return out


__all__ = ["render_mrkdwn", "render_blocks", "NameLookup"]
