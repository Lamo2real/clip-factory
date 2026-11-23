"""Lamo Stories' own agents, skills and memory, as every model call sees them (docs/CONTRACTS.md §45.25-§45.27,
ADR-78).

* **Agents** (``AGENT#{agentId}``): the five built-ins of ``stories/config/agents.json``; an owner's edit (instructions,
  on/off, model, effort, skills) lives on the item, and anything the item does not set comes from the file.
* **Skills**: an agent gets exactly its enabled, assigned Lamo Stories skills, in its own order (``skillIds``). A
  built-in skill's text is the bundled ``stories/skills/{id}/SKILL.md`` (``SKILL#{id}`` may only switch it off); an
  owner's skill is its current revision under ``ws/{userId}/{workspaceId}/skills/`` (``SKILL#.key``). Clip Factory's
  skills are never read (§45.26).
* **Memory** (``MEM#``): the newest 50 items, after the skills.
* **Levels** (§45.25): the stored per-request override (``PJOB#.configuration.override``, ``TASK#.override``, the
  pending assistant ``MSG#.requested``), the conversation's setting (``CONV#``) and the project's (``STORY#.ai``,
  ``REFVID#.ai``), read from the item the call works for.

Everything here is read with plain, synchronous table calls: the model client runs in a worker thread (§45.33)."""

from __future__ import annotations

import io
import re
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from functools import cache
from typing import Any

from . import config, keys
from .store import from_ddb
from .util import log

MEMORY_ITEMS = 50
SKILL_BYTES = 1024 * 1024  # one SKILL.md, at most (§45.26)
ZIP_TEXT_BYTES = 400 * 1024  # the text taken from one .zip skill, at most
ZIP_MEMBERS = 200


@dataclass(frozen=True)
class AgentProfile:
    agent_id: str
    name: str
    tasks: tuple[str, ...]
    instructions: str
    active: bool
    model: str | None
    effort: str | None
    skill_ids: tuple[str, ...]


@dataclass(frozen=True)
class SkillText:
    skill_id: str
    title: str
    description: str
    text: str
    builtin: bool


def default_agents() -> dict[str, dict[str, Any]]:
    return {str(a["agentId"]): dict(a) for a in config.agents()["agents"]}


def agent_for_task(task: str) -> str | None:
    """The agent a task belongs to (§45.26's table)."""
    for agent_id, a in default_agents().items():
        if task in (a.get("tasks") or []):
            return agent_id
    return None


def _words(text: str) -> str:
    return " ".join(text.split())


def untouched(base: dict[str, Any], instructions: str) -> bool:
    """Whether stored instructions are an earlier default of the file (``formerInstructions``), copied into the
    workspace when the agent was first made and never edited: such an agent gets today's default (§45.36 E5)."""
    former = base.get("formerInstructions")
    return isinstance(former, list) and _words(instructions) in {_words(str(f)) for f in former if isinstance(f, str)}


def profile_from(agent_id: str, item: dict[str, Any] | None) -> AgentProfile:
    base = default_agents().get(agent_id)
    if base is None:
        raise KeyError(f"unknown agent {agent_id}")
    item = item or {}

    def pick(name: str, default: Any) -> Any:
        return item[name] if name in item and item[name] is not None else default

    skill_ids = item.get("skillIds")
    if not isinstance(skill_ids, list):
        skill_ids = base.get("skills") or []
    instructions = str(pick("instructions", "") or "").strip()
    if not instructions or untouched(base, instructions):
        instructions = str(base.get("instructions") or "")
    return AgentProfile(
        agent_id=agent_id,
        name=str(base.get("name") or agent_id),
        tasks=tuple(str(t) for t in base.get("tasks") or []),
        instructions=instructions,
        active=item.get("active") is not False,
        model=str(item["model"]) if item.get("model") else None,
        effort=str(item["effort"]) if item.get("effort") else None,
        skill_ids=tuple(str(s) for s in skill_ids if isinstance(s, str)),
    )


_FRONT = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.S)


def split_front_matter(text: str) -> tuple[dict[str, str], str]:
    """A SKILL.md's ``name`` / ``description`` front matter and its body."""
    m = _FRONT.match(text)
    if not m:
        return {}, text
    meta: dict[str, str] = {}
    for line in m.group(1).splitlines():
        k, sep, v = line.partition(":")
        if sep and k.strip():
            meta[k.strip()] = v.strip().strip('"')
    return meta, text[m.end() :]


@cache
def builtin_ids() -> tuple[str, ...]:
    d = config.skills_dir()
    if not d.is_dir():
        return ()
    return tuple(sorted(p.parent.name for p in d.glob("*/SKILL.md")))


def builtin_skill(skill_id: str) -> SkillText | None:
    if skill_id not in builtin_ids():
        return None
    raw = (config.skills_dir() / skill_id / "SKILL.md").read_text("utf-8")
    meta, body = split_front_matter(raw)
    return SkillText(skill_id, meta.get("name") or skill_id, meta.get("description") or "", body.strip(), True)


def text_of_zip(data: bytes) -> str:
    """A ``.zip`` skill's text: its ``SKILL.md`` first (the shallowest), then its other ``.md`` / ``.txt`` files, each
    read with a size cap (a zip bomb reads as nothing more than the cap)."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = [n for n in z.namelist()[:ZIP_MEMBERS] if not n.endswith("/") and "__MACOSX" not in n]
        main = sorted((n for n in names if n.rsplit("/", 1)[-1].lower() == "skill.md"), key=lambda n: n.count("/"))
        rest = sorted(n for n in names if n.lower().endswith((".md", ".txt")) and n not in main[:1])
        parts: list[str] = []
        left = ZIP_TEXT_BYTES
        for name in [*main[:1], *rest]:
            if left <= 0:
                break
            with z.open(name) as f:
                chunk = f.read(min(left, SKILL_BYTES))
            left -= len(chunk)
            text = chunk.decode("utf-8", "replace").strip()
            if text:
                parts.append(text if name in main[:1] else f"### {name}\n\n{text}")
        return "\n\n".join(parts)


class Workspace:
    """One workspace's agents, skills, memory and AI configuration, read on first use (one model call's view)."""

    def __init__(self, table: Any, get_bytes: Callable[[str], bytes], user_id: str, workspace_id: str) -> None:
        self.table = table
        self.get_bytes = get_bytes
        self.user_id = user_id
        self.workspace_id = workspace_id
        self.pk = keys.ws_pk(user_id, workspace_id)
        self._items: dict[str, dict[str, Any] | None] = {}
        self._models: dict[str, Any] | None = None

    def item(self, sk: str) -> dict[str, Any] | None:
        if sk not in self._items:
            r = self.table.get_item(Key={"pk": self.pk, "sk": sk}, ConsistentRead=True)
            got = from_ddb(r.get("Item")) if r.get("Item") else None
            self._items[sk] = self._owned(got)
        return self._items[sk]

    def _owned(self, item: dict[str, Any] | None) -> dict[str, Any] | None:
        if item is None:
            return None
        if item.get("userId") not in (None, self.user_id) or item.get("workspaceId") not in (None, self.workspace_id):
            log("error", "stories.foreign_item", sk=item.get("sk"))
            return None
        return item

    def query(self, prefix: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": "pk = :pk AND begins_with(sk, :sk)",
            "ExpressionAttributeValues": {":pk": self.pk, ":sk": prefix},
        }
        while True:
            r = self.table.query(**kwargs)
            out += [i for i in (self._owned(from_ddb(x)) for x in r.get("Items") or []) if i is not None]
            if not r.get("LastEvaluatedKey"):
                return out
            kwargs["ExclusiveStartKey"] = r["LastEvaluatedKey"]

    # --- what a call needs ---------------------------------------------------------------------------------------

    def ai(self) -> dict[str, Any]:
        return self.item(keys.AICONFIG_SK) or {}

    def models(self) -> dict[str, Any]:
        """The bundled model list with this workspace's own models (``MODELDEF#``) merged over it, read once for this
        call's view and never shared with another workspace (§45.34)."""
        if self._models is None:
            self._models = config.merged_models(self.query(config.MODELDEF_PREFIX))
        return self._models

    def agent(self, agent_id: str) -> AgentProfile:
        return profile_from(agent_id, self.item(keys.agent_sk(agent_id)))

    def skills(self, profile: AgentProfile) -> list[SkillText]:
        """The agent's enabled, assigned skills, in its order. A skill that cannot be read is left out (and logged);
        it never stops the call."""
        out: list[SkillText] = []
        for skill_id in profile.skill_ids:
            if not keys.SAFE_ID.match(skill_id):
                continue
            item = self.item(keys.skill_sk(skill_id))
            if item is not None and item.get("enabled") is False:
                continue
            builtin = builtin_skill(skill_id)
            if builtin is not None and (item is None or item.get("builtin") is not False):
                out.append(builtin)
                continue
            if item is None:
                continue
            try:
                got = self._owner_skill(skill_id, item)
            except Exception as e:
                log("warn", "stories.skill_unreadable", skill=skill_id, error=type(e).__name__)
                continue
            if got is not None:
                out.append(got)
        return out

    def _owner_skill(self, skill_id: str, item: dict[str, Any]) -> SkillText | None:
        title = str(item.get("title") or skill_id)
        description = str(item.get("description") or "")
        key = str(item.get("key") or "")
        if key:
            if not key.startswith(keys.skill_prefix(self.user_id, self.workspace_id, skill_id)):
                log("error", "stories.skill_key_outside", skill=skill_id)
                return None
            data = self.get_bytes(key)
            if key.lower().endswith(".zip") or item.get("format") == "zip":
                text = text_of_zip(data)
            else:
                text = data[:SKILL_BYTES].decode("utf-8", "replace")
            meta, body = split_front_matter(text)
            return SkillText(skill_id, title or meta.get("name", ""), description or meta.get("description", ""),
                             body.strip(), False)  # fmt: skip
        if item.get("instructions"):  # a skill written in the app, kept on the item
            return SkillText(skill_id, title, description, str(item["instructions"]).strip(), False)
        return None

    def memory(self) -> list[str]:
        rows = self.query(keys.MEM_PREFIX)
        rows.sort(key=lambda r: str(r.get("createdAt") or ""), reverse=True)
        return [str(r.get("text") or "").strip() for r in rows[:MEMORY_ITEMS] if str(r.get("text") or "").strip()]

    def system_blocks(self, profile: AgentProfile) -> list[str]:
        """The first system blocks of every call (§45.25 "Calls"): the agent's instructions, its skills, the memory."""
        blocks = [profile.instructions]
        skills = self.skills(profile)
        if skills:
            parts = ["Your skills (Funded Clips' own; follow them):"]
            for s in skills:
                head = f"## Skill: {s.title}"
                if s.description:
                    head += f"\n{s.description}"
                parts.append(f"{head}\n\n{s.text}")
            blocks.append("\n\n".join(parts))
        memory = self.memory()
        if memory:
            blocks.append(
                "What the owner asked Funded Clips to remember (newest first):\n" + "\n".join(f"- {m}" for m in memory)
            )
        return blocks

    def levels(
        self, *, job_id: str | None, task_id: str | None, conv_id: str | None, msg_id: str | None
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None, dict[str, Any] | None]:
        """(the stored per-request override, the conversation's setting, the project's setting) for the item a call
        works for."""
        override: dict[str, Any] | None = None
        conversation: dict[str, Any] | None = None
        project: dict[str, Any] | None = None
        if job_id:
            job = self.item(keys.job_sk(job_id)) or {}
            override = _choice((job.get("configuration") or {}).get("override"))
            content = str(job.get("contentId") or "")
            if content and job.get("contentType") == "animation":
                project = _choice((self.item(keys.story_sk(content)) or {}).get("ai"))
            elif content and job.get("contentType") == "reference":
                project = _choice((self.item(keys.refvid_sk(content)) or {}).get("ai"))
        if task_id:
            override = _choice((self.item(keys.task_sk(task_id)) or {}).get("override"))
        if conv_id:
            conversation = _choice(self.item(keys.conv_sk(conv_id)))
            if msg_id:
                override = _choice((self.item(keys.msg_sk(conv_id, msg_id)) or {}).get("requested"))
        return override, conversation, project


def _choice(raw: Any) -> dict[str, Any] | None:
    """``{model?, effort?}`` from an item's setting (``None`` values mean "not set at this level")."""
    if not isinstance(raw, dict):
        return None
    out = {k: str(raw[k]) for k in ("model", "effort") if raw.get(k)}
    return out or None
