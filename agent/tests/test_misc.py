from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import pytest

from clipfactory_agent import learnings, sources
from clipfactory_agent.config import load_config, model_from_models_json
from clipfactory_agent.loudness import first_loud_second, parse_astats, spikes
from clipfactory_agent.proc import CommandError, error_tail, parse_probe, run
from clipfactory_agent.retry import is_transient, retry
from clipfactory_agent.schema import check
from clipfactory_agent.store import from_ddb, to_ddb
from clipfactory_agent.util import TransientError, UserFacingError, hms, ulid

REPO = Path(__file__).resolve().parents[2]


def test_ulid_is_sortable_and_well_formed() -> None:
    a = ulid(1_700_000_000_000, bytes(10))
    b = ulid(1_700_000_000_001, bytes(10))
    assert len(a) == 26 and a < b
    assert set(ulid()) <= set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")


def test_hms() -> None:
    assert hms(0) == "0:00:00" and hms(3725.4) == "1:02:05"


def test_schema_check() -> None:
    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["a", "b"],
        "properties": {
            "a": {"type": "integer", "minimum": 1},
            "b": {"type": "array", "maxItems": 1, "items": {"type": "string", "enum": ["x"]}},
            "c": {"type": ["string", "null"]},
        },
    }
    assert check(schema, {"a": 1, "b": ["x"], "c": None}) == []
    assert check(schema, {"a": True, "b": ["y", "x"], "d": 1}) == [
        "$.d is not allowed",
        "$.a should be integer",
        "$.b has more than 1 items",
        "$.b[0] must be one of ['x']",
    ]
    assert check(schema, []) == ["$ should be object"]


def test_ddb_conversion() -> None:
    item = to_ddb({"a": 1.5, "b": [2.0, {"c": float("nan")}], "d": None, "e": True})
    assert item == {"a": Decimal("1.5"), "b": [Decimal("2.0"), {}], "e": True}
    assert from_ddb({"a": Decimal("2"), "b": [Decimal("1.25")]}) == {"a": 2, "b": [1.25]}


def test_config(tmp_path: Path) -> None:
    assert model_from_models_json(REPO / "config" / "models.json") == "global.anthropic.claude-fable-5-1"
    cfg = load_config({"CF_REGION": "eu-north-1", "CF_TABLE": "t", "CF_MEDIA_BUCKET": "b", "CF_MODEL_ID": "m"})
    assert cfg.skills_dir == Path("/app/skills") and cfg.model_id == "m"
    with pytest.raises(RuntimeError, match="CF_TABLE"):
        load_config({"CF_REGION": "r", "CF_MEDIA_BUCKET": "b", "CF_MODEL_ID": "m"})


def test_deep_config(tmp_path: Path) -> None:
    base = {"CF_REGION": "eu-north-1", "CF_TABLE": "t", "CF_MEDIA_BUCKET": "b", "CF_MODEL_ID": "m"}
    assert model_from_models_json(REPO / "config" / "models.json", "watchModel") == "eu.amazon.nova-2-lite-v1:0"
    cfg = load_config({**base, "CF_CONFIG_DIR": str(REPO / "config")})
    assert cfg.watch_model_id == "eu.amazon.nova-2-lite-v1:0" and cfg.deep_enabled is True  # on by default
    assert load_config({**base, "CF_WATCH_MODEL_ID": "eu.other"}).watch_model_id == "eu.other"
    assert load_config({**base, "CF_CONFIG_DIR": str(tmp_path)}).watch_model_id is None  # no file: Nova is off
    for off in ("off", "OFF", " off "):
        assert load_config({**base, "CF_DEEP": off}).deep_enabled is False
    for on in ("on", "", "1", "true"):
        assert load_config({**base, "CF_DEEP": on}).deep_enabled is True
    models = json.loads((REPO / "config" / "models.json").read_text("utf-8"))
    nova = models["models"][models["watchModel"]]
    assert nova["modelId"] == "amazon.nova-2-lite-v1:0" and nova["profilePrefix"] == "eu"
    assert nova["profileRegions"] == [
        "eu-central-1",
        "eu-north-1",
        "eu-south-1",
        "eu-south-2",
        "eu-west-1",
        "eu-west-3",
    ]


def test_model_profile_prefix_per_model(tmp_path: Path) -> None:
    def write(models: dict[str, object], top: str | None = "global") -> Path:
        data: dict[str, object] = {"agentModel": "a", "models": models}
        if top is not None:
            data["profilePrefix"] = top
        path = tmp_path / "models.json"
        path.write_text(json.dumps(data), "utf-8")
        return path

    assert model_from_models_json(write({"a": {"modelId": "anthropic.m", "profilePrefix": "eu"}})) == "eu.anthropic.m"
    assert model_from_models_json(write({"a": {"modelId": "anthropic.m"}})) == "global.anthropic.m"
    assert model_from_models_json(write({"a": {"modelId": "anthropic.m", "profilePrefix": ""}})) == "global.anthropic.m"
    assert model_from_models_json(write({"a": {"modelId": "anthropic.m"}}, top=None)) == "anthropic.m"
    assert model_from_models_json(write({"b": {"modelId": "anthropic.m"}})) is None


def test_platforms_and_links() -> None:
    assert sources.platform_of("https://www.youtube.com/watch?v=abc") == "youtube"
    assert sources.platform_of("https://youtu.be/abc") == "youtube"
    assert sources.platform_of("https://www.twitch.tv/videos/123") == "twitch"
    assert sources.platform_of("https://kick.com/x/videos/1") == "kick"
    assert sources.platform_of("https://evil-youtube.com/x") is None
    assert sources.platform_of("file:///etc/passwd") is None
    with pytest.raises(UserFacingError):
        sources.check_link("https://example.com/video.mp4")


def test_url_at() -> None:
    assert (
        sources.url_at("https://www.youtube.com/watch?v=abc&t=5", "youtube", 125.7)
        == "https://www.youtube.com/watch?v=abc&t=125s"
    )
    assert sources.url_at("https://www.twitch.tv/videos/1", "twitch", 3725) == "https://www.twitch.tv/videos/1?t=1h2m5s"
    assert sources.url_at("https://kick.com/v/1", "kick", 10) is None


def test_explain_ytdlp_errors() -> None:
    def e(tail: str) -> CommandError:
        return CommandError("yt-dlp", 1, tail)

    assert str(sources.explain(e("ERROR: Sign in to confirm you’re not a bot"), "youtube", False)) == (
        sources.BLOCKED_NO_COOKIES
    )
    assert str(sources.explain(e("Sign in to confirm you're not a bot"), "youtube", True)) == (
        sources.BLOCKED_WITH_COOKIES
    )
    assert "private" in str(sources.explain(e("ERROR: Private video"), "youtube", False))
    assert isinstance(sources.explain(e("HTTP Error 503: Service Unavailable"), "twitch", False), UserFacingError)
    assert isinstance(sources.explain(e("Read timed out"), "twitch", False), TransientError)


def test_source_fields_and_heatmap() -> None:
    info = {
        "title": "Stream",
        "uploader": "Me",
        "duration": 3600,
        "thumbnail": "https://i/x.jpg",
        "heatmap": [{"start_time": 0, "end_time": 10, "value": 0.5}, {"bad": 1}],
    }
    assert sources.source_fields(info, "youtube") == {
        "platform": "youtube",
        "title": "Stream",
        "channel": "Me",
        "durationSec": 3600.0,
        "thumbnailUrl": "https://i/x.jpg",
    }
    assert sources.heatmap(info) == [{"start": 0.0, "end": 10.0, "value": 0.5}]
    # §16.12: the channel id is kept when the site gives one (the creator key prefers it to the name).
    assert sources.source_fields({**info, "channel_id": "UC1"}, "youtube")["channelId"] == "UC1"
    seen: list[float] = []
    sources.progress_reader(seen.append)("[download]  42.5% of ~ 100.00MiB at 2.00MiB/s ETA 00:30")
    assert seen == [0.425]


def test_loudness() -> None:
    text = "frame:0\nlavfi.astats.Overall.RMS_level=-20.55\nframe:1\nlavfi.astats.Overall.RMS_level=-inf\n"
    assert parse_astats(text) == [-20.6, -90.0]
    loud = [-40.0] * 200
    loud[100] = -15.0
    loud[103] = -12.0  # merged with 100: the louder one stays
    loud[150] = -45.0 + 30  # a big jump
    found = spikes(loud)
    assert [s.t for s in found] == [103, 150]
    assert spikes(loud, limit=1)[0].t == 103
    assert first_loud_second(loud, 101.5) == pytest.approx(102.8)
    assert first_loud_second(loud, 10) == 10


def test_learnings_texts() -> None:
    rows = [
        {"learningId": "01A", "text": " old  one "},
        {"learningId": "01C", "text": ""},
        {"learningId": "01B", "text": "new"},
    ]
    assert learnings.texts(rows, 10) == ["new", "old one"]


def test_probe_and_tail() -> None:
    info = parse_probe(
        json.dumps(
            {
                "format": {"duration": "12.5"},
                "streams": [{"codec_type": "video", "width": 1920, "height": 1080}, {"codec_type": "audio"}],
            }
        ).encode()
    )
    assert (info.duration, info.width, info.height, info.has_audio) == (12.5, 1920, 1080, True)
    assert error_tail("ok\nERROR: thing failed\nmore\n") == "ERROR: thing failed"


async def test_run_reports_failures() -> None:
    r = await run(["python3", "-c", "import sys; print('out'); print('progress 1', file=sys.stderr)"], time_limit=30)
    assert r.stdout.strip() == b"out" and "progress 1" in r.stderr
    with pytest.raises(CommandError, match="exit 3"):
        await run(["python3", "-c", "import sys; print('ERROR: nope', file=sys.stderr); sys.exit(3)"], time_limit=30)
    with pytest.raises(TimeoutError):
        await run(["python3", "-c", "import time; time.sleep(5)"], time_limit=0.2)


async def test_retry_only_transient() -> None:
    calls = {"n": 0}

    async def flaky() -> str:
        calls["n"] += 1
        if calls["n"] < 3:
            raise TransientError("x")
        return "ok"

    assert await retry(flaky, what="t", base=0.001) == "ok"

    async def fatal() -> str:
        raise ValueError("no")

    with pytest.raises(ValueError):
        await retry(fatal, what="t", base=0.001)

    class Throttled(Exception):
        def __init__(self) -> None:
            self.response = {"Error": {"Code": "ThrottlingException"}, "ResponseMetadata": {"HTTPStatusCode": 400}}

    assert is_transient(Throttled()) and not is_transient(ValueError())
