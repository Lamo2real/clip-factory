"""Skills: SKILL.md frontmatter, zip checks and the built-in skills bundled with the package.

The build script copies ``skills/<name>/SKILL.md`` from the repository into ``clipfactory_api/builtin_skills``.
Built-ins are not table items; only the owner's on/off choice is stored, as ``SKILL#builtin-<name>``.
"""

from __future__ import annotations

import io
import os
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

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
    """The upload is not a usable skill; the message is shown to the owner."""


@dataclass(frozen=True)
class Frontmatter:
    name: str
    description: str


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        inner = value[1:-1]
        return inner.replace("''", "'") if value[0] == "'" else inner.replace('\\"', '"')
    return value


def parse_frontmatter(text: str) -> dict[str, str]:
    """The top-level ``key: value`` pairs of a YAML frontmatter block (plain, quoted, ``>`` and ``|`` values)."""
    text = text.lstrip("﻿")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise SkillError("SKILL.md must start with a frontmatter block between --- lines.")
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() in {"---", "..."})
    except StopIteration as e:
        raise SkillError("The frontmatter block in SKILL.md is not closed with ---.") from e
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
        raise SkillError("SKILL.md needs a name in its frontmatter.")
    if not NAME_RE.match(name):
        raise SkillError("The skill name may only use lowercase letters, digits and dashes (at most 64).")
    if not description:
        raise SkillError("SKILL.md needs a description in its frontmatter.")
    if len(description) > DESCRIPTION_MAX:
        raise SkillError(f"The skill description is too long (at most {DESCRIPTION_MAX} characters).")
    return Frontmatter(name, description)


def decode_text(data: bytes) -> str:
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise SkillError("SKILL.md must be UTF-8 text.") from e


def _safe_member(name: str) -> bool:
    if not name or name.startswith(("/", "\\")) or "\\" in name or "\x00" in name:
        return False
    path = PurePosixPath(name)
    return not any(part in {"..", ""} for part in path.parts) and not re.match(r"^[A-Za-z]:", name)


def skill_md_from_zip(data: bytes) -> str:
    """Checks a skill zip and returns its SKILL.md text.

    The zip must hold exactly one SKILL.md (at the root or in one top folder), no absolute or ``..`` paths,
    no symlinks, and stay within entry and size limits so extracting it in the agent is safe.
    """
    if len(data) > ZIP_MAX_BYTES:
        raise SkillError("The zip is larger than 20 MB.")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise SkillError("That file is not a valid zip.") from e
    with archive:
        members = archive.infolist()
        if len(members) > ZIP_MAX_ENTRIES:
            raise SkillError(f"The zip holds more than {ZIP_MAX_ENTRIES} files.")
        total = 0
        found: list[zipfile.ZipInfo] = []
        for info in members:
            if not _safe_member(info.filename):
                raise SkillError("The zip contains a file path that is not allowed.")
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise SkillError("The zip contains a link, which is not allowed.")
            total += info.file_size
            if total > ZIP_MAX_UNCOMPRESSED:
                raise SkillError("The zip unpacks to more than 50 MB.")
            if not info.is_dir() and PurePosixPath(info.filename).name == "SKILL.md":
                found.append(info)
        if len(found) != 1:
            raise SkillError("The zip must contain exactly one SKILL.md.")
        skill_md = found[0]
        if len(PurePosixPath(skill_md.filename).parts) > 2:
            raise SkillError("SKILL.md must be at the top of the zip or in one folder.")
        if skill_md.file_size > MD_MAX_BYTES:
            raise SkillError("SKILL.md is larger than 1 MB.")
        try:
            return decode_text(archive.read(skill_md))
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as e:
            raise SkillError("SKILL.md in the zip could not be read.") from e


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
