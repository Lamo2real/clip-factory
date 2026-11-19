"""Files in Ask (docs/CONTRACTS.md §27.7): which kinds are read, the limits, and turning each file into model input.

A file is uploaded by the browser to ``ask/{sub}/{fileId}`` with a presigned PUT (signed type and length), read once
by the worker, and deleted in the worker's ``finally``. Nothing about a file is logged except its kind and size.

* image: JPEG only (the browser re-encodes every picture, §26), checked and cleaned by ``help.pictures``;
* pdf: ``%PDF-``, ≤ 100 pages, sent as a ``document`` with citations;
* text: decoded as UTF-8 (else cp1252), sent as a plain-text ``document``; ``.tfvars``/``.env``/``.pem`` redacted;
* office: docx/xlsx/pptx/odt/ods text pulled out with ``zipfile`` + ``xml.etree`` under zip-bomb limits.
"""

from __future__ import annotations

import base64
import io
import re
import secrets
import zipfile
from dataclasses import dataclass
from typing import Any, Literal
from xml.etree import ElementTree

from .redact import redact

Kind = Literal["image", "pdf", "text", "office"]

FILES_PER_QUESTION = 10
BYTES_PER_FILE = 25_000_000
BYTES_PER_QUESTION = 50_000_000
IMAGES_PER_QUESTION = 8
PDF_PAGES = 100
TEXT_CHARS_PER_FILE = 400_000
TEXT_CHARS_PER_QUESTION = 600_000
# Base64 sent to the model in one request (images + PDFs). Bedrock's request limit is larger; this stays well under.
MODEL_BINARY_B64 = 20_000_000
UNZIPPED_MAX = 50_000_000
ZIP_ENTRIES_MAX = 2_000
NAME_MAX = 120
TYPE_MAX = 100
FILES_PER_DAY = 300
FILE_BYTES_PER_DAY = 1_000_000_000
FILE_ID = re.compile(r"^[A-Za-z0-9_-]{22}$")

LIMITS = {
    "filesPerQuestion": FILES_PER_QUESTION,
    "bytesPerFile": BYTES_PER_FILE,
    "bytesPerQuestion": BYTES_PER_QUESTION,
    "imagesPerQuestion": IMAGES_PER_QUESTION,
    "questionChars": 4000,
    "pdfPages": PDF_PAGES,
}

IMAGE_EXT = frozenset({"jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "bmp", "avif"})
TEXT_EXT = frozenset(
    {
        "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm", "log", "ini", "toml",
        "tf", "tfvars", "hcl", "py", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "sql", "sh", "srt", "vtt",
        "env", "pem", "cfg", "conf", "rs", "go", "java", "kt", "swift", "rb", "php", "c", "h", "cpp", "cs",
    }
)  # fmt: skip
OFFICE_EXT = frozenset({"docx", "xlsx", "pptx", "odt", "ods"})
REDACT_EXT = frozenset({"tfvars", "env", "pem"})
UNSUPPORTED = {
    "zip": "I can't read .ZIP files. Unzip it and add the files inside.",
    "doc": "I can't read old .DOC files. Save it as .DOCX or PDF.",
    "xls": "I can't read old .XLS files. Save it as .XLSX or CSV.",
    "ppt": "I can't read old .PPT files. Save it as .PPTX or PDF.",
}
VIDEO_NOTE = "I can't watch videos here. To make clips, use **Make clips** on Home."
OTHER_NOTE = "I can't read that kind of file yet. Try a PDF, a picture or a text file."


class FileRefused(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def extension(name: str) -> str:
    base = name.rsplit("/", 1)[-1]
    if base.startswith(".") and base.count(".") == 1:
        return base[1:].lower()  # ".env"
    return base.rsplit(".", 1)[-1].lower() if "." in base else ""


def kind_of(name: str, mime: str) -> Kind:
    """The kind a file is read as, from its extension then its type. Raises ``FileRefused`` with the owner note."""
    ext = extension(name)
    mime = mime.lower().split(";")[0].strip()
    if ext in UNSUPPORTED:
        raise FileRefused(UNSUPPORTED[ext])
    if ext in IMAGE_EXT or (not ext and mime.startswith("image/")):
        return "image"
    if ext == "pdf" or mime == "application/pdf":
        return "pdf"
    if ext in OFFICE_EXT:
        return "office"
    if ext in TEXT_EXT or mime.startswith("text/") or mime in {"application/json", "application/xml"}:
        return "text"
    if mime.startswith("video/") or ext in {"mp4", "mov", "mkv", "webm", "avi", "m4v"}:
        raise FileRefused(VIDEO_NOTE)
    raise FileRefused(OTHER_NOTE)


def new_file_id() -> str:
    return secrets.token_urlsafe(16)[:22].ljust(22, "A")


def file_key(user_id: str, file_id: str) -> str:
    return f"ask/{user_id}/{file_id}"


@dataclass
class Read:
    """One file turned into model input (``block``) or not (``why``)."""

    block: dict[str, Any] | None
    why: str | None = None  # "unsupported" | "too_long" | "damaged" | "off"
    chars: int = 0
    b64: int = 0
    redacted: bool = False
    pages: int = 0


def pdf_pages(data: bytes) -> int:
    return len(re.findall(rb"/Type\s*/Page(?![a-zA-Z])", data))


def decode_text(data: bytes) -> str | None:
    if b"\x00" in data[:8000]:
        return None
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            return data.decode("cp1252")
        except UnicodeDecodeError:
            return None


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _xml(archive: zipfile.ZipFile, name: str) -> ElementTree.Element | None:
    try:
        raw = archive.read(name)
    except KeyError:
        return None
    if b"<!DOCTYPE" in raw[:2000] or b"<!ENTITY" in raw[:4000]:
        raise FileRefused("damaged")  # no entity expansion, ever
    return ElementTree.fromstring(raw)  # noqa: S314 (DTDs refused above; stdlib does not fetch externals)


def _docx(archive: zipfile.ZipFile) -> str:
    root = _xml(archive, "word/document.xml")
    if root is None:
        raise FileRefused("damaged")
    lines: list[str] = []
    for el in root.iter():
        tag = _local(el.tag)
        if tag == "p":
            text = "".join(t.text or "" for t in el.iter() if _local(t.tag) == "t")
            lines.append(text)
        elif tag == "tr":
            cells = [
                "".join(t.text or "" for t in c.iter() if _local(t.tag) == "t") for c in el if _local(c.tag) == "tc"
            ]
            lines.append("\t".join(cells))
    return "\n".join(line for line in lines if line.strip())


def _col(ref: str) -> int:
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
        else:
            break
    return max(n - 1, 0)


def _csv_cell(value: str) -> str:
    return '"' + value.replace('"', '""') + '"' if any(c in value for c in ',"\n') else value


def _xlsx(archive: zipfile.ZipFile) -> str:
    shared: list[str] = []
    strings = _xml(archive, "xl/sharedStrings.xml")
    if strings is not None:
        for si in strings:
            shared.append("".join(t.text or "" for t in si.iter() if _local(t.tag) == "t"))
    out: list[str] = []
    sheets = sorted(n for n in archive.namelist() if re.match(r"^xl/worksheets/sheet\d+\.xml$", n))
    for name in sorted(sheets, key=lambda n: int(re.findall(r"\d+", n)[-1])):
        root = _xml(archive, name)
        if root is None:
            continue
        out.append(f"# Sheet {re.findall(r'\d+', name)[-1]}")
        for row in (el for el in root.iter() if _local(el.tag) == "row"):
            cells: dict[int, str] = {}
            for c in row:
                if _local(c.tag) != "c":
                    continue
                v = next((x.text or "" for x in c if _local(x.tag) == "v"), "")
                if c.get("t") == "s" and v.isdigit() and int(v) < len(shared):
                    v = shared[int(v)]
                elif c.get("t") == "inlineStr":
                    v = "".join(t.text or "" for t in c.iter() if _local(t.tag) == "t")
                cells[_col(c.get("r") or "A")] = v
            if cells:
                out.append(",".join(_csv_cell(cells.get(i, "")) for i in range(max(cells) + 1)))
    return "\n".join(out)


def _pptx(archive: zipfile.ZipFile) -> str:
    out: list[str] = []
    slides = [n for n in archive.namelist() if re.match(r"^ppt/slides/slide\d+\.xml$", n)]
    for name in sorted(slides, key=lambda n: int(re.findall(r"\d+", n)[-1])):
        root = _xml(archive, name)
        if root is None:
            continue
        texts = [t.text or "" for t in root.iter() if _local(t.tag) == "t"]
        out.append(f"# Slide {re.findall(r'\d+', name)[-1]}\n" + "\n".join(t for t in texts if t.strip()))
    return "\n\n".join(out)


def _odf(archive: zipfile.ZipFile) -> str:
    root = _xml(archive, "content.xml")
    if root is None:
        raise FileRefused("damaged")
    lines = []
    for el in root.iter():
        tag = _local(el.tag)
        if tag in {"p", "h"}:
            lines.append("".join(el.itertext()))
        elif tag == "table-row":
            lines.append("\t".join("".join(c.itertext()) for c in el if _local(c.tag) == "table-cell"))
    return "\n".join(line for line in lines if line.strip())


def office_text(data: bytes, ext: str) -> str:
    if not data.startswith(b"PK"):
        raise FileRefused("damaged")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise FileRefused("damaged") from None
    with archive:
        infos = archive.infolist()
        if len(infos) > ZIP_ENTRIES_MAX or sum(i.file_size for i in infos) > UNZIPPED_MAX:
            raise FileRefused("too_long")
        try:
            if ext == "docx":
                return _docx(archive)
            if ext == "xlsx":
                return _xlsx(archive)
            if ext == "pptx":
                return _pptx(archive)
            return _odf(archive)
        except (ElementTree.ParseError, zipfile.BadZipFile, KeyError, ValueError, RuntimeError):
            raise FileRefused("damaged") from None


def _text_doc(name: str, text: str) -> dict[str, Any]:
    return {
        "type": "document",
        "source": {"type": "text", "media_type": "text/plain", "data": text},
        "title": name[:NAME_MAX],
        "citations": {"enabled": True},
    }


def read(name: str, kind: Kind, data: bytes, *, chars_left: int, b64_left: int) -> Read:
    """Checks the bytes against the kind and builds the content block (never raises for a bad file)."""
    ext = extension(name)
    try:
        if kind == "image":
            from ..help.pictures import PICTURE_BYTES_MAX, PictureError, walk

            if len(data) > PICTURE_BYTES_MAX:
                return Read(None, "too_long")
            try:
                info = walk(data)
            except PictureError:
                return Read(None, "damaged")
            size = (len(info.clean) + 2) // 3 * 4
            if size > b64_left:
                return Read(None, "too_long")
            source = {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(info.clean).decode()}
            return Read({"type": "image", "source": source}, b64=size)
        if kind == "pdf":
            if not data.startswith(b"%PDF-"):
                return Read(None, "damaged")
            pages = pdf_pages(data)
            size = (len(data) + 2) // 3 * 4
            if pages > PDF_PAGES or size > b64_left:
                return Read(None, "too_long", pages=pages)
            block = {
                "type": "document",
                "source": {"type": "base64", "media_type": "application/pdf", "data": base64.b64encode(data).decode()},
                "title": name[:NAME_MAX],
                "citations": {"enabled": True},
            }
            return Read(block, b64=size, pages=pages)
        if kind == "office":
            text = office_text(data, ext)
        else:
            decoded = decode_text(data)
            if decoded is None:
                return Read(None, "damaged")
            text = decoded
        redacted = False
        if ext in REDACT_EXT or kind == "text":
            cleaned, hit = redact(text)
            # Only key-like files are always cleaned; other text files are cleaned too, but noted only when hit.
            text, redacted = cleaned, hit
        if not text.strip():
            return Read(None, "damaged")
        if len(text) > TEXT_CHARS_PER_FILE or len(text) > chars_left:
            return Read(None, "too_long")
        return Read(_text_doc(name, text), chars=len(text), redacted=redacted)
    except FileRefused as e:
        return Read(None, e.message if e.message in {"damaged", "too_long"} else "unsupported")
