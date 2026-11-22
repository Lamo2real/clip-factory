"""Keeping and clearing files now (docs/CONTRACTS.md §45.34 "Keeping and clearing files"; the owner's second request
§6F: "Media storage. Reference-video storage. Asset retention.").

``POST /v1/workspaces/{ws}/storage/cleanup`` → ``{ removed: { files, bytes } }`` applies the workspace's keep
settings at once (Lamo Stories' agent applies them after each job too):

* ``production.keepReferences``: ``all`` keeps everything; ``study_only`` deletes a reference video's file and its
  frames once its study is written and keeps the study; ``days_30`` / ``days_90`` delete the file and frames of a
  reference older than that (its study, if any, stays). The ``REFVID#`` keeps its name and study and gets
  ``fileRemovedAt`` and ``note`` (internal; the agent writes the same, §45.35 D9; an older item's
  ``sourceRemovedAt`` still counts): the reference answers ``fileRemoved: true`` and ``studyKept`` (the page says
  "The video was removed to save space. Its study stays." only when a study was kept) and Analyze is refused.
* ``production.keepChatPictures``: ``days_30`` / ``days_90`` delete the pictures of chat messages older than that;
  the message keeps its words (its ``attachments`` empty, ``picturesRemovedAt`` internal).
* ``production.keepVersions``: a number keeps the files of each story's last N versions, as the agent's own pruning
  does: the current files, the writer's newest storyboard and every key another file row or the story still names
  are always kept.

Every S3 delete is a key under the workspace's own ``ws/{userId}/{workspaceId}/`` (checked again here), only after the
item that names it was read from this workspace's partition. A story with a job running and a reference being studied
are left alone. One call deletes at most about ``MAX_FILES`` files and rows (the rest on the next call, also inside one
story); a second call finds nothing already cleared, so calling twice is safe.
"""

from __future__ import annotations

import contextlib
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Final

from .. import db
from ..clock import iso, parse
from ..log import log
from . import ai_config as cfg
from . import shapes
from . import types as ws
from .expr import Update

MAX_FILES: Final = 200  # S3 deletes and ASSET# row deletes per call: well inside the API's 29 s
DAYS: Final = {"days_30": 30, "days_90": 90}
STORY_KINDS: Final = ("storyboard", "scene_still", "scene_clip", "audio", "captions", "final_video", "cover", "video")
CLEARABLE_REFS: Final = ("ready", "analyzed", "failed")
# A reference video whose file was cleared (§45.34, §45.35 D9). Lamo Stories' agent writes ``fileRemovedAt`` and
# ``note`` after each job; this module writes the same. ``sourceRemovedAt`` (the API's earlier name) is still read.
REMOVED_MARK: Final = "fileRemovedAt"
REMOVED_MARKS: Final = (REMOVED_MARK, "sourceRemovedAt")
REMOVED_NOTE: Final = "The video was removed to save space. Its study stays."
REMOVED_NO_STUDY: Final = "The video was removed to save space."


@dataclass
class Removed:
    files: int = 0
    bytes: int = 0
    spent: int = 0  # S3 objects and rows deleted in this call (the bound)

    def full(self) -> bool:
        return self.spent >= MAX_FILES

    def left(self) -> int:
        return max(MAX_FILES - self.spent, 0)


def _bytes(value: Any) -> int:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) and value > 0 else 0


def inside(user_id: str, workspace_id: str, key: Any) -> bool:
    """Only files of this workspace: ``ws/{userId}/{workspaceId}/…``, never ``..``."""
    return isinstance(key, str) and key.startswith(ws.s3_prefix(user_id, workspace_id)) and ".." not in key


def file_removed(item: Mapping[str, Any]) -> bool:
    """Whether a reference video's file was cleared by a keep setting (by this API or by Lamo Stories' agent)."""
    return any(item.get(mark) for mark in REMOVED_MARKS)


def study_kept(item: Mapping[str, Any]) -> bool:
    """Whether a cleared reference video still has its study (``analysisKey``): only then does the page say "Its
    study stays." (§45.35 D9). A reference that was never studied (ready or failed) was cleared without one."""
    return file_removed(item) and bool(item.get("analysisKey"))


def _older(item: Mapping[str, Any], cutoff: datetime) -> bool:
    made = parse(item.get("createdAt"))
    return made is not None and made < cutoff


def pictures_cutoff(workspace: Mapping[str, Any], now: datetime) -> datetime | None:
    """Chat pictures of messages older than this are gone under ``keepChatPictures`` (the agent clears them after each
    job by the files' age, this API on cleanup), so they are not shown; None while every picture is kept."""
    production = shapes.stories_config(workspace).get("production") or {}
    keep = str(production.get("keepChatPictures") or "all")
    return now - timedelta(days=DAYS[keep]) if keep in DAYS else None


def cleanup(app: Any, user_id: str, workspace_id: str, workspace: Mapping[str, Any], now: datetime) -> dict[str, int]:
    """Applies keepReferences, keepChatPictures and keepVersions now; returns what was removed."""
    production = shapes.stories_config(workspace).get("production") or {}
    removed = Removed()
    references(app, user_id, workspace_id, keep=str(production.get("keepReferences") or "all"), now=now, out=removed)
    chat_pictures(
        app, user_id, workspace_id, keep=str(production.get("keepChatPictures") or "all"), now=now, out=removed
    )
    versions(app, user_id, workspace_id, keep=production.get("keepVersions"), out=removed)
    log("info", "ws.storage_cleaned", files=removed.files, bytes=removed.bytes)
    return {"files": removed.files, "bytes": removed.bytes}


# --- reference videos ------------------------------------------------------------------------------------------


def _ref_due(item: Mapping[str, Any], keep: str, now: datetime) -> bool:
    if file_removed(item) or item.get("currentJobId") or item.get("status") not in CLEARABLE_REFS:
        return False
    if keep == "study_only":
        return item.get("status") == "analyzed" and bool(item.get("analysisKey"))
    if keep in DAYS:
        return _older(item, now - timedelta(days=DAYS[keep]))
    return False


def references(app: Any, user_id: str, workspace_id: str, *, keep: str, now: datetime, out: Removed) -> None:
    """First the mark (only while the reference is as it was read and nothing studies it), then the files: Analyze
    refuses a marked reference, so a study never starts on a file that is about to go."""
    removed = out
    if keep == "all":
        return
    store = app.store
    for item in cfg.query_owned(store, user_id, workspace_id, ws.REFVID_SK):
        if removed.full():
            return
        if not _ref_due(item, keep, now):
            continue
        ref_prefix = f"{ws.s3_prefix(user_id, workspace_id)}references/{item.get('refId')}/"
        key = item.get("key")
        if not inside(user_id, workspace_id, key) or not str(key).startswith(ref_prefix):
            continue
        studied = item.get("status") == "analyzed" and bool(item.get("analysisKey"))
        at = iso(now)
        mark = Update(
            str(item["pk"]),
            str(item["sk"]),
            sets={REMOVED_MARK: at, "note": REMOVED_NOTE if studied else REMOVED_NO_STUDY, "updatedAt": at},
        )
        mark.equals("userId", user_id).equals("workspaceId", workspace_id)
        mark.equals("status", item.get("status")).absent_or_null("currentJobId")
        for name in REMOVED_MARKS:
            mark.absent_or_null(name)
        try:
            mark.run(store)
        except db.ConditionFailed:
            log("info", "ws.reference_clear_raced", refId=item.get("refId"))
            continue  # studied (or cleared) meanwhile: the next cleanup looks again
        try:
            app.media.delete(str(key))
            frames = app.media.delete_prefix(f"{ref_prefix}frames/")
        except Exception:
            _unmark(store, item, at)  # the file is still there: the next cleanup tries again
            raise
        removed.files += 1 + frames
        removed.spent += 1 + frames
        removed.bytes += _bytes(item.get("bytes"))


def _unmark(store: db.Store, item: Mapping[str, Any], at: str) -> None:
    undo = Update(str(item["pk"]), str(item["sk"]), removes=[REMOVED_MARK, "note"])
    try:
        undo.equals(REMOVED_MARK, at).run(store)
    except db.ConditionFailed:
        log("info", "ws.reference_unmark_skipped", refId=item.get("refId"))


# --- chat pictures ---------------------------------------------------------------------------------------------


def chat_pictures(app: Any, user_id: str, workspace_id: str, *, keep: str, now: datetime, out: Removed) -> None:
    """The pictures of messages older than the days kept. Only a picture under the conversation's own ``chat/``
    folder is deleted, and only one still there is counted (the agent may have cleared it already); first the
    files, then the message's ``attachments`` (a cut-off call leaves the message for the next one)."""
    removed = out
    if keep not in DAYS:
        return
    cutoff = now - timedelta(days=DAYS[keep])
    store = app.store
    for item in cfg.query_owned(store, user_id, workspace_id, ws.MSG_SK):
        if removed.full():
            return
        pictures = [a for a in item.get("attachments") or [] if isinstance(a, Mapping)]
        if not pictures or not _older(item, cutoff):
            continue
        chat_prefix = f"{ws.s3_prefix(user_id, workspace_id)}chat/{item.get('convId')}/"
        ours = [a for a in pictures if inside(user_id, workspace_id, a.get("key")) and a["key"].startswith(chat_prefix)]
        if not ours:
            continue
        files, size = 0, 0
        for picture in ours:
            there = app.media.head(str(picture["key"]))
            if there is None:
                continue  # already cleared (by the agent after a job): not counted again
            app.media.delete(str(picture["key"]))
            files += 1
            size += _bytes(picture.get("bytes")) or _bytes(there.get("ContentLength"))
        kept = [a for a in pictures if a not in ours]
        update = Update(str(item["pk"]), str(item["sk"]), sets={"attachments": kept, "picturesRemovedAt": iso(now)})
        # the files are gone either way; a refused update leaves the links for the next cleanup (not counted again)
        with contextlib.suppress(db.ConditionFailed):
            update.equals("userId", user_id).equals("workspaceId", workspace_id).run(store)
        removed.files += files
        removed.bytes += size
        removed.spent += max(files, 1)


# --- old story versions ----------------------------------------------------------------------------------------


def _current(asset: Mapping[str, Any]) -> int:
    meta = asset.get("meta") if isinstance(asset.get("meta"), Mapping) else {}
    return int((meta or {}).get("current", 1) or 0)


def versions(app: Any, user_id: str, workspace_id: str, *, keep: Any, out: Removed) -> None:
    removed = out
    if not isinstance(keep, int) or isinstance(keep, bool) or keep < 1:
        return  # "all"
    store = app.store
    assets = cfg.query_owned(store, user_id, workspace_id, ws.ASSET_SK)
    by_story: dict[str, list[dict[str, Any]]] = {}
    for asset in assets:
        if asset.get("storyId"):
            by_story.setdefault(str(asset["storyId"]), []).append(asset)
    for story in cfg.query_owned(store, user_id, workspace_id, ws.STORY_SK):
        if removed.full():
            return
        if story.get("currentJobId") or story.get("status") == "producing":
            continue  # its job may be writing files right now
        own = by_story.get(str(story.get("storyId")), [])
        _prune_story(app, user_id, workspace_id, story=story, assets=own, keep=keep, out=removed)


def _prune_story(
    app: Any,
    user_id: str,
    workspace_id: str,
    *,
    story: Mapping[str, Any],
    assets: list[dict[str, Any]],
    keep: int,
    out: Removed,
) -> None:
    """The agent's ``_prune_versions`` rule for one story (§45.29): versions older than the last ``keep`` go, oldest
    first and only as many as this call has left (the rest on the next call). Each file goes with every row that
    names it; first the files, then the rows, so a call cut off leaves rows the next call finds again."""
    removed = out
    version = int(story.get("scriptVersion") or 0)
    if version <= keep:
        return
    floor = version - keep + 1
    story_prefix = shapes.story_prefix(user_id, workspace_id, str(story["storyId"]))
    writers = [a for a in assets if a.get("kind") == "storyboard" and (a.get("meta") or {}).get("by") == "writer"]
    newest_writer = max(writers, key=lambda a: int(a.get("version") or 0), default=None)
    old = [
        a
        for a in assets
        if a.get("kind") in STORY_KINDS
        and _current(a) == 0
        and isinstance(a.get("version"), int | float)
        and int(a["version"]) < floor
        and a is not newest_writer
        and str(a.get("key") or "").startswith(story_prefix)
    ]
    if not old:
        return
    old_ids = {a["assetId"] for a in old}
    used = {str(a.get("key")) for a in assets if a.get("assetId") not in old_ids}
    used |= {str(story.get(k)) for k in ("scriptKey", "videoKey", "coverKey") if story.get(k)}
    stills = story.get("stillKeys") if isinstance(story.get("stillKeys"), Mapping) else {}
    used |= {str(v) for v in (stills or {}).values()}
    groups: dict[str, list[dict[str, Any]]] = {}
    for asset in sorted(old, key=lambda a: (int(a["version"]), str(a.get("key")))):
        groups.setdefault(str(asset["key"]), []).append(asset)
    rows: list[dict[str, Any]] = []
    files: list[str] = []
    deletes: list[str] = []
    for key, named_by in groups.items():
        gone = key not in used  # a file another row or the story still names is kept (its rows still go)
        objects = (
            ([key, key.removesuffix(".json") + ".writer.json"] if key.endswith(".json") else [key]) if gone else []
        )
        cost = len(objects) + len(named_by)
        if cost > removed.left() - len(deletes) - len(rows) and (rows or removed.spent):
            break  # this call has done enough: the next one goes on from here
        rows += named_by
        if gone:
            files.append(key)
            deletes += objects
    for key in deletes:
        if inside(user_id, workspace_id, key) and key.startswith(story_prefix):
            app.media.delete(key)
    for asset in rows:
        app.store.delete_if(str(asset["pk"]), str(asset["sk"]), {"userId": [user_id], "workspaceId": [workspace_id]})
    removed.files += len(files)
    removed.spent += len(deletes) + len(rows)
    sizes = {str(a["key"]): _bytes(a.get("bytes")) for a in old}
    removed.bytes += sum(sizes.get(k, 0) for k in files)
