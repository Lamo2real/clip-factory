"""/v1/tiktok/mac and /v1/clips/{clipId}/tiktok/mac/*: Your Mac posts it on TikTok (docs/CONTRACTS.md §47).

The owner's Mac helper signs in as the owner (the same JWT) and uses the helper routes; the app uses the owner's.

* Helper: ``GET /v1/tiktok/mac`` (on, the helper item, the queue), ``POST /v1/tiktok/mac/ping``, and per clip
  ``claim``, ``step``, ``done`` and ``stopped``.
* Owner: ``POST /v1/tiktok/mac/send`` (Send these to my Mac), ``POST …/tiktok/mac/retry`` (Try again) and
  ``DELETE …/tiktok/mac`` (Take it back, before Post it yourself instead).

Nothing here calls TikTok's API. The logic and every conditional write live in ``tiktok_mac.py``; the Mac's done goes
through ``tiktok_self.mark_posted``, the same write as I posted it (one TikTok post per clip).
"""

from __future__ import annotations

from typing import Any

from .. import db, posts, settings, tiktok_mac, tiktok_self, validate
from ..app import App
from ..errors import bad_request, conflict
from ..http import Request, Response, ok
from ..ids import is_ulid
from ..log import log
from ..stats import config as stats_config
from . import clips as clip_routes

DEVICE_MAX = 100
VERSION_MAX = 40


def _refused(e: tiktok_self.Refused) -> Exception:
    return conflict(e.message) if e.status == 409 else bad_request(e.message)


def _device(body: dict[str, Any]) -> str:
    return validate.required_string(body, "device", max_len=DEVICE_MAX)


def _attempt(body: dict[str, Any]) -> int | None:
    """The claim's ``attempt`` (``MacJob.attempt``), optional: when sent it must still be the post's (§47.3)."""
    if body.get("attempt") is None:
        return None
    number = validate.whole_number(body["attempt"])
    if number is None or number < 1:
        raise bad_request("attempt must be a whole number from 1.")
    return number


def _job(app: App, req: Request, row: dict[str, Any]) -> Response:
    clip = clip_routes._clip_or_404(app, req)
    return ok({"job": tiktok_mac.job(row, clip)})


def status(app: App, req: Request) -> Response:
    """``GET /v1/tiktok/mac`` → ``{on, helper, queue}``."""
    current = settings.load(app.store, req.user_id)
    return ok(
        {
            "on": tiktok_mac.is_on(current),
            "helper": tiktok_mac.public_helper(tiktok_mac.helper_item(app.store, req.user_id)),
            "queue": tiktok_mac.queue(app.store, req.user_id, current),
        }
    )


def ping(app: App, req: Request) -> Response:
    """``POST /v1/tiktok/mac/ping`` ``{state, reason?, version?, device}`` → ``{on}``."""
    body = req.json()
    validate.only_keys(body, {"state", "reason", "version", "device", "login", "loginDone"})
    state = body.get("state")
    if state not in tiktok_mac.HELPER_STATES:
        raise bad_request("state must be ok, needs_you or paused.")
    reason = body.get("reason")
    if reason is not None and not isinstance(reason, str):
        raise bad_request("reason must be text.")
    version = validate.string(body, "version", required=False, max_len=VERSION_MAX)
    device = _device(body)
    login = body.get("login")
    if login is not None and login not in tiktok_mac.LOGIN_STATES:
        raise bad_request("login must be saved or none.")
    login_done = validate.string(body, "loginDone", required=False, max_len=40)
    tiktok_mac.ping(
        app.store,
        req.user_id,
        state=state,
        device=device,
        reason=reason,
        version=version,
        now=app.clock(),
        login=login,
        login_done=login_done,
    )
    return ok({"on": tiktok_mac.is_on(settings.load(app.store, req.user_id))})


def login(app: App, req: Request) -> Response:
    """``POST /v1/tiktok/mac/login`` ``{action: "change" | "forget"}`` → ``{helper}`` (§47.8)."""
    body = req.json()
    validate.only_keys(body, {"action"})
    action = body.get("action")
    if action not in tiktok_mac.LOGIN_ACTIONS:
        raise bad_request("Pick change or forget.")
    try:
        item = tiktok_mac.login_request(app.store, req.user_id, str(action), app.clock())
    except tiktok_self.Refused as e:
        raise _refused(e) from None
    log("info", "tiktok_mac.login_request", action=action)
    return ok({"helper": tiktok_mac.public_helper(item)})


def send(app: App, req: Request) -> Response:
    """``POST /v1/tiktok/mac/send`` ``{clipIds}`` → ``{results}``: each clip once, in order (§47.2)."""
    body = req.json()
    validate.only_keys(body, {"clipIds"})
    ids = body.get("clipIds")
    if not isinstance(ids, list) or not ids or len(ids) > tiktok_mac.SEND_MAX:
        raise bad_request(f"clipIds must list 1 to {tiktok_mac.SEND_MAX} clips.")
    if not all(isinstance(i, str) for i in ids):
        raise bad_request("clipIds must hold clip ids.")
    current = settings.load(app.store, req.user_id)
    if not tiktok_mac.is_on(current):
        raise conflict(tiktok_mac.MAC_OFF)
    _cr_time(app, req)
    pk = db.user_pk(req.user_id)
    now = app.clock()
    results: list[dict[str, Any]] = []
    for clip_id in dict.fromkeys(ids):
        clip = app.store.get(pk, db.clip_sk(clip_id)) if is_ulid(clip_id) else None
        is_campaign = False
        if clip is not None:
            rows = posts.posts_for_clip(app.store, req.user_id, clip_id, consistent=True)
            is_campaign = clip_routes.campaign_clip(app, req.user_id, clip, rows) is not None
        reason = tiktok_mac.send(app.store, req.user_id, clip, current, now, is_campaign=is_campaign)
        results.append({"clipId": clip_id, "sent": reason is None, **({"reason": reason} if reason else {})})
    log("info", "tiktok_mac.sent", sent=sum(1 for r in results if r["sent"]), asked=len(results))
    return ok({"results": results})


def _cr_time(app: App, req: Request) -> None:
    deps = getattr(app, "contentrewards", None)
    if deps is not None:
        deps.for_request(req.started)


def claim(app: App, req: Request) -> Response:
    """``POST /v1/clips/{clipId}/tiktok/mac/claim`` ``{device}`` → ``{job}`` (409 when another try has it)."""
    body = req.json()
    validate.only_keys(body, {"device"})
    device = _device(body)
    item = clip_routes._clip_or_404(app, req)
    try:
        row = tiktok_mac.claim(app.store, item, device, app.clock(), settings.load(app.store, req.user_id))
    except tiktok_self.Refused as e:
        raise _refused(e) from e
    log("info", "tiktok_mac.claimed", clipId=item["clipId"], attempt=row.get("macAttempt"))
    return _job(app, req, row)


def step(app: App, req: Request) -> Response:
    """``POST /v1/clips/{clipId}/tiktok/mac/step`` ``{device, step}`` → ``{job}``."""
    body = req.json()
    validate.only_keys(body, {"device", "step", "attempt"})
    device = _device(body)
    attempt = _attempt(body)
    name = body.get("step")
    if name not in tiktok_mac.STEPS:
        raise bad_request("step must be video, opening, uploading, settings, pressing or finding.")
    item = clip_routes._clip_or_404(app, req)
    try:
        row = tiktok_mac.step(
            app.store, item, device, name, app.clock(), settings=settings.load(app.store, req.user_id), attempt=attempt
        )
    except tiktok_self.Refused as e:
        raise _refused(e) from e
    if name == "pressing":
        log("info", "tiktok_mac.pressing", clipId=item["clipId"])
    return _job(app, req, row)


def stopped(app: App, req: Request) -> Response:
    """``POST /v1/clips/{clipId}/tiktok/mac/stopped`` ``{device, reason, needsYou?}`` → ``{job}``."""
    body = req.json()
    validate.only_keys(body, {"device", "reason", "needsYou", "attempt"})
    device = _device(body)
    attempt = _attempt(body)
    reason = validate.required_string(body, "reason", max_len=10_000)
    needs_you = validate.boolean(body.get("needsYou", False), "needsYou")
    item = clip_routes._clip_or_404(app, req)
    try:
        row = tiktok_mac.stopped(app.store, item, device, reason, app.clock(), needs_you=needs_you, attempt=attempt)
    except tiktok_self.Refused as e:
        raise _refused(e) from e
    log("info", "tiktok_mac.stopped", clipId=item["clipId"], pressed=bool(row.get("macPressedAt")))
    return _job(app, req, row)


def done(app: App, req: Request) -> Response:
    """``POST /v1/clips/{clipId}/tiktok/mac/done`` ``{device, link?}`` → ``{clip, posts, note?}``: the Mac posted it.
    Through ``tiktok_self.mark_posted`` (one TikTok post per clip). The link is read as I posted it reads one; without
    one, the §42 finder looks from a minute before the claim. A repeat is answered as the first (adding the link)."""
    body = req.json()
    validate.only_keys(body, {"device", "link", "attempt"})
    device = _device(body)
    attempt = _attempt(body)
    link = body.get("link")
    if link is not None and not isinstance(link, str):
        raise bad_request("Paste the TikTok link as text.")
    item = clip_routes._clip_or_404(app, req)
    rows = posts.posts_for_clip(app.store, req.user_id, item["clipId"], consistent=True)
    row = tiktok_self.tiktok_row(rows) or {}
    try:
        tiktok_mac.check_done(row, device, attempt)  # before the finder asks TikTok anything
    except tiktok_self.Refused as e:
        raise _refused(e) from e
    since = tiktok_mac.since_for_finder(row)
    video, count_views, note = clip_routes.tiktok_video(app, req.user_id, item, link, since)
    if row.get("status") == posts.MAC_STATUS and tiktok_self.mac_privacy(row) != "public":
        count_views = False  # a private post never joins the poller (§16.3)
    done_by = tiktok_self.MacDone(device, attempt)
    minutes = stats_config.load().platform("tiktok").min_interval
    try:
        try:
            tiktok_self.mark_posted(
                app.store, item, video, app.clock(), min_interval=minutes, count_views=count_views, mac=done_by
            )
        except db.ConditionFailed:
            fresh = clip_routes._clip_or_404(app, req)  # the clip just changed (a flow settled it): once more
            tiktok_self.mark_posted(
                app.store, fresh, video, app.clock(), min_interval=minutes, count_views=count_views, mac=done_by
            )
    except tiktok_self.Refused as e:
        raise _refused(e) from e
    except db.ConditionFailed as e:
        raise conflict(tiktok_mac.CHANGED) from e
    log("info", "tiktok_mac.done", clipId=item["clipId"], link=video is not None, views=count_views)
    return clip_routes._with_posts(app, req, note=note)


def retry(app: App, req: Request) -> Response:
    """``POST /v1/clips/{clipId}/tiktok/mac/retry`` ``{notOnTikTok?}`` → ``{clip, posts}``: the owner's Try again."""
    body = req.json()
    validate.only_keys(body, {"notOnTikTok"})
    not_on_tiktok = validate.boolean(body.get("notOnTikTok", False), "notOnTikTok")
    item = clip_routes._clip_or_404(app, req)
    try:
        tiktok_mac.retry(app.store, item, not_on_tiktok=not_on_tiktok)
    except tiktok_self.Refused as e:
        raise _refused(e) from e
    log("info", "tiktok_mac.retry", clipId=item["clipId"], notOnTikTok=not_on_tiktok)
    return clip_routes._with_posts(app, req)


def take_back(app: App, req: Request) -> Response:
    """``DELETE /v1/clips/{clipId}/tiktok/mac`` → ``{clip, posts}``: Take it back (then Post it yourself instead)."""
    item = clip_routes._clip_or_404(app, req)
    try:
        tiktok_mac.take_back(app.store, item)
    except tiktok_self.Refused as e:
        raise _refused(e) from e
    log("info", "tiktok_mac.taken_back", clipId=item["clipId"])
    return clip_routes._with_posts(app, req)
