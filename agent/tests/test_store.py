"""S3 writes under jobs/{jobId}/source/ carry the retention tag the 14-day lifecycle rule matches (CONTRACTS.md §7)."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from clipfactory_agent.store import TEMPORARY_TAGGING, Store, is_temporary, source_prefix

REPO = Path(__file__).resolve().parents[2]


class FakeS3:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    def __getattr__(self, name: str) -> Any:
        def record(*args: Any, **kwargs: Any) -> dict[str, Any]:
            self.calls.append((name, args, kwargs))
            return {}

        return record


class FakeSession:
    def __init__(self, s3: FakeS3) -> None:
        self.s3 = s3

    def resource(self, *_: Any, **__: Any) -> Any:
        class Resource:
            def Table(self, name: str) -> str:
                return name

        return Resource()

    def client(self, service: str, **_: Any) -> Any:
        return self.s3 if service == "s3" else object()


def make_store() -> tuple[Store, FakeS3]:
    s3 = FakeS3()
    return Store("table", "bucket", "us-east-1", session=FakeSession(s3)), s3


def test_is_temporary_matches_only_job_sources() -> None:
    assert is_temporary(source_prefix("J1") + "video.mp4")
    assert is_temporary("jobs/J1/source/transcript.part2.json")
    assert not is_temporary("jobs/J1/clips/C1/clip.mp4")
    assert not is_temporary("jobs//source/video.mp4")
    assert not is_temporary("jobs/J1/source")
    assert not is_temporary("uploads/U/x.mp4")
    assert not is_temporary("private/U/youtube-cookies.txt")


async def test_source_writes_are_tagged_and_clip_writes_are_not(tmp_path: Path) -> None:
    store, s3 = make_store()
    f = tmp_path / "a.m4a"
    f.write_bytes(b"x")
    await store.put_json("jobs/J/source/meta.json", {"a": 1})
    await store.put_json("jobs/J/clips/C/meta.json", {"a": 1})
    await store.upload(f, "jobs/J/source/audio.m4a", "audio/mp4")
    await store.upload(f, "jobs/J/clips/C/clip.mp4", "video/mp4")
    await store.copy("uploads/U/in.mp4", "jobs/J/source/video.mp4")
    await store.copy("jobs/J/source/video.mp4", "jobs/J/clips/C/raw.mp4")
    await store.tag_temporary("jobs/J/source/transcript.json")

    (put_src, put_clip, up_src, up_clip, cp_src, cp_clip, tag) = s3.calls
    assert put_src[0] == "put_object" and put_src[2]["Tagging"] == TEMPORARY_TAGGING
    assert "Tagging" not in put_clip[2]
    assert up_src[2]["ExtraArgs"] == {"ContentType": "audio/mp4", "Tagging": TEMPORARY_TAGGING}
    assert up_clip[2]["ExtraArgs"] == {"ContentType": "video/mp4"}
    assert cp_src[2]["ExtraArgs"] == {"TaggingDirective": "REPLACE", "Tagging": TEMPORARY_TAGGING}
    assert cp_clip[2]["ExtraArgs"] is None
    assert tag[0] == "put_object_tagging" and tag[2]["Key"] == "jobs/J/source/transcript.json"
    assert tag[2]["Tagging"] == {"TagSet": [{"Key": "cf-retention", "Value": "temporary"}]}


def test_tag_matches_the_infra_lifecycle_rule() -> None:
    variables = (REPO / "infra/modules/storage/variables.tf").read_text()
    key = re.search(r'variable "temporary_tag_key".*?default\s*=\s*"([^"]+)"', variables, re.S)
    value = re.search(r'variable "temporary_tag_value".*?default\s*=\s*"([^"]+)"', variables, re.S)
    assert key and value
    assert f"{key.group(1)}={value.group(1)}" == TEMPORARY_TAGGING


def test_dockerfile_builds_the_venv_where_it_runs() -> None:
    """uv writes absolute shebangs, so the build stage's venv path must equal the runtime one."""
    text = (REPO / "agent/Dockerfile").read_text()
    _, build, runtime = re.split(r"^FROM ", text, flags=re.M)
    workdir = re.findall(r"^WORKDIR (\S+)", build, re.M)[-1]
    copied = re.search(r"COPY --from=build (\S+)/\.venv (\S+)/\.venv", runtime)
    assert copied and copied.group(1) == workdir == copied.group(2)
    assert "PATH=" + workdir + "/.venv/bin" in runtime


class FakeDdbClient:
    def __init__(self, pages: list[dict[str, Any]]) -> None:
        self.pages = pages
        self.calls: list[dict[str, Any]] = []

    def batch_get_item(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(kw)
        return self.pages.pop(0)


class FakeTable:
    name = "cf-prod-main"

    def __init__(self, client: FakeDdbClient) -> None:
        self.meta = type("Meta", (), {"client": client})()


async def test_clip_statuses_reads_the_owners_clips_and_retries_unprocessed_keys() -> None:
    client = FakeDdbClient(
        [
            {
                "Responses": {"cf-prod-main": [{"clipId": "A", "status": "review"}]},
                "UnprocessedKeys": {"cf-prod-main": {"Keys": [{"pk": "USER#U", "sk": "CLIP#B"}]}},
            },
            {"Responses": {"cf-prod-main": [{"clipId": {"S": "B"}, "status": {"S": "declined"}}]}},
        ]
    )
    store = Store.__new__(Store)
    store.table = FakeTable(client)
    assert await store.clip_statuses("U", ["A", "B", "C", "A"]) == {"A": "review", "B": "declined"}
    keys = client.calls[0]["RequestItems"]["cf-prod-main"]["Keys"]
    assert keys == [{"pk": "USER#U", "sk": f"CLIP#{i}"} for i in "ABC"]
    assert client.calls[1]["RequestItems"] == {"cf-prod-main": {"Keys": [{"pk": "USER#U", "sk": "CLIP#B"}]}}
