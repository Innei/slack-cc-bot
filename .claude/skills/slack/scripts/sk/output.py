"""Output helper — emit JSON either to stdout or to a file.

Used by every ``cmd_*`` module so large results stay out of AI context.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Optional


def emit(payload: Any, *, output: Optional[str] = None, pretty: bool = True) -> None:
    """Emit *payload* as JSON.

    - If *output* is None (or ``"-"``) → write to stdout.
    - Otherwise → atomic write to the given path, then print ``saved: <path>`` to stdout.
    """
    text = json.dumps(payload, ensure_ascii=False, indent=2 if pretty else None)

    if output in (None, "", "-"):
        sys.stdout.write(text)
        if not text.endswith("\n"):
            sys.stdout.write("\n")
        sys.stdout.flush()
        return

    path = Path(output).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp = tempfile.mkstemp(prefix=".slack-skill-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

    sys.stdout.write(f"saved: {path}\n")
    sys.stdout.flush()


__all__ = ["emit"]
