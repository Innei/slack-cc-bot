"""Custom exceptions + token-redaction helpers."""

from __future__ import annotations

import re


_TOKEN_RE = re.compile(r"xox[abposr]-[A-Za-z0-9-]{10,}")


def redact(text: str) -> str:
    """Replace any Slack token-looking substring with ``xox*-***redacted***``."""
    if not text:
        return text
    return _TOKEN_RE.sub(lambda m: m.group(0)[:4] + "***redacted***", text)


class SlackSkillError(RuntimeError):
    """Base class for every user-visible error raised by the skill."""

    exit_code: int = 1


class TokenMissingError(SlackSkillError):
    """Required env var(s) not set."""

    exit_code = 2


class ReadOnlyViolation(SlackSkillError):
    """Attempt to call a Slack method not in the read-only whitelist."""

    exit_code = 3


class InvalidArgument(SlackSkillError):
    exit_code = 4


class SlackAPIError(SlackSkillError):
    """Slack responded with ``ok: false`` or HTTP error."""

    def __init__(self, method: str, error: str, *, http_status: int | None = None, detail: str | None = None):
        self.method = method
        self.error = error
        self.http_status = http_status
        self.detail = detail
        message = f"{method}: {error}"
        if http_status:
            message = f"HTTP {http_status} {message}"
        if detail:
            message = f"{message} | {redact(detail)[:500]}"
        super().__init__(message)


__all__ = [
    "SlackSkillError",
    "TokenMissingError",
    "ReadOnlyViolation",
    "InvalidArgument",
    "SlackAPIError",
    "redact",
]
