"""Keeping and clearing files after each job (docs/CONTRACTS.md §45.34 "Keeping and clearing files"; request 2 §6F:
"Media storage. Reference-video storage. Asset retention.").

The workspace's ``production`` settings say what stays:

* ``keepReferences``: ``all`` (the default), ``study_only`` (a reference video's file and frames go once its study is
  written; ``analysis.json`` and the ``REFVID#`` item stay, with a note), ``days_30`` or ``days_90`` (the same, once
  the reference is that old);
* ``keepChatPictures``: ``all`` (the default), ``days_30`` or ``days_90`` (the pictures of chat messages that old
  go; the message keeps its words, its ``attachments`` empty and ``picturesRemovedAt`` set, as the API's cleanup).

A cleared reference gets ``fileRemovedAt`` (internal; the one name the API and the agent both write, §45.35 D9: the
API then stops offering the file, shows the note and refuses Analyze). Both still read the older ``sourceRemovedAt``.

Only files under the workspace's own ``ws/{userId}/{workspaceId}/`` prefix are ever listed or deleted, a reference
that is uploading or being analyzed is never touched, and every run is logged with what it removed (files and
bytes). Old story versions are ``keepVersions``' (pipeline.py)."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from . import keys
from .data import JobFence, StoryData
from .util import JobSuperseded, log, now_iso

REFERENCE_CHOICES = ("all", "study_only", "days_30", "days_90")
CHAT_CHOICES = ("all", "days_30", "days_90")
REMOVED_NOTE = "The video was removed to save space. Its study stays."
REMOVED_NO_STUDY = "The video was removed to save space."
KEEP_FILES = ("analysis.json",)  # a reference's study always stays
BUSY = ("uploading", "fetching", "analyzing")  # fetching: a link Clips Funded is still getting (§45.40)
FILE_REMOVED = "fileRemovedAt"  # the mark's one name, written by the API and the agent (§45.35 D9)
OLD_FILE_REMOVED = "sourceRemovedAt"  # the old name an earlier build of the API wrote; still read


def file_removed(ref: Mapping[str, Any]) -> bool:
    """Whether keepReferences (the agent's or the API's cleanup) already cleared this reference's video."""
    return bool(ref.get(FILE_REMOVED) or ref.get(OLD_FILE_REMOVED))


@dataclass
class Removed:
    files: int = 0
    bytes: int = 0

    def add(self, files: list[dict[str, Any]]) -> None:
        self.files += len(files)
        self.bytes += sum(int(f.get("size") or 0) for f in files)


def choice(production: Mapping[str, Any] | None, name: str, allowed: tuple[str, ...]) -> str:
    raw = (production or {}).get(name)
    return str(raw) if raw in allowed else "all"


def days(value: str) -> int | None:
    """``days_30`` → 30; anything else → None."""
    head, _, n = value.partition("_")
    return int(n) if head == "days" and n.isdigit() else None


def parse_time(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if not isinstance(value, str) or not value:
        return None
    try:
        got = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return got if got.tzinfo else got.replace(tzinfo=UTC)


async def after_job(
    data: StoryData, fence: JobFence, configuration: Mapping[str, Any] | None, *, now: datetime | None = None
) -> dict[str, dict[str, int]]:
    """Applies ``keepReferences`` and ``keepChatPictures``; returns what was removed, per kind. A failure is logged
    and never changes the job's result."""
    production = (configuration or {}).get("production")
    production = production if isinstance(production, Mapping) else {}
    at = now or datetime.now(UTC)
    out: dict[str, dict[str, int]] = {}
    refs = choice(production, "keepReferences", REFERENCE_CHOICES)
    chat = choice(production, "keepChatPictures", CHAT_CHOICES)
    try:
        if refs != "all":
            got = await _references(data, fence, refs, at)
            out["references"] = {"files": got.files, "bytes": got.bytes}
        if chat != "all":
            got = await _chat_pictures(data, fence, days(chat) or 0, at)
            out["chatPictures"] = {"files": got.files, "bytes": got.bytes}
    except JobSuperseded:
        log("info", "stories.retention_fenced", job=fence.job_id)
        return out
    except Exception as e:  # keeping files a little longer is never a failure of the job
        log("warn", "stories.retention_failed", job=fence.job_id, error=type(e).__name__, detail=str(e)[:300])
        return out
    if out:
        log("info", "stories.retention", job=fence.job_id, keepReferences=refs, keepChatPictures=chat, removed=out)
    return out


async def _references(data: StoryData, fence: JobFence, rule: str, now: datetime) -> Removed:
    removed = Removed()
    limit = days(rule)
    rows = await data.query_prefix(fence.pk, "REFVID#", consistent=True)
    for ref in rows:
        if data._owned(ref, fence.user_id, fence.workspace_id) is None or file_removed(ref):
            continue
        ref_id = str(ref.get("refId") or str(ref.get("sk") or "").removeprefix("REFVID#"))
        status = str(ref.get("status") or "")
        if not keys.SAFE_ID.match(ref_id) or status in BUSY or ref.get("currentJobId"):
            continue
        studied = status == "analyzed" and bool(ref.get("analysisKey"))
        if limit is None:  # study_only
            if not studied:
                continue
        else:
            made = parse_time(ref.get("createdAt"))
            if made is None or now - made < timedelta(days=limit):
                continue
        prefix = keys.reference_prefix(fence.user_id, fence.workspace_id, ref_id)
        files = [
            f
            for f in await data.list_files(fence, prefix)
            if str(f["key"]).removeprefix(prefix) not in KEEP_FILES and str(f["key"]) != str(ref.get("analysisKey"))
        ]
        if not files:
            continue
        # First the note (only while the reference is as it was read), then the files.
        note = REMOVED_NOTE if studied else REMOVED_NO_STUDY
        await data.write(
            fence,
            other_set=(keys.refvid_sk(ref_id), {FILE_REMOVED: now_iso(), "note": note}, {"status": status}),
        )
        await data.delete_files(fence, [str(f["key"]) for f in files])
        removed.add(files)
    return removed


async def _chat_pictures(data: StoryData, fence: JobFence, limit: int, now: datetime) -> Removed:
    """The pictures of this workspace's chat messages older than ``limit`` days, per ``MSG#`` (as the API's cleanup):
    first the message (``attachments`` empty, ``picturesRemovedAt``, only while it is still this workspace's), then
    its files under ``chat/{convId}/``. A message that changed meanwhile keeps its pictures until the next run."""
    removed = Removed()
    if limit <= 0:
        return removed
    cutoff = now - timedelta(days=limit)
    chat = keys.chat_prefix(fence.user_id, fence.workspace_id)
    rows = await data.query_prefix(fence.pk, "MSG#", consistent=True)
    for msg in rows:
        if data._owned(msg, fence.user_id, fence.workspace_id) is None or msg.get("picturesRemovedAt"):
            continue
        pictures = [a for a in msg.get("attachments") or [] if isinstance(a, Mapping)]
        made = parse_time(msg.get("createdAt"))
        conv_id = str(msg.get("convId") or "")
        if not pictures or made is None or made >= cutoff or not keys.SAFE_ID.match(conv_id):
            continue
        folder = f"{chat}{conv_id}/"
        gone = [a for a in pictures if str(a.get("key") or "").startswith(folder) and ".." not in str(a["key"])]
        try:
            await data.write(
                fence,
                other_set=(
                    str(msg["sk"]),
                    {"attachments": [], "picturesRemovedAt": now_iso()},
                    {"userId": fence.user_id, "workspaceId": fence.workspace_id},
                ),
            )
        except JobSuperseded:
            log("info", "stories.chat_pictures_raced", sk=msg.get("sk"))
            continue
        if gone:
            await data.delete_files(fence, [str(a["key"]) for a in gone])
            removed.files += len(gone)
            removed.bytes += sum(_bytes(a.get("bytes")) for a in gone)
    return removed


def _bytes(value: Any) -> int:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) and value > 0 else 0
