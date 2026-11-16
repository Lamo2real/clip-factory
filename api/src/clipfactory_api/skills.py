"""Skills: SKILL.md frontmatter, zip checks and the built-in skills bundled with the package.

The build script copies ``skills/<name>/SKILL.md`` from the repository into ``clipfactory_api/builtin_skills``.
Built-ins are not table items. Every skill is always used (docs/CONTRACTS.md §18.1): there is no on/off choice.
The pure helpers for skills written in the app (``slug``, ``humanize``, ``build_skill_md``, ``parse_form``) and for
editing a zip skill (``replace_skill_md_in_zip``) live here too (§18.2-§18.4).
"""

from __future__ import annotations

import copy
import io
import json
import os
import re
import unicodedata
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

MD_MAX_BYTES = 1 * 1024 * 1024
ZIP_MAX_BYTES = 20 * 1024 * 1024
ZIP_MAX_ENTRIES = 500
ZIP_MAX_UNCOMPRESSED = 50 * 1024 * 1024
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
DESCRIPTION_MAX = 1024
BUILTIN_PREFIX = "builtin-"
# Built-ins ship with the code; this date only gives the UI something stable to sort and show.
BUILTIN_CREATED_AT = "2026-11-15T00:00:00.000Z"


class SkillError(ValueError):
    """The upload is not a usable skill; the message is shown to the owner, in plain words with a next step."""


class SkillTooLarge(SkillError):
    """The skill breaks a size limit (the API answers 413 for this one when an edit grows a file)."""


NO_HEADER = (
    "This file is missing its name and what it is for at the top. "
    "Tap Write a skill to make one by answering three questions instead."
)
BAD_NAME = "The name inside this file uses letters we cannot read. Tap Write a skill instead."
NOT_TEXT = "We could not read the words in this file. Save it as plain text and try again."
ONE_SKILL = "This .zip needs exactly one skill inside it."


@dataclass(frozen=True)
class Frontmatter:
    name: str
    description: str


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        inner = value[1:-1]
        if value[0] == "'":
            return inner.replace("''", "'")
        try:  # YAML double-quoted strings use JSON-like escapes; build_skill_md writes JSON strings
            decoded = json.loads(value)
        except ValueError:
            return inner.replace('\\"', '"')
        return decoded if isinstance(decoded, str) else inner
    return value


def parse_frontmatter(text: str) -> dict[str, str]:
    """The top-level ``key: value`` pairs of a YAML frontmatter block (plain, quoted, ``>`` and ``|`` values)."""
    text = text.lstrip("﻿")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise SkillError(NO_HEADER)
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() in {"---", "..."})
    except StopIteration as e:
        raise SkillError(NO_HEADER) from e
    fields: dict[str, str] = {}
    i = 1
    while i < end:
        line = lines[i]
        i += 1
        if not line.strip() or line.lstrip().startswith("#") or line[0] in " \t":
            continue
        key, sep, rest = line.partition(":")
        if not sep:
            continue
        key = key.strip()
        rest = rest.strip()
        if rest[:1] in {">", "|"}:
            block = []
            while i < end and (not lines[i].strip() or lines[i][0] in " \t"):
                block.append(lines[i].strip())
                i += 1
            joiner = " " if rest.startswith(">") else "\n"
            fields[key] = joiner.join(b for b in block if b).strip()
        else:
            # Plain multi-line scalars continue on indented lines.
            parts = [rest]
            while i < end and lines[i][:1] in {" ", "\t"} and lines[i].strip():
                parts.append(lines[i].strip())
                i += 1
            fields[key] = _unquote(" ".join(p for p in parts if p))
    return fields


def read_frontmatter(text: str) -> Frontmatter:
    fields = parse_frontmatter(text)
    name = fields.get("name", "").strip()
    description = " ".join(fields.get("description", "").split())
    if not name:
        raise SkillError(NO_HEADER)
    if not NAME_RE.match(name):
        raise SkillError(BAD_NAME)
    if not description:
        raise SkillError(NO_HEADER)
    if len(description) > DESCRIPTION_MAX:
        raise SkillError(
            f"The line at the top that says what this skill is for is too long. "
            f"Make it shorter than {DESCRIPTION_MAX} letters and try again."
        )
    return Frontmatter(name, description)


def decode_text(data: bytes) -> str:
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise SkillError(NOT_TEXT) from e


def _safe_member(name: str) -> bool:
    if not name or name.startswith(("/", "\\")) or "\\" in name or "\x00" in name:
        return False
    path = PurePosixPath(name)
    return not any(part in {"..", ""} for part in path.parts) and not re.match(r"^[A-Za-z]:", name)


ZIP_METHODS = (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)


def skill_md_from_zip(data: bytes, *, strict: bool = True) -> str:
    """Checks a skill zip and returns its SKILL.md text.

    The zip must hold exactly one SKILL.md (at the root or in one top folder), no absolute or ``..`` paths,
    no symlinks, and stay within entry and size limits so extracting it in the agent is safe. With ``strict``
    (every upload, every edit and every model call) no member may be password-locked or packed with anything but
    stored/deflate, so the API and the agent accept exactly the same zips; ``strict=False`` only lets the owner
    still read an older stored zip that breaks that rule.
    """
    if len(data) > ZIP_MAX_BYTES:
        raise SkillTooLarge("This .zip is larger than 20 MB. Make it smaller and try again.")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise SkillError("This file is not a .zip we can open. Make the .zip again and try again.") from e
    with archive:
        members = archive.infolist()
        if len(members) > ZIP_MAX_ENTRIES:
            raise SkillTooLarge(f"This .zip has more than {ZIP_MAX_ENTRIES} files. Use fewer files and try again.")
        total = 0
        found: list[zipfile.ZipInfo] = []
        for info in members:
            if not _safe_member(info.filename):
                raise SkillError("This .zip has a file with a name that is not allowed. Make the .zip again.")
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise SkillError("This .zip has a shortcut (link) inside, which is not allowed. Make the .zip again.")
            if strict and info.flag_bits & 0x1:
                raise SkillError(
                    "This .zip has a file locked with a password, which is not allowed. Make it again with no password."
                )
            if strict and info.compress_type not in ZIP_METHODS:
                raise SkillError("This .zip was packed in a way we cannot open. Make it again with the normal Zip.")
            total += info.file_size
            if total > ZIP_MAX_UNCOMPRESSED:
                raise SkillTooLarge("This .zip unpacks to more than 50 MB. Make it smaller and try again.")
            if not info.is_dir() and PurePosixPath(info.filename).name == "SKILL.md":
                found.append(info)
        if len(found) != 1:
            raise SkillError(ONE_SKILL)
        skill_md = found[0]
        if len(PurePosixPath(skill_md.filename).parts) > 2:
            raise SkillError("The skill in this .zip is too deep in folders. Put it at the top or in one folder.")
        if skill_md.file_size > MD_MAX_BYTES:
            raise SkillTooLarge("The skill in this .zip is larger than 1 MB. Make it shorter and try again.")
        try:
            return decode_text(archive.read(skill_md))
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as e:
            raise SkillError("We could not open the skill in this .zip. Make the .zip again and try again.") from e


# --- built-in skills ------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class BuiltinSkill:
    name: str
    description: str
    size: int
    path: Path

    @property
    def skill_id(self) -> str:
        return BUILTIN_PREFIX + self.name


def builtin_dir() -> Path:
    """Bundled copies in the Lambda; in a checkout without a build, the repository's skills/ folder."""
    override = os.environ.get("CF_BUILTIN_SKILLS_DIR")
    if override:
        return Path(override)
    bundled = Path(__file__).resolve().parent / "builtin_skills"
    if bundled.is_dir():
        return bundled
    return Path(__file__).resolve().parents[3] / "skills"


def load_builtins(directory: Path | None = None) -> list[BuiltinSkill]:
    root = directory or builtin_dir()
    if not root.is_dir():
        return []
    out = []
    for path in sorted(root.glob("*/SKILL.md")):
        data = path.read_bytes()
        try:
            meta = read_frontmatter(decode_text(data))
        except SkillError:
            continue  # a broken built-in is a build bug; the CI test catches it, the app keeps working
        out.append(BuiltinSkill(meta.name, meta.description, len(data), path))
    return out


# --- skills written in the app (§18.2-§18.4) ------------------------------------------------------------------

TITLE_MAX = 60
DESCRIPTION_MIN = 3
INSTRUCTIONS_MAX = 50_000
FORM_BODY_MAX_BYTES = 256 * 1024
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_NOT_SLUG = re.compile(r"[^a-z0-9]+")
_ALNUM = re.compile(r"[^\W_]")


class FormError(ValueError):
    """A form field breaks a rule; ``field`` says which question the message belongs under."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field
        self.message = message


@dataclass(frozen=True)
class SkillForm:
    title: str
    description: str
    instructions: str

    def as_json(self) -> dict[str, str]:
        return {"title": self.title, "description": self.description, "instructions": self.instructions}


def clean_text(value: str) -> str:
    """Trimmed, ``\\r\\n``/``\\r`` → ``\\n``, control characters other than newline and tab removed."""
    return _CONTROL.sub("", value.replace("\r\n", "\n").replace("\r", "\n")).strip()


def slug(title: str) -> str:
    """The frontmatter ``name`` for a typed title: "Funny Moments FIRST!!" → ``funny-moments-first``."""
    text = unicodedata.normalize("NFKD", title)
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    name = _NOT_SLUG.sub("-", text).strip("-")
    if len(name) > 64:
        cut = name[:65].rfind("-")
        name = (name[:cut] if cut > 0 else name[:64]).strip("-")
    return name or "my-skill"


def humanize(name: str) -> str:
    """``funny-moments-first`` → "Funny moments first"."""
    words = " ".join(name.replace("-", " ").split())
    return words[:1].upper() + words[1:]


def normalize_form(body: Mapping[str, Any]) -> SkillForm:
    """The three answers of the Write-a-skill form, cleaned and checked (§18.2)."""
    values: dict[str, str] = {}
    for field in ("title", "description", "instructions"):
        raw = body.get(field)
        if raw is None:
            raw = ""
        if not isinstance(raw, str):
            raise FormError(field, f"{field} must be text.")
        values[field] = clean_text(raw)
    title = " ".join(values["title"].split())
    description = " ".join(values["description"].split())
    instructions = values["instructions"]
    if not title:
        raise FormError("title", "Give your skill a name.")
    if len(title) > TITLE_MAX:
        raise FormError("title", f"The name is too long. Use at most {TITLE_MAX} characters.")
    if not _ALNUM.search(title):
        raise FormError("title", "Put at least one letter or number in the name.")
    if len(description) < DESCRIPTION_MIN:
        raise FormError("description", "Say when Clip Factory should use it (at least 3 characters).")
    if len(description) > DESCRIPTION_MAX:
        raise FormError("description", f"This answer is too long. Use at most {DESCRIPTION_MAX} characters.")
    if not instructions:
        raise FormError("instructions", "Write what the skill should do.")
    if len(instructions) > INSTRUCTIONS_MAX:
        raise FormError("instructions", f"This answer is too long. Use at most {INSTRUCTIONS_MAX:,} characters.")
    return SkillForm(title, description, instructions)


def _starts_with_h1(text: str) -> bool:
    first = text.split("\n", 1)[0]
    return first.startswith("# ") or first == "#"


def build_skill_md(name: str, description: str, title: str, instructions: str, extra_frontmatter: str = "") -> str:
    """A valid SKILL.md for a written skill (§18.2)."""
    head = ["---", f"name: {name}", "description: " + json.dumps(description, ensure_ascii=False)]
    extra = extra_frontmatter.strip("\n")
    if extra:
        head.append(extra)
    head.append("---")
    parts = ["\n".join(head), ""]
    if not _starts_with_h1(instructions):
        parts += [f"# {title}", ""]
    parts.append(instructions)
    return "\n".join(parts) + "\n"


def _frontmatter_lines(text: str) -> tuple[list[str], list[str]]:
    """(the lines between the --- fences, the lines after the closing fence)."""
    lines = text.lstrip("\ufeff").replace("\r\n", "\n").split("\n")
    if not lines or lines[0].strip() != "---":
        raise SkillError(NO_HEADER)
    for i in range(1, len(lines)):
        if lines[i].strip() in {"---", "..."}:
            return lines[1:i], lines[i + 1 :]
    raise SkillError(NO_HEADER)


def frontmatter_extra(text: str) -> str:
    """Every top-level frontmatter entry except ``name`` and ``description``, verbatim and in order (with its
    indented continuation lines), so an edit in the app keeps them (§18.4)."""
    inner, _ = _frontmatter_lines(text)
    kept: list[str] = []
    dropping = False
    for line in inner:
        top_level = bool(line.strip()) and line[0] not in " \t"
        if top_level:
            key = line.partition(":")[0].strip()
            dropping = key in {"name", "description"}
        if not dropping:
            kept.append(line)
    while kept and not kept[-1].strip():
        kept.pop()
    while kept and not kept[0].strip():
        kept.pop(0)
    return "\n".join(kept)


def skill_body(text: str) -> str:
    """The SKILL.md text after its frontmatter."""
    _, rest = _frontmatter_lines(text)
    return "\n".join(rest)


def parse_form(item: Mapping[str, Any], text: str) -> SkillForm:
    """The form answers of a stored skill (§18.3): the inverse of ``build_skill_md``."""
    fields = parse_frontmatter(text)
    title = str(item.get("title") or humanize(str(item.get("name") or fields.get("name") or "")))
    description = " ".join(fields.get("description", "").split())
    lines = skill_body(text).split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines and lines[0].rstrip() == f"# {title}":
        lines.pop(0)
        while lines and not lines[0].strip():
            lines.pop(0)
    return SkillForm(title, description, "\n".join(lines).rstrip())


def zip_other_files(data: bytes) -> list[str]:
    """The member paths of a skill zip other than its SKILL.md and folders, sorted (at most ZIP_MAX_ENTRIES)."""
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = [
            i.filename for i in archive.infolist() if not i.is_dir() and PurePosixPath(i.filename).name != "SKILL.md"
        ]
    return sorted(names)[:ZIP_MAX_ENTRIES]


def replace_skill_md_in_zip(data: bytes, new_text: str) -> bytes:
    """The same zip with only its SKILL.md replaced: every other member keeps its name, order, date and bytes.
    The result is checked again like an upload. Any zip problem is a ``SkillError`` (never a bare zip error)."""
    skill_md_from_zip(data)
    out = io.BytesIO()
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as source, zipfile.ZipFile(out, "w") as target:
            for info in source.infolist():
                member = copy.copy(info)  # writestr updates sizes on the info it gets; keep the source's intact
                if not info.is_dir() and PurePosixPath(info.filename).name == "SKILL.md":
                    target.writestr(member, new_text.encode())
                else:
                    target.writestr(member, source.read(info))
    except (RuntimeError, NotImplementedError, zipfile.BadZipFile, EOFError, OSError) as e:
        raise SkillError("We could not open this .zip to change it. Tap Replace the whole file instead.") from e
    result = out.getvalue()
    skill_md_from_zip(result)
    return result
