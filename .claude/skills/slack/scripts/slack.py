#!/usr/bin/env python3
"""Entry point for the Slack skill CLI.

Running:

    python slack/scripts/slack.py <subcommand> [args...]

This file only wires ``sk/`` onto ``sys.path`` and delegates to
``sk.cli.main``.  Keep logic in the ``sk`` package.
"""

from __future__ import annotations

import sys
from pathlib import Path


def _bootstrap() -> int:
    here = Path(__file__).resolve().parent
    if str(here) not in sys.path:
        sys.path.insert(0, str(here))

    from sk.cli import main  # noqa: PLC0415 — needs path setup above

    return main(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(_bootstrap())
