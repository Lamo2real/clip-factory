"""/v1/clips: review, caption edits, confirm, decline and similar clips. Nothing is published without Confirm."""

from __future__ import annotations

from typing import Any

from .. import clips, db, posts, s3, settings, validate, vectors
from ..app import App
from ..clock import iso
from ..errors import bad_request, conflict, not_found
from ..flow_client import FlowStartError
from ..http import Request, Response, ok
from ..ids import is_ulid
from ..log import log

ALREADY_DECIDED = "This clip has already been kept or thrown away."
ALREADY_DECLINED = "This clip was thrown away, so it cannot be kept."


def _clip_or_404(app: App, req: Request) -> dict[str, Any]:
    clip_id = req.params["clipId"]
    item = app.store.get(db.user_pk(req.user_id), db.clip_sk(clip_id)) if is_ulid(clip_id) else None
    if item is None:
        raise not_found("We could not find that clip.")
    return item


def _require_review(item: dict[str, Any]) -> None:
    if item.get("status") != "review":
        raise conflict(ALREADY_DECIDED)


def list_clips(app: App, req: Request) -> Response:
    status = req.query.get("status") or "review"
    if status not in clips.STATUS_GROUPS:
        raise bad_request("status must be review, confirmed, posted, declined or all.")
    wanted = clips.STATUS_GROUPS[status]
    job_id = req.query.get("jobId")
    if job_id:
        if not is_ulid(job_id):
            raise bad_request("jobId is not valid.")
        items = clips.clips_for_job(app.store, req.user_id, job_id)
        items.sort(key=lambda c: (c.get("rank", 0), c.get("clipId", "")))
    else:
        items = clips.all_clips(app.store, req.user_id)
    if wanted is not None:
        items = [c for c in items if c.get("status") in wanted]
    return ok({"clips": [clips.public_clip(c, app.media) for c in items]})


def get_clip(app: App, req: Request) -> Response:
    return ok({"clip": clips.public_clip(_clip_or_404(app, req), app.media)})


def patch_clip(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, {"captions"})
    if "captions" not in body:
        raise bad_request("captions is required.")
    patch = clips.caption_patch(body["captions"])
    item = _clip_or_404(app, req)
    _require_review(item)
    try:
        updated = app.store.update(
            item["pk"],
            item["sk"],
            {"captions": clips.merged_captions(item.get("captions"), patch)},
            expect_in={"status": ["review"]},
        )
    except db.ConditionFailed as e:
        raise conflict(ALREADY_DECIDED) from e
    return ok({"clip": clips.public_clip(updated, app.media)})


def confirm(app: App, req: Request) -> Response:
    """Keep a clip (docs/CONTRACTS.md §14.5). Safe to repeat: the posts are created once and the durable
    ``cf-prod-clip-flow`` start is idempotent on its execution name."""
    body = req.json()
    validate.only_keys(body, {"captions"})
    patch = clips.caption_patch(body["captions"]) if body.get("captions") is not None else {}
    item = _clip_or_404(app, req)
    if item.get("status") == "review":
        now = iso(app.clock())
        fields = {
            "status": "confirmed",
            "decidedAt": now,
            "captions": clips.merged_captions(item.get("captions"), patch),
            "publishState": clips.PUBLISH_PENDING,
            "flowRun": 1,
        }
        try:
            created = posts.create_for_clip(
                app.store,
                req.user_id,
                item,
                settings.load(app.store, req.user_id),
                now,
                clip_fields=fields,
                expect_status=["review"],
            )
        except db.ConditionFailed:
            # Another Confirm (or a Decline) won the race: carry on from the clip's current state.
            item = _clip_or_404(app, req)
        else:
            confirmed = _start_flow(app, {**item, **fields, "postsCreated": True})
            log("info", "clip.confirmed", clipId=item["clipId"], posts=len(created))
            return ok({"clip": clips.public_clip(confirmed, app.media), "posts": created})
    status = item.get("status")
    if status == "declined":
        raise conflict(ALREADY_DECLINED)
    if status == "review":
        raise conflict("This clip changed while you pressed Keep. Please try again.")
    if status == "failed":
        item = _try_again(app, item)
    elif status in {"confirmed", "publishing"} and item.get("publishState") == clips.PUBLISH_PENDING:
        item = _start_flow(app, item)  # an earlier Confirm stopped before its flow started
    return ok({"clip": clips.public_clip(item, app.media), "posts": _posts(app, req.user_id, item["clipId"])})


def _posts(app: App, user_id: str, clip_id: str) -> list[dict[str, Any]]:
    return [posts.public_post(p) for p in posts.posts_for_clip(app.store, user_id, clip_id, consistent=True)]


def _start_flow(app: App, clip: dict[str, Any]) -> dict[str, Any]:
    """Starts ``clip-{clipId}-{flowRun}``; on success the clip becomes ``publishState: started``. A failed start
    leaves it ``pending``, so the next Confirm starts it again."""
    run = int(clip.get("flowRun") or 1)
    try:
        started = app.flows.start_clip_flow(clip["clipId"], clip["userId"], run)
    except (FlowStartError, ValueError) as e:
        log("error", "clip.flow_start_failed", clipId=clip["clipId"], run=run, error=str(e))
        return clip
    fields: dict[str, Any] = {"publishState": clips.PUBLISH_STARTED, "flowRun": run}
    if started.execution_arn:
        fields["flowExecutionArn"] = started.execution_arn
    expect: dict[str, Any] = {"publishState": [clips.PUBLISH_PENDING]}
    if clip.get("flowRun"):
        expect["flowRun"] = [run]  # a clip kept before flow runs existed has none yet
    try:
        updated = app.store.update(clip["pk"], clip["sk"], fields, expect_in=expect)
    except db.ConditionFailed:
        return app.store.get(clip["pk"], clip["sk"]) or clip
    log("info", "clip.flow_started", clipId=clip["clipId"], flow=started.name, existed=started.execution_arn is None)
    return updated


def _try_again(app: App, clip: dict[str, Any]) -> dict[str, Any]:
    """A clip whose every queued post failed: its failed posts go back to ``queued`` and a new flow run starts."""
    run = int(clip.get("flowRun") or 1)
    failed = [
        p
        for p in posts.posts_for_clip(app.store, clip["userId"], clip["clipId"], consistent=True)
        if p.get("status") == "failed"
    ]
    clip_update = db.update_request(
        clip["pk"],
        clip["sk"],
        {"status": "confirmed", "publishState": clips.PUBLISH_PENDING, "flowRun": run + 1},
        remove=["flowExecutionArn"],
        expect_in={"status": ["failed"], "flowRun": [run]} if clip.get("flowRun") else {"status": ["failed"]},
    )
    post_updates = [
        db.update_request(p["pk"], p["sk"], {"status": "queued"}, remove=["error"], expect_in={"status": ["failed"]})
        for p in failed
    ]
    try:
        app.store.transact(updates=[clip_update, *post_updates])
    except db.ConditionFailed:
        current = app.store.get(clip["pk"], clip["sk"]) or clip
        if current.get("status") == "confirmed" and current.get("publishState") == clips.PUBLISH_PENDING:
            return _start_flow(app, current)  # a parallel Try again reset it; finish its start
        return current
    log("info", "clip.try_again", clipId=clip["clipId"], run=run + 1, posts=len(failed))
    refreshed = app.store.get(clip["pk"], clip["sk"]) or clip
    return _start_flow(app, refreshed)


def decline(app: App, req: Request) -> Response:
    item = _clip_or_404(app, req)
    _require_review(item)
    now = iso(app.clock())
    try:
        updated = app.store.update(
            item["pk"],
            item["sk"],
            {"status": "declined", "decidedAt": now},
            remove=["videoKey", "coverKey"],
            expect_in={"status": ["review"]},
        )
    except db.ConditionFailed as e:
        raise conflict(ALREADY_DECIDED) from e
    _delete_files(app, item)
    _delete_vector(app, req.user_id, item["clipId"])
    log("info", "clip.declined", clipId=item["clipId"])
    return ok({"clip": clips.public_clip(updated, app.media)})


def _delete_vector(app: App, user_id: str, clip_id: str) -> None:
    if app.vectors is None:
        return
    try:
        app.vectors.delete_clip(user_id, clip_id)
    except Exception as e:  # the clip is declined either way; a leftover vector is never shown (not "performed")
        log("error", "clip.delete_vector_failed", clipId=clip_id, error=type(e).__name__)


def similar(app: App, req: Request) -> Response:
    """Up to 5 of the owner's measured clips most like this one (docs/CONTRACTS.md §14.6); ``[]`` on any error."""
    item = _clip_or_404(app, req)
    if app.vectors is None:
        return ok({"clips": []})
    try:
        hits = app.vectors.similar(req.user_id, item["clipId"], k=vectors.SIMILAR_TOP_K)
        pk = db.user_pk(req.user_id)
        found = {c.get("clipId"): c for c in app.store.batch_get((pk, db.clip_sk(h.clip_id)) for h in hits)}
        out = []
        for hit in hits:
            clip = found.get(hit.clip_id)
            if clip is None or clip.get("status") == "declined" or clip.get("userId") != req.user_id:
                continue
            out.append(_similar_clip(app, hit, clip))
    except Exception as e:
        log("error", "clip.similar_failed", clipId=item["clipId"], error=type(e).__name__)
        return ok({"clips": []})
    out.sort(key=lambda c: -float(c["similarity"]))
    return ok({"clips": out[: vectors.SIMILAR_MAX]})


def _similar_clip(app: App, hit: vectors.Hit, clip: dict[str, Any]) -> dict[str, Any]:
    meta = hit.metadata
    raw_captions = clip.get("captions")
    captions: dict[str, Any] = raw_captions if isinstance(raw_captions, dict) else {}
    out: dict[str, Any] = {
        "clipId": hit.clip_id,
        "hook": str(clip.get("hook") or meta.get("hook") or ""),
        "title": str(captions.get("youtubeTitle") or meta.get("title") or ""),
        "momentType": str(clip.get("momentType") or meta.get("momentType") or ""),
        "similarity": hit.similarity,
    }
    performance = _performance(meta.get("performance"))
    if performance is not None:
        out["performance"] = performance
    if clip.get("coverKey"):
        out["coverUrl"] = app.media.presign_get(clip["coverKey"])
    return out


def _performance(raw: object) -> dict[str, Any] | None:
    parsed = vectors.parse_performance(raw)
    if parsed is None:
        return None
    perf: dict[str, Any] = {}
    for key in ("views", "likes", "comments", "shares", "posts"):
        value = parsed.get(key, 0)
        perf[key] = int(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0
    if isinstance(parsed.get("checkedAt"), str):
        perf["checkedAt"] = parsed["checkedAt"]
    return perf


def _delete_files(app: App, item: dict[str, Any]) -> None:
    try:
        app.media.delete_prefix(s3.clip_prefix(item["jobId"], item["clipId"]))
        # Keys normally live under the clip's prefix; delete them by name too in case the agent stored them elsewhere.
        for field in ("videoKey", "coverKey"):
            key = item.get(field)
            if isinstance(key, str) and s3.is_safe_key(key) and key.startswith(f"jobs/{item['jobId']}/"):
                app.media.delete(key)
    except Exception as e:
        # The clip is declined either way; its files stay unreachable (the API never links a declined clip).
        log("error", "clip.delete_files_failed", clipId=item["clipId"], error=type(e).__name__)
