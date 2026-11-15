"""Skills: the built-in ones from the image plus the owner's enabled ones from S3, written to
``<workdir>/.claude/skills/<name>/`` so the Claude Agent SDK loads them, and returned as text for the prompts."""

from __future__ import annotations

import io
import re
import shutil
import stat
import zipfile
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from .util import log

MAX_FILES = 500
MAX_UNZIPPED = 50 * 1024 * 1024
MAX_FILE = 20 * 1024 * 1024
MAX_PROMPT_CHARS = 40_000  # per skill, in the moment-selection prompt
_NAME = re.compile(r"[^a-z0-9-]+")


@dataclass(frozen=True)
class SkillDoc:
    name: str
    description: str
    text: str
    builtin: bool


class SkillError(ValueError):
    pass


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """``---``-fenced ``key: value`` lines (quotes stripped) and the body after them."""
    if not text.startswith("---"):
        return {}, text
    lines = text.splitlines()
    meta: dict[str, str] = {}
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return meta, "\n".join(lines[i + 1 :]).lstrip("\n")
        key, sep, value = line.partition(":")
        if sep and key.strip() and not key.startswith((" ", "\t")):
            meta[key.strip()] = value.strip().strip("'\"")
    return {}, text


def safe_name(raw: str) -> str:
    name = _NAME.sub("-", raw.lower()).strip("-")[:64].strip("-")
    return name or "skill"


def _member_path(name: str) -> PurePosixPath | None:
    """The member's path if it is safe to extract: relative, no ``..``, no drive letters."""
    p = PurePosixPath(name.replace("\\", "/"))
    if p.is_absolute() or ".." in p.parts or (p.parts and ":" in p.parts[0]):
        return None
    return p


def extract_zip(data: bytes, dest: Path) -> Path:
    """Extracts a skill zip safely and returns the folder that holds its one SKILL.md.

    Refuses absolute paths, ``..``, symlinks, more than MAX_FILES files and zip bombs; ``__MACOSX`` is skipped."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise SkillError("not a zip file") from e
    with zf:
        members = [m for m in zf.infolist() if not m.is_dir() and not m.filename.startswith("__MACOSX/")]
        if len(members) > MAX_FILES:
            raise SkillError("too many files")
        if sum(m.file_size for m in members) > MAX_UNZIPPED:
            raise SkillError("too large when unzipped")
        skill_md = [m for m in members if PurePosixPath(m.filename).name == "SKILL.md"]
        if len(skill_md) != 1:
            raise SkillError("the zip must contain exactly one SKILL.md")
        root = PurePosixPath(skill_md[0].filename).parent
        dest.mkdir(parents=True, exist_ok=True)
        base = dest.resolve()
        for m in members:
            p = _member_path(m.filename)
            if p is None:
                raise SkillError(f"unsafe path in zip: {m.filename[:100]}")
            if stat.S_ISLNK(m.external_attr >> 16):
                raise SkillError("the zip contains a symbolic link")
            if root.parts and p.parts[: len(root.parts)] != root.parts:
                continue  # files outside the skill's folder are not part of the skill
            rel = PurePosixPath(*p.parts[len(root.parts) :])
            target = (dest / rel).resolve()
            if not target.is_relative_to(base):
                raise SkillError(f"unsafe path in zip: {m.filename[:100]}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(m) as src, target.open("wb") as out:
                copied = 0
                while chunk := src.read(1 << 16):
                    copied += len(chunk)
                    if copied > MAX_FILE or copied > m.file_size + 1024:
                        raise SkillError("a file in the zip is larger than it claims")
                    out.write(chunk)
    return dest


def _unique(name: str, taken: set[str]) -> str:
    candidate, n = name, 2
    while candidate in taken:
        candidate = f"{name[:60]}-{n}"
        n += 1
    taken.add(candidate)
    return candidate


def _doc(folder: Path, fallback: str, builtin: bool) -> tuple[str, str, str]:
    text = (folder / "SKILL.md").read_text("utf-8", "replace")
    meta, _ = parse_frontmatter(text)
    return meta.get("name") or fallback, meta.get("description", ""), text


def builtin_choices(rows: Iterable[dict[str, Any]]) -> dict[str, bool]:
    """The owner's enable/disable choice per built-in skill (``SKILL#builtin-<name>`` items)."""
    out: dict[str, bool] = {}
    for r in rows:
        sid = str(r.get("skillId") or str(r.get("sk", "")).removeprefix("SKILL#"))
        if sid.startswith("builtin-"):
            out[sid.removeprefix("builtin-")] = bool(r.get("enabled", True))
    return out


async def prepare_skills(
    workdir: Path,
    builtin_dir: Path,
    rows: list[dict[str, Any]],
    fetch: Callable[[str], Awaitable[bytes]],
) -> list[SkillDoc]:
    """Writes every enabled skill under ``<workdir>/.claude/skills`` and returns them. A broken owner skill is
    skipped and logged, never fatal: the job still runs with the others."""
    target = workdir / ".claude" / "skills"
    shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True)
    taken: set[str] = set()
    docs: list[SkillDoc] = []
    choices = builtin_choices(rows)

    if builtin_dir.is_dir():
        for folder in sorted(p for p in builtin_dir.iterdir() if (p / "SKILL.md").is_file()):
            if not choices.get(folder.name, True):
                continue
            name, desc, text = _doc(folder, folder.name, True)
            final = _unique(safe_name(name), taken)
            shutil.copytree(folder, target / final, symlinks=False)
            docs.append(SkillDoc(final, desc, text, True))

    owner = [
        r
        for r in rows
        if r.get("enabled")
        and not r.get("builtin")
        and r.get("key")
        and not str(r.get("skillId", "")).startswith("builtin-")
    ]
    for r in sorted(owner, key=lambda r: str(r.get("createdAt", ""))):
        label = str(r.get("name") or r.get("skillId"))
        try:
            data = await fetch(str(r["key"]))
            staging = workdir / ".skill-staging" / safe_name(str(r.get("skillId", label)))
            shutil.rmtree(staging, ignore_errors=True)
            if r.get("format") == "zip" or str(r["key"]).endswith(".zip"):
                folder = extract_zip(data, staging)
            else:
                staging.mkdir(parents=True)
                (staging / "SKILL.md").write_bytes(data[:MAX_FILE])
                folder = staging
            name, desc, text = _doc(folder, label, False)
            final = _unique(safe_name(name), taken)
            shutil.move(str(folder), str(target / final))
            docs.append(SkillDoc(final, desc or str(r.get("description", "")), text, False))
        except Exception as e:
            log("warn", "skills.skipped", skill=label, error=type(e).__name__, detail=str(e)[:200])
    shutil.rmtree(workdir / ".skill-staging", ignore_errors=True)
    return docs


def skills_prompt(docs: list[SkillDoc]) -> str:
    """Every skill's text for the prompt, each fenced so it reads as the owner's reference, not as chat."""
    parts = []
    for d in docs:
        text = d.text if len(d.text) <= MAX_PROMPT_CHARS else d.text[:MAX_PROMPT_CHARS] + "\n…(shortened)"
        parts.append(f'<skill name="{d.name}">\n{text}\n</skill>')
    return "\n\n".join(parts)
