"""/v1/clips: review, caption edits, confirm, decline and similar clips. Nothing is published without Confirm."""

from __future__ import annotations

from typing import Any

from .. import clips, db, post_preset, posts, release, s3, settings, validate, vectors
from ..app import App
from ..clock import iso
from ..errors import bad_request, conflict, not_found
from ..http import Request, Response, ok
from ..ids import is_ulid
from ..log import log
from ..platforms import label as platform_label

ALREADY_DECIDED = "This clip has already been uploaded or thrown away."
ALREADY_DECLINED = "This clip was thrown away, so it cannot be uploaded."


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
    by_clip = clips.posts_by_clip(posts.all_posts(app.store, req.user_id)) if items else {}
    return ok({"clips": [clips.public_clip(c, app.media, posts=by_clip.get(c["clipId"], [])) for c in items]})


def get_clip(app: App, req: Request) -> Response:
    item = _clip_or_404(app, req)
    found = posts.posts_for_clip(app.store, req.user_id, item["clipId"])
    return ok({"clip": clips.public_clip(item, app.media, posts=found)})


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


TIKTOK_PRIVACY = ("PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY")
TIKTOK_SWITCHES = ("disableComment", "disableDuet", "disableStitch", "brandContent", "brandOrganic")


def tiktok_options(raw: Any) -> dict[str, Any]:
    """The "Post to TikTok" sheet's choices (§17.8), validated."""
    body = validate.obj(raw, "tiktok")
    validate.only_keys(body, {"privacyLevel", *TIKTOK_SWITCHES})
    privacy = body.get("privacyLevel")
    if privacy not in TIKTOK_PRIVACY:
        raise bad_request("Pick who can see it on TikTok.")
    out: dict[str, Any] = {"privacyLevel": privacy}
    for name in TIKTOK_SWITCHES:
        out[name] = validate.boolean(body.get(name, False), name)
    if out["brandContent"] and privacy == "SELF_ONLY":
        raise bad_request("Branded content cannot be posted as Only me on TikTok. Pick who can see it.")
    return out


def upload_platforms(raw: Any) -> list[str]:
    """The places the owner picked on Upload (§33): a non-empty list of known platforms, each once, in STATS_ORDER."""
    if not isinstance(raw, list) or not raw:
        raise bad_request("Pick at least one place to upload to.")
    seen: list[str] = []
    for value in raw:
        if not isinstance(value, str) or value not in posts.UPLOAD_ORDER:
            raise bad_request("One of the places to upload to is not one Clip Factory knows.")
        if value in seen:
            raise bad_request(f"{platform_label(value)} is in the list twice. Pick each place once.")
        seen.append(value)
    return [p for p in posts.UPLOAD_ORDER if p in seen]


def _require_set_up(app: App, user_id: str, platforms: list[str]) -> None:
    """Every chosen place must have a connected account (§33): a clip is never sent somewhere that is not set up."""
    for platform in platforms:
        if posts.connected_account(app.store, user_id, platform) is None:
            raise bad_request(f"{platform_label(platform)} is not set up yet. Turn it off, then tap Upload.")


def confirm(app: App, req: Request) -> Response:
    """Upload a clip (docs/CONTRACTS.md §14.5, §33). Safe to repeat: the posts are created once and the durable
    ``cf-prod-clip-flow`` start is idempotent on its execution name. With TikTok going (connected and chosen, or
    enabled in settings when nothing is chosen), the TikTok sheet's choices are required (§17.8). ``platforms`` picks
    exactly where the clip goes; without it (older clients) Settings › Where clips go decides, as before. On a
    ``posted``, ``failed`` or ``confirmed`` clip, ``platforms`` names the failed posts to try again (one platform's
    Try again) and the waiting posts to send now that their place is connected (Post now, §33.6)."""
    body = req.json()
    validate.only_keys(body, {"captions", "tiktok", "platforms", "options"})
    patch = clips.caption_patch(body["captions"]) if body.get("captions") is not None else {}
    options = tiktok_options(body["tiktok"]) if body.get("tiktok") is not None else None
    chosen = upload_platforms(body["platforms"]) if body.get("platforms") is not None else None
    # Per-clip choices for YouTube, Instagram and X from the card's rows (§36.3); only the places that go keep theirs.
    per_clip = post_preset.clip_options(body["options"]) if body.get("options") is not None else {}
    item = _clip_or_404(app, req)
    if item.get("status") == "review":
        now = iso(app.clock())
        current_settings = settings.load(app.store, req.user_id)
        if chosen is not None:
            _require_set_up(app, req.user_id, chosen)
            tiktok_queued = "tiktok" in chosen
        else:
            tiktok_queued = "tiktok" in current_settings.get("platforms", []) and (
                posts.connected_account(app.store, req.user_id, "tiktok") is not None
            )
        if tiktok_queued and options is None:
            raise bad_request("Pick who can see it on TikTok.")
        fields: dict[str, Any] = {
            "status": "confirmed",
            "decidedAt": now,
            "captions": clips.merged_captions(item.get("captions"), patch),
            "publishState": clips.PUBLISH_PENDING,
            "flowRun": 1,
        }
        if chosen is not None:
            fields["uploadTo"] = chosen
        try:
            created = posts.create_for_clip(
                app.store,
                req.user_id,
                item,
                current_settings,
                now,
                clip_fields=fields,
                expect_status=["review"],
                post_options={
                    **{p: o for p, o in per_clip.items() if chosen is None or p in chosen},
                    **({"tiktok": options} if options else {}),
                }
                or None,
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
        raise conflict("This clip changed while you pressed Upload. Please try again.")
    if status == "failed" or (status in {"posted", "confirmed"} and chosen is not None):
        item = _try_again(app, item, tiktok=options, platforms=chosen)
    elif status in {"confirmed", "publishing", "posted"} and item.get("publishState") == clips.PUBLISH_PENDING:
        item = _start_flow(app, item)  # an earlier Confirm, Try again or release stopped before its flow started
    return ok({"clip": clips.public_clip(item, app.media), "posts": _posts(app, req.user_id, item["clipId"])})


def _posts(app: App, user_id: str, clip_id: str) -> list[dict[str, Any]]:
    return [posts.public_post(p) for p in posts.posts_for_clip(app.store, user_id, clip_id, consistent=True)]


def _start_flow(app: App, clip: dict[str, Any]) -> dict[str, Any]:
    """Starts ``clip-{clipId}-{flowRun}`` (``release.start_flow``, shared with the OAuth callback)."""
    return release.start_flow(app.store, app.flows, clip)


def _try_again(
    app: App, clip: dict[str, Any], *, tiktok: dict[str, Any] | None = None, platforms: list[str] | None = None
) -> dict[str, Any]:
    """Failed posts go back to ``queued`` and a new flow run starts (``release.restart``). Without ``platforms`` (a
    ``failed`` clip, whose every post failed) all failed posts are tried again; with it only the named ones, which also
    works on a ``posted`` clip where one place did not work (§33). Named places still ``pending_integration`` are
    released the same way once they are connected (Post now, §33.6); one not connected yet is a 400 with the plain
    sentence Upload uses. A ``failed`` clip becomes ``confirmed``; a ``posted`` one stays ``posted``. Naming nothing
    to send changes nothing. New TikTok sheet choices (``tiktok``) replace the TikTok post's ``postOptions``, so a
    privacy TikTok no longer offers can be picked again."""
    rows = posts.posts_for_clip(app.store, clip["userId"], clip["clipId"], consistent=True)
    named = [p for p in rows if platforms is None or p.get("platform") in platforms]
    failed = [p for p in named if p.get("status") == "failed"]
    waiting = [p for p in named if platforms is not None and p.get("status") == "pending_integration"]
    if waiting:
        _require_set_up(
            app, clip["userId"], [p for p in posts.UPLOAD_ORDER if any(w["platform"] == p for w in waiting)]
        )
        if tiktok is None and any(p["platform"] == "tiktok" and not release.has_tiktok_choice(p) for p in waiting):
            raise bad_request("Pick who can see it on TikTok.")
    if not failed and not waiting:
        # Nothing to send among the named places. A start that did not go through earlier still gets finished.
        return _start_flow(app, clip) if clip.get("publishState") == clips.PUBLISH_PENDING else clip
    return release.restart(app.store, app.flows, clip, [*failed, *waiting], clip_posts=rows, tiktok=tiktok)


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
