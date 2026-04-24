"""Environment / token / path resolution.

- Loads ``<skill>/.env`` and ``$PWD/.env`` if present (simple parser, no deps).
- Resolves tokens per operation scope (read / search / unreads).
- Computes cache / files directories under ``$PWD/.agent-slack/cache/slack``.
"""

from __future__ import annotations

import os
from pathlib import Path

from .errors import TokenMissingError


ENV_BOT = "SLACK_BOT_TOKEN"
ENV_USER = "SLACK_USER_TOKEN"
ENV_ANY = "SLACK_TOKEN"
ENV_CACHE_DIR = "SLACK_SKILL_CACHE_DIR"
ENV_FILES_DIR = "SLACK_SKILL_FILES_DIR"
ENV_DOWNLOAD_TYPES = "SLACK_SKILL_DOWNLOAD_TYPES"
ENV_TIMEOUT = "SLACK_SKILL_TIMEOUT"
ENV_ALLOWED_CHANNELS = "SLACK_SKILL_ALLOWED_CHANNELS"


_DOTENV_LOADED = False


def _parse_dotenv(path: Path) -> None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if value and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        # Env vars already set by the caller win over .env values.
        os.environ.setdefault(key, value)


def load_dotenv() -> None:
    """Load ``slack/.env`` (next to the skill) then ``$PWD/.env``."""
    global _DOTENV_LOADED
    if _DOTENV_LOADED:
        return
    _DOTENV_LOADED = True

    # slack/.env — lives two levels above sk/ (scripts/sk/ -> scripts/ -> slack/)
    skill_dir = Path(__file__).resolve().parent.parent.parent
    _parse_dotenv(skill_dir / ".env")

    # $PWD/.env
    try:
        cwd = Path.cwd()
    except OSError:
        cwd = None
    if cwd is not None:
        _parse_dotenv(cwd / ".env")


class Config:
    """Resolved configuration for one CLI invocation."""

    def __init__(self) -> None:
        load_dotenv()
        self.bot_token = os.environ.get(ENV_BOT) or None
        self.user_token = os.environ.get(ENV_USER) or None
        self.any_token = os.environ.get(ENV_ANY) or None
        self.timeout = int(os.environ.get(ENV_TIMEOUT) or "60")

        allowed = os.environ.get(ENV_ALLOWED_CHANNELS) or ""
        self.allowed_channels = {
            item.strip().lstrip("#") for item in allowed.split(",") if item.strip()
        } or None

        self.download_types_default = (
            os.environ.get(ENV_DOWNLOAD_TYPES) or "text"
        )

        cwd = Path.cwd()
        self.cache_dir = Path(
            os.environ.get(ENV_CACHE_DIR) or (cwd / ".agent-slack" / "cache" / "slack")
        )
        self.files_dir = Path(
            os.environ.get(ENV_FILES_DIR) or (self.cache_dir / "files")
        )

    # -- token routing -------------------------------------------------

    def token_for(self, scope: str) -> str:
        """Return a token appropriate for *scope*.

        Scopes:
          - ``"read"``   bot → user → any  (channels/users/get/replies/history/files)
          - ``"search"`` user → any        (must be xoxp)
          - ``"unreads"`` user → any       (must be xoxp)
        """
        if scope == "read":
            chain = [(ENV_BOT, self.bot_token), (ENV_USER, self.user_token), (ENV_ANY, self.any_token)]
        elif scope in ("search", "unreads"):
            chain = [(ENV_USER, self.user_token), (ENV_ANY, self.any_token)]
        else:  # pragma: no cover - defensive
            raise ValueError(f"unknown token scope: {scope!r}")

        for _env_name, tok in chain:
            if tok:
                return tok

        required = " or ".join(env for env, _ in chain)
        raise TokenMissingError(
            f"{scope!r} operation requires a Slack token; set one of: {required}. "
            f"See slack/.env.example."
        )

    def ensure_dirs(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.files_dir.mkdir(parents=True, exist_ok=True)


__all__ = [
    "Config",
    "load_dotenv",
    "ENV_BOT",
    "ENV_USER",
    "ENV_ANY",
    "ENV_CACHE_DIR",
    "ENV_FILES_DIR",
    "ENV_DOWNLOAD_TYPES",
    "ENV_TIMEOUT",
    "ENV_ALLOWED_CHANNELS",
]
