"""/v1/tiktok/mac and /v1/clips/{clipId}/tiktok/mac/*: Your Mac posts it on TikTok (docs/CONTRACTS.md §47).

The owner's Mac helper signs in as the owner (the same JWT) and uses the helper routes; the app uses the owner's.

* Helper: ``GET /v1/tiktok/mac`` (on, the helper item, the queue), ``POST /v1/tiktok/mac/ping``, and per clip
  ``claim``, ``step`` (a re-sent step is the job's beat), ``done``, ``stopped`` (``code: "login"``: a TikTok login
  problem, §47.11) and ``logged-in`` (the Mac is logged in to the right TikTok again: its login hold on that clip ends,
  §47.11; the web never calls it).
* Owner: ``POST /v1/tiktok/mac/send`` (Send these to my Mac, or with ``now: true`` a row's Post with my Mac),
  ``POST /v1/tiktok/mac/login`` (Change or Forget TikTok login), ``POST /v1/tiktok/mac/request`` (Start my Mac
  again, Let them go), ``POST …/tiktok/mac/retry`` (Try again; ``now: true`` from a row) and ``DELETE …/tiktok/mac``
  (Take it back, kept for older apps). ``now`` is an optional, additive body key: the Mac posts that clip at once, as
  an Upload tap (``macSource: "upload"``); without it every call is answered exactly as before.

Nothing here calls TikTok's API. The logic and every conditional write live in ``tiktok_mac.py``; the Mac's done goes
through ``tiktok_self.mark_posted``, the same write as the owner's It's on TikTok (one TikTok post per clip).
"""

from __future__ import annotations

from typing import Any

from .. import db, posts, settings, tiktok_mac, tiktok_self, validate
from ..app import App
from ..clock import parse
from ..errors import bad_request, conflict
from ..http import Request, Response, ok
from ..ids import is_ulid
from ..log import log
from ..stats import config as stats_config
from . import clips as clip_routes

DEVICE_MAX = 100
VERSION_MAX = 40
STAMP_MAX = 40  # an ISO time the helper sends back (``loginDone``, ``resumeDone``, ``letGoDone``, ``backlogAt``)


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


def _time(body: dict[str, Any], key: str) -> str | None:
    """An optional time from the helper's plan: text of at most 40 characters that ``clock.parse`` reads."""
    raw = body.get(key)
    if raw is None:
        return None
    if not isinstance(raw, str) or len(raw) > STAMP_MAX or parse(raw) is None:
        raise bad_request(f"{key} must be a time.")
    return raw


def ping(app: App, req: Request) -> Response:
    """``POST /v1/tiktok/mac/ping`` ``{state, reason?, version?, device, login?, loginDone?, backlogAt?, holdBefore?,
    backfill?, resumeDone?, letGoDone?}`` → ``{on}``. A plan key left out removes what the last ping said."""
    body = req.json()
    validate.only_keys(
        body,
        {
            "state",
            "reason",
            "version",
            "device",
            "login",
            "loginDone",
            "backlogAt",
            "holdBefore",
            "backfill",
            "resumeDone",
            "letGoDone",
        },
    )
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
    login_done = validate.string(body, "loginDone", required=False, max_len=STAMP_MAX)
    backlog_at = _time(body, "backlogAt")
    hold_before = _time(body, "holdBefore")
    backfill = validate.boolean(body.get("backfill", False), "backfill")
    resume_done = validate.string(body, "resumeDone", required=False, max_len=STAMP_MAX)
    let_go_done = validate.string(body, "letGoDone", required=False, max_len=STAMP_MAX)
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
        backlog_at=backlog_at,
        hold_before=hold_before,
        backfill=backfill,
        resume_done=resume_done,
        let_go_done=let_go_done,
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


def request(app: App, req: Request) -> Response:
    """``POST /v1/tiktok/mac/request`` ``{action: "resume" | "let_go"}`` → ``{helper}`` (§47.3): Start my Mac again
    (only while it is paused) or Let them go (only while it holds auto-posting clips); the helper does it on its next
    tick."""
    body = req.json()
    validate.only_keys(body, {"action"})
    action = body.get("action")
    if action not in tiktok_mac.REQUESTS:
        raise bad_request(tiktok_mac.PICK_REQUEST)
    try:
        item = tiktok_mac.request(app.store, req.user_id, str(action), app.clock())
    except tiktok_self.Refused as e:
        raise _refused(e) from None
    log("info", "tiktok_mac.request", action=action)
    return ok({"helper": tiktok_mac.public_helper(item)})


def send(app: App, req: Request) -> Response:
    """``POST /v1/tiktok/mac/send`` ``{clipIds, now?}`` → ``{results}``: each clip once, in order (§47.2).

    Without ``now`` (Settings' Send these to my Mac) a clip waits as the backlog (``macSource: "sent"``): one after
    each auto-posting run. With ``now: true`` (a row's Post with my Mac) it goes at once and first, as an Upload tap
    (``"upload"``), and so does a Mac post that already waits (``sent`` or ``auto``: it becomes ``upload`` in place
    and counts as sent). A campaign clip never goes (``SEND_CAMPAIGN``). Every other refusal is the same either
    way."""
    body = req.json()
    validate.only_keys(body, {"clipIds", "now"})
    ids = body.get("clipIds")
    if not isinstance(ids, list) or not ids or len(ids) > tiktok_mac.SEND_MAX:
        raise bad_request(f"clipIds must list 1 to {tiktok_mac.SEND_MAX} clips.")
    if not all(isinstance(i, str) for i in ids):
        raise bad_request("clipIds must hold clip ids.")
    now_tap = validate.boolean(body.get("now", False), "now")
    source = "upload" if now_tap else "sent"
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
        reason = tiktok_mac.send(app.store, req.user_id, clip, current, now, is_campaign=is_campaign, source=source)
        results.append({"clipId": clip_id, "sent": reason is None, **({"reason": reason} if reason else {})})
    log("info", "tiktok_mac.sent", sent=sum(1 for r in results if r["sent"]), asked=len(results), source=source)
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
    """``POST /v1/clips/{clipId}/tiktok/mac/step`` ``{device, step, attempt?}`` → ``{job}``. The same step sent again
    is the job's beat (``macBeatAt``)."""
    body = req.json()
    validate.only_keys(body, {"device", "step", "attempt"})
    device = _device(body)
    attempt = _attempt(body)
    name = body.get("step")
    if name not in tiktok_mac.STEPS:
        raise bad_request("step must be video, opening, uploading, settings, pressing or finding.")
    item = clip_routes._clip_or_404(app, req)
    try:
        row, pressed = tiktok_mac.step(
            app.store, item, device, name, app.clock(), settings=settings.load(app.store, req.user_id), attempt=attempt
        )
    except tiktok_self.Refused as e:
        raise _refused(e) from e
    if pressed:
        log("info", "tiktok_mac.pressing", clipId=item["clipId"])
    return _job(app, req, row)


def _code(body: dict[str, Any]) -> str | None:
    """The stop's optional ``code`` (§47.11): only ``login``."""
    code = body.get("code")
    if code is not None and code not in tiktok_mac.HOLD_CODES:
        raise bad_request(tiktok_mac.BAD_CODE)
    return code


def stopped(app: App, req: Request) -> Response:
    """``POST /v1/clips/{clipId}/tiktok/mac/stopped`` ``{device, reason, needsYou?, attempt?, code?}`` → ``{job}``."""
    body = req.json()
    validate.only_keys(body, {"device", "reason", "needsYou", "attempt", "code"})
    device = _device(body)
    attempt = _attempt(body)
    reason = validate.required_string(body, "reason", max_len=10_000)
    needs_you = validate.boolean(body.get("needsYou", False), "needsYou")
    code = _code(body)
    item = clip_routes._clip_or_404(app, req)
    try:
        row = tiktok_mac.stopped(
            app.store, item, device, reason, app.clock(), needs_you=needs_you, attempt=attempt, code=code
        )
    except tiktok_self.Refused as e:
        raise _refused(e) from e
    log("info", "tiktok_mac.stopped", clipId=item["clipId"], pressed=bool(row.get("macPressedAt")), code=code)
    return _job(app, req, row)


def logged_in(app: App, req: Request) -> Response:
    """``POST /v1/clips/{clipId}/tiktok/mac/logged-in`` ``{device}`` → ``{helper, outcome}`` (§47.11): the helper's
    Chrome is logged in to Clip Factory's TikTok again, so its login hold on this clip ends. ``outcome`` is
    ``resumed`` (the stopped clip waits for the Mac again), ``pressed`` (Post was pressed: the clip stays for the owner)
    or ``cleared`` (only the hold ended). No 404 for a clip that is gone: its hold still ends. 409 unless this device's
    hold is a login hold on this clip, or when it changed meanwhile."""
    body = req.json()
    validate.only_keys(body, {"device"})
    device = _device(body)
    clip_id = str(req.params["clipId"])
    try:
        item, outcome = tiktok_mac.logged_in(app.store, req.user_id, clip_id, device)
    except tiktok_self.Refused as e:
        raise _refused(e) from e
    log("info", "tiktok_mac.logged_in", clipId=clip_id, outcome=outcome)
    return ok({"helper": tiktok_mac.public_helper(item), "outcome": outcome})


def done(app: App, req: Request) -> Response:
    """``POST /v1/clips/{clipId}/tiktok/mac/done`` ``{device, link?}`` → ``{clip, posts, note?}``: the Mac posted it.
    Through ``tiktok_self.mark_posted`` (one TikTok post per clip). The link is read as the owner's It's on TikTok
    reads one; without one, the §42 finder looks from a minute before the claim, and it is saved without its link when
    nothing is found (``NOT_FOUND_YET``: the Mac knows it posted). A repeat is answered as the first (adding the
    link)."""
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
    """``POST /v1/clips/{clipId}/tiktok/mac/retry`` ``{notOnTikTok?, now?}`` → ``{clip, posts}``: the owner's Try
    again. With ``now: true`` the stopped post, or one that already waits, goes at once, as an Upload tap
    (``macSource: "upload"``). A stuck post (``tiktok_self.mac_stuck``: no beat for 5 minutes, or claimed 50 minutes
    ago) is taken back from that claim the same way, so the Mac claims it afresh. After Post was pressed only with
    ``notOnTikTok`` and once the find window is over (``MAC_STILL_LOOKING``)."""
    body = req.json()
    validate.only_keys(body, {"notOnTikTok", "now"})
    not_on_tiktok = validate.boolean(body.get("notOnTikTok", False), "notOnTikTok")
    now_tap = validate.boolean(body.get("now", False), "now")
    item = clip_routes._clip_or_404(app, req)
    try:
        tiktok_mac.retry(app.store, item, not_on_tiktok=not_on_tiktok, at=app.clock(), now=now_tap)
    except tiktok_self.Refused as e:
        raise _refused(e) from e
    log("info", "tiktok_mac.retry", clipId=item["clipId"], notOnTikTok=not_on_tiktok, now=now_tap)
    return clip_routes._with_posts(app, req)


def take_back(app: App, req: Request) -> Response:
    """``DELETE /v1/clips/{clipId}/tiktok/mac`` → ``{clip, posts}``: Take it back (kept; the web no longer calls it)."""
    item = clip_routes._clip_or_404(app, req)
    try:
        tiktok_mac.take_back(app.store, item)
    except tiktok_self.Refused as e:
        raise _refused(e) from e
    log("info", "tiktok_mac.taken_back", clipId=item["clipId"])
    return clip_routes._with_posts(app, req)
