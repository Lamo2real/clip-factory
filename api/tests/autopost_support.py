"""Shared helpers of the auto-posting tests (docs/CONTRACTS.md §46.15): in-memory items only, written with their keys."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from clipfactory_api import db, settings
from clipfactory_api.app import App
from clipfactory_api.autopost import OWNERS_PK, STATE_SK, run_sk
from clipfactory_api.autopost.run import RunDeps
from clipfactory_api.clock import iso
from conftest import CLIP_FLOW_ARN, NOW, USER, seed_clip, seed_job
from fakes import FakeLambda, FakeS3, FakeTable

PK = db.user_pk(USER)
# Switched on at NOW (12:00): the first run is the 13:00 tick.
SLOT = NOW + timedelta(hours=1)


def ready(store: db.Store, *places: str, user: str = USER, audit: str | None = None) -> None:
    """Connected and ready on Set up posting (§17.4): YouTube's published app ticked, TikTok's audit as given."""
    pk = db.user_pk(user)
    for platform in places:
        store.put(
            {
                "pk": pk,
                "sk": f"ACCOUNT#{platform}",
                "type": "account",
                "userId": user,
                "platform": platform,
                "status": "connected",
                "accountId": f"acct-{platform}",
            }
        )
        setup: dict[str, Any] = {"pk": pk, "sk": f"SETUP#{platform}", "type": "setup", "platform": platform}
        if platform == "youtube":
            setup["stepsDone"] = ["key-publish"]
        if platform == "tiktok" and audit:
            setup["gates"] = {"posting_audit": {"state": audit, "at": "2026-11-14T10:00:00.000Z"}}
        store.put(setup)


def turn_on(
    store: db.Store,
    *,
    user: str = USER,
    every: int = 5,
    per_run: int = 1,
    practice: bool = False,
    on: bool = True,
    on_at: str | None = None,
    **more: Any,
) -> None:
    """Saves ``autoPost`` (switched on at NOW unless told otherwise) and registers the owner, as the PUT does."""
    current = settings.load(store, user)
    auto: dict[str, Any] = {"on": on, "everyHours": every, "perRun": per_run, "practice": practice}
    if on:
        auto["onAt"] = on_at or iso(NOW)
    settings.save(store, user, {**current, **more, "autoPost": auto}, iso(NOW))
    store.put({"pk": OWNERS_PK, "sk": f"USER#{user}", "type": "autopostowner", "userId": user, "since": iso(NOW)})


def review_clip(
    store: db.Store,
    s3_client: FakeS3 | None = None,
    *,
    user: str = USER,
    made: str = "2026-11-15T09:00:00.000Z",
    job: dict[str, Any] | None = None,
    **fields: Any,
) -> dict[str, Any]:
    """A clip in Review of a finished job made at ``made`` (or of ``job``)."""
    job = job or seed_job(store, user, status="ready", createdAt=made)
    return seed_clip(store, s3_client, user, job_id=job["jobId"], **fields)


def deps(app: App, **kw: Any) -> RunDeps:
    return RunDeps(app=app, monotonic=kw.pop("monotonic", lambda: 0.0), **kw)


def flow_starts(lambda_client: FakeLambda) -> list[str]:
    return [c["DurableExecutionName"] for c in lambda_client.calls if c["FunctionName"] == CLIP_FLOW_ARN]


def clip_of(store: db.Store, clip_id: str, user: str = USER) -> dict[str, Any]:
    found = store.get(db.user_pk(user), db.clip_sk(clip_id))
    assert found is not None
    return found


def run_item(store: db.Store, run_id: str, user: str = USER) -> dict[str, Any] | None:
    return store.get(db.user_pk(user), run_sk(run_id))


def state(store: db.Store, user: str = USER) -> dict[str, Any]:
    return store.get(db.user_pk(user), STATE_SK) or {}


def posts_of(table: FakeTable, clip_id: str) -> dict[str, dict[str, Any]]:
    return {i["platform"]: i for i in table.all() if i.get("type") == "post" and i.get("clipId") == clip_id}


def post_count(table: FakeTable, clip_id: str) -> int:
    """Every post item of the clip: one per place when it was confirmed once (never a second set)."""
    return sum(1 for i in table.all() if i.get("type") == "post" and i.get("clipId") == clip_id)
