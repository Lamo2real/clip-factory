"""Publishing jobs: one approved story to the workspace's own accounts (docs/CONTRACTS.md §45.14, ADR-73).

* ``POST …/stories/{storyId}/publish`` checks every target with ``validate_destination`` first, then writes one
  ``PUBJOB#`` per target with the identity at the moment of the tap (``externalAccountId``), raises ``run`` on the
  story in the same transaction, and starts ``cf-prod-story-flow`` once (``story-{storyId}-{run}``).
* Options are flat and allow-listed per platform (the keys the publishers read, §17.6, §17.8): ``campaign`` and any
  unknown key are refused, ``madeForKids`` is never accepted (Lamo Stories posts are never "made for kids"), YouTube's
  ``category`` and ``privacy`` default to the workspace's ``StoriesConfig``. TikTok has no defaults at all: its
  privacy and all five switches (comments, Duet, Stitch and the two brand ones) are the owner's own picks.
* There is no default account: a target names its account, every platform at most once. The answer names each
  target's current account (``accountName``, ``handle``, ``externalAccountId``: the identity it goes to), so the web
  shows exactly where it went; a target may carry ``confirmAccount`` (the ``externalAccountId`` the owner saw on the
  sheet), and when the account changed since, nothing is written and the ``409`` names the new account. With Lamo
  Stories' own TikTok app, Lamo Stories cannot tell its TikTok from Lamo Clips' (TikTok gives each app its own id):
  while Lamo Clips has a TikTok, the first post there answers ``409`` naming the account until the owner confirms it
  (``confirmAccount``), and that "yes" is stored with the jobs (``notClipsConfirmed``, §45.13.4).
* A story whose production used a realistic generator (``nova-reel``, in any of its jobs' ``meta.providers``) is
  posted only through Lamo Stories' own thin publisher wrappers that set the platforms' AI labels (YouTube's
  ``containsSyntheticMedia``, TikTok's ``is_aigc``; the shared publishers unchanged); Instagram, Facebook and X, where
  no label can be set through their APIs, refuse it with a plain sentence.
* Retry raises ``run`` again, re-runs the check and, when the account's identity changed, answers ``409`` naming
  the new account until the owner confirms it (``confirmAccount``); only then is the new identity recorded. Like
  publish, it refuses while another job of the story is being posted to that platform or is already posted there.
* A job still ``queued`` or ``publishing`` ``STUCK_AFTER`` its last write lost its story flow (a crash, a timeout,
  a start that never ran): every read of the jobs (the list, publish, retry) fails it with a plain sentence
  (``settle_stuck``, conditional on what was read), so Try again works. The raised ``run`` fences the old flow.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta
from typing import Any, Final

from .. import db, validate
from ..clock import iso, parse
from ..errors import ApiError, bad_request, conflict, not_found
from ..ids import ulid
from ..log import log
from ..platforms.base import PublishError, PublishJob
from ..platforms.publishers import TikTokPublisher, YouTubePublisher, publisher_for
from . import guard
from . import types as ws
from .destinations import (
    Destination,
    DestinationProblem,
    confirm_not_clips_update,
    story_sk,
    validate_destination,
)
from .secrets import WorkspaceSecrets
from .sentences import label, story_sentence, this_account
from .social import Scope

Item = dict[str, Any]

STATUSES: Final = ("queued", "publishing", "posted", "failed", "needs_attention")
RETRYABLE: Final = ("failed", "needs_attention")
IN_FLIGHT: Final = ("queued", "publishing")
MAX_TARGETS: Final = 5
# Far longer than one live publish chain (its longest upload, processing and finish steps with every retry), so
# only a flow that is gone leaves a job in flight this long.
STUCK_AFTER: Final = timedelta(hours=6)
YOUTUBE_CATEGORIES: Final = ("1", "2", "23", "24", "27")
YOUTUBE_PRIVACY: Final = ("public", "unlisted", "private")
TIKTOK_PRIVACY: Final = re.compile(r"^[A-Z_]{1,40}$")
TIKTOK_BRANDED_PRIVACY: Final = ("PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS")
TIKTOK_SWITCHES: Final = ("disableComment", "disableDuet", "disableStitch", "brandContent", "brandOrganic")
TIKTOK_PICK: Final = {
    "disableComment": "Pick if people can comment on TikTok.",
    "disableDuet": "Pick if people can Duet it on TikTok.",
    "disableStitch": "Pick if people can Stitch it on TikTok.",
    "brandContent": "Pick if this TikTok post promotes a brand.",
    "brandOrganic": "Pick if this TikTok post promotes a brand.",
}
ALLOWED: Final[dict[str, frozenset[str]]] = {
    "youtube": frozenset({"privacy", "category", "notifySubscribers"}),
    "tiktok": frozenset({"privacyLevel", *TIKTOK_SWITCHES}),
    "instagram": frozenset({"shareToFeed"}),
    "facebook": frozenset(),
    "x": frozenset(),
}
NEVER: Final = frozenset({"campaign", "madeForKids"})
NOT_ON: Final = "Posting is not switched on for Lamo Stories yet."
PUBLIC: Final = (
    "publishingJobId",
    "workspaceId",
    "contentId",
    "socialAccountId",
    "platform",
    "publishingStatus",
    "accountName",
    "handle",
    "externalAccountId",
    "url",
    "postedAt",
    "error",
    "metrics",
    "createdAt",
    "updatedAt",
)


def pubjob_sk(publishing_job_id: str) -> str:
    return f"{ws.PUBJOB_SK}{publishing_job_id}"


# --- AI labels (§45.14) -----------------------------------------------------------------------------------------

REALISTIC: Final = frozenset({"nova-reel"})  # generators whose footage looks real: the post must say it is AI


class LabelledYouTubePublisher(YouTubePublisher):
    """Lamo Clips' YouTube publisher, unchanged, with the AI label on: ``status.containsSyntheticMedia = true``."""

    def metadata(self, job: PublishJob, *, paid: bool | None = None) -> dict[str, Any]:
        out = super().metadata(job, paid=paid)
        out["status"]["containsSyntheticMedia"] = True
        return out


class LabelledTikTokPublisher(TikTokPublisher):
    """Lamo Clips' TikTok publisher, unchanged, with the AI label on: ``post_info.is_aigc = true``."""

    def post_info(self, job: PublishJob, creator: dict[str, Any]) -> dict[str, Any]:
        out = super().post_info(job, creator)
        out["is_aigc"] = True
        return out


LABELLED: Final[dict[str, type]] = {"youtube": LabelledYouTubePublisher, "tiktok": LabelledTikTokPublisher}


class AiLabelMissing(PublishError):
    """Realistic AI footage, and the platform's API has no AI label to set: it is not posted there."""


def publisher(platform: str, *, ai_label: bool, default: Any = publisher_for) -> Any:
    """The publisher of one job: the shared one (``default``) for cartoons; the labelling wrapper for realistic AI
    footage. A platform where no label can be set has none: ``AiLabelMissing`` stops it."""
    if not ai_label:
        return default(platform)
    found = LABELLED.get(platform)
    if found is None:
        raise AiLabelMissing(story_sentence(platform, "ai_label"))
    return found()


def realistic_video(store: db.Store, user_id: str, workspace_id: str, story_id: str) -> bool:
    """True when any production job of the story used a realistic generator (``PJOB#.meta.providers``): a remade
    scene keeps the others, so any of them counts."""
    found = store.query_all(ws.workspace_pk(user_id, workspace_id), ws.PJOB_SK, consistent=True)
    for job in found:
        if not guard.owned(job, user_id, workspace_id) or job.get("contentId") != story_id:
            continue
        meta = job.get("meta")
        providers = meta.get("providers") if isinstance(meta, Mapping) else None
        if isinstance(providers, Mapping) and any(str(v) in REALISTIC for v in providers.values()):
            return True
    return False


# --- options ---------------------------------------------------------------------------------------------------


def clean_options(platform: str, raw: Any, config: Mapping[str, Any] | None = None) -> Item:
    """The target's flat options for one platform, allow-listed (``bad_request`` otherwise). YouTube's category and
    privacy default to the workspace's ``StoriesConfig``; nothing else gets a default."""
    if raw is None:
        raw = {}
    options = validate.obj(raw, "options")
    for key in sorted(options):
        if key == "madeForKids":
            raise bad_request("Lamo Stories videos are never marked as made for kids.", "options")
        if key == "campaign":
            raise bad_request("Lamo Stories posts are not campaign posts.", "options")
    validate.only_keys(options, ALLOWED[platform])
    cfg = config or {}
    out: Item = {}
    if platform == "youtube":
        privacy = options.get("privacy", cfg.get("youtubePrivacy") or "public")
        if privacy not in YOUTUBE_PRIVACY:
            raise bad_request("Pick Public, Unlisted or Private for YouTube.", "options")
        category = options.get("category", cfg.get("youtubeCategory") or "27")
        if category not in YOUTUBE_CATEGORIES:
            raise bad_request("Pick one of the YouTube categories.", "options")
        out = {"privacy": privacy, "category": category}
        if "notifySubscribers" in options:
            out["notifySubscribers"] = validate.boolean(options["notifySubscribers"], "notifySubscribers")
    elif platform == "tiktok":
        privacy = options.get("privacyLevel")
        if not isinstance(privacy, str) or not TIKTOK_PRIVACY.match(privacy):
            raise bad_request("Pick who can see it on TikTok.", "options")
        out = {"privacyLevel": privacy}
        for key in TIKTOK_SWITCHES:  # the owner's own picks, every one of them: no defaults (§45.6, §45.14)
            if key not in options:
                raise bad_request(TIKTOK_PICK[key], "options")
            out[key] = validate.boolean(options[key], key)
        if out["brandContent"] and privacy not in TIKTOK_BRANDED_PRIVACY:
            raise bad_request("TikTok only allows branded content for Everyone or Friends.", "options")
    elif platform == "instagram" and "shareToFeed" in options:
        out = {"shareToFeed": validate.boolean(options["shareToFeed"], "shareToFeed")}
    return out


def flow_options(platform: str, stored: Any) -> Item:
    """The stored options, filtered once more on the flow's side: never ``campaign``, never ``madeForKids``,
    only the platform's own keys."""
    if not isinstance(stored, Mapping):
        return {}
    allowed = ALLOWED.get(platform, frozenset())
    return {k: v for k, v in stored.items() if k in allowed and k not in NEVER}


# --- shapes ----------------------------------------------------------------------------------------------------


def public_job(item: Mapping[str, Any]) -> Item:
    out: Item = {}
    for key in PUBLIC:
        value = item.get(key)
        if value is None:
            if key in ("accountName", "handle", "externalAccountId"):
                out[key] = None
            continue
        out[key] = value
    if out.get("publishingStatus") not in STATUSES:
        out["publishingStatus"] = "failed"
    metrics = item.get("metrics")
    if isinstance(metrics, Mapping):
        out["metrics"] = {
            "views": metrics.get("views"),
            "likes": metrics.get("likes"),
            "comments": metrics.get("comments"),
            "shares": metrics.get("shares"),
            "checkedAt": str(metrics.get("checkedAt") or ""),
        }
    return out


def job_item(store: db.Store, user_id: str, workspace_id: str, publishing_job_id: str) -> Item | None:
    item = store.get(ws.workspace_pk(user_id, workspace_id), pubjob_sk(publishing_job_id))
    if not guard.owned(item, user_id, workspace_id) or item is None:
        return None
    if item.get("publishingJobId") != publishing_job_id:
        return None
    return item


def list_jobs(store: db.Store, user_id: str, workspace_id: str, story_id: str | None = None) -> list[Item]:
    found = store.query_all(ws.workspace_pk(user_id, workspace_id), ws.PUBJOB_SK, newest_first=True, consistent=True)
    out = []
    for item in found:
        if not guard.owned(item, user_id, workspace_id):
            continue
        if story_id is not None and item.get("contentId") != story_id:
            continue
        out.append(item)
    return out


def stuck(job: Mapping[str, Any], now: datetime) -> bool:
    if job.get("publishingStatus") not in IN_FLIGHT:
        return False
    at = parse(job.get("updatedAt"))
    return at is not None and now - at >= STUCK_AFTER


def settle_stuck(store: db.Store, jobs: Iterable[Item], now: datetime) -> list[Item]:
    """The jobs, with every stuck one (``stuck``) failed: "We are not sure it posted. Look on {Platform} before
    you tap Try again." once it may have reached the platform (``publishing`` or a saved handle), else "Posting did
    not start. Tap Try again.". Conditional on the status, ``updatedAt`` and ``flowRun`` read: a flow that wrote
    meanwhile wins, and the stored item is returned."""
    out: list[Item] = []
    for job in jobs:
        if not stuck(job, now):
            out.append(job)
            continue
        platform = str(job.get("platform") or "")
        reached = job.get("publishingStatus") == "publishing" or bool(job.get("publishHandle"))
        expect: dict[str, list[Any]] = {
            "publishingStatus": [job.get("publishingStatus")],
            "updatedAt": [job.get("updatedAt")],
        }
        run = job.get("flowRun")
        if isinstance(run, int) and not isinstance(run, bool):
            expect["flowRun"] = [run]
        sentence = story_sentence(platform, "unsure" if reached else "not_started")
        try:
            fresh = store.update(
                job["pk"],
                job["sk"],
                {"publishingStatus": "failed", "error": sentence, "updatedAt": iso(now)},
                expect_in=expect,
            )
        except db.ConditionFailed:
            fresh = store.get(job["pk"], job["sk"]) or dict(job)
        else:
            log("warning", "ws_publish.stuck_failed", platform=platform, reached=reached)
        out.append(fresh)
    return out


def _clash(jobs: Iterable[Mapping[str, Any]], platform: str, *, skip: str | None = None) -> None:
    """One story goes to one platform once: ``409`` while another of its jobs is being posted there or is posted."""
    mine = [j for j in jobs if j.get("platform") == platform and j.get("publishingJobId") != skip]
    if any(j.get("publishingStatus") in IN_FLIGHT for j in mine):
        raise conflict(f"This story is already being posted to {label(platform)}.")
    if any(j.get("publishingStatus") == "posted" for j in mine):
        raise conflict(f"This story is already on {label(platform)}.")


# --- the run counter -----------------------------------------------------------------------------------------


def _run_update(story: Mapping[str, Any], now: datetime) -> tuple[dict[str, Any], int]:
    """The conditional UpdateItem that raises the story's publishing ``run`` by one (and its ``version``, as every
    STORY# write does): conditional on the run read, so two taps at once never share a run."""
    old = story.get("run")
    current = int(old) if isinstance(old, int) and not isinstance(old, bool) else 0
    names = {"#run": "run", "#v": "version", "#u": "updatedAt", "#s": "status"}
    values: dict[str, Any] = {
        ":run": current + 1,
        ":one": 1,
        ":zero": 0,
        ":now": iso(now),
        ":a": "approved",
        ":p": "published",
    }
    condition = "attribute_exists(pk) AND #s IN (:a, :p)"
    if isinstance(old, int) and not isinstance(old, bool):
        condition += " AND #run = :old"
        values[":old"] = current
    else:
        condition += " AND attribute_not_exists(#run)"
    request = {
        "Key": {"pk": story["pk"], "sk": story["sk"]},
        "UpdateExpression": "SET #run = :run, #v = if_not_exists(#v, :zero) + :one, #u = :now",
        "ConditionExpression": condition,
        "ExpressionAttributeNames": names,
        "ExpressionAttributeValues": {k: db.to_dynamo(v) for k, v in values.items()},
    }
    return request, current + 1


# --- publish -------------------------------------------------------------------------------------------------


def _targets(body: Mapping[str, Any]) -> list[Item]:
    validate.only_keys(body, {"targets"})
    raw = body.get("targets")
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_TARGETS:
        raise bad_request("Pick where to post it (1 to 5 places).", "targets")
    seen: set[str] = set()
    out: list[Item] = []
    for entry in raw:
        target = validate.obj(entry, "Each target")
        validate.only_keys(target, {"platform", "socialAccountId", "options", "confirmAccount"})
        platform = target.get("platform")
        if platform not in ws.PLATFORMS:
            raise bad_request("We do not support that platform.", "targets")
        if platform in seen:
            raise bad_request(f"{label(str(platform))} is picked twice. Pick each place once.", "targets")
        seen.add(str(platform))
        account_id = target.get("socialAccountId")
        if not isinstance(account_id, str) or not account_id:
            raise bad_request(f"Pick the {label(str(platform))} account.", "targets")
        confirm = target.get("confirmAccount")
        if confirm is not None and (not isinstance(confirm, str) or not confirm or len(confirm) > 200):
            raise bad_request("confirmAccount must be the account the app showed.", "targets")
        out.append(
            {
                "platform": platform,
                "socialAccountId": account_id,
                "options": target.get("options"),
                "confirmAccount": confirm,
            }
        )
    return out


def _changed_account(platform: str, destination: Destination) -> ApiError:
    """``409``: the account is not the one the owner saw; it names the account it would go to now ("this {Platform}
    account ({name})", round 5 E13) and says the publish sheet's own button: Yes. A raw channel id never goes in the
    sentence (E14: "this {Platform} account" when it has no name or handle); it stays in ``error.account``."""
    name = destination.account_name or _handle(destination)
    return ApiError(
        409,
        "conflict",
        f"Lamo Stories' {label(platform)} is a different account now: {this_account(platform, name)}. Tap Yes if "
        "that is right.",
        extra={
            "account": {
                "externalAccountId": destination.external_account_id,
                "accountName": destination.account_name,
                "handle": _handle(destination),
            }
        },
    )


def _handle(destination: Destination) -> str | None:
    found = destination.account.get("handle")
    return str(found) if isinstance(found, str) and found else None


def _story(store: db.Store, user_id: str, workspace_id: str, story_id: str) -> Item:
    item = store.get(ws.workspace_pk(user_id, workspace_id), story_sk(story_id))
    if item is None or not guard.owned(item, user_id, workspace_id) or item.get("storyId") != story_id:
        raise not_found("We could not find that story.")
    return item


def _unsure_account(platform: str, problem: DestinationProblem) -> ApiError:
    """``409``: Lamo Stories cannot tell this TikTok from Clip Factory's own; it names the account ("this {Platform}
    account ({name})", round 5 E13) for the owner's Yes, the publish sheet's own button. A raw open_id never goes in
    the sentence (E14: "this {Platform} account" when it has no name or handle); it stays in ``error.account``."""
    account = problem.account or {}
    name = account.get("accountName") or account.get("handle")
    return ApiError(
        409,
        "conflict",
        f"Lamo Stories cannot tell if {this_account(platform, name)} is Clip Factory's {label(platform)}. Tap Yes if "
        f"it is your Lamo Stories {label(platform)}.",
        extra={"account": dict(account)},
    )


def _check(
    store: db.Store,
    secrets: WorkspaceSecrets,
    user_id: str,
    workspace_id: str,
    target: Mapping[str, Any],
    *,
    now: datetime,
    confirm: str | None = None,
) -> Destination:
    try:
        return validate_destination(
            store, secrets, user_id, workspace_id, target, at_tap=True, now=now, confirm=confirm
        )
    except DestinationProblem as e:
        if e.kind == "clips_unknown":
            raise _unsure_account(str(target.get("platform") or ""), e) from e
        raise conflict(e.sentence) from e


def publish(
    scope: Scope, starter: Any, workspace: Mapping[str, Any], story_id: str, body: Mapping[str, Any], *, now: datetime
) -> list[Item]:
    store, secrets, user_id, workspace_id = scope.store, scope.secrets, scope.user_id, scope.workspace_id
    targets = _targets(body)
    if starter is None or not getattr(starter, "ready", False):
        raise ApiError(503, "unavailable", NOT_ON)
    story = _story(store, user_id, workspace_id, story_id)
    config = workspace.get("configuration") if isinstance(workspace.get("configuration"), Mapping) else {}
    existing = settle_stuck(store, list_jobs(store, user_id, workspace_id, story_id), now)
    ai_label = realistic_video(store, user_id, workspace_id, story_id)
    planned: list[tuple[Item, Destination, Item]] = []
    for target in targets:
        platform = str(target["platform"])
        options = clean_options(platform, target.get("options"), config)
        if ai_label and platform not in LABELLED:
            raise conflict(story_sentence(platform, "ai_label"))
        _clash(existing, platform)
        checked = {k: v for k, v in target.items() if k != "confirmAccount"}
        confirm = target.get("confirmAccount")
        destination = _check(
            store, secrets, user_id, workspace_id, {**checked, "contentId": story_id}, now=now, confirm=confirm
        )
        if confirm is not None and confirm != destination.external_account_id:
            raise _changed_account(platform, destination)  # the owner saw another account: nothing is written
        planned.append((target, destination, options))
    run_request, run = _run_update(story, now)
    jobs: list[Item] = []
    for _target, destination, options in planned:
        job_id = ulid()
        jobs.append(
            {
                "pk": ws.workspace_pk(user_id, workspace_id),
                "sk": pubjob_sk(job_id),
                "type": ws.TYPE_PUBJOB,
                "userId": user_id,
                "workspaceId": workspace_id,
                "publishingJobId": job_id,
                "contentId": story_id,
                "socialAccountId": destination.social_account_id,
                "platform": destination.platform,
                "publishingStatus": "queued",
                "accountName": destination.account_name,
                "handle": _handle(destination),
                "externalAccountId": destination.external_account_id,
                "appChoice": destination.app.choice,
                "aiLabel": ai_label,
                "flowRun": run,
                "postOptions": options,
                "createdAt": iso(now),
                "updatedAt": iso(now),
            }
        )
    confirmed = [confirm_not_clips_update(d, now) for _t, d, _o in planned if d.confirms_not_clips]
    try:
        store.transact(updates=[run_request, *confirmed], puts=jobs)
    except db.ConditionFailed as e:
        raise conflict("This story changed a moment ago. Tap Post it again.") from e
    _start(scope, starter, story_id, jobs, run=run, now=now)
    log("info", "ws_publish.started", storyId=story_id, run=run, platforms=",".join(str(j["platform"]) for j in jobs))
    return [public_job(j) for j in _fresh(store, jobs)]


def _fresh(store: db.Store, jobs: list[Item]) -> list[Item]:
    return [store.get(j["pk"], j["sk"]) or j for j in jobs]


def _start(scope: Scope, starter: Any, story_id: str, jobs: list[Item], *, run: int, now: datetime) -> None:
    from .flow import FlowStartError

    store = scope.store
    try:
        starter.start(scope.user_id, scope.workspace_id, story_id, [str(j["publishingJobId"]) for j in jobs], run)
    except FlowStartError as e:
        log("error", "ws_publish.start_failed", storyId=story_id, error=str(e))
        for job in jobs:
            try:
                store.update(
                    job["pk"],
                    job["sk"],
                    {
                        "publishingStatus": "failed",
                        "error": story_sentence(str(job["platform"]), "not_started"),
                        "updatedAt": iso(now),
                    },
                    expect_in={"publishingStatus": ["queued"], "flowRun": [run]},
                )
            except db.ConditionFailed:
                continue
        raise ApiError(503, "unavailable", story_sentence(str(jobs[0]["platform"]), "not_started")) from e


# --- retry ---------------------------------------------------------------------------------------------------


def _retryable(store: db.Store, scope: Scope, job: Item, now: datetime) -> Item:
    """The job as it stands after the stuck check; ``409`` unless Try again may send it (never a second post of
    this story on that platform, never a stuck post that may have reached the platform)."""
    platform, story_id = str(job.get("platform") or ""), str(job.get("contentId") or "")
    before = job.get("publishingStatus")
    jobs = settle_stuck(store, list_jobs(store, scope.user_id, scope.workspace_id, story_id), now)
    job = next((j for j in jobs if j.get("publishingJobId") == job.get("publishingJobId")), job)
    unsure = story_sentence(platform, "unsure")
    if before in IN_FLIGHT and job.get("publishingStatus") == "failed" and job.get("error") == unsure:
        raise conflict(unsure)  # it was stuck after reaching the platform: the owner looks there first
    if job.get("publishingStatus") not in RETRYABLE:
        raise conflict("This post is not stuck. There is nothing to try again.")
    _clash(jobs, platform, skip=str(job.get("publishingJobId")))
    return job


def retry(
    scope: Scope,
    starter: Any,
    workspace: Mapping[str, Any],
    publishing_job_id: str,
    body: Mapping[str, Any],
    *,
    now: datetime,
) -> Item:
    store, secrets, user_id, workspace_id = scope.store, scope.secrets, scope.user_id, scope.workspace_id
    validate.only_keys(body, {"options", "confirmAccount"})
    job = job_item(store, user_id, workspace_id, publishing_job_id)
    if job is None:
        raise not_found("We could not find that post.")
    if starter is None or not getattr(starter, "ready", False):
        raise ApiError(503, "unavailable", NOT_ON)
    platform = str(job.get("platform") or "")
    if platform not in ws.PLATFORMS:
        raise not_found("We could not find that post.")
    story_id = str(job.get("contentId") or "")
    job = _retryable(store, scope, job, now)
    confirm = body.get("confirmAccount")
    if confirm is not None and (not isinstance(confirm, str) or not confirm or len(confirm) > 200):
        raise bad_request("confirmAccount must be the account the app showed.", "confirmAccount")
    config = workspace.get("configuration") if isinstance(workspace.get("configuration"), Mapping) else {}
    if "options" in body:
        options = clean_options(platform, body.get("options"), config)
    else:
        options = clean_options(platform, flow_options(platform, job.get("postOptions")), config)
    story = _story(store, user_id, workspace_id, story_id)
    ai_label = realistic_video(store, user_id, workspace_id, story_id)
    if ai_label and platform not in LABELLED:
        raise conflict(story_sentence(platform, "ai_label"))
    target = {"platform": platform, "socialAccountId": job.get("socialAccountId"), "contentId": story_id}
    destination = _check(store, secrets, user_id, workspace_id, target, now=now, confirm=confirm)
    fields: Item = {
        "publishingStatus": "queued",
        "postOptions": options,
        "appChoice": destination.app.choice,
        "aiLabel": ai_label,
        "updatedAt": iso(now),
    }
    if destination.external_account_id != job.get("externalAccountId"):
        if confirm != destination.external_account_id:
            raise _changed_account(platform, destination)
        fields["externalAccountId"] = destination.external_account_id
        fields["accountName"] = destination.account_name
        handle = _handle(destination)
        if handle:
            fields["handle"] = handle
    run_request, run = _run_update(story, now)
    fields["flowRun"] = run
    update = db.update_request(
        job["pk"],
        job["sk"],
        fields,
        remove=["error", "publishHandle"],
        expect_in={"publishingStatus": list(RETRYABLE), "flowRun": [job.get("flowRun")]},
    )
    confirmed = [confirm_not_clips_update(destination, now)] if destination.confirms_not_clips else []
    try:
        store.transact(updates=[run_request, update, *confirmed])
    except db.ConditionFailed as e:
        raise conflict("This post changed a moment ago. Look at it again.") from e
    fresh = store.get(job["pk"], job["sk"]) or {**job, **fields}
    _start(scope, starter, story_id, [fresh], run=run, now=now)
    log("info", "ws_publish.retried", storyId=story_id, run=run, platform=platform)
    return public_job(store.get(job["pk"], job["sk"]) or fresh)
