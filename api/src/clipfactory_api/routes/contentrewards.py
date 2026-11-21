"""/v1/contentrewards: the Content Rewards connection, campaigns, submissions and money (docs/CONTRACTS.md §38.8).

Every route answers 503 ``unavailable`` unless ``CONTENT_REWARDS=on`` and the CR deps are configured (an api from
before §38 answers 404, so the web hides every CR card). ``GET /v1/contentrewards`` reads items only, never CR.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any

from .. import db, posts, validate
from ..app import App
from ..clock import iso, parse
from ..errors import ApiError, bad_request, conflict, not_found, too_large
from ..http import Request, Response, no_content, ok
from ..ids import is_ulid
from ..log import log

UNAVAILABLE = "Content Rewards is not switched on for this app yet."
UNDO_SECONDS = 8


def _deps(app: App) -> Any:
    from ..contentrewards import config

    deps = getattr(app, "contentrewards", None)
    if deps is None:
        raise ApiError(503, "unavailable", UNAVAILABLE)
    deps.until(config.API_SECONDS)  # this request's time: a token refresh starts only with ≥ 20 s of it left
    return deps


def _now(app: App) -> datetime:
    return app.clock()


# --- overview and connection -------------------------------------------------------------------------------------


def overview(app: App, req: Request) -> Response:
    from ..contentrewards import campaigns, connection, money, submissions

    deps = _deps(app)
    now = _now(app)
    view = campaigns.View(deps, req.user_id, now)
    items = sorted(campaigns.all_for(deps.store, req.user_id), key=lambda c: str(c.get("addedAt") or ""), reverse=True)
    waiting = []
    for subs in view.subs.values():
        for sub in subs:
            if sub.get("state") == "send_by_hand" and submissions.minutes_left(sub, now) > 0:
                campaign = next((c for c in items if c.get("campaignId") == sub.get("campaignId")), None)
                waiting.append(submissions.public(sub, now=now, campaign=campaign))
    return ok(
        {
            "connection": connection.public(view.conn, now),
            "campaigns": [view.summary(c) for c in items],
            "money": money.public(deps, req.user_id, now),
            "waitingSends": waiting,
        }
    )


def connect(app: App, req: Request) -> Response:
    from ..contentrewards import connect as cr_connect

    deps = _deps(app)
    body = req.json()
    validate.only_keys(body, {"port"})
    return ok(cr_connect.start(deps, req.user_id, body.get("port"), _now(app)))


def connect_finish(app: App, req: Request) -> Response:
    from ..contentrewards import connect as cr_connect

    deps = _deps(app)
    body = req.json()
    validate.only_keys(body, {"state", "code", "iss", "error", "errorDescription"})
    for name in ("state", "code", "iss", "error", "errorDescription"):
        if name in body and body[name] is not None and (not isinstance(body[name], str) or len(body[name]) > 4096):
            raise bad_request(f"{name} must be text.", name)
    if not isinstance(body.get("state"), str) or not (body.get("code") or body.get("error")):
        raise bad_request("Send the state and the code (or the error).")
    return ok(cr_connect.finish(deps, req.user_id, body, _now(app)))


def check(app: App, req: Request) -> Response:
    from ..contentrewards import connect as cr_connect

    return ok(cr_connect.check(_deps(app), req.user_id, _now(app)))


def patch_connection(app: App, req: Request) -> Response:
    from ..contentrewards import connect as cr_connect

    deps = _deps(app)
    body = req.json()
    return ok({"connection": cr_connect.patch(deps, req.user_id, body, _now(app))})


def delete_connection(app: App, req: Request) -> Response:
    from ..contentrewards import connect as cr_connect

    cr_connect.disconnect(_deps(app), req.user_id, _now(app))
    return no_content()


# --- campaigns ---------------------------------------------------------------------------------------------------


def list_campaigns(app: App, req: Request) -> Response:
    from ..contentrewards import campaigns

    deps = _deps(app)
    view = campaigns.View(deps, req.user_id, _now(app))
    items = sorted(campaigns.all_for(deps.store, req.user_id), key=lambda c: str(c.get("addedAt") or ""), reverse=True)
    return ok({"campaigns": [view.summary(c) for c in items]})


def add_campaign(app: App, req: Request) -> Response:
    from ..contentrewards import campaigns

    deps = _deps(app)
    body = req.json()
    validate.only_keys(body, {"url"})
    url = validate.required_string(body, "url", max_len=2048)
    now = _now(app)
    status, found = campaigns.add(deps, req.user_id, url, now)
    if "group" in found:
        return ok(found)
    _brand_picture(deps, req.user_id, found)
    view = campaigns.View(deps, req.user_id, now)
    return ok({"campaign": view.full(found)}, status)


def _brand_picture(deps: Any, user_id: str, item: Mapping[str, Any]) -> None:
    from ..contentrewards import logo

    org = ((item.get("public") or {}).get("organization") or {}) if isinstance(item.get("public"), Mapping) else {}
    if item.get("brandKey") or logo.brand_url(org.get("logoUrl")) is None or deps.invoker is None:
        return
    try:
        deps.invoker.brand_picture(user_id, str(item["campaignId"]))
    except Exception as e:  # a round letter shows instead
        log("warning", "cr.brand_invoke_failed", error=type(e).__name__)


def _campaign(app: App, req: Request) -> tuple[Any, dict[str, Any]]:
    from ..contentrewards import campaigns

    deps = _deps(app)
    return deps, campaigns.get_or_404(deps.store, req.user_id, req.params["campaignId"])


def get_campaign(app: App, req: Request) -> Response:
    from ..contentrewards import campaigns, config

    deps, item = _campaign(app, req)
    now = _now(app)
    before = item.get("publicAt")
    campaigns.refresh_public(deps, req.user_id, item, now, max_age=config.PUBLIC_STALE)
    if item.get("publicAt") != before:
        item = campaigns.save(deps, req.user_id, item)
    return ok({"campaign": campaigns.View(deps, req.user_id, now).full(item)})


def read_campaign(app: App, req: Request) -> Response:
    """Check now: membership and status now, the rules again when the brief or the pasted rules changed."""
    from ..contentrewards import campaigns, config, connection

    deps, item = _campaign(app, req)
    body = req.json()
    validate.only_keys(body, {"pastedRules"})
    pasted = body.get("pastedRules")
    if pasted is not None and (not isinstance(pasted, str) or len(pasted) > config.MAX_PASTED_RULES):
        raise bad_request("The rules can be at most 8,000 characters.", "pastedRules")
    now = _now(app)
    last = parse(item.get("lastManualAt"))
    view = campaigns.View(deps, req.user_id, now)
    changed_paste = isinstance(pasted, str) and pasted.strip() and pasted != item.get("pastedRules")
    if last is not None and now - last < config.CHECK_NOW_EVERY and not changed_paste:
        return ok({"campaign": view.full(item)})
    item["lastManualAt"] = iso(now)
    if isinstance(pasted, str) and pasted.strip():
        item["pastedRules"] = pasted
    campaigns.refresh_public(deps, req.user_id, item, now, max_age=timedelta(0))
    conn = connection.load(deps.store, req.user_id)
    campaigns.check_membership(deps, req.user_id, item, conn, now)
    if changed_paste or campaigns.retry_read(item, now):
        # New pasted rules always get their own read, even while one runs (that older read then can't write its
        # answer: its briefHash no longer matches); a failed or stuck read is tried again ("Tap Check now").
        campaigns.start_read(deps, req.user_id, item, now)
    item = campaigns.save(deps, req.user_id, item)
    return ok({"campaign": campaigns.View(deps, req.user_id, now).full(item)}, 202)


SAID = ("applied", "not_eligible", "joined_by_hand")


def patch_campaign(app: App, req: Request) -> Response:
    from ..contentrewards import campaigns, connection, gates

    deps, item = _campaign(app, req)
    body = req.json()
    validate.only_keys(body, {"said", "anyway"})
    if not body:
        raise bad_request("Send said or anyway.")
    now = _now(app)
    conn = connection.load(deps.store, req.user_id)
    if "said" in body:
        said = body["said"]
        if said is not None and said not in SAID:
            raise bad_request('said must be "applied", "not_eligible", "joined_by_hand" or null.', "said")
        apply_said(item, conn, said, now)
        if campaigns.needs_read(item):
            campaigns.start_read(deps, req.user_id, item, now)
    if "anyway" in body:
        codes = body["anyway"]
        soft = gates.SOFT - {"not_connected"}
        if not isinstance(codes, list) or not all(isinstance(c, str) and c in soft for c in codes):
            raise bad_request("anyway only takes soft stops.", "anyway")
        item["anyway"] = sorted(set(codes))
    item = campaigns.save(deps, req.user_id, item)
    return ok({"campaign": campaigns.View(deps, req.user_id, now).full(item)})


def apply_said(item: dict[str, Any], conn: Mapping[str, Any], said: str | None, now: datetime) -> None:
    from ..contentrewards import campaigns, connection

    before = item.get("membership")
    if said is None:
        item.pop("said", None)
        if before in ("manual", "not_accepted", "waiting"):
            if not connection.signed_in(conn):
                item["membership"] = "unknown"
            elif item.get("lastListedAt"):
                item["membership"] = "left"
            elif item.get("access") == "application":
                item["membership"] = "apply_first"
            else:
                item["membership"] = "not_joined"
    else:
        item["said"] = said
        if said == "not_eligible":
            item["membership"] = "not_accepted"
            item.pop("nextCheckAt", None)
        elif said == "joined_by_hand" and before != "in":
            item["membership"] = "manual"
            item["inSince"] = iso(now)
        elif said == "applied" and before in ("apply_first", "waiting"):
            item["membership"] = "waiting"
    if item.get("membership") in campaigns.WAITING and before not in campaigns.WAITING:
        item["waitingSince"] = iso(now)
    found = campaigns._next_check(item, now)
    if found:
        item["nextCheckAt"] = found


def delete_campaign(app: App, req: Request) -> Response:
    from ..contentrewards import logo

    deps, item = _campaign(app, req)
    uuid = str(item["campaignId"])
    deps.store.delete(item["pk"], item["sk"])
    if deps.media is not None:
        try:
            for name in logo.campaign_files(req.user_id, uuid, item):
                deps.media.delete(name)  # a missing file is fine: S3 answers 204
        except Exception as e:  # the item is gone; a stray picture is harmless
            log("warning", "cr.campaign_files_failed", error=type(e).__name__)
    log("info", "cr.campaign_removed")
    return no_content()


# --- the logo ------------------------------------------------------------------------------------------------------


def logo_upload(app: App, req: Request) -> Response:
    from ..contentrewards import config, logo

    deps, item = _campaign(app, req)
    body = req.json()
    validate.only_keys(body, {"filename", "contentType", "size"})
    validate.required_string(body, "filename", max_len=255)
    content_type = body.get("contentType")
    size = body.get("size")
    if content_type not in config.LOGO_TYPES:
        raise bad_request(logo.WRONG_TYPE, "contentType")
    if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
        raise bad_request("size must be the file's size in bytes.", "size")
    if size > config.LOGO_MAX_BYTES:
        raise too_large(logo.TOO_BIG)
    rev = int(item.get("logoRev") or 0) + 1
    key = logo.upload_key(req.user_id, str(item["campaignId"]), rev, config.LOGO_TYPES[str(content_type)])
    url = deps.media.presign_put_sized(key, str(content_type), size, 900)
    return ok({"uploadUrl": url, "headers": {"Content-Type": content_type}, "key": key})


def logo_done(app: App, req: Request) -> Response:
    import re

    from ..contentrewards import campaigns, config, logo

    deps, item = _campaign(app, req)
    body = req.json()
    validate.only_keys(body, {"key"})
    key = validate.required_string(body, "key", max_len=512)
    uuid = str(item["campaignId"])
    prefix = logo.campaign_prefix(req.user_id, uuid)
    found = re.fullmatch(re.escape(prefix) + r"logo-(\d{1,6})\.(png|jpg|webp)", key)
    if not found:
        raise bad_request("That upload does not belong to this campaign.", "key")
    head = deps.media.head(key)
    if head is None:
        raise bad_request("We could not find the picture. Choose the file again.", "key")
    if int(head.get("ContentLength") or 0) > config.LOGO_MAX_BYTES:
        deps.media.delete(key)
        raise too_large(logo.TOO_BIG)
    data = deps.media.read(key, config.LOGO_MAX_BYTES)
    kind = logo.kind_of(data[:16])
    if kind is None:
        deps.media.delete(key)
        raise bad_request(logo.WRONG_TYPE, "key")
    old = item.get("logoKey")
    current = dict(item.get("logo") or {})
    current.update({"state": "ready"})
    current.pop("error", None)
    item.update({"logo": current, "logoKey": key, "logoRev": max(int(found.group(1)), int(item.get("logoRev") or 0))})
    item = campaigns.save(deps, req.user_id, item)
    if isinstance(old, str) and old.startswith(prefix) and old != key:
        deps.media.delete(old)  # jobs hold their own copy (§38.5)
    return ok({"campaign": campaigns.View(deps, req.user_id, _now(app)).full(item)})


def logo_link(app: App, req: Request) -> Response:
    from ..contentrewards import campaigns, logo

    deps, item = _campaign(app, req)
    body = req.json()
    validate.only_keys(body, {"url"})
    url = validate.required_string(body, "url", max_len=2048)
    try:
        logo.download_url(url)
    except logo.LogoError as e:
        raise bad_request(e.sentence, "url") from e
    current = dict(item.get("logo") or {})
    current.update({"state": "fetching"})
    current.pop("error", None)
    item["logo"] = current
    item = campaigns.save(deps, req.user_id, item)
    try:
        if deps.invoker is None:
            raise RuntimeError("no invoker")
        deps.invoker.fetch_logo(req.user_id, str(item["campaignId"]), url)
    except Exception as e:
        log("warning", "cr.logo_invoke_failed", error=type(e).__name__)
        current["state"] = "failed"
        current["error"] = "Clip Factory couldn't get that file. Try again, or drop the file."
        item["logo"] = current
        item = campaigns.save(deps, req.user_id, item)
    return ok({"campaign": campaigns.View(deps, req.user_id, _now(app)).full(item)}, 202)


def logo_delete(app: App, req: Request) -> Response:
    from ..contentrewards import campaigns, logo

    deps, item = _campaign(app, req)
    old = item.pop("logoKey", None)
    item["logo"] = {"needed": bool((item.get("logo") or {}).get("needed")), "state": "none"}
    item = campaigns.save(deps, req.user_id, item)
    if isinstance(old, str) and old.startswith(logo.campaign_prefix(req.user_id, str(item["campaignId"]))):
        deps.media.delete(old)
    return ok({"campaign": campaigns.View(deps, req.user_id, _now(app)).full(item)})


# --- submissions -------------------------------------------------------------------------------------------------


def _campaign_of(post: Mapping[str, Any], clip: Mapping[str, Any] | None, job: Mapping[str, Any] | None) -> str | None:
    for found in (
        post.get("campaignId"),
        (clip or {}).get("campaignId"),
        ((job or {}).get("campaign") or {}).get("campaignId")
        if isinstance((job or {}).get("campaign"), Mapping)
        else None,
    ):
        if isinstance(found, str) and found:
            return found
    return None


def _clip_rows(
    deps: Any, user_id: str, clip_id: str
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, list[dict[str, Any]]]:
    clip = deps.store.get(db.user_pk(user_id), db.clip_sk(clip_id))
    if clip is None:
        return None, None, []
    job = deps.store.get(db.user_pk(user_id), db.job_sk(str(clip.get("jobId")))) if clip.get("jobId") else None
    rows = posts.posts_for_clip(deps.store, user_id, clip_id)
    return clip, job, rows


def _subs_for_clip(deps: Any, user_id: str, clip_id: str, now: datetime) -> list[dict[str, Any]]:
    from ..contentrewards import campaigns, submissions

    clip, job, rows = _clip_rows(deps, user_id, clip_id)
    if clip is None:
        raise not_found("We could not find that clip.")
    stored = submissions.for_clip(deps.store, user_id, [str(p["postId"]) for p in rows])
    out = []
    cache: dict[str, Any] = {}
    for post in rows:
        sub = stored.get(str(post["postId"]))
        campaign_id = (sub or {}).get("campaignId") or _campaign_of(post, clip, job)
        if not campaign_id:
            continue
        if campaign_id not in cache:
            cache[campaign_id] = campaigns.get(deps.store, user_id, str(campaign_id))
        shown = sub or submissions.made_up(post, str(campaign_id), now)
        out.append(
            submissions.public(
                shown,
                now=now,
                clip=clip,
                campaign=cache[campaign_id],
                post=post,
                job_campaign=(job or {}).get("campaign"),
            )
        )
    return out


def _subs_for_campaign(deps: Any, user_id: str, campaign_id: str, now: datetime) -> list[dict[str, Any]]:
    from ..contentrewards import campaigns, submissions

    campaign = campaigns.get(deps.store, user_id, campaign_id)
    pk = db.user_pk(user_id)
    subs = [s for s in deps.store.query_all(pk, db.CRSUB_PREFIX) if s.get("campaignId") == campaign_id]
    known = {str(s.get("postId")) for s in subs}
    extra = [
        p
        for p in deps.store.query_all(pk, "POST#")
        if p.get("campaignId") == campaign_id and str(p.get("postId")) not in known
    ]
    clips: dict[str, Any] = {}
    out = []
    for sub in subs + [submissions.made_up(p, campaign_id, now) for p in extra]:
        clip_id = str(sub.get("clipId") or "")
        if clip_id and clip_id not in clips:
            clips[clip_id] = deps.store.get(pk, db.clip_sk(clip_id))
        post = deps.store.get(pk, db.post_sk(str(sub.get("postId"))))
        out.append(submissions.public(sub, now=now, clip=clips.get(clip_id), campaign=campaign, post=post))
    out.sort(key=lambda s: str(s.get("postedAt") or s.get("updatedAt") or ""), reverse=True)
    return out


def list_submissions(app: App, req: Request) -> Response:
    deps = _deps(app)
    now = _now(app)
    clip_id, campaign_id = req.query.get("clipId"), req.query.get("campaignId")
    if clip_id:
        if not is_ulid(clip_id):
            raise not_found("We could not find that clip.")
        return ok({"submissions": _subs_for_clip(deps, req.user_id, clip_id, now)})
    if campaign_id:
        return ok({"submissions": _subs_for_campaign(deps, req.user_id, campaign_id.lower(), now)})
    raise bad_request("Send clipId or campaignId.")


def check_submissions(app: App, req: Request) -> Response:
    from ..contentrewards import poll, submissions

    deps = _deps(app)
    body = req.json()
    validate.only_keys(body, {"clipId"})
    clip_id = validate.required_string(body, "clipId", max_len=40)
    if not is_ulid(clip_id):
        raise not_found("We could not find that clip.")
    now = _now(app)
    _clip, _job, rows = _clip_rows(deps, req.user_id, clip_id)
    post_ids = [str(p["postId"]) for p in rows]
    stored = submissions.for_clip(deps.store, req.user_id, post_ids)
    recent = [parse(s.get("manualCheckAt")) for s in stored.values()]
    if not any(r is not None and now - r < timedelta(minutes=1) for r in recent) and stored:
        for sub in stored.values():
            deps.store.update(sub["pk"], sub["sk"], {"manualCheckAt": iso(now)})
        try:
            poll.check_clip(deps, req.user_id, list(stored), now)
        except Exception as e:  # the stored lines answer instead
            log("info", "cr.check_clip_failed", error=type(e).__name__)
    return ok({"submissions": _subs_for_clip(deps, req.user_id, clip_id, now)})


def _sub_or_404(deps: Any, user_id: str, post_id: str) -> dict[str, Any]:
    from ..contentrewards import submissions

    found = deps.store.get(*submissions.key(user_id, post_id)) if is_ulid(post_id) else None
    if found is None:
        raise not_found("We could not find that post.")
    return found  # type: ignore[no-any-return]


def _one_sub(deps: Any, user_id: str, sub: Mapping[str, Any], now: datetime) -> dict[str, Any]:
    from ..contentrewards import campaigns, submissions

    pk = db.user_pk(user_id)
    clip = deps.store.get(pk, db.clip_sk(str(sub.get("clipId")))) if sub.get("clipId") else None
    job = deps.store.get(pk, db.job_sk(str((clip or {}).get("jobId")))) if (clip or {}).get("jobId") else None
    post = deps.store.get(pk, db.post_sk(str(sub.get("postId"))))
    campaign = campaigns.get(deps.store, user_id, str(sub.get("campaignId") or ""))
    return submissions.public(
        sub, now=now, clip=clip, campaign=campaign, post=post, job_campaign=(job or {}).get("campaign")
    )


def send_submission(app: App, req: Request) -> Response:
    from ..contentrewards import config, submit

    deps = _deps(app)
    now = _now(app)
    sub = _sub_or_404(deps, req.user_id, req.params["postId"])
    by = parse(sub.get("sendBy"))
    if sub.get("state") not in ("send_by_hand",) or by is None or now >= by:
        if by is not None and now >= by:
            raise conflict("Too late for this one.")
        raise conflict("This clip is not waiting to be sent.")
    post = deps.store.get(db.user_pk(req.user_id), db.post_sk(str(sub["postId"]))) or {}
    if isinstance(post.get("url"), str) and post["url"] and post["url"] != sub.get("url"):
        sub = submit.resend_link(deps, req.user_id, sub, str(post["url"]))
    deps.store.update(sub["pk"], sub["sk"], {"state": "sending", "updatedAt": iso(now)}, remove=["reason"])
    submit.send(deps, req.user_id, str(sub["postId"]), str(sub["campaignId"]), timeout=config.SUBMIT_TIMEOUT_API)
    fresh = _sub_or_404(deps, req.user_id, str(sub["postId"]))
    if fresh.get("state") == "sending":  # a retry answer: the owner sends it himself now
        from ..contentrewards.submissions import reason_text

        reason = {"code": "not_sent_by_app", "text": reason_text("not_sent_by_app", str(fresh.get("platform")))}
        fresh = deps.store.update(fresh["pk"], fresh["sk"], {"state": "send_by_hand", "reason": reason})
    return ok({"submission": _one_sub(deps, req.user_id, fresh, now)})


def patch_submission(app: App, req: Request) -> Response:
    deps = _deps(app)
    now = _now(app)
    sub = _sub_or_404(deps, req.user_id, req.params["postId"])
    body = req.json()
    validate.only_keys(body, {"said"})
    if "said" not in body:
        raise bad_request("Send said.", "said")
    said = body["said"]
    state = sub.get("state")
    fields: dict[str, Any] = {"updatedAt": iso(now)}
    remove: list[str] = []
    if said == "sent_by_hand":
        if state not in ("send_by_hand", "missed"):
            raise conflict("This clip is not waiting to be sent.")
        fields.update({"state": "sent_by_hand", "undo": {"state": state, "at": iso(now)}, "nextCheckAt": iso(now)})
    elif said == "appealed":
        if state != "rejected":
            raise conflict("Only a clip that was not approved can be asked again.")
        fields.update(
            {"appealedAt": iso(now), "undo": {"field": "appealedAt", "at": iso(now)}, "nextCheckAt": iso(now)}
        )
    elif said == "proof_sent":
        proof = sub.get("proof") if isinstance(sub.get("proof"), Mapping) else None
        if proof is None or not proof.get("notifiedAt"):
            raise conflict("No proof is due for this clip.")
        fields.update({"proof": {**proof, "doneAt": iso(now)}, "undo": {"field": "proof", "at": iso(now)}})
    elif said is None:
        undo = sub.get("undo") if isinstance(sub.get("undo"), Mapping) else None
        at = parse((undo or {}).get("at"))
        if undo is None or at is None or now - at > timedelta(seconds=UNDO_SECONDS):
            raise conflict("That can't be undone any more.")
        if undo.get("state"):
            fields["state"] = undo["state"]
        elif undo.get("field") == "appealedAt":
            remove.append("appealedAt")
        elif undo.get("field") == "proof":
            proof = dict(sub.get("proof") or {})
            proof.pop("doneAt", None)
            fields["proof"] = proof
        remove.append("undo")
    else:
        raise bad_request('said must be "sent_by_hand", "appealed", "proof_sent" or null.', "said")
    updated = deps.store.update(sub["pk"], sub["sk"], fields, remove=remove)
    return ok({"submission": _one_sub(deps, req.user_id, updated, now)})


# --- money and celebrations --------------------------------------------------------------------------------------


def get_money(app: App, req: Request) -> Response:
    from ..contentrewards import money

    deps = _deps(app)
    return ok(money.public(deps, req.user_id, _now(app)))


def refresh_money(app: App, req: Request) -> Response:
    from ..contentrewards import config, connection, money

    deps = _deps(app)
    now = _now(app)
    item = money.load(deps.store, req.user_id)
    last = parse(item.get("lastManualAt"))
    if last is not None and now - last < config.MONEY_REFRESH_EVERY:
        return ok({"started": False, "nextAllowedAt": iso(last + config.MONEY_REFRESH_EVERY)})
    if not connection.signed_in(connection.load(deps.store, req.user_id)):
        raise conflict("Connect Content Rewards first.")
    deps.store.update_expr(
        db.user_pk(req.user_id),
        db.CRMONEY_SK,
        "SET #m = :now, #t = :type, #u = :user",
        names={"#m": "lastManualAt", "#t": "type", "#u": "userId"},
        values={":now": iso(now), ":type": "crmoney", ":user": req.user_id},
    )
    try:
        deps.invoker.cr_check(req.user_id, "money")
    except Exception as e:
        log("warning", "cr.money_invoke_failed", error=type(e).__name__)
        raise ApiError(503, "platform_down", "Content Rewards didn't answer. Try again in a minute.") from e
    return ok({"started": True, "nextAllowedAt": iso(now + config.MONEY_REFRESH_EVERY)}, 202)


def seen(app: App, req: Request) -> Response:
    from ..contentrewards import campaigns, links, money

    deps = _deps(app)
    body = req.json()
    validate.only_keys(body, {"key"})
    key = validate.required_string(body, "key", max_len=200)
    if key.startswith("in:"):
        uuid = key[3:]
        item = campaigns.get(deps.store, req.user_id, uuid) if links.UUID.match(uuid) else None
        if item is None or item.get("celebrate") != "in":
            raise not_found("Nothing to show.")
        deps.store.update(item["pk"], item["sk"], {"celebratedAt": iso(_now(app))}, remove=["celebrate"])
        return ok({"ok": True})
    if not money.seen(deps, req.user_id, key):
        raise not_found("Nothing to show.")
    return ok({"ok": True})
