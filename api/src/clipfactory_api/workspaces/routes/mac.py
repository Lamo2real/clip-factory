"""My Mac posts TikTok for Clips Funded (docs/CONTRACTS.md §47.10): the helper's and the owner's routes. Served only by
Clips Funded's own Lambda (``workspaces/http.py``), under the existing ``ANY /v1/workspaces/{proxy+}`` route.

* Helper: ``GET …/tiktok/mac`` (``?version=``: the queue is empty for a helper older than ``MAC_WS_FROM``),
  ``POST …/tiktok/mac/ping``, and per job ``…/publishing/{id}/mac/claim``, ``step`` (a re-sent step is the job's
  beat), ``done`` and ``stopped``. It downloads the video with the existing ``…/stories/{storyId}/download``.
* Owner: ``POST …/tiktok/mac/login`` (Log in on my Mac), ``POST …/tiktok/mac/request`` (Start my Mac again),
  ``…/publishing/{id}/mac/retry`` (Try again) and ``…/publishing/{id}/mac/posted`` (It's on TikTok).

Every route is **S** (a ``stories`` workspace; Clip Factory's id is a 409) and builds every key from the JWT's
``sub`` and the path's workspace id; unknown body keys are a 400, another owner's job a 404. Nothing here calls TikTok
or touches Clip Factory's ``USER#{u}`` items. The logic and every conditional write live in ``workspaces/mac.py``.
"""

from __future__ import annotations

import re
from typing import Any

from ... import validate
from ...app import App
from ...errors import bad_request
from ...http import Request, Response, ok, route
from ...workspaces import deps as ws_deps
from ...workspaces import guard, publish, social
from ...workspaces import mac as ws_mac
from ...workspaces import secrets as ws_secrets

WS = "/v1/workspaces/{ws}"
JOB = WS + "/publishing/{publishingJobId}/mac"
DEVICE_MAX = 100
VERSION_MAX = 20
STAMP_MAX = 40
CONFIRM_MAX = 200
HANDLE = re.compile(r"^@[A-Za-z0-9._]{1,30}$")


def _workspace(app: App, req: Request) -> dict[str, Any]:
    return guard.require_workspace(app.store, req.user_id, req.params["ws"], stories=True, now=app.clock())


def _scope(app: App, req: Request, workspace: dict[str, Any]) -> social.Scope:
    """The checked workspace with its secrets (the claim and Try again check the destination)."""
    found = ws_deps.of(app)
    if found.secrets is None:
        found.secrets = ws_secrets.from_env()
    return social.Scope(app.store, social.secrets_or_503(found.secrets), req.user_id, str(workspace["workspaceId"]))


def _device(body: dict[str, Any]) -> str:
    return validate.required_string(body, "device", max_len=DEVICE_MAX)


def _attempt(body: dict[str, Any]) -> int | None:
    """The claim's ``attempt`` (``WsMacJob.attempt``), optional: when sent it must still be the job's."""
    if body.get("attempt") is None:
        return None
    number = validate.whole_number(body["attempt"])
    if number is None or number < 1:
        raise bad_request("attempt must be a whole number from 1.")
    return number


def _job_id(req: Request) -> str:
    return str(req.params["publishingJobId"])


# --- the helper's routes ----------------------------------------------------------------------------------------


def status(app: App, req: Request) -> Response:
    """``GET …/tiktok/mac`` → ``WsMacStatus`` ``{on, helper, account, queue}``."""
    workspace = _workspace(app, req)
    return ok(ws_mac.status(app.store, req.user_id, workspace, req.query.get("version")))


def ping(app: App, req: Request) -> Response:
    """``POST …/tiktok/mac/ping`` ``{state, reason?, version, device, setUp, handle?, loginDone?, resumeDone?}`` →
    ``{on}``."""
    workspace = _workspace(app, req)
    body = req.json()
    validate.only_keys(body, {"state", "reason", "version", "device", "setUp", "handle", "loginDone", "resumeDone"})
    state = body.get("state")
    if state not in ws_mac.HELPER_STATES:
        raise bad_request("state must be ok, needs_you or paused.")
    reason = body.get("reason")
    if reason is not None and not isinstance(reason, str):
        raise bad_request("reason must be text.")
    version = validate.required_string(body, "version", max_len=VERSION_MAX)
    device = _device(body)
    set_up = validate.boolean(body.get("setUp"), "setUp")
    handle = body.get("handle")
    if handle is not None and (not isinstance(handle, str) or not HANDLE.match(handle)):
        raise bad_request("handle must be a TikTok @name.", "handle")
    login_done = validate.string(body, "loginDone", required=False, max_len=STAMP_MAX)
    resume_done = validate.string(body, "resumeDone", required=False, max_len=STAMP_MAX)
    workspace_id = str(workspace["workspaceId"])
    ws_mac.ping(
        app.store,
        req.user_id,
        workspace_id,
        state=str(state),
        reason=reason,
        version=version,
        device=device,
        set_up=set_up,
        handle=handle,
        login_done=login_done,
        now=app.clock(),
        resume_done=resume_done,
    )
    return ok({"on": ws_mac.is_on(workspace)})


def claim(app: App, req: Request) -> Response:
    """``POST …/publishing/{id}/mac/claim`` ``{device, version}`` → ``{job: WsMacJob}``."""
    workspace = _workspace(app, req)
    body = req.json()
    validate.only_keys(body, {"device", "version"})
    device = _device(body)
    version = validate.required_string(body, "version", max_len=VERSION_MAX)
    scope = _scope(app, req, workspace)
    found = ws_mac.claim(scope, workspace, _job_id(req), device=device, version=version, now=app.clock())
    return ok({"job": found})


def step(app: App, req: Request) -> Response:
    """``POST …/publishing/{id}/mac/step`` ``{device, step, attempt?}`` → ``{job: WsMacJob}`` (a re-sent step is
    the job's beat)."""
    workspace = _workspace(app, req)
    body = req.json()
    validate.only_keys(body, {"device", "step", "attempt"})
    device = _device(body)
    attempt = _attempt(body)
    name = body.get("step")
    if name not in ws_mac.STEPS:
        raise bad_request("step must be video, opening, uploading, settings, pressing or finding.")
    found = ws_mac.step(
        app.store, req.user_id, workspace, _job_id(req), device=device, name=str(name), attempt=attempt, now=app.clock()
    )
    return ok({"job": found})


def stopped(app: App, req: Request) -> Response:
    """``POST …/publishing/{id}/mac/stopped`` ``{device, reason, needsYou?, attempt?}`` → ``{job: WsMacJob}``."""
    workspace = _workspace(app, req)
    body = req.json()
    validate.only_keys(body, {"device", "reason", "needsYou", "attempt"})
    device = _device(body)
    attempt = _attempt(body)
    reason = validate.required_string(body, "reason", max_len=10_000)
    needs_you = validate.boolean(body.get("needsYou", False), "needsYou")
    found = ws_mac.stopped(
        app.store,
        req.user_id,
        str(workspace["workspaceId"]),
        _job_id(req),
        device=device,
        reason=reason,
        needs_you=needs_you,
        attempt=attempt,
        now=app.clock(),
    )
    return ok({"job": found})


def done(app: App, req: Request) -> Response:
    """``POST …/publishing/{id}/mac/done`` ``{device, link, attempt?}`` → ``{job: PublishingJob}``."""
    workspace = _workspace(app, req)
    body = req.json()
    validate.only_keys(body, {"device", "link", "attempt"})
    device = _device(body)
    attempt = _attempt(body)
    link = validate.required_string(body, "link", max_len=2000)
    found = ws_mac.done(
        app.store,
        req.user_id,
        str(workspace["workspaceId"]),
        _job_id(req),
        device=device,
        link=link,
        attempt=attempt,
        now=app.clock(),
    )
    return ok({"job": publish.public_job(found)})


# --- the owner's routes -------------------------------------------------------------------------------------------


def login(app: App, req: Request) -> Response:
    """``POST …/tiktok/mac/login`` ``{action: "sign_in"}`` → ``{helper: WsMacHelper}``: Log in on my Mac."""
    workspace = _workspace(app, req)
    body = req.json()
    validate.only_keys(body, {"action"})
    if body.get("action") != "sign_in":
        raise bad_request(ws_mac.PICK_SIGN_IN)
    item = ws_mac.login_request(app.store, req.user_id, str(workspace["workspaceId"]), app.clock())
    return ok({"helper": ws_mac.public_helper(item)})


def request(app: App, req: Request) -> Response:
    """``POST …/tiktok/mac/request`` ``{action: "resume"}`` → ``{helper: WsMacHelper}``: Start my Mac again."""
    workspace = _workspace(app, req)
    body = req.json()
    validate.only_keys(body, {"action"})
    if body.get("action") != "resume":
        raise bad_request(ws_mac.PICK_RESUME)
    item = ws_mac.resume_request(app.store, req.user_id, str(workspace["workspaceId"]), app.clock())
    return ok({"helper": ws_mac.public_helper(item)})


def retry(app: App, req: Request) -> Response:
    """``POST …/publishing/{id}/mac/retry`` ``{notOnTikTok?, confirmAccount?}`` → ``{job: PublishingJob}``."""
    workspace = _workspace(app, req)
    body = req.json()
    validate.only_keys(body, {"notOnTikTok", "confirmAccount"})
    not_on_tiktok = validate.boolean(body.get("notOnTikTok", False), "notOnTikTok")
    confirm = body.get("confirmAccount")
    if confirm is not None and (not isinstance(confirm, str) or not confirm or len(confirm) > CONFIRM_MAX):
        raise bad_request("confirmAccount must be the account the app showed.", "confirmAccount")
    scope = _scope(app, req, workspace)
    found = ws_mac.retry(scope, _job_id(req), not_on_tiktok=not_on_tiktok, confirm=confirm, now=app.clock())
    return ok({"job": publish.public_job(found)})


def posted(app: App, req: Request) -> Response:
    """``POST …/publishing/{id}/mac/posted`` ``{link}`` or ``{noLink: true}`` → ``{job: PublishingJob}``: It's on
    TikTok."""
    workspace = _workspace(app, req)
    body = req.json()
    validate.only_keys(body, {"link", "noLink"})
    no_link = validate.boolean(body.get("noLink", False), "noLink")
    link = validate.string(body, "link", required=False, max_len=2000)
    if no_link == (link is not None):
        raise bad_request("Paste the TikTok link, or say there is none.", "link")
    found = ws_mac.posted(
        app.store, req.user_id, str(workspace["workspaceId"]), _job_id(req), link=link, now=app.clock()
    )
    return ok({"job": publish.public_job(found)})


ROUTES = [
    route("GET", f"{WS}/tiktok/mac", status),
    route("POST", f"{WS}/tiktok/mac/ping", ping),
    route("POST", f"{WS}/tiktok/mac/login", login),
    route("POST", f"{WS}/tiktok/mac/request", request),
    route("POST", f"{JOB}/claim", claim),
    route("POST", f"{JOB}/step", step),
    route("POST", f"{JOB}/done", done),
    route("POST", f"{JOB}/stopped", stopped),
    route("POST", f"{JOB}/retry", retry),
    route("POST", f"{JOB}/posted", posted),
]
