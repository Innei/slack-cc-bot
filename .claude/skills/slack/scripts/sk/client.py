"""HTTP client for the Slack Web API.

Design decisions (see ``docs/specs/slack-skill.md``):

- Uses only ``urllib`` from the standard library (0 runtime dependencies).
- Enforces a hard-coded **read-only method whitelist** as defense-in-depth.
  Even a token with ``chat:write`` cannot send a message through this client.
- Honours ``Retry-After`` on HTTP 429 and retries transient errors up to 3 times.
- Redacts Slack tokens from every error message it surfaces.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from typing import Any, Iterable, Iterator, Optional
from urllib.error import HTTPError, URLError

from .errors import ReadOnlyViolation, SlackAPIError, redact


API_BASE = "https://slack.com/api/"
USER_AGENT = "winches-slack-skill/0.1 (+https://github.com/winchesHe/winches-skills)"

#: Hard-coded whitelist of Slack Web API methods the skill may ever call.
#: Adding a method here is the **only** way to widen capability — editing this
#: set should be paired with a review of whether it's still strictly read-only.
READ_ONLY_METHODS: frozenset[str] = frozenset(
    {
        # auth / sanity
        "auth.test",
        # messages (read)
        "conversations.history",
        "conversations.replies",
        "conversations.info",
        "conversations.list",
        "conversations.members",
        # search
        "search.messages",
        # users
        "users.list",
        "users.info",
        "users.lookupByEmail",
        # usergroups
        "usergroups.list",
        "usergroups.users.list",
        # files
        "files.info",
    }
)


class SlackClient:
    """Minimal urllib-based client enforcing the read-only whitelist."""

    def __init__(
        self,
        token: str,
        *,
        timeout: int = 60,
        max_retries: int = 3,
        user_agent: str = USER_AGENT,
    ) -> None:
        self._token = token
        self._timeout = timeout
        self._max_retries = max_retries
        self._user_agent = user_agent

    # -- public API ----------------------------------------------------

    def call(self, method: str, **params: Any) -> dict[str, Any]:
        """Call ``method`` with *params*.  Raises on ``ok: false`` or HTTP error."""
        if method not in READ_ONLY_METHODS:
            raise ReadOnlyViolation(
                f"method {method!r} is not in the read-only whitelist; "
                f"the slack skill does not perform writes."
            )

        url = API_BASE + method
        # Slack accepts GET with query string for every read method we use.
        qs = urllib.parse.urlencode(
            {k: _stringify(v) for k, v in params.items() if v is not None}
        )
        if qs:
            url = f"{url}?{qs}"

        last_error: Optional[Exception] = None
        for attempt in range(self._max_retries):
            try:
                payload = self._request_json(url, method=method)
            except _Retryable as exc:
                last_error = exc.original
                if attempt + 1 >= self._max_retries:
                    break
                time.sleep(exc.delay)
                continue

            if not payload.get("ok", False):
                err = str(payload.get("error") or "unknown_error")
                # ratelimited returned as ok:false with Retry-After header
                # is handled at the HTTP layer; this branch covers logical errors.
                raise SlackAPIError(method, err, detail=_truncate_detail(payload))
            return payload

        assert last_error is not None  # for mypy; loop exits only via break
        raise last_error

    def paginate(
        self,
        method: str,
        *,
        result_key: str,
        page_size: int = 200,
        **params: Any,
    ) -> Iterator[dict[str, Any]]:
        """Yield items from ``payload[result_key]`` across every cursor page."""
        cursor = ""
        local = dict(params)
        local.setdefault("limit", page_size)
        while True:
            if cursor:
                local["cursor"] = cursor
            payload = self.call(method, **local)
            for item in payload.get(result_key) or []:
                yield item
            cursor = (
                (payload.get("response_metadata") or {}).get("next_cursor") or ""
            ).strip()
            if not cursor:
                return

    # -- HTTP layer ----------------------------------------------------

    def _request_json(self, url: str, *, method: str) -> dict[str, Any]:
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {self._token}",
                "User-Agent": self._user_agent,
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                body = resp.read()
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            if exc.code == 429:
                retry_after = _parse_retry_after(exc.headers.get("Retry-After"))
                raise _Retryable(exc, delay=retry_after) from None
            if exc.code >= 500:
                raise _Retryable(exc, delay=1) from None
            raise SlackAPIError(
                method,
                f"http_{exc.code}",
                http_status=exc.code,
                detail=redact(detail),
            ) from None
        except URLError as exc:
            raise _Retryable(exc, delay=1) from None

        try:
            return json.loads(body.decode("utf-8"))
        except ValueError as exc:
            raise SlackAPIError(method, "invalid_json", detail=redact(str(exc))) from None


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------

class _Retryable(Exception):
    """Wraps an exception that the retry loop may swallow."""

    def __init__(self, original: Exception, *, delay: int) -> None:
        super().__init__(str(original))
        self.original = original
        self.delay = max(1, min(delay, 30))


def _stringify(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, tuple, set, frozenset)):
        return ",".join(_stringify(v) for v in value)
    return str(value)


def _parse_retry_after(value: Optional[str]) -> int:
    if not value:
        return 1
    try:
        return max(1, min(int(value), 30))
    except ValueError:
        return 1


def _truncate_detail(payload: dict[str, Any]) -> str:
    try:
        blob = json.dumps(payload, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        return ""
    return redact(blob[:500])


def is_read_only_method(method: str) -> bool:
    return method in READ_ONLY_METHODS


__all__ = [
    "SlackClient",
    "READ_ONLY_METHODS",
    "is_read_only_method",
]
