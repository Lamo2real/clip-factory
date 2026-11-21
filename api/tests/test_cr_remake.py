"""A campaign copy of a clip (docs/CONTRACTS.md §39.3 "The copy (remake)", tests §39.5 "api (G)").

``POST /v1/contentrewards/campaigns/{campaignId}/remake``: 503 while ``CR_REMAKE`` is off, the refusals (the fit's
``canRemake``, an unaccepted soft stop, a video file that is gone), the reservation on the original clip before the
job (a double tap or two calls at once make one job; a failed job frees it; a copy that no longer counts may be
made again), and the job itself: the original's source, a new ``macFetch`` map, ``sourceKey`` found by a HEAD, the
notes, one clip, A's rules snapshot and logo copy, ``sourceLanguage``, the public ``remakeOf`` and the internal
``remake`` (never in ``public_job``). Offline: in-memory items, recorded CR answers, a fake S3.
"""

from __future__ import annotations

import re
from datetime import timedelta
from typing import Any

import pytest

import fakes
from clipfactory_api import db, jobs
from clipfactory_api.clock import iso
from clipfactory_api.contentrewards import campaigns, public, remake, rules
from conftest import JOB_FLOW_ARN, NOW, USER, Call, seed_clip, seed_job
from cr_support import (
    JSON_URL_FOR,
    UUID,
    FakeCR,
    FakeInvoker,
    listed_campaign,
    make_deps,
    page,
    public_campaign,
    seed_campaign,
    seed_connection,
    seed_setup,
)
from fakes import FakeLambda, FakeS3, FakeTable

PK = db.user_pk(USER)
LINK = "https://www.youtube.com/watch?v=abc"
BRIEF = "Clip the draft. Caption must include #FaZe @FaZeClan."
URL = f"/v1/contentrewards/campaigns/{UUID}/remake"


# --- the fake table learns document paths (``remakes.#c``), as DynamoDB has them --------------------------------


class _Paths(dict[str, Any]):
    """An item whose ``a\0b`` keys reach inside maps (the fake's conditions read paths through it)."""

    def _walk(self, key: str) -> Any:
        found: Any = dict(self)
        for part in key.split("\0"):
            if not isinstance(found, dict) or part not in found:
                return fakes._MISSING
            found = found[part]
        return found

    def __contains__(self, key: object) -> bool:
        if isinstance(key, str) and "\0" in key:
            return self._walk(key) is not fakes._MISSING
        return super().__contains__(key)

    def get(self, key: str, default: Any = None) -> Any:
        if "\0" in key:
            found = self._walk(key)
            return default if found is fakes._MISSING else found
        return super().get(key, default)


@pytest.fixture(autouse=True)
def document_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    token = re.compile(r"\s*(#\w+(?:\.#\w+)+|#\w+|:\w+|<>|<=|>=|[()=<>,+-]|[A-Za-z_][\w.]*)")
    monkeypatch.setattr(fakes, "_TOKEN", token)
    name, init, update = fakes._Eval.name, fakes._Eval.__init__, fakes.apply_update

    def path_name(self: Any, tok: str) -> str:
        if tok.startswith("#") and "." in tok:
            return "\0".join(self.names[p] for p in tok.split("."))
        return name(self, tok)  # type: ignore[no-any-return]

    def path_init(self: Any, text: str, item: Any, names: Any, values: Any) -> None:
        init(self, text, item, names, values)
        self.item = _Paths(self.item)

    def path_update(expression: str, item: dict[str, Any], names: dict[str, str], values: dict[str, Any]) -> None:
        found = re.fullmatch(r"REMOVE (#\w+)\.(#\w+)", expression.strip())
        if found:
            holder = item.get(names[found.group(1)])
            if isinstance(holder, dict):
                holder.pop(names[found.group(2)], None)
            return
        update(expression, item, names, values)

    monkeypatch.setattr(fakes._Eval, "name", path_name)
    monkeypatch.setattr(fakes._Eval, "__init__", path_init)
    monkeypatch.setattr(fakes, "apply_update", path_update)


# --- the world ----------------------------------------------------------------------------------------------------


@pytest.fixture
def cr(app: Any, secrets_client: Any, clock: Any, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv("CR_REMAKE", "on")
    public.reset_limit()
    fake = FakeCR()
    fake.public[JSON_URL_FOR(UUID)] = public_campaign(application=False, name="FaZe Clips")
    fake.answer("list_my_campaigns", page([listed_campaign(access="open", name="FaZe Clips", description=BRIEF)]))
    deps = make_deps(app.store, secrets_client, fake, clock, media=app.media, invoker=FakeInvoker())
    app.contentrewards = deps
    seed_connection(deps, USER, clock.now, stepsDone=["connect", "ready-account", "ready-socials"])
    seed_setup(app.store, USER, "youtube")
    seed_setup(app.store, USER, "instagram")
    seed_campaign(app.store, USER, clock.now, brief=BRIEF, briefHash=campaigns.brief_hash(BRIEF + "\n"))
    return deps


def campaign(cr: Any, **fields: Any) -> None:
    item = cr.store.get(PK, db.campaign_sk(UUID))
    item.update(fields)
    cr.store.put({k: v for k, v in item.items() if v is not None})


def original(cr: Any, s3: FakeS3, *, kept: bool = True, **job_fields: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    """A normal clip waiting in Review, its link job and (``kept``) the job's kept source video."""
    job = seed_job(
        cr.store,
        status="ready",
        source={"type": "link", "platform": "youtube", "url": LINK, "title": "The draft", "channel": "FaZe Clan"},
        notes="Only the funny parts",
        sourceLanguage="en-US",
        macFetch={"state": "done", "deviceId": "mac-1"},
        createdAt=iso(cr.clock.now - timedelta(hours=1)),
        **job_fields,
    )
    clip = seed_clip(cr.store, job_id=job["jobId"], pickedFor="Loud laugh")
    if kept:
        s3.objects[f"jobs/{job['jobId']}/source/video.mp4"] = b"mp4"
    return clip, job


def copy_jobs(table: FakeTable, clip: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        i for i in table.all() if i.get("type") == "job" and (i.get("remakeOf") or {}).get("clipId") == clip["clipId"]
    ]


def stored_clip(cr: Any, clip: dict[str, Any]) -> dict[str, Any]:
    return cr.store.get(PK, db.clip_sk(clip["clipId"]))  # type: ignore[no-any-return]


# --- off, unknown, refused ------------------------------------------------------------------------------------


def test_off_until_cr_remake_is_on(call: Call, cr: Any, s3_client: FakeS3, monkeypatch: pytest.MonkeyPatch) -> None:
    clip, _job = original(cr, s3_client)
    monkeypatch.setenv("CR_REMAKE", "off")
    status, body = call("POST", URL, {"clipId": clip["clipId"]})
    assert (status, body["error"]["code"], body["error"]["message"]) == (503, "unavailable", "Coming soon.")
    monkeypatch.delenv("CR_REMAKE")
    assert call("POST", URL, {"clipId": clip["clipId"]})[0] == 503
    assert remake.enabled({"CR_REMAKE": "on"})
    assert not remake.enabled({})


def test_content_rewards_switched_off_is_503(call: Call) -> None:
    status, body = call("POST", URL, {"clipId": "01J0000000000000000000000C"})
    assert (status, body["error"]["code"]) == (503, "unavailable")


def test_unknown_clip_or_campaign(call: Call, cr: Any, s3_client: FakeS3) -> None:
    clip, _job = original(cr, s3_client)
    assert call("POST", URL, {"clipId": "01J0000000000000000000000C"})[0] == 404
    other = "/v1/contentrewards/campaigns/a1cefc3b-4533-438f-8e70-a7299550f1cf/remake"
    status, body = call("POST", other, {"clipId": clip["clipId"]})
    assert (status, body["error"]["message"]) == (404, "Add the campaign again.")
    assert call("POST", URL, {"clipId": clip["clipId"], "nope": 1})[0] == 400
    assert call("POST", URL, {"clipId": clip["clipId"], "campaignAnyway": "budget_half"})[0] == 400


def test_refused_when_the_copy_could_not_earn(call: Call, cr: Any, s3_client: FakeS3, table: FakeTable) -> None:
    clip, _job = original(cr, s3_client)
    cr.store.update(PK, db.clip_sk(clip["clipId"]), {"durationSec": 95.0})
    status, body = call("POST", URL, {"clipId": clip["clipId"]})
    assert (status, body["error"]["message"]) == (409, "This clip is 95 seconds. FaZe Clips takes 15 to 60 seconds.")
    cr.store.update(PK, db.clip_sk(clip["clipId"]), {"durationSec": 31.5})
    campaign(cr, held={"at": iso(cr.clock.now), "pending": 2})
    status, body = call("POST", URL, {"clipId": clip["clipId"]})
    assert status == 409
    assert body["error"]["message"].startswith("Not yet for FaZe Clips: Content Rewards wants the brand")
    assert copy_jobs(table, clip) == []
    assert "remakes" not in stored_clip(cr, clip)


def test_an_unaccepted_soft_stop_needs_campaign_anyway(
    call: Call, cr: Any, s3_client: FakeS3, table: FakeTable
) -> None:
    clip, _job = original(cr, s3_client)
    campaign(cr, budget={"totalCents": 1000, "spentCents": 600, "leftCents": 400, "usedPct": 60.0})
    status, body = call("POST", URL, {"clipId": clip["clipId"]})
    assert (status, body["error"]["message"]) == (
        409,
        "Half the money is used. $4.00 is left. Post soon, before it runs out.",
    )
    assert "remakes" not in stored_clip(cr, clip)
    status, body = call("POST", URL, {"clipId": clip["clipId"], "campaignAnyway": ["budget_half"]})
    assert status == 202, body


def test_a_video_file_that_is_gone(call: Call, cr: Any, s3_client: FakeS3, table: FakeTable) -> None:
    upload = {"type": "upload", "platform": "upload", "key": f"uploads/{USER}/x/video.mp4", "filename": "video.mp4"}
    old_job = seed_job(cr.store, status="ready", source=upload, createdAt=iso(cr.clock.now - timedelta(days=13)))
    old = seed_clip(cr.store, job_id=old_job["jobId"])
    status, body = call("POST", URL, {"clipId": old["clipId"]})
    assert (status, body["error"]["message"]) == (
        409,
        "This video is gone from Clip Factory. Make new clips for this campaign.",
    )
    recent_job = seed_job(cr.store, status="ready", source=upload, createdAt=iso(cr.clock.now - timedelta(days=2)))
    recent = seed_clip(cr.store, job_id=recent_job["jobId"])  # young enough, but its files were removed
    status, body = call("POST", URL, {"clipId": recent["clipId"]})
    assert (status, body["error"]["message"]) == (
        409,
        "This video is gone from Clip Factory. Make new clips for this campaign.",
    )
    assert copy_jobs(table, old) == []
    assert copy_jobs(table, recent) == []


# --- the copy ------------------------------------------------------------------------------------------------------


def test_the_copy_job(call: Call, cr: Any, s3_client: FakeS3, table: FakeTable, lambda_client: FakeLambda) -> None:
    clip, job = original(cr, s3_client)
    asked = cr.clock.now  # CR's checks may move the test clock on
    status, body = call("POST", URL, {"clipId": clip["clipId"], "macFetch": True})
    assert status == 202, body
    made = body["job"]
    assert made["remakeOf"] == {"clipId": clip["clipId"], "jobId": job["jobId"]}
    assert "remake" not in made  # internal
    assert "campaign" not in made
    assert made["campaignId"] == UUID
    stored = table.raw(PK, db.job_sk(made["jobId"])) or {}
    assert stored["source"] == job["source"]
    assert stored["macFetch"] == {"state": "waiting", "up": True}  # a new map from the body, never the original's
    assert stored["clipTarget"] == {"min": 1, "max": 1}
    assert stored["notes"] == "Only the funny parts"
    assert stored["sourceLanguage"] == "en-US"
    assert stored["campaign"]["campaignId"] == UUID
    assert stored["campaign"]["rules"]["requiredHashtags"] == ["#FaZe"]  # A's rules snapshot
    assert stored["remake"] == {
        "clipId": clip["clipId"],
        "jobId": job["jobId"],
        "sourceStart": 100.0,
        "sourceEnd": 131.5,
        "layout": "facecam_top",
        "momentType": "rage",
        "hook": "He lost it",
        "pickedFor": "Loud laugh",
        "sourceKey": f"jobs/{job['jobId']}/source/video.mp4",
    }
    assert "remake" not in jobs.public_job(stored)
    assert stored_clip(cr, clip)["remakes"] == {UUID: {"jobId": made["jobId"], "at": iso(asked)}}
    assert [c for c in lambda_client.calls if c["FunctionName"] == JOB_FLOW_ARN]  # its flow started
    status, body = call("GET", f"/v1/jobs/{made['jobId']}")
    assert (status, body["job"]["remakeOf"]["clipId"]) == (200, clip["clipId"])
    assert "remake" not in body["job"]
    # nothing else on the original changes
    before = {k: v for k, v in clip.items() if k not in ("remakes",)}
    assert {k: v for k, v in stored_clip(cr, clip).items() if k != "remakes"} == before


def test_the_copy_copies_the_campaign_logo(call: Call, cr: Any, s3_client: FakeS3, table: FakeTable) -> None:
    key = f"campaigns/{USER}/{UUID}/logo-1.png"
    s3_client.objects[key] = b"\x89PNG logo"
    campaign(
        cr,
        logoKey=key,
        logo={"needed": True, "state": "ready"},
        rules={**cr.store.get(PK, db.campaign_sk(UUID))["rules"], "logo": {"required": True, "rules": None}},
    )
    clip, _job = original(cr, s3_client)
    status, body = call("POST", URL, {"clipId": clip["clipId"]})
    assert status == 202, body
    copy = f"jobs/{body['job']['jobId']}/source/campaign-logo.png"
    assert s3_client.objects[copy] == b"\x89PNG logo"


def test_the_source_key_is_found_by_a_head(call: Call, cr: Any, s3_client: FakeS3, table: FakeTable) -> None:
    clip, job = original(cr, s3_client, kept=False)
    s3_client.objects[f"uploads/{USER}/mac-{job['jobId']}/video.mp4"] = b"mp4"
    status, body = call("POST", URL, {"clipId": clip["clipId"]})
    assert status == 202, body
    stored = table.raw(PK, db.job_sk(body["job"]["jobId"])) or {}
    assert stored["remake"]["sourceKey"] == f"uploads/{USER}/mac-{job['jobId']}/video.mp4"
    assert stored["macFetch"] == {"state": "cloud"}
    # both gone: a link job fetches its link again
    gone, _gone_job = original(cr, s3_client, kept=False)
    status, body = call("POST", URL, {"clipId": gone["clipId"]})
    assert status == 202, body
    assert "sourceKey" not in (table.raw(PK, db.job_sk(body["job"]["jobId"])) or {})["remake"]


def test_a_double_tap_makes_one_copy(call: Call, cr: Any, s3_client: FakeS3, table: FakeTable) -> None:
    clip, _job = original(cr, s3_client)
    first = call("POST", URL, {"clipId": clip["clipId"]})
    second = call("POST", URL, {"clipId": clip["clipId"]})
    assert (first[0], second[0]) == (202, 200)
    assert second[1]["job"]["jobId"] == first[1]["job"]["jobId"]
    assert len(copy_jobs(table, clip)) == 1


def test_two_calls_at_once_make_one_job(
    call: Call, cr: Any, s3_client: FakeS3, table: FakeTable, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The reservation is written before the job: a second call that arrives while the first is still making its
    job (CR's checks) finds it and never makes a second one."""
    from clipfactory_api.contentrewards import jobs as cr_jobs

    clip, _job = original(cr, s3_client)
    real = cr_jobs.prepare
    seen: list[tuple[int, Any]] = []

    def prepare(*args: Any, **kw: Any) -> Any:
        if not seen:
            seen.append(call("POST", URL, {"clipId": clip["clipId"]}))  # the second tap, meanwhile
        return real(*args, **kw)

    monkeypatch.setattr(cr_jobs, "prepare", prepare)
    status, body = call("POST", URL, {"clipId": clip["clipId"]})
    assert status == 202, body
    inner_status, inner = seen[0]
    assert (inner_status, inner["error"]["message"]) == (409, "Making the copy… It shows here in about 3 minutes.")
    assert len(copy_jobs(table, clip)) == 1
    assert stored_clip(cr, clip)["remakes"][UUID]["jobId"] == body["job"]["jobId"]


def test_a_failed_job_frees_the_reservation(
    call: Call, cr: Any, s3_client: FakeS3, table: FakeTable, monkeypatch: pytest.MonkeyPatch
) -> None:
    clip, _job = original(cr, s3_client)
    campaign(cr, rules={**rules.empty(), "draftsFirst": True}, rulesState="ready")
    from clipfactory_api.contentrewards import fit

    # the fit (stored items) still says yes; CR's fresh check at the job start says no
    real = fit.Loader.fit_one

    def stale(self: Any, *args: Any, **kw: Any) -> Any:
        found = real(self, *args, **kw)
        found["canRemake"] = True
        return found

    monkeypatch.setattr(fit.Loader, "fit_one", stale)
    status, body = call("POST", URL, {"clipId": clip["clipId"]})
    assert status == 409
    assert body["error"]["message"].startswith("This campaign wants to see each clip before you post it.")
    assert stored_clip(cr, clip).get("remakes") == {}
    assert copy_jobs(table, clip) == []


def test_a_copy_that_no_longer_counts_can_be_made_again(
    call: Call, cr: Any, s3_client: FakeS3, table: FakeTable
) -> None:
    clip, _job = original(cr, s3_client)
    first = call("POST", URL, {"clipId": clip["clipId"]})[1]["job"]["jobId"]
    cr.store.update(PK, db.job_sk(first), {"status": "failed"})
    status, body = call("POST", URL, {"clipId": clip["clipId"]})
    assert status == 202, body
    assert body["job"]["jobId"] != first
    assert stored_clip(cr, clip)["remakes"][UUID]["jobId"] == body["job"]["jobId"]
    # a thrown-away copy no longer counts either
    second = body["job"]["jobId"]
    seed_clip(cr.store, job_id=second, status="declined", campaignId=UUID)
    status, body = call("POST", URL, {"clipId": clip["clipId"]})
    assert status == 202
    assert body["job"]["jobId"] not in (first, second)


def test_alive_rules() -> None:
    store = db.Store(FakeTable())
    now = NOW
    young = {"jobId": "01J0000000000000000000000J", "at": iso(now)}
    assert remake.alive(store, USER, young, now) is True  # its request may still be writing the job
    old = {"jobId": "01J0000000000000000000000J", "at": iso(now - timedelta(minutes=5))}
    assert remake.alive(store, USER, old, now) is False
    job = seed_job(store, status="running")
    assert remake.alive(store, USER, {"jobId": job["jobId"]}, now) is True
    store.update(job["pk"], job["sk"], {"deletingAt": iso(now)})
    assert remake.alive(store, USER, {"jobId": job["jobId"]}, now) is False
    assert remake.alive(store, USER, {}, now) is False


def test_the_review_card_sees_the_copy(call: Call, cr: Any, s3_client: FakeS3) -> None:
    clip, _job = original(cr, s3_client)
    asked = cr.clock.now
    made = call("POST", URL, {"clipId": clip["clipId"]})[1]["job"]
    found = call("GET", "/v1/contentrewards/fit", query={"clipId": clip["clipId"]})[1]
    assert found["remakes"] == {UUID: {"jobId": made["jobId"], "at": iso(asked)}}
    assert found["suggestion"] == {"campaignId": UUID, "name": "FaZe Clips"}
