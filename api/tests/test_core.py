"""ids, db, s3 and the agent client."""

from __future__ import annotations

import io
from decimal import Decimal
from urllib.parse import parse_qs, urlsplit

import boto3
import pytest
from botocore.config import Config

from clipfactory_api import db, ids, s3
from clipfactory_api.agent_client import AgentClient, AgentError, new_session_id
from clipfactory_api.errors import ApiError
from fakes import FakeAgentCore, FakeS3, FakeTable, decimal_free

# --- ids ------------------------------------------------------------------------------------------------------


def test_ulid_shape() -> None:
    value = ids.ulid()
    assert len(value) == 26
    assert ids.is_ulid(value)
    assert not ids.is_ulid("x" * 26)
    assert not ids.is_ulid("8" + value[1:])  # beyond the 48-bit time range


def test_ulid_is_time_sortable() -> None:
    earlier = ids.ulid(now_ms=1_800_000_000_000)
    later = ids.ulid(now_ms=1_800_000_000_001)
    assert earlier < later
    assert earlier[:10] < later[:10]


def test_ulid_monotonic_within_a_millisecond() -> None:
    values = [ids.ulid(now_ms=1_900_000_000_000) for _ in range(500)]
    assert values == sorted(values)
    assert len(set(values)) == len(values)


def test_ulid_survives_clock_step_back() -> None:
    first = ids.ulid(now_ms=1_950_000_000_000)
    assert ids.ulid(now_ms=1_000_000_000_000) > first


def test_ulid_encodes_time() -> None:
    value = ids.ulid(now_ms=2_000_000_000_000)
    decoded = 0
    for ch in value[:10]:
        decoded = decoded * 32 + ids.ALPHABET.index(ch)
    assert decoded == 2_000_000_000_000


# --- db -------------------------------------------------------------------------------------------------------


def test_numbers_round_trip(table: FakeTable) -> None:
    store = db.Store(table)
    store.put({"pk": "P", "sk": "S", "f": 1.5, "i": 3, "nested": {"x": [0.25, 2]}, "none": None})
    raw = table.raw("P", "S")
    assert raw is not None
    assert raw["f"] == Decimal("1.5")
    assert "none" not in raw
    item = store.get("P", "S")
    assert item == {"pk": "P", "sk": "S", "f": 1.5, "i": 3, "nested": {"x": [0.25, 2]}}
    assert isinstance(item["i"], int)
    assert decimal_free(item)


def test_update_conditions(table: FakeTable) -> None:
    store = db.Store(table)
    with pytest.raises(db.ConditionFailed):
        store.update("P", "S", {"a": 1})  # missing item
    store.put({"pk": "P", "sk": "S", "status": "running", "gone": 1})
    with pytest.raises(db.ConditionFailed):
        store.update("P", "S", {"status": "x"}, expect_in={"status": ["queued"]})
    out = store.update("P", "S", {"status": "done"}, remove=["gone"], expect_in={"status": ["queued", "running"]})
    assert out == {"pk": "P", "sk": "S", "status": "done"}
    with pytest.raises(ValueError, match="at least one"):
        store.update("P", "S", {})


def test_put_if_absent(table: FakeTable) -> None:
    store = db.Store(table)
    store.put({"pk": "P", "sk": "S"}, if_absent=True)
    with pytest.raises(db.ConditionFailed):
        store.put({"pk": "P", "sk": "S"}, if_absent=True)


def test_other_errors_pass_through() -> None:
    class Broken(FakeTable):
        def put_item(self, **kw: object) -> dict[str, object]:
            raise RuntimeError("network")

    with pytest.raises(RuntimeError):
        db.Store(Broken()).put({"pk": "P", "sk": "S"})


def test_cursor_round_trip_and_scoping() -> None:
    key = {"pk": "USER#u", "sk": "JOB#01"}
    cursor = db.encode_cursor(key)
    assert cursor is not None
    assert "=" not in cursor
    assert db.decode_cursor(cursor, "USER#u", "JOB#") == key
    assert db.encode_cursor(None) is None
    assert db.decode_cursor(None, "USER#u", "JOB#") is None
    for bad in (
        "%%%",
        "WzFd",
        db.encode_cursor({"pk": "USER#other", "sk": "JOB#01"}),
        db.encode_cursor({"pk": "USER#u", "sk": "SKILL#x"}),  # outside the queried range
        db.encode_cursor({"pk": "USER#u", "sk": "JOB#01", "foo": "bar"}),  # not a table key
        db.encode_cursor({"pk": "USER#u"}),
        db.encode_cursor({"pk": "USER#u", "sk": 5}),
    ):
        with pytest.raises(ApiError):
            db.decode_cursor(bad, "USER#u", "JOB#")


def test_query_all_follows_pages(table: FakeTable) -> None:
    store = db.Store(table)
    for n in range(7):
        store.put({"pk": "P", "sk": f"JOB#{n}"})
    store.put({"pk": "P", "sk": "CLIP#1"})
    real_query = table.query

    def small_pages(**kw: object) -> dict[str, object]:
        return real_query(**{**kw, "Limit": 3})

    table.query = small_pages  # type: ignore[method-assign]
    assert [i["sk"] for i in store.query_all("P", "JOB#", newest_first=True)] == [f"JOB#{n}" for n in range(6, -1, -1)]


def test_strip_keys() -> None:
    item = {"pk": 1, "sk": 2, "gsi1pk": 3, "gsi1sk": 4, "type": "t", "userId": "u", "ttl": 5, "a": 6, "secret": 7}
    assert db.strip_keys(item, ["secret"]) == {"a": 6}


# --- s3 -------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("stream.mp4", "stream.mp4"),
        ("../../etc/passwd", "passwd"),
        ("C:\\Users\\me\\Vidéo final.mov", "Video-final.mov"),
        ("...", "file"),
        ("", "file"),
        ("a" * 300 + ".mp4", "a" * 116 + ".mp4"),
    ],
)
def test_safe_filename(name: str, expected: str) -> None:
    assert s3.safe_filename(name) == expected


def test_keys_are_scoped() -> None:
    assert s3.upload_key("u1", "ID", "../x.mp4") == "uploads/u1/ID/x.mp4"
    rev = "01JABCDEFGHJKMNPQRSTVWXYZ0"
    assert s3.skill_key("u1", "S", rev, "zip") == f"skills/u1/S/{rev}/skill.zip"
    assert s3.skill_key("u1", "S", rev, "md") == f"skills/u1/S/{rev}/SKILL.md"
    assert s3.skill_key_format(f"skills/u1/S/{rev}/skill.zip", "u1", "S") == "zip"
    assert s3.skill_key_format("skills/u1/S/SKILL.md", "u1", "S") is None
    assert s3.skill_key_format("skills/u1/S/SKILL.md", "u1", "S", legacy=True) == "md"
    assert s3.skill_key_format(f"skills/u2/S/{rev}/SKILL.md", "u1", "S") is None
    assert s3.skill_key_format(f"skills/u1/S/{rev}/../SKILL.md", "u1", "S") is None
    assert s3.is_revision_key(f"skills/u1/S/{rev}/SKILL.md")
    assert not s3.is_revision_key("skills/u1/S/SKILL.md")
    assert s3.cookies_key("u1") == "private/u1/youtube-cookies.txt"
    assert s3.clip_prefix("J", "C") == "jobs/J/clips/C/"
    assert not s3.is_safe_key("uploads/u1/../u2/x")
    assert not s3.is_safe_key("/abs")
    assert not s3.is_safe_key("a//b")


def test_media_head_read_delete() -> None:
    fake = FakeS3()
    media = s3.Media(fake, "b")
    assert media.head("missing") is None
    fake.objects["jobs/J/clips/C/clip.mp4"] = b"12345"
    fake.objects["jobs/J/clips/C/cover.jpg"] = b"1"
    fake.objects["jobs/J/clips/D/clip.mp4"] = b"1"
    assert media.head("jobs/J/clips/C/clip.mp4") == {"ContentLength": 5}
    assert media.read("jobs/J/clips/C/clip.mp4", 5) == b"12345"
    with pytest.raises(ValueError, match="larger"):
        media.read("jobs/J/clips/C/clip.mp4", 4)
    assert media.delete_prefix("jobs/J/clips/C/") == 2
    assert list(fake.objects) == ["jobs/J/clips/D/clip.mp4"]
    for bad in ("", "jobs/../", "jobs/J"):
        with pytest.raises(ValueError, match="unsafe"):
            media.delete_prefix(bad)


def test_real_presign_is_sigv4_regional_virtual_host() -> None:
    """Signs locally with dummy keys (no network): the URL shape browsers will PUT to."""
    client = boto3.client(
        "s3",
        region_name="eu-north-1",
        aws_access_key_id="AKIDEXAMPLE",
        aws_secret_access_key="secret",
        config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}),
    )
    url = s3.Media(client, "cf-prod-media-123").presign_put("uploads/u1/ID/x.mp4", "video/mp4")
    parts = urlsplit(url)
    assert parts.hostname == "cf-prod-media-123.s3.eu-north-1.amazonaws.com"
    assert parts.path == "/uploads/u1/ID/x.mp4"
    query = parse_qs(parts.query)
    assert query["X-Amz-Algorithm"] == ["AWS4-HMAC-SHA256"]
    assert query["X-Amz-Expires"] == ["3600"]
    assert "content-type" in query["X-Amz-SignedHeaders"][0]


def test_vendored_boto3_knows_agentcore() -> None:
    assert "bedrock-agentcore" in boto3.session.Session().get_available_services()


def test_vendored_boto3_knows_durable_executions_and_s3vectors() -> None:
    """The locked boto3 (the copy build_lambda.py vendors) must expose what §14 calls (docs/CONTRACTS.md §14.10)."""
    session = boto3.session.Session()
    assert "s3vectors" in session.get_available_services()
    lam = session.client("lambda", region_name="eu-north-1")
    invoke = lam.meta.service_model.operation_model("Invoke")
    assert "DurableExecutionName" in invoke.input_shape.members
    assert "DurableExecutionArn" in invoke.output_shape.members
    for op in (
        "send_durable_execution_callback_success",
        "send_durable_execution_callback_failure",
        "send_durable_execution_callback_heartbeat",
    ):
        assert hasattr(lam, op), op
    s3v = session.client("s3vectors", region_name="eu-north-1")
    for op in ("put_vectors", "get_vectors", "query_vectors", "delete_vectors"):
        assert hasattr(s3v, op), op
    assert "apigatewaymanagementapi" in session.get_available_services()


def test_only_the_durable_handlers_load_the_durable_sdk() -> None:
    """The HTTP, realtime and hooks Lambdas never import the durable execution SDK (cold starts, §14.10)."""
    import subprocess
    import sys

    code = (
        "import sys\n"
        "import clipfactory_api.http, clipfactory_api.routes, clipfactory_api.hooks\n"
        "import clipfactory_api.realtime.authorizer, clipfactory_api.realtime.ws, clipfactory_api.realtime.broadcast\n"
        "import clipfactory_api.stats.handler, clipfactory_api.weekly\n"
        "assert not any(m.startswith('aws_durable_execution_sdk_python') for m in sys.modules), 'durable SDK loaded'\n"
        "import clipfactory_api.flows.job_flow, clipfactory_api.flows.clip_flow\n"
        "assert 'aws_durable_execution_sdk_python' in sys.modules\n"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=False)
    assert out.returncode == 0, out.stderr


# --- agent client ---------------------------------------------------------------------------------------------


def test_session_id_rule() -> None:
    job_id = ids.ulid()
    session = new_session_id(job_id)
    assert session.startswith(f"cfjob-{job_id}-")
    suffix = session.rsplit("-", 1)[1]
    assert len(suffix) == 8
    assert suffix.isalnum()
    assert suffix == suffix.lower()
    assert len(session) >= 33
    assert new_session_id(job_id) != session


def test_agent_client_payloads() -> None:
    fake = FakeAgentCore()
    client = AgentClient(fake, "arn:runtime")
    client.start_job("J", "U", "cfjob-J-abcdefgh", "cb-1")
    client.cancel_job("J", "cfjob-J-abcdefgh")
    start, cancel = fake.calls
    assert start["agentRuntimeArn"] == "arn:runtime"
    assert start["contentType"] == "application/json"
    assert start["payload"] == {"action": "process_job", "jobId": "J", "userId": "U", "callbackId": "cb-1"}
    assert cancel["payload"] == {"action": "cancel", "jobId": "J"}


def test_agent_client_errors() -> None:
    with pytest.raises(AgentError):
        AgentClient(FakeAgentCore(), "").start_job("J", "U", "s", "cb")

    class Failing:
        def invoke_agent_runtime(self, **_: object) -> dict[str, object]:
            return {"statusCode": 500, "response": io.BytesIO(b"oops")}

    with pytest.raises(AgentError, match="500") as e:
        AgentClient(Failing(), "arn").start_job("J", "U", "s", "cb")
    assert e.value.retryable

    throttled = FakeAgentCore()
    throttled.fail = True  # 503 ServiceUnavailableException
    with pytest.raises(AgentError) as e:
        AgentClient(throttled, "arn").start_job("J", "U", "s", "cb")
    assert e.value.retryable

    refused = FakeAgentCore()
    refused.reply = {"accepted": False}
    with pytest.raises(AgentError) as e:
        AgentClient(refused, "arn").start_job("J", "U", "s", "cb")
    assert not e.value.retryable


def test_agent_client_fits_inside_the_api_lambda_timeout() -> None:
    from clipfactory_api import agent_client

    client = agent_client.make_client("eu-north-1")
    config = client.meta.config
    attempts = config.retries["total_max_attempts"]  # botocore counts the first try here
    assert attempts == 1
    assert (config.connect_timeout + config.read_timeout) * attempts < 29


def test_every_lambda_builds_its_clients_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Wiring only: boto3 clients are created offline, nothing is called (docs/CONTRACTS.md §9 environment)."""
    from clipfactory_api import app as app_module
    from clipfactory_api import hooks
    from clipfactory_api.flows import clip_flow, job_flow
    from clipfactory_api.realtime import authorizer, broadcast, ws

    env = {
        "AWS_REGION": "eu-north-1",
        "AWS_ACCESS_KEY_ID": "testing",
        "AWS_SECRET_ACCESS_KEY": "testing",
        "TABLE_NAME": "cf-prod-data",
        "MEDIA_BUCKET": "cf-prod-media-123",
        "AGENT_RUNTIME_ARN": "arn:aws:bedrock-agentcore:eu-north-1:123456789012:runtime/cf_prod_clip_agent-abc",
        "JOB_FLOW_ARN": "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-job-flow:live",
        "CLIP_FLOW_ARN": "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-clip-flow:live",
        "VECTOR_BUCKET": "cf-prod-vectors-123",
        "VECTOR_INDEX": "clips",
        "MODEL_ID": "global.anthropic.claude-fable-5-1",
        "EMBED_MODEL_ID": "amazon.titan-embed-text-v2:0",
        "WS_ENDPOINT": "https://abc123.execute-api.eu-north-1.amazonaws.com/live",
        "APP_URL": "https://d111.cloudfront.net",
        "USER_POOL_ID": "eu-north-1_Pool",
        "USER_POOL_CLIENT_ID": "client",
    }
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    api = app_module.from_env()
    assert api.flows.job_flow_arn.endswith(":cf-prod-job-flow:live")
    assert api.flows.clip_flow_arn.endswith(":cf-prod-clip-flow:live")
    assert api.vectors is not None
    assert (api.vectors.bucket, api.vectors.index) == ("cf-prod-vectors-123", "clips")
    assert job_flow._from_env().agent is not None
    flow = clip_flow._from_env()
    assert flow.model_id == "global.anthropic.claude-fable-5-1"
    assert flow.vectors is not None
    assert flow.vectors.embed_model_id == "amazon.titan-embed-text-v2:0"
    assert ws._from_env().ttl_seconds == 7200
    assert broadcast._from_env().management.meta.endpoint_url == env["WS_ENDPOINT"]
    assert hooks._from_env().app_url == env["APP_URL"]
    verifier = authorizer._get_verifier()
    assert verifier.issuer == "https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_Pool"
    authorizer._verifier = None
