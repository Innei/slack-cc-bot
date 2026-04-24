"""Private-file download helper.

Slack file URLs (``url_private`` / ``url_private_download``) are not public —
they require the same Bearer token that accessed the message.  Tools running
on the skill's output cannot fetch them without this helper.

Design:
- **Idempotent on disk** — files are named ``{file_id}{ext}`` under
  ``cfg.files_dir``.  If a file of that name exists (and is non-empty), we
  skip the download.  This also naturally dedupes shared files referenced
  from multiple messages.
- **Bearer token never logged** — error messages route through ``redact``.
- **Type-filtered** — caller passes a ``categories`` whitelist; files whose
  category doesn't match are returned with ``skipped_reason='type_filtered'``
  and never touched.
- **Atomic writes** — stream to ``<path>.part`` then ``os.replace`` so a
  killed download never leaves a partial file claiming to be complete.
"""

from __future__ import annotations

import mimetypes
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable, Optional

from .errors import SlackSkillError, redact


# --- category classification ------------------------------------------

# mimetype prefix  →  category
_MIME_PREFIX_CAT: dict[str, str] = {
    "image/": "image",
    "video/": "video",
    "audio/": "audio",
    "text/": "text",
}

# filetype (Slack's own taxonomy) / extension  →  category
_FILETYPE_CAT: dict[str, str] = {
    # text-ish
    "text": "text", "post": "text", "snippet": "text", "markdown": "text",
    "md": "text", "gdoc": "text", "docx": "text", "doc": "text",
    "email": "text", "csv": "text", "log": "text",
    # pdf
    "pdf": "pdf",
    # code — treated as text for filter purposes so AI can read sources
    "py": "text", "js": "text", "ts": "text", "tsx": "text", "jsx": "text",
    "go": "text", "java": "text", "kt": "text", "rb": "text", "rs": "text",
    "c": "text", "h": "text", "cpp": "text", "hpp": "text",
    "sh": "text", "bash": "text", "zsh": "text",
    "json": "text", "yaml": "text", "yml": "text", "toml": "text",
    "xml": "text", "html": "text", "css": "text", "scss": "text", "sql": "text",
    # images
    "png": "image", "jpg": "image", "jpeg": "image", "gif": "image",
    "webp": "image", "heic": "image", "bmp": "image", "tiff": "image",
    "svg": "image",
    # video / audio / archive
    "mp4": "video", "mov": "video", "webm": "video", "mkv": "video", "avi": "video",
    "mp3": "audio", "m4a": "audio", "wav": "audio", "flac": "audio",
    "ogg": "audio", "opus": "audio",
    "zip": "archive", "tar": "archive", "gz": "archive", "tgz": "archive",
    "rar": "archive", "7z": "archive",
}

VALID_CATEGORIES = {"text", "image", "video", "audio", "pdf", "archive", "other", "all"}


def categorize(file_obj: dict[str, Any]) -> str:
    """Return one of ``VALID_CATEGORIES`` (minus ``all``) for *file_obj*."""
    mimetype = (file_obj.get("mimetype") or "").lower()
    for prefix, cat in _MIME_PREFIX_CAT.items():
        if mimetype.startswith(prefix):
            return cat
    if mimetype == "application/pdf":
        return "pdf"

    filetype = (file_obj.get("filetype") or "").lower()
    if filetype in _FILETYPE_CAT:
        return _FILETYPE_CAT[filetype]

    # Fallback: extension from name.
    name = (file_obj.get("name") or "").lower()
    _, _, ext = name.rpartition(".")
    if ext and ext in _FILETYPE_CAT:
        return _FILETYPE_CAT[ext]

    return "other"


def parse_types(raw: str) -> set[str]:
    """Parse a comma-separated ``--types`` value into a category set.

    ``"all"`` expands to every concrete category.  Unknown values are
    reported as :class:`SlackSkillError` so typos fail loudly.
    """
    tokens = {t.strip().lower() for t in (raw or "").split(",") if t.strip()}
    if not tokens:
        tokens = {"all"}

    unknown = tokens - VALID_CATEGORIES
    if unknown:
        raise SlackSkillError(
            f"unknown --types value(s): {sorted(unknown)}; "
            f"allowed: {sorted(VALID_CATEGORIES)}"
        )

    if "all" in tokens:
        return VALID_CATEGORIES - {"all"}
    return tokens


# --- download ----------------------------------------------------------

_EXT_BY_MIME_FALLBACK = {
    "application/pdf": ".pdf",
    "image/svg+xml": ".svg",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "application/json": ".json",
}


def _pick_extension(file_obj: dict[str, Any]) -> str:
    """Best-effort filename extension starting with ``.``."""
    name = (file_obj.get("name") or "").strip()
    if "." in name:
        ext = "." + name.rsplit(".", 1)[-1].lower()
        if 1 < len(ext) <= 8:
            return ext

    filetype = (file_obj.get("filetype") or "").strip().lower()
    if filetype and 0 < len(filetype) <= 6 and filetype.isalnum():
        return "." + filetype

    mimetype = (file_obj.get("mimetype") or "").strip().lower()
    if mimetype:
        guessed = mimetypes.guess_extension(mimetype)
        if guessed:
            return guessed
        if mimetype in _EXT_BY_MIME_FALLBACK:
            return _EXT_BY_MIME_FALLBACK[mimetype]

    return ".bin"


def local_path_for(file_obj: dict[str, Any], files_dir: Path) -> Path:
    file_id = file_obj.get("id") or "unknown"
    return files_dir / f"{file_id}{_pick_extension(file_obj)}"


def download_file(
    file_obj: dict[str, Any],
    *,
    token: str,
    files_dir: Path,
    categories: set[str],
    timeout: int = 60,
) -> dict[str, Any]:
    """Download a single Slack file object.

    Returns a report dict::

        {
          "id": "F...",
          "name": "...",
          "mimetype": "...",
          "category": "image",
          "size": 12345,            # bytes actually on disk (or source size)
          "local_path": "/abs/..",  # None on skip_reason='type_filtered'
          "skipped": bool,
          "skipped_reason": "type_filtered" | "already_exists" | None,
          "error": None | "...",
        }
    """
    file_id = file_obj.get("id")
    name = file_obj.get("name")
    mimetype = file_obj.get("mimetype")
    category = categorize(file_obj)

    report: dict[str, Any] = {
        "id": file_id,
        "name": name,
        "mimetype": mimetype,
        "category": category,
        "size": file_obj.get("size"),
        "local_path": None,
        "skipped": False,
        "skipped_reason": None,
        "error": None,
    }

    if category not in categories:
        report["skipped"] = True
        report["skipped_reason"] = "type_filtered"
        return report

    if not file_id:
        report["error"] = "missing file id"
        return report

    url = file_obj.get("url_private_download") or file_obj.get("url_private")
    if not url:
        # Tombstones / deleted files have no download URL.
        report["error"] = "no url_private on file object (deleted or tombstoned?)"
        return report

    files_dir.mkdir(parents=True, exist_ok=True)
    dest = local_path_for(file_obj, files_dir)

    if dest.exists() and dest.stat().st_size > 0:
        report["local_path"] = str(dest)
        report["skipped"] = True
        report["skipped_reason"] = "already_exists"
        report["size"] = dest.stat().st_size
        return report

    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "User-Agent": "winches-slack-skill",
                "Accept": "*/*",
            },
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            # Slack sometimes 302-redirects un-authenticated callers back to
            # the workspace login page and returns HTML — guard by checking
            # Content-Type when we were expecting binary.
            with open(tmp, "wb") as fp:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    fp.write(chunk)
        os.replace(tmp, dest)
    except urllib.error.HTTPError as exc:
        _cleanup(tmp)
        report["error"] = redact(f"http_{exc.code}: {exc.reason}")
        return report
    except urllib.error.URLError as exc:
        _cleanup(tmp)
        report["error"] = redact(f"url_error: {exc.reason}")
        return report
    except OSError as exc:
        _cleanup(tmp)
        report["error"] = redact(f"os_error: {exc}")
        return report

    report["local_path"] = str(dest)
    report["size"] = dest.stat().st_size
    return report


def _cleanup(path: Path) -> None:
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


def download_files_for_messages(
    messages: Iterable[dict[str, Any]],
    *,
    token: str,
    files_dir: Path,
    categories: set[str],
    timeout: int = 60,
) -> dict[str, Any]:
    """Download every ``files[]`` entry across *messages* and mutate in place.

    Each normalised file dict gains ``local_path`` (or stays ``None`` when
    skipped / failed) plus sidecar fields ``download_category`` and
    ``download_status`` (``"ok" | "skipped:<reason>" | "error:<msg>"``).

    Idempotent across messages: a file seen twice (same id) only downloads
    once because ``local_path_for`` collides and we detect ``already_exists``.
    Returns a summary dict.
    """
    seen: dict[str, dict[str, Any]] = {}
    downloaded = 0
    skipped = 0
    errored = 0

    for msg in messages:
        for f in msg.get("files") or []:
            if not isinstance(f, dict):
                continue
            fid = f.get("id")

            if fid and fid in seen:
                report = seen[fid]
            else:
                report = download_file(
                    f,
                    token=token,
                    files_dir=files_dir,
                    categories=categories,
                    timeout=timeout,
                )
                if fid:
                    seen[fid] = report
                if report.get("error"):
                    errored += 1
                elif report.get("skipped"):
                    skipped += 1
                else:
                    downloaded += 1

            f["local_path"] = report.get("local_path")
            f["download_category"] = report.get("category")
            if report.get("error"):
                f["download_status"] = f"error:{report['error']}"
            elif report.get("skipped"):
                f["download_status"] = f"skipped:{report.get('skipped_reason')}"
            else:
                f["download_status"] = "ok"

    return {
        "total_files": sum(1 for _ in seen),
        "downloaded": downloaded,
        "skipped": skipped,
        "errored": errored,
        "files_dir": str(files_dir),
    }


__all__ = [
    "categorize",
    "parse_types",
    "local_path_for",
    "download_file",
    "download_files_for_messages",
    "VALID_CATEGORIES",
]
