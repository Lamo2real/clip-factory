"""/v1/autopost: auto-posting's status and its test runs (docs/CONTRACTS.md §46.9).

* ``GET /v1/autopost``: whether it is on, when the next run is, which clips go next and which wait (with the reason),
  the recent runs with each post's state and live link, the failed auto-posted posts (with Try again in the app) and
  the auto-posted clips to post on TikTok yourself.
* ``POST /v1/autopost/run`` ``{"kind": "practice" | "private"}``: one Practice run, or one Private test run, now and
  inline (the same ``run_once`` the hourly tick runs, with Upload's own grants), whether auto-posting is on or not. At
  most one a minute. Neither moves the schedule.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .. import clips, db, posts, release, settings, tiktok_self, validate
from ..app import App
from ..autopost import RUN_PREFIX, STATE_SK, pick, run, schedule
from ..clock import iso
from ..errors import bad_request
from ..http import Request, Response, ok

Item = dict[str, Any]

RUNS_SHOWN = 10
FAILED_SHOWN = 20
TIKTOK_SHOWN = 10
RUN_KINDS = {"practice": "practice_now", "private": "private_now"}
PICK_KIND = "Pick practice or private."


def _cover(app: App, clip: Mapping[str, Any]) -> dict[str, str]:
    """A 1-hour cover link, as ``clips.public_clip`` gives (never for a clip thrown away)."""
    key = clip.get("coverKey")
    if not key or clip.get("status") == "declined":
        return {}
    return {"coverUrl": app.media.presign_get(str(key))}


def _cr_time(app: App, req: Request) -> None:
    """The campaign fit check (§39.3) counts this request's time from its start."""
    deps = getattr(app, "contentrewards", None)
    if deps is not None:
        deps.for_request(req.started)


def _run_posts(app: App, user_id: str, runs: list[Item], by_id: Mapping[str, Item]) -> dict[str, Item]:
    """The posts of the runs' clips, read by each clip's ``postIds`` (strongly consistent)."""
    pk = db.user_pk(user_id)
    keys: list[tuple[str, str]] = []
    for item in runs:
        for planned in item.get("clips") or []:
            clip = by_id.get(str(planned.get("clipId")))
            if clip is not None and clip.get("autoRun") == item.get("runId"):
                keys += [(pk, db.post_sk(str(i))) for i in clip.get("postIds") or []]
    return {str(p.get("postId")): p for p in app.store.batch_get(keys) if p.get("type") == "post"} if keys else {}


def public_run(item: Mapping[str, Any], by_id: Mapping[str, Item], found: Mapping[str, Item]) -> Item:
    """The ``AutoRun`` shape (§46.9): each clip's posts are the ones this run made (never a TikTok post the owner
    posted himself, §42, or a place he added later)."""
    out: Item = {k: item[k] for k in ("runId", "at", "kind", "mode", "state", "note") if k in item}
    out["clips"] = []
    for planned in item.get("clips") or []:
        entry: Item = {
            "clipId": str(planned.get("clipId") or ""),
            "hook": str(planned.get("hook") or ""),
            "places": [str(p) for p in planned.get("places") or []],
        }
        for key in ("outcome", "reason"):
            if planned.get(key):
                entry[key] = planned[key]
        clip = by_id.get(entry["clipId"])
        rows: list[Item] = []
        if clip is not None and clip.get("autoRun") == item.get("runId"):
            for post_id in clip.get("postIds") or []:
                post = found.get(str(post_id))
                if post is None or post.get("autoRun") != item.get("runId"):
                    continue
                row: Item = {"platform": post.get("platform"), "status": post.get("status")}
                for key in ("url", "error"):
                    if post.get(key):
                        row[key] = post[key]
                if posts.is_private_test(post):
                    row["test"] = "private"
                rows.append(row)
        entry["posts"] = rows
        out["clips"].append(entry)
    return out


def _tiktok_not_out(clip: Mapping[str, Any], rows: list[Item]) -> bool:
    """§42.1: an uploaded clip whose TikTok is not out for everyone (none, waiting, failed or uploaded privately), not
    while Clip Factory is uploading it and not once the owner marked it."""
    if clip.get("status") not in tiktok_self.DECIDED or not clip.get("postsCreated"):
        return False
    row = tiktok_self.tiktok_row(rows)
    if row is None:
        return True
    if row.get("by") == "you" or row.get("status") == "queued":
        return False
    if row.get("status") == "posted":
        return row.get("privacy") != "public"
    return row.get("status") in {"pending_integration", "failed"}


def status(app: App, req: Request) -> Response:
    """``GET /v1/autopost`` → ``AutoPostStatus``."""
    _cr_time(app, req)
    user_id = req.user_id
    store = app.store
    pk = db.user_pk(user_id)
    now = app.clock()
    auto = settings.load(store, user_id)["autoPost"]
    state = store.get(pk, STATE_SK)
    every = clips.all_clips(store, user_id)
    by_id = {str(c.get("clipId")): c for c in every if c.get("type") == "clip"}
    picked = pick.pick(app, user_id, now, found=every)
    next_at = schedule.next_run_at(auto, state, now)
    per_run = int(auto["perRun"])
    next_up: list[Item] = []
    for i, taken in enumerate(picked.taken[: pick.NEXT_UP_MAX]):
        clip = taken.clip
        row: Item = {"clipId": clip["clipId"], "jobId": clip.get("jobId"), "hook": str(clip.get("hook") or "")}
        row.update(_cover(app, clip))
        if next_at is not None:
            row["runAt"] = iso(next_at + schedule.every(auto) * (i // per_run))
        next_up.append(row)
    waiting = [
        {
            "clipId": w.clip["clipId"],
            "jobId": w.clip.get("jobId"),
            "hook": str(w.clip.get("hook") or ""),
            **_cover(app, w.clip),
            "reason": w.reason,
        }
        for w in picked.waiting[: pick.WAITING_MAX]
    ]
    runs = store.query_page(pk, RUN_PREFIX, newest_first=True, limit=RUNS_SHOWN, consistent=True).items
    run_posts = _run_posts(app, user_id, runs, by_id)
    rows = posts.all_posts(store, user_id)
    failed = [
        {
            "postId": p["postId"],
            "clipId": p.get("clipId"),
            "hook": str(by_id.get(str(p.get("clipId")), {}).get("hook") or ""),
            "platform": p.get("platform"),
            "error": str(p.get("error") or ""),
            "at": str(p.get("createdAt") or ""),
        }
        for p in rows
        if p.get("type") == "post" and p.get("autoRun") and p.get("status") == "failed"
    ][:FAILED_SHOWN]
    by_clip = clips.posts_by_clip([p for p in rows if p.get("type") == "post"])
    auto_clips = sorted(
        (c for c in by_id.values() if c.get("autoRun") and c.get("autoTest") != "private"),
        key=lambda c: (str(c.get("autoAt") or ""), str(c.get("clipId"))),
        reverse=True,
    )
    tiktok_yourself = [
        {"clipId": c["clipId"], "hook": str(c.get("hook") or ""), **_cover(app, c)}
        for c in auto_clips
        if _tiktok_not_out(c, by_clip.get(str(c["clipId"]), []))
    ][:TIKTOK_SHOWN]
    return ok(
        {
            "autoPost": auto,
            "nextRunAt": iso(next_at) if next_at is not None else None,
            "perDay": schedule.per_day(auto),
            "places": picked.places,
            "leftOut": pick.left_out(picked.places),
            "nextUp": next_up,
            "waiting": waiting,
            "runs": [public_run(r, by_id, run_posts) for r in runs],
            "failed": failed,
            "tiktokYourself": tiktok_yourself,
        }
    )


def run_now(app: App, req: Request) -> Response:
    """``POST /v1/autopost/run`` → ``{"run": AutoRun}``."""
    body = req.json()
    validate.only_keys(body, {"kind"})
    raw = body.get("kind")
    kind = RUN_KINDS.get(raw) if isinstance(raw, str) else None
    if kind is None:
        raise bad_request(PICK_KIND)
    _cr_time(app, req)
    # Inline in the request (API Gateway waits 29 s): the same time rules as the release on connect.
    deps = run.RunDeps(
        app=app,
        time_budget_seconds=release.ANSWER_SECONDS,
        clip_seconds=release.CLIP_SECONDS,
        deadline=req.started + release.ANSWER_SECONDS,
    )
    outcome = run.run_once(deps, req.user_id, kind, app.clock())
    item = outcome.run or {}
    pk = db.user_pk(req.user_id)
    ids = [str(c.get("clipId")) for c in item.get("clips") or []]
    by_id = {str(c.get("clipId")): c for c in app.store.batch_get((pk, db.clip_sk(i)) for i in ids)} if ids else {}
    return ok({"run": public_run(item, by_id, _run_posts(app, req.user_id, [item], by_id))})
