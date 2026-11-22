"""Publishing isolation (docs/CONTRACTS.md §45.14, §45.19, ADR-73).

* each rule of ``validate_destination`` alone stops a job (``needs_attention``) and sends nothing: the fake HTTP
  records zero platform calls, at the tap and inside the flow;
* the destination changing after the tap stops; the secret's own identity differing stops; the same place as Lamo
  Clips without a matching share stops;
* the publish and retry routes: flat allow-listed options, 1–5 targets each platform once, no default account, the
  identity snapshot, ``run`` raised, the durable start, the confirmAccount rule.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import pytest

import ws_social_support as sup
from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.flows.story_flow import run_story_flow
from clipfactory_api.workspaces.destinations import DestinationProblem, validate_destination
from clipfactory_api.workspaces.flow import StoryFlowStarter, story_flow_name
from clipfactory_api.workspaces.secrets import WorkspaceSecrets
from clipfactory_api.workspaces.sentences import story_sentence
from conftest import USER, Call, Clock
from fakes import FakeDurableContext, FakeHttp, FakeLambda, FakeSecretsManager, FakeTable
from test_oauth_state_formats import GOOD

PUBLISH = f"/v1/workspaces/stories/stories/{sup.STORY_ID}/publish"


@pytest.fixture
def call(app: App) -> Call:
    return sup.ws_call(app)


STORY_SK = f"STORY#{sup.STORY_ID}"
Mutation = Callable[[db.Store, FakeSecretsManager, dict[str, Any]], None]


def _update(sk: str, **fields: Any) -> Mutation:
    def run(store: db.Store, _secrets: FakeSecretsManager, _job: dict[str, Any]) -> None:
        store.update(sup.PK, sk, fields)

    return run


def _remove(sk: str, *names: str) -> Mutation:
    def run(store: db.Store, _secrets: FakeSecretsManager, _job: dict[str, Any]) -> None:
        store.update(sup.PK, sk, {"updatedAt": "x"}, remove=list(names))

    return run


def _no_workspace(store: db.Store, _secrets: FakeSecretsManager, _job: dict[str, Any]) -> None:
    store.delete(f"USER#{USER}#WSREG", "WS#stories")


def _not_stories(store: db.Store, _secrets: FakeSecretsManager, _job: dict[str, Any]) -> None:
    store.update(f"USER#{USER}#WSREG", "WS#stories", {"workspaceType": "clips"})


def _no_account(store: db.Store, _secrets: FakeSecretsManager, _job: dict[str, Any]) -> None:
    store.delete(sup.PK, "SOCIAL#youtube")


def _token(**fields: Any) -> Mutation:
    def run(_store: db.Store, secrets: FakeSecretsManager, _job: dict[str, Any]) -> None:
        name = "cf-prod/workspaces/stories/youtube/token"
        value = {**json.loads(secrets.values[name]), **fields}
        secrets.values[name] = json.dumps({k: v for k, v in value.items() if v is not None})

    return run


def _no_token(_store: db.Store, secrets: FakeSecretsManager, _job: dict[str, Any]) -> None:
    del secrets.values["cf-prod/workspaces/stories/youtube/token"]


def _new_app_keys(_store: db.Store, secrets: FakeSecretsManager, _job: dict[str, Any]) -> None:
    secrets.values["cf-prod/platforms/youtube/app"] = json.dumps(
        {**GOOD["youtube"], "clientId": "999999999999-newkeys.apps.googleusercontent.com"}
    )


def _clips_same(store: db.Store, _secrets: FakeSecretsManager, _job: dict[str, Any]) -> None:
    sup.clips_account(store, None, "youtube", accountId=sup.IDENTITY["youtube"])


def _shared_for_another(store: db.Store, secrets: FakeSecretsManager, job: dict[str, Any]) -> None:
    _clips_same(store, secrets, job)
    store.update(sup.PK, "SOCIAL#youtube", {"sharedWithClips": True, "sharedExternalAccountId": "UC-SOMETHING-ELSE"})


def _job(**fields: Any) -> Mutation:
    def run(store: db.Store, _secrets: FakeSecretsManager, job: dict[str, Any]) -> None:
        store.update(sup.PK, job["sk"], fields)
        job.update(fields)

    return run


# (rule, kind, mutation): every rule of §45.14 alone
RULES: dict[str, tuple[int, str, Mutation]] = {
    "workspace-missing": (1, "workspace", _no_workspace),
    "workspace-not-stories": (1, "workspace", _not_stories),
    "story-in-review": (2, "story", _update(STORY_SK, status="review")),
    "story-rejected": (2, "story", _update(STORY_SK, status="rejected")),
    "story-no-video": (2, "story", _remove(STORY_SK, "videoKey")),
    "story-video-of-another-prefix": (2, "story", _update(STORY_SK, videoKey="jobs/j1/clips/c1/clip.mp4")),
    "story-no-duration": (2, "story", _remove(STORY_SK, "actualDurationSec")),
    "story-of-another-workspace": (2, "story", _update(STORY_SK, workspaceId="01JZ0000000000000000000000")),
    "story-of-another-user": (2, "story", _update(STORY_SK, userId="99999999-8888-7777-6666-555555555555")),
    "account-missing": (3, "not_connected", _no_account),
    "account-of-another-workspace": (
        3,
        "not_connected",
        _update("SOCIAL#youtube", workspaceId="01JZ0000000000000000000000"),
    ),
    "account-id-not-this-workspace": (3, "not_connected", _update("SOCIAL#youtube", socialAccountId="clips.youtube")),
    "account-other-platform": (3, "not_connected", _update("SOCIAL#youtube", platform="x")),
    "account-needs-reconnect": (3, "reconnect", _update("SOCIAL#youtube", connectionStatus="needs_reconnect")),
    "account-not-connected": (3, "not_connected", _update("SOCIAL#youtube", connectionStatus="not_connected")),
    "account-choose": (3, "not_connected", _update("SOCIAL#youtube", connectionStatus="choose_account")),
    "account-same-as-clips": (3, "same_as_clips", _update("SOCIAL#youtube", connectionStatus="same_as_clips")),
    "app-keys-changed": (3, "keys_changed", _new_app_keys),
    "account-changed-after-the-tap": (3, "changed", _update("SOCIAL#youtube", externalAccountId="UC-ANOTHER")),
    "job-for-another-account-id": (3, "not_connected", _job(socialAccountId="clips.youtube")),
    "job-without-identity": (3, "changed", _job(externalAccountId="")),
    "token-missing": (4, "not_connected", _no_token),
    "token-without-identity": (4, "not_connected", _token(channelId=None)),
    "token-of-another-channel": (4, "changed", _token(channelId="UC-ANOTHER")),
    "lamo-clips-own-channel": (5, "same_as_clips", _clips_same),
    "shared-for-another-identity": (5, "same_as_clips", _shared_for_another),
}


@pytest.fixture
def ready(store: db.Store, secrets_client: FakeSecretsManager) -> dict[str, Any]:
    sup.ready(store, secrets_client, "youtube")
    return sup.pubjob(store, "youtube")


def test_a_good_destination_passes(store: db.Store, secrets_client: FakeSecretsManager, ready: dict[str, Any]) -> None:
    found = validate_destination(store, WorkspaceSecrets(secrets_client), USER, "stories", ready)
    assert (found.platform, found.external_account_id, found.social_account_id) == (
        "youtube",
        "UC-STORIES",
        "stories.youtube",
    )


def test_a_shared_destination_passes_only_for_its_identity(
    store: db.Store, secrets_client: FakeSecretsManager, ready: dict[str, Any]
) -> None:
    _clips_same(store, secrets_client, ready)
    store.update(sup.PK, "SOCIAL#youtube", {"sharedWithClips": True, "sharedExternalAccountId": "UC-STORIES"})
    assert validate_destination(store, WorkspaceSecrets(secrets_client), USER, "stories", ready).platform == "youtube"


@pytest.mark.parametrize("name", sorted(RULES))
def test_each_rule_alone_stops_the_check(
    store: db.Store, secrets_client: FakeSecretsManager, ready: dict[str, Any], name: str
) -> None:
    rule, kind, mutate = RULES[name]
    mutate(store, secrets_client, ready)
    with pytest.raises(DestinationProblem) as e:
        validate_destination(store, WorkspaceSecrets(secrets_client), USER, "stories", ready)
    assert (e.value.rule, e.value.kind) == (rule, kind)
    assert "Settings" not in e.value.sentence


def test_a_lamo_clips_workspace_or_another_story_never_validates(
    store: db.Store, secrets_client: FakeSecretsManager, ready: dict[str, Any]
) -> None:
    secrets = WorkspaceSecrets(secrets_client)
    with pytest.raises(DestinationProblem):
        validate_destination(store, secrets, USER, "clips", ready)
    with pytest.raises(DestinationProblem):
        validate_destination(store, secrets, USER, "stories", {**ready, "contentId": "01JZ0000000000000000000ST2"})
    with pytest.raises(DestinationProblem):
        validate_destination(store, secrets, "99999999-8888-7777-6666-555555555555", "stories", ready)
    with pytest.raises(DestinationProblem):
        validate_destination(store, secrets, USER, "stories", {**ready, "platform": "myspace"})


@pytest.mark.parametrize("name", sorted(RULES))
def test_each_rule_alone_stops_a_job_in_the_flow_and_sends_nothing(
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    clock: Clock,
    ready: dict[str, Any],
    name: str,
) -> None:
    _, kind, mutate = RULES[name]
    mutate(store, secrets_client, ready)
    story_before = table.raw(sup.PK, STORY_SK)
    http = FakeHttp()  # no answers: any platform call fails the test
    ctx = FakeDurableContext()
    out = run_story_flow(ctx, sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    assert out["outcome"] == "not_posted"
    assert http.calls == []
    assert ctx.steps == ["load-jobs", "validate-youtube"]
    job = table.raw(sup.PK, ready["sk"])
    assert job is not None
    assert job["publishingStatus"] == "needs_attention", job
    assert job["error"] == story_sentence("youtube", kind, "Lamo Stories youtube")
    assert "Settings" not in job["error"]
    assert table.raw(sup.PK, STORY_SK) == story_before
    acts = [i for i in table.all() if str(i["sk"]).startswith("ACT#")]
    assert [(a["kind"], a["platform"]) for a in acts] == [("failed", "youtube")]


class AfterStep(FakeDurableContext):
    """A fake context that changes the world right after one named step: the next step must notice."""

    def __init__(self, after: str, change: Callable[[], None]) -> None:
        super().__init__()
        self.after = after
        self.change = change

    def step(self, func: Any, name: str | None = None, config: Any = None) -> Any:
        result = super().step(func, name=name, config=config)
        if name == self.after:
            self.change()
        return result


@pytest.mark.parametrize(
    "change",
    ["reconnected-to-another-channel", "secret-of-another-channel", "disconnected", "story-rejected", "same-as-clips"],
)
def test_the_check_runs_inside_the_publish_step_itself(
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    clock: Clock,
    ready: dict[str, Any],
    change: str,
) -> None:
    def changed() -> None:
        if change == "reconnected-to-another-channel":
            store.update(sup.PK, "SOCIAL#youtube", {"externalAccountId": "UC-ANOTHER"})
            _token(channelId="UC-ANOTHER")(store, secrets_client, ready)
        elif change == "secret-of-another-channel":
            _token(channelId="UC-ANOTHER")(store, secrets_client, ready)
        elif change == "disconnected":
            _no_token(store, secrets_client, ready)
        elif change == "story-rejected":
            store.update(sup.PK, STORY_SK, {"status": "rejected"})
        else:
            _clips_same(store, secrets_client, ready)

    http = FakeHttp()
    ctx = AfterStep("validate-youtube", changed)
    run_story_flow(ctx, sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    assert ctx.steps == ["load-jobs", "validate-youtube", "publish-youtube"]
    assert http.calls == []
    job = table.raw(sup.PK, ready["sk"])
    assert job is not None
    assert job["publishingStatus"] == "needs_attention"


def test_the_flow_reads_only_workspace_tokens(
    store: db.Store, secrets_client: FakeSecretsManager, clock: Clock, ready: dict[str, Any]
) -> None:
    secrets_client.values["cf-prod/platforms/youtube/token"] = json.dumps(
        {"accessToken": "CLIPS", "channelId": "UC123"}
    )
    secrets_client.values["cf-prod/platforms/youtube/pending"] = json.dumps({})
    http = FakeHttp()
    _no_token(store, secrets_client, ready)
    run_story_flow(FakeDurableContext(), sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    names = [name for op, name in secrets_client.calls]
    assert "cf-prod/workspaces/stories/youtube/token" in names
    assert all(n.startswith("cf-prod/workspaces/stories/") or n.endswith("/app") for n in names), names
    assert http.calls == []


# --- the publish route ----------------------------------------------------------------------------------------


@pytest.fixture
def starter(app: App, store: db.Store, secrets_client: FakeSecretsManager) -> sup.FakeStarter:
    found = sup.FakeStarter()
    sup.install(app, secrets_client, found)
    sup.ready(store, secrets_client, "youtube", "x", "tiktok")
    return found


TIKTOK = {
    "privacyLevel": "SELF_ONLY",
    "disableComment": False,
    "disableDuet": False,
    "disableStitch": False,
    "brandContent": False,
    "brandOrganic": False,
}


def test_publish_writes_one_job_per_target_with_the_identity_and_starts_the_flow(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter
) -> None:
    targets = [
        {"platform": "youtube", "socialAccountId": "stories.youtube"},
        {"platform": "x", "socialAccountId": "stories.x", "options": {}},
        {"platform": "tiktok", "socialAccountId": "stories.tiktok", "options": TIKTOK},
    ]
    status, body = call("POST", PUBLISH, {"targets": targets})
    assert status == 202, body
    jobs = body["publishingJobs"]
    assert [j["platform"] for j in jobs] == ["youtube", "x", "tiktok"]
    for job in jobs:
        assert job["publishingStatus"] == "queued"
        assert (job["workspaceId"], job["contentId"]) == ("stories", sup.STORY_ID)
        assert job["socialAccountId"] == f"stories.{job['platform']}"
        assert not {"flowRun", "postOptions", "publishHandle", "appChoice", "aiLabel"} & set(job)
        # verify before publish: the answer names the account each job goes to, as checked at the tap
        assert job["externalAccountId"] == sup.IDENTITY[job["platform"]]
        assert (job["accountName"], job["handle"]) == (f"Lamo Stories {job['platform']}", "@lamostories")
        stored = table.raw(sup.PK, f"PUBJOB#{job['publishingJobId']}")
        assert stored is not None
        assert stored["externalAccountId"] == sup.IDENTITY[job["platform"]]
        assert stored["flowRun"] == 1
        assert (stored["appChoice"], stored["aiLabel"]) == ("clips", False)
    youtube = table.raw(sup.PK, f"PUBJOB#{jobs[0]['publishingJobId']}")
    assert youtube is not None
    assert youtube["postOptions"] == {"privacy": "public", "category": "27"}  # the StoriesConfig defaults
    story = table.raw(sup.PK, STORY_SK)
    assert story is not None
    assert (story["run"], story["version"]) == (1, 4)
    assert starter.started == [
        {
            "userId": USER,
            "workspaceId": "stories",
            "storyId": sup.STORY_ID,
            "publishingJobIds": [j["publishingJobId"] for j in jobs],
            "run": 1,
        }
    ]
    assert story_flow_name(sup.STORY_ID, 1) == f"story-{sup.STORY_ID}-1"
    _, listed = call("GET", "/v1/workspaces/stories/publishing", query={"storyId": sup.STORY_ID})
    assert {j["publishingJobId"] for j in listed["publishingJobs"]} == {j["publishingJobId"] for j in jobs}
    assert call("POST", PUBLISH, {"targets": targets[:1]})[0] == 409  # already being posted there


@pytest.mark.parametrize(
    ("targets", "status"),
    [
        ([], 400),
        ([{"platform": "youtube"}], 400),  # no default account: a target names its account
        ([{"platform": "youtube", "socialAccountId": ""}], 400),
        ([{"platform": "youtube", "socialAccountId": "stories.youtube"}] * 2, 400),
        ([{"platform": "myspace", "socialAccountId": "stories.myspace"}], 400),
        ([{"platform": "youtube", "socialAccountId": "stories.youtube", "extra": 1}], 400),
        ([{"platform": "youtube", "socialAccountId": "stories.youtube", "options": {"campaign": {}}}], 400),
        ([{"platform": "youtube", "socialAccountId": "stories.youtube", "options": {"madeForKids": False}}], 400),
        ([{"platform": "youtube", "socialAccountId": "stories.youtube", "options": {"embeddable": False}}], 400),
        ([{"platform": "youtube", "socialAccountId": "stories.youtube", "options": {"category": "20"}}], 400),
        ([{"platform": "x", "socialAccountId": "stories.x", "options": {"replies": "following"}}], 400),
        ([{"platform": "tiktok", "socialAccountId": "stories.tiktok"}], 400),  # privacy has no default
        (
            [
                {
                    "platform": "tiktok",
                    "socialAccountId": "stories.tiktok",
                    "options": {**TIKTOK, "brandContent": True},
                }
            ],
            400,
        ),
        ([{"platform": "youtube", "socialAccountId": "clips.youtube"}], 409),  # Lamo Clips' account: never
        ([{"platform": "facebook", "socialAccountId": "stories.facebook"}], 409),  # not connected
    ],
)
def test_publish_refuses_and_writes_nothing(
    call: Call, table: FakeTable, starter: sup.FakeStarter, targets: list[Any], status: int
) -> None:
    before = json.dumps(table.all(), sort_keys=True, default=str)
    code, body = call("POST", PUBLISH, {"targets": targets})
    assert code == status, body
    assert json.dumps(table.all(), sort_keys=True, default=str) == before
    assert starter.started == []


def test_made_for_kids_is_never_accepted(call: Call, starter: sup.FakeStarter) -> None:
    target = {"platform": "youtube", "socialAccountId": "stories.youtube", "options": {"madeForKids": True}}
    _, body = call("POST", PUBLISH, {"targets": [target]})
    assert body["error"]["message"] == "Lamo Stories videos are never marked as made for kids."


def test_publish_checks_the_story_at_the_tap(call: Call, store: db.Store, starter: sup.FakeStarter) -> None:
    store.update(sup.PK, STORY_SK, {"status": "review"})
    status, body = call("POST", PUBLISH, {"targets": [{"platform": "x", "socialAccountId": "stories.x"}]})
    assert status == 409
    assert body["error"]["message"] == "This story is not ready to post. Approve it first, then tap Try again."
    assert call("POST", "/v1/workspaces/stories/stories/01JZ0000000000000000000ST9/publish", {"targets": []})[0] == 400
    status, _ = call(
        "POST",
        "/v1/workspaces/stories/stories/01JZ0000000000000000000ST9/publish",
        {"targets": [{"platform": "x", "socialAccountId": "stories.x"}]},
    )
    assert status == 404


def test_publish_needs_the_story_flow(
    call: Call, app: App, store: db.Store, secrets_client: FakeSecretsManager
) -> None:
    sup.install(app, secrets_client, None)
    from clipfactory_api.workspaces import deps

    deps.of(app).story_flow_arn = ""
    sup.ready(store, secrets_client, "x")
    status, body = call("POST", PUBLISH, {"targets": [{"platform": "x", "socialAccountId": "stories.x"}]})
    assert status == 503
    assert body["error"]["message"] == "Posting is not switched on for Lamo Stories yet."


def test_a_flow_that_does_not_start_fails_the_jobs_plainly(
    call: Call, app: App, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager
) -> None:
    sup.install(app, secrets_client, sup.FakeStarter(fail=True))
    sup.ready(store, secrets_client, "x")
    status, body = call("POST", PUBLISH, {"targets": [{"platform": "x", "socialAccountId": "stories.x"}]})
    assert status == 503
    assert body["error"]["message"] == "Posting did not start. Tap Try again."
    jobs = [i for i in table.all() if str(i["sk"]).startswith("PUBJOB#")]
    assert [(j["publishingStatus"], j["error"]) for j in jobs] == [("failed", "Posting did not start. Tap Try again.")]


# --- retry and the confirmAccount rule ------------------------------------------------------------------------


def test_retry_asks_before_sending_to_a_new_account(
    call: Call, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, starter: sup.FakeStarter
) -> None:
    store.update(sup.PK, STORY_SK, {"run": 1})
    job = sup.pubjob(
        store, "youtube", publishingStatus="failed", error="YouTube did not answer.", publishHandle={"videoId": "v"}
    )
    path = f"/v1/workspaces/stories/publishing/{job['publishingJobId']}/retry"
    # The owner reconnected Lamo Stories' YouTube to another channel since.
    store.update(sup.PK, "SOCIAL#youtube", {"externalAccountId": "UC-NEW", "accountName": "New Channel"})
    _token(channelId="UC-NEW")(store, secrets_client, job)
    status, body = call("POST", path, {})
    assert status == 409
    assert body["error"]["account"] == {
        "externalAccountId": "UC-NEW",
        "accountName": "New Channel",
        "handle": "@lamostories",
    }
    assert "New Channel" in body["error"]["message"]
    assert call("POST", path, {"confirmAccount": "UC-SOMETHING"})[0] == 409
    assert starter.started == []
    status, body = call("POST", path, {"confirmAccount": "UC-NEW"})
    assert status == 202, body
    assert body["publishingJob"]["publishingStatus"] == "queued"
    assert body["publishingJob"]["accountName"] == "New Channel"
    stored = table.raw(sup.PK, job["sk"])
    assert stored is not None
    assert (stored["externalAccountId"], stored["flowRun"]) == ("UC-NEW", 2)
    assert "error" not in stored
    assert "publishHandle" not in stored
    assert starter.started[-1]["run"] == 2
    assert starter.started[-1]["publishingJobIds"] == [job["publishingJobId"]]
    assert call("POST", path, {})[0] == 409  # queued: nothing stuck to try again


def test_the_new_account_question_names_this_account_and_the_yes_button(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, starter: sup.FakeStarter
) -> None:
    """Round 5 E13: Lamo Stories' YouTube was reconnected to a channel itself named "Lamo Stories": the question
    says "this YouTube account (Lamo Stories)" and the sheet's own button (Yes), never "Tap Post to Lamo Stories"."""
    store.update(sup.PK, STORY_SK, {"run": 1})
    job = sup.pubjob(store, "youtube", publishingStatus="failed", error="YouTube did not answer.")
    store.update(sup.PK, "SOCIAL#youtube", {"externalAccountId": "UC-NEW", "accountName": "Lamo Stories"})
    _token(channelId="UC-NEW")(store, secrets_client, job)
    status, body = call("POST", f"/v1/workspaces/stories/publishing/{job['publishingJobId']}/retry", {})
    assert status == 409, body
    assert body["error"]["message"] == (
        "Lamo Stories' YouTube is a different account now: this YouTube account (Lamo Stories). Tap Yes if that is "
        "right."
    )
    assert starter.started == []


def test_the_new_account_question_never_puts_a_raw_channel_id_in_its_sentence(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, starter: sup.FakeStarter
) -> None:
    """Round 5 E14: a channel with no name and no handle is "this YouTube account"; its id stays in
    ``error.account`` for the sheet's Technical details, never in the first line."""
    store.update(sup.PK, STORY_SK, {"run": 1})
    job = sup.pubjob(store, "youtube", publishingStatus="failed", error="YouTube did not answer.")
    store.update(
        sup.PK, "SOCIAL#youtube", {"externalAccountId": "UCnoNameChannel0000", "accountName": "", "handle": ""}
    )
    _token(channelId="UCnoNameChannel0000")(store, secrets_client, job)
    status, body = call("POST", f"/v1/workspaces/stories/publishing/{job['publishingJobId']}/retry", {})
    assert status == 409, body
    assert body["error"]["message"] == (
        "Lamo Stories' YouTube is a different account now: this YouTube account. Tap Yes if that is right."
    )
    assert "UCnoNameChannel0000" not in body["error"]["message"]
    assert body["error"]["account"]["externalAccountId"] == "UCnoNameChannel0000"
    assert starter.started == []


def test_retry_to_the_same_account_needs_no_confirmation(call: Call, store: db.Store, starter: sup.FakeStarter) -> None:
    job = sup.pubjob(store, "x", publishingStatus="needs_attention", error="X has no credits left.")
    status, body = call("POST", f"/v1/workspaces/stories/publishing/{job['publishingJobId']}/retry", {})
    assert status == 202, body
    assert starter.started[-1]["run"] == 1
    assert call("POST", "/v1/workspaces/stories/publishing/01JZ0000000000000000000NOPE/retry", {})[0] == 404


def test_the_story_flow_starter_uses_the_alias_and_a_fixed_name() -> None:
    lam = FakeLambda()
    starter = StoryFlowStarter(lam, sup.STORY_FLOW_ARN)
    first = starter.start(USER, "stories", sup.STORY_ID, ["J1"], 3)
    assert first.name == f"story-{sup.STORY_ID}-3"
    assert lam.calls[0]["FunctionName"] == sup.STORY_FLOW_ARN
    assert lam.calls[0]["InvocationType"] == "Event"
    assert lam.calls[0]["payload"] == {
        "userId": USER,
        "workspaceId": "stories",
        "storyId": sup.STORY_ID,
        "publishingJobIds": ["J1"],
        "run": 3,
    }
    assert starter.start(USER, "stories", sup.STORY_ID, ["J1"], 3).execution_arn is None  # already started
    from clipfactory_api.workspaces.flow import FlowStartError

    with pytest.raises(FlowStartError):
        StoryFlowStarter(lam, "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-story-flow").start(
            USER, "stories", sup.STORY_ID, ["J1"], 1
        )


# --- app keys that changed are stored where every reader sees them ---------------------------------------------


def test_new_app_keys_found_by_the_check_are_stored_as_needs_reconnect(
    store: db.Store, secrets_client: FakeSecretsManager, clock: Clock, ready: dict[str, Any]
) -> None:
    _new_app_keys(store, secrets_client, ready)
    with pytest.raises(DestinationProblem):
        validate_destination(store, WorkspaceSecrets(secrets_client), USER, "stories", ready, now=clock())
    social = store.get(sup.PK, "SOCIAL#youtube")
    assert social is not None
    assert (social["connectionStatus"], social["reason"]) == ("needs_reconnect", "keys_changed")
    assert social["updatedAt"] == "2026-11-15T12:00:00.000Z"
    assert store.get(f"USER#{USER}", "ACCOUNT#youtube") is None


# --- TikTok: every switch is the owner's own pick ---------------------------------------------------------------


@pytest.mark.parametrize("missing", sorted(TIKTOK))
def test_tiktok_needs_every_pick_of_the_owner(
    call: Call, table: FakeTable, starter: sup.FakeStarter, missing: str
) -> None:
    before = json.dumps(table.all(), sort_keys=True, default=str)
    options = {k: v for k, v in TIKTOK.items() if k != missing}
    target = {"platform": "tiktok", "socialAccountId": "stories.tiktok", "options": options}
    status, body = call("POST", PUBLISH, {"targets": [target]})
    assert status == 400, body
    assert body["error"]["message"].startswith("Pick ")
    assert "TikTok" in body["error"]["message"]
    assert json.dumps(table.all(), sort_keys=True, default=str) == before
    assert starter.started == []


def test_a_tiktok_retry_with_options_needs_every_pick_too(
    call: Call, store: db.Store, starter: sup.FakeStarter
) -> None:
    job = sup.pubjob(store, "tiktok", publishingStatus="failed", error="TikTok did not answer.", postOptions=TIKTOK)
    path = f"/v1/workspaces/stories/publishing/{job['publishingJobId']}/retry"
    status, body = call("POST", path, {"options": {"privacyLevel": "SELF_ONLY"}})
    assert status == 400, body
    assert starter.started == []
    status, body = call("POST", path, {})  # the stored picks
    assert status == 202, body


# --- one story goes to one platform once, retry included --------------------------------------------------------


@pytest.mark.parametrize(
    ("other", "message"),
    [
        ("posted", "This story is already on YouTube."),
        ("queued", "This story is already being posted to YouTube."),
        ("publishing", "This story is already being posted to YouTube."),
    ],
)
def test_retry_never_posts_a_story_twice_on_one_platform(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter, other: str, message: str
) -> None:
    old = sup.pubjob(store, "youtube", "01JZ0000000000000000000PJ1", publishingStatus="failed", error="x")
    sup.pubjob(
        store, "youtube", "01JZ0000000000000000000PJ2", publishingStatus=other, updatedAt="2026-11-15T11:59:00.000Z"
    )
    before = json.dumps(table.all(), sort_keys=True, default=str)
    status, body = call("POST", f"/v1/workspaces/stories/publishing/{old['publishingJobId']}/retry", {})
    assert status == 409, body
    assert body["error"]["message"] == message
    assert json.dumps(table.all(), sort_keys=True, default=str) == before
    assert starter.started == []


def test_retry_is_fine_when_the_other_jobs_are_elsewhere(call: Call, store: db.Store, starter: sup.FakeStarter) -> None:
    old = sup.pubjob(store, "youtube", "01JZ0000000000000000000PJ1", publishingStatus="failed", error="x")
    sup.pubjob(store, "x", "01JZ0000000000000000000PJ2", publishingStatus="posted")
    sup.pubjob(store, "youtube", "01JZ0000000000000000000PJ3", publishingStatus="needs_attention", error="y")
    status, body = call("POST", f"/v1/workspaces/stories/publishing/{old['publishingJobId']}/retry", {})
    assert status == 202, body


# --- a job whose story flow is gone is never stuck -------------------------------------------------------------

LONG_AGO = "2026-11-15T05:59:00.000Z"  # 6 h 1 min before the clock's 12:00


@pytest.mark.parametrize(
    ("status", "handle", "sentence"),
    [
        ("queued", None, "Posting did not start. Tap Try again."),
        ("queued", {"publishId": "p"}, "We are not sure it posted. Look on YouTube before you tap Try again."),
        ("publishing", None, "We are not sure it posted. Look on YouTube before you tap Try again."),
    ],
)
def test_the_list_fails_a_job_left_in_flight_by_a_flow_that_is_gone(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter, status: str, handle: Any, sentence: str
) -> None:
    fields: dict[str, Any] = {"publishingStatus": status, "updatedAt": LONG_AGO}
    if handle:
        fields["publishHandle"] = handle
    job = sup.pubjob(store, "youtube", **fields)
    sup.pubjob(store, "x", "01JZ0000000000000000000PJ2", publishingStatus="publishing")  # a live one stays
    _, listed = call("GET", "/v1/workspaces/stories/publishing")
    shown = {j["platform"]: j for j in listed["publishingJobs"]}
    assert (shown["youtube"]["publishingStatus"], shown["youtube"]["error"]) == ("failed", sentence)
    assert shown["x"]["publishingStatus"] == "publishing"
    stored = table.raw(sup.PK, job["sk"])
    assert stored is not None
    assert (stored["publishingStatus"], stored["error"], stored["flowRun"]) == ("failed", sentence, 1)


def test_a_job_in_flight_for_less_than_six_hours_is_left_alone(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter
) -> None:
    job = sup.pubjob(store, "youtube", publishingStatus="publishing", updatedAt="2026-11-15T06:00:01.000Z")
    _, listed = call("GET", "/v1/workspaces/stories/publishing")
    assert listed["publishingJobs"][0]["publishingStatus"] == "publishing"
    assert call("POST", f"/v1/workspaces/stories/publishing/{job['publishingJobId']}/retry", {})[0] == 409
    assert call("POST", PUBLISH, {"targets": [{"platform": "youtube", "socialAccountId": "stories.youtube"}]})[0] == 409
    assert starter.started == []


def test_try_again_on_a_stuck_job(call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter) -> None:
    store.update(sup.PK, STORY_SK, {"run": 1})
    queued = sup.pubjob(store, "x", "01JZ0000000000000000000PJ2", updatedAt=LONG_AGO)
    status, body = call("POST", f"/v1/workspaces/stories/publishing/{queued['publishingJobId']}/retry", {})
    assert status == 202, body  # it never started: Try again just goes
    assert starter.started[-1]["publishingJobIds"] == [queued["publishingJobId"]]
    reached = sup.pubjob(store, "youtube", publishingStatus="publishing", updatedAt=LONG_AGO)
    path = f"/v1/workspaces/stories/publishing/{reached['publishingJobId']}/retry"
    status, body = call("POST", path, {})
    assert status == 409  # it may be on YouTube: the owner looks there first
    assert body["error"]["message"] == "We are not sure it posted. Look on YouTube before you tap Try again."
    status, body = call("POST", path, {})
    assert status == 202, body
    stored = table.raw(sup.PK, reached["sk"])
    assert stored is not None
    assert (stored["publishingStatus"], stored["flowRun"]) == ("queued", 3)


def test_publish_after_a_stuck_job_posts_again(call: Call, store: db.Store, starter: sup.FakeStarter) -> None:
    sup.pubjob(store, "youtube", updatedAt=LONG_AGO)
    status, body = call("POST", PUBLISH, {"targets": [{"platform": "youtube", "socialAccountId": "stories.youtube"}]})
    assert status == 202, body
    assert len(starter.started) == 1
