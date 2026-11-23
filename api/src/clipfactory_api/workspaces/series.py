"""Series: a folder of story videos with a short running memory, the story so far (docs/CONTRACTS.md §45.43, ADR-90).

Pure: the rules of what the owner sends and the public ``Series`` shape. A ``SERIES#{seriesId}`` item keeps only the
owner's fields, the story so far and the episode summaries (the newest 50, rewritten whole); its episodes, their
numbers, the counts and the cover are worked out from the workspace's ``STORY#`` and ``IDEA#`` items on every read.
The recap task (``series_recap``, in Lamo Stories' own runtime) writes ``storySoFar`` and a summary after an approval;
the routes are in ``routes/series.py``.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Final

from .. import validate
from ..errors import bad_request
from ..ids import is_ulid
from . import shapes
from . import types as ws

Item = dict[str, Any]

NAME_MAX = 40
LINE_MAX = 120
STORY_SO_FAR_MAX = 1500
SUMMARY_MAX = 400
MAX_SERIES = 50
MAX_CAST = 3
KEEP_SUMMARIES = 50

NO_SERIES = "That series is gone."
NO_NAME = "Give your series a name."
NAME_LONG = "Keep the name to 40 letters."
TOO_MANY = "You have 50 series. Delete one to make another."
CHANGED = "Someone changed this meanwhile. Look again, then save."
NOT_AN_EPISODE = "Only an approved video of this series gets a summary."

INPUT_KEYS: Final = ("name", "line", "castIds")
PATCH_KEYS: Final = ("version", "name", "line", "castIds", "cover", "storySoFar")
EPISODE_STATUSES: Final = ("approved", "published")
MAKING: Final = ("draft", "producing", "failed")
REVIEW: Final = ("needs_check", "review")
RECAP_SHOWN: Final = ("queued", "running", "failed")


def series_sk(series_id: str) -> str:
    return f"{ws.SERIES_SK}{series_id}"


def name_taken(items: Iterable[Mapping[str, Any]], name: str, *, except_id: str | None = None) -> str | None:
    """The stored name of another series called ``name`` (case and spaces do not count), else None."""
    wanted = " ".join(name.split()).casefold()
    for item in items:
        stored = " ".join(str(item.get("name") or "").split())
        if stored.casefold() == wanted and item.get("seriesId") != except_id:
            return stored
    return None


def taken_sentence(name: str) -> str:
    return f"You already have a series called {name}."


def _name(value: Any) -> str:
    if value is not None and not isinstance(value, str):
        raise bad_request(NO_NAME, "name")
    name = " ".join(str(value or "").split())
    if not name:
        raise bad_request(NO_NAME, "name")
    if len(name) > NAME_MAX:
        raise bad_request(NAME_LONG, "name")
    return name


def _line(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise bad_request("line must be text.", "line")
    line = " ".join(value.split())
    if len(line) > LINE_MAX:
        raise bad_request(f"Keep the line to {LINE_MAX} letters.", "line")
    return line or None


def cast_ids(value: Any) -> list[str]:
    """Up to 3 character ids, each once, in the owner's order (the route checks them and ``cast_problem``)."""
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) and is_ulid(v) for v in value):
        raise bad_request("castIds must be a list of character ids.", "castIds")
    ids = list(dict.fromkeys(value))
    if len(ids) > MAX_CAST:
        raise bad_request("Pick up to 3 characters.", "castIds")
    return ids


def series_input(body: Mapping[str, Any]) -> Item:
    """SeriesInput: ``{ name, line?, castIds? }``. Unknown keys are 400."""
    validate.only_keys(body, INPUT_KEYS)
    return {"name": _name(body.get("name")), "line": _line(body.get("line")), "castIds": cast_ids(body.get("castIds"))}


def cover(value: Any) -> Item | None:
    """``{storyId}``, ``{characterId}`` or null (automatic)."""
    if value is None:
        return None
    body = validate.obj(value, "cover")
    if len(body) != 1 or not (set(body) <= {"storyId", "characterId"}):
        raise bad_request("cover must be a story, a character or null.", "cover")
    key, found = next(iter(body.items()))
    if not isinstance(found, str) or not is_ulid(found):
        raise bad_request("cover must be a story, a character or null.", "cover")
    return {key: found}


def story_so_far(value: Any) -> str:
    if not isinstance(value, str):
        raise bad_request("storySoFar must be text.", "storySoFar")
    text = value.strip()
    if len(text) > STORY_SO_FAR_MAX:
        raise bad_request(f"Keep the story so far to {STORY_SO_FAR_MAX} letters.", "storySoFar")
    return text


def patch_input(body: Mapping[str, Any]) -> tuple[int, Item]:
    """SeriesPatch → (the version it was read at, the changes). "Nothing to change." when only the version came."""
    validate.only_keys(body, PATCH_KEYS)
    version = validate.integer(body.get("version"), "version", lo=1, hi=10**9)
    out: Item = {}
    if "name" in body:
        out["name"] = _name(body["name"])
    if "line" in body:
        out["line"] = _line(body["line"])
    if "castIds" in body:
        out["castIds"] = cast_ids(body["castIds"])
    if "cover" in body:
        out["cover"] = cover(body["cover"])
    if "storySoFar" in body:
        out["storySoFar"] = story_so_far(body["storySoFar"])
    if not out:
        raise bad_request("Nothing to change.")
    return version, out


def new_item(user_id: str, workspace_id: str, series_id: str, fields: Mapping[str, Any], at: str) -> Item:
    return {
        "pk": ws.workspace_pk(user_id, workspace_id),
        "sk": series_sk(series_id),
        "type": ws.TYPE_SERIES,
        "userId": user_id,
        "workspaceId": workspace_id,
        "seriesId": series_id,
        "name": fields["name"],
        "line": fields.get("line"),
        "castIds": list(fields.get("castIds") or []),
        "cover": None,
        "storySoFar": "",
        "storySoFarBy": None,
        "storySoFarAt": None,
        "summaries": [],
        "recapTaskId": None,
        "version": 1,
        "createdAt": at,
        "updatedAt": at,
    }


# --- summaries (the newest 50, rewritten whole by the recap task) ---------------------------------------------------


def summaries(item: Mapping[str, Any]) -> dict[str, Item]:
    """``storyId`` → ``{storyId, summary, by, at}`` of the series' stored summaries."""
    out: dict[str, Item] = {}
    for entry in item.get("summaries") or []:
        if isinstance(entry, Mapping) and isinstance(entry.get("storyId"), str):
            out[entry["storyId"]] = dict(entry)
    return out


def without_summary(item: Mapping[str, Any], story_id: str) -> list[Item] | None:
    """The summaries without that story's, or None when it had none (nothing to write)."""
    found = summaries(item)
    if story_id not in found:
        return None
    return [e for e in found.values() if e["storyId"] != story_id]


# --- what the routes work out on every read -----------------------------------------------------------------------


def in_series(item: Mapping[str, Any], series_id: str) -> bool:
    return item.get("seriesId") == series_id


def episodes(series_id: str, stories: Iterable[Mapping[str, Any]]) -> list[Item]:
    """The series' approved and published stories in the order of approval (the story's id breaks a tie)."""
    found = [dict(s) for s in stories if in_series(s, series_id) and s.get("status") in EPISODE_STATUSES]
    return sorted(found, key=lambda s: (str(s.get("approvedAt") or s.get("updatedAt") or ""), str(s["storyId"])))


def orphan(item: Mapping[str, Any], known: Iterable[str]) -> bool:
    """No series (``?seriesId=none``): no ``seriesId``, or one whose series is gone."""
    series_id = item.get("seriesId")
    return not series_id or series_id not in set(known)


def counts(series_id: str, stories: Iterable[Mapping[str, Any]], ideas: Iterable[Mapping[str, Any]]) -> dict[str, int]:
    out = {"ideas": 0, "making": 0, "review": 0, "done": 0}
    for idea in ideas:
        if in_series(idea, series_id) and idea.get("status") != "used":
            out["ideas"] += 1
    for story in stories:
        if not in_series(story, series_id):
            continue
        status = story.get("status")
        if status in MAKING:
            out["making"] += 1
        elif status in REVIEW:
            out["review"] += 1
        elif status in EPISODE_STATUSES:
            out["done"] += 1
    return out


def _portrait_url(presign: shapes.Presign, user_id: str, character: Mapping[str, Any] | None) -> str | None:
    stored = (character or {}).get("portrait")
    if not isinstance(stored, Mapping) or character is None:
        return None
    return shapes.safe_url(presign, user_id, str(character["workspaceId"]), stored.get("key"))


def _cover_of(presign: shapes.Presign, user_id: str, story: Mapping[str, Any] | None) -> str | None:
    if story is None:
        return None
    return shapes.safe_url(presign, user_id, str(story["workspaceId"]), story.get("coverKey"))


def _recap(task: Mapping[str, Any] | None) -> Item | None:
    if task is None or task.get("status") not in RECAP_SHOWN:
        return None
    task_input = task.get("input") if isinstance(task.get("input"), Mapping) else {}
    out: Item = {
        "taskId": str(task["taskId"]),
        "storyId": str((task_input or {}).get("storyId") or ""),
        "status": str(task["status"]),
    }
    if task.get("status") == "failed" and task.get("error"):
        out["error"] = str(task["error"])
    return out


def public_series(
    item: Mapping[str, Any],
    *,
    stories: list[Item],
    ideas: list[Item],
    characters: Mapping[str, Mapping[str, Any]],
    recap_task: Mapping[str, Any] | None,
    presign: shapes.Presign,
    user_id: str,
) -> Item:
    """The public ``Series`` (§45.6): its episodes numbered 1..N, the counts, the cover and the running recap."""
    series_id = str(item["seriesId"])
    stored = summaries(item)
    by_id = {str(s["storyId"]): s for s in stories}
    shown_episodes: list[Item] = []
    for n, story in enumerate(episodes(series_id, stories), start=1):
        summary = stored.get(str(story["storyId"]))
        entry: Item = {
            "storyId": str(story["storyId"]),
            "number": n,
            "title": str(story.get("title") or ""),
            "status": str(story.get("status")),
            "summary": summary["summary"] if summary else None,
            "by": summary.get("by") if summary and summary.get("by") in ("ai", "owner") else None,
            "approvedAt": str(story.get("approvedAt") or story.get("updatedAt") or ""),
        }
        url = _cover_of(presign, user_id, story)
        if url:
            entry["coverUrl"] = url
        shown_episodes.append(entry)
    cast = [str(c) for c in item.get("castIds") or [] if str(c) in characters]
    chosen = item.get("cover") if isinstance(item.get("cover"), Mapping) else None
    cover_url: str | None = None
    if chosen and chosen.get("storyId"):
        cover_url = _cover_of(presign, user_id, by_id.get(str(chosen["storyId"])))
    elif chosen and chosen.get("characterId"):
        cover_url = _portrait_url(presign, user_id, characters.get(str(chosen["characterId"])))
    if cover_url is None:
        cover_url = next((e["coverUrl"] for e in reversed(shown_episodes) if e.get("coverUrl")), None)
    if cover_url is None and cast:
        cover_url = _portrait_url(presign, user_id, characters.get(cast[0]))
    by = item.get("storySoFarBy")
    return {
        "seriesId": series_id,
        "workspaceId": str(item["workspaceId"]),
        "name": str(item.get("name") or ""),
        "line": item.get("line") or None,
        "castIds": cast,
        "cover": dict(chosen) if chosen else None,
        "coverUrl": cover_url,
        "storySoFar": str(item.get("storySoFar") or ""),
        "storySoFarBy": by if by in ("ai", "owner") else None,
        "storySoFarAt": item.get("storySoFarAt") or None,
        "episodes": shown_episodes,
        "counts": counts(series_id, stories, ideas),
        "recap": _recap(recap_task),
        "version": int(item.get("version") or 1),
        "createdAt": str(item.get("createdAt") or ""),
        "updatedAt": str(item.get("updatedAt") or ""),
    }
