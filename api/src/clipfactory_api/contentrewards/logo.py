"""The campaign's logo: a dropped file or a Google Drive / Dropbox link (docs/CONTRACTS.md §38.4 item 5, §38.10).

Stored at ``campaigns/{userId}/{uuid}/logo-{rev}.{png|jpg|webp}`` in the media bucket; a job copies the ready one to
``jobs/{jobId}/source/campaign-logo.{ext}`` (§38.11), so a later change never breaks a queued job. Only PNG, JPEG and
WebP, checked by their first bytes (never the name or the type the browser said), at most 10 MB.
"""

from __future__ import annotations

import re
import urllib.parse
from collections.abc import Callable, Mapping
from typing import Any

from . import config, fetch

WRONG_TYPE = "Clip Factory needs a PNG, JPG or WebP picture. Save the logo as PNG and try again."
TOO_BIG = "That picture is too big. Use one under 10 MB."
FOLDER = "That's a folder. Open the logo file in it, then copy that link."
DRIVE_PRIVATE = "That file isn't shared. In Google Drive tap Share, then Anyone with the link, then paste it again."
DROPBOX_PRIVATE = "That file isn't shared. In Dropbox tap Share, then Copy link."
OTHER_SITE = "Paste a Google Drive or Dropbox link, or drop the file."

HOSTS = frozenset(
    {
        "drive.google.com",
        "drive.usercontent.google.com",
        "docs.google.com",
        "dropbox.com",
        "www.dropbox.com",
        "dl.dropboxusercontent.com",
    }
)
HOP_SUFFIXES = (".dl.dropboxusercontent.com", ".googleusercontent.com")
CONTENT_TYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}
_DRIVE_ID = re.compile(r"^[A-Za-z0-9_-]{10,200}$")


class LogoError(Exception):
    def __init__(self, sentence: str) -> None:
        super().__init__(sentence)
        self.sentence = sentence


def kind_of(head: bytes) -> str | None:
    """``png``, ``jpg`` or ``webp`` from the first bytes; None for anything else (SVG, GIF, HTML…)."""
    if head.startswith(b"\x89PNG"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


def upload_key(user_id: str, uuid: str, rev: int, ext: str) -> str:
    return f"campaigns/{user_id}/{uuid}/logo-{rev}.{ext}"


def brand_key(user_id: str, uuid: str, ext: str) -> str:
    return f"campaigns/{user_id}/{uuid}/brand.{ext}"


def campaign_prefix(user_id: str, uuid: str) -> str:
    return f"campaigns/{user_id}/{uuid}/"


def campaign_files(user_id: str, uuid: str, item: Mapping[str, Any]) -> list[str]:
    """Every file a campaign can have, named without listing the bucket (the api has no ``s3:ListBucket`` on
    ``campaigns/``): its logo and brand picture, the current logo revision and an upload not finished yet. Each new
    logo deletes the one before it, so older revisions are already gone."""
    prefix = campaign_prefix(user_id, uuid)
    rev = int(item.get("logoRev") or 0)
    keys = {str(item.get(name)) for name in ("logoKey", "brandKey") if isinstance(item.get(name), str)}
    for ext in CONTENT_TYPES:
        keys.add(brand_key(user_id, uuid, ext))
        keys.update(upload_key(user_id, uuid, r, ext) for r in (rev, rev + 1) if r > 0)
    return sorted(k for k in keys if k.startswith(prefix))


def job_logo_key(job_id: str, ext: str) -> str:
    return f"jobs/{job_id}/source/campaign-logo.{ext}"


def ext_of(key: str) -> str:
    return key.rsplit(".", 1)[-1] if "." in key else "png"


def download_url(url: str) -> tuple[str, str]:
    """``(the URL to read, "drive" | "dropbox")`` for an allowed link; ``LogoError`` with the §38.4 sentence."""
    text = (url or "").strip()
    try:
        parts = urllib.parse.urlsplit(text)
    except ValueError as e:
        raise LogoError(OTHER_SITE) from e
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or host not in HOSTS or parts.port not in (None, 443) or parts.username:
        raise LogoError(OTHER_SITE)
    path = parts.path
    query = urllib.parse.parse_qs(parts.query)
    if host.endswith("google.com"):
        if "/drive/folders/" in path or "/folderview" in path:
            raise LogoError(FOLDER)
        found = re.search(r"/file/d/([^/]+)", path)
        file_id = found.group(1) if found else (query.get("id") or [""])[0]
        if host == "docs.google.com" and not found and "id" not in query:
            raise LogoError(OTHER_SITE)
        if not _DRIVE_ID.match(file_id or ""):
            raise LogoError(OTHER_SITE)
        return f"https://drive.usercontent.google.com/download?id={file_id}&export=download", "drive"
    if "/sh/" in path or "/scl/fo/" in path:
        raise LogoError(FOLDER)
    query["dl"] = ["1"]
    clean = urllib.parse.urlunsplit(("https", host, path, urllib.parse.urlencode(query, doseq=True), ""))
    return clean, "dropbox"


def _signin(url: str) -> bool:
    host = fetch.host_of(url)
    return host == "accounts.google.com" or (host.endswith("dropbox.com") and "/login" in url)


def fetch_link(url: str, get: Callable[..., Any] = fetch.get) -> tuple[bytes, str]:
    """``(bytes, ext)`` of the logo behind an allowed link; ``LogoError`` with the owner's sentence otherwise."""
    target, site = download_url(url)
    private = DRIVE_PRIVATE if site == "drive" else DROPBOX_PRIVATE
    try:
        got = get(
            target,
            allow=lambda u: fetch.host_in(u, HOSTS, HOP_SUFFIXES),
            max_bytes=config.LOGO_MAX_BYTES,
            budget=10.0,
            signin=_signin,
        )
    except fetch.FetchFail as e:
        if e.reason == "signin":
            raise LogoError(private) from e
        if e.reason == "too_big":
            raise LogoError(TOO_BIG) from e
        if e.reason in {"host", "private"}:
            raise LogoError(OTHER_SITE) from e
        if e.reason == "status":
            raise LogoError(private) from e
        raise LogoError("Clip Factory couldn't get that file. Try again, or drop the file.") from e
    if got.content_type.startswith("text/html"):
        raise LogoError(private)
    kind = kind_of(got.body[:16])
    if kind is None:
        raise LogoError(WRONG_TYPE)
    return got.body, kind


BRAND_HOST = "crusercontent.com"


def brand_url(raw: Any) -> str | None:
    """CR's brand picture: only ``https://crusercontent.com/…`` (the public JSON sometimes gives the path only)."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = raw.strip()
    if not text.startswith("https://"):
        if "://" in text or (text.startswith("/") is False and ":" in text.split("/", 1)[0]):
            return None
        text = f"https://{BRAND_HOST}/{text.lstrip('/')}"
    parts = urllib.parse.urlsplit(text)
    if parts.scheme != "https" or (parts.hostname or "").lower() != BRAND_HOST or parts.port not in (None, 443):
        return None
    return text
