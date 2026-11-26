"""Files and images added to a job's notes (docs/CONTRACTS.md §52)."""

from __future__ import annotations

from typing import Any

import pytest

from clipfactory_api import attachments
from clipfactory_api.routes.contentrewards import _attachments_of
from conftest import OTHER, USER, Call
from fakes import FakeS3

LINK = {"type": "link", "url": "https://kick.com/a/videos/b"}
MB20 = 20 * 1024 * 1024


def up(name: str = "logo.png", kind: str = "image/png", size: int = 10, **more: Any) -> dict[str, Any]:
    return {"filename": name, "contentType": kind, "size": size, "purpose": "attachment", **more}


def test_attachment_upload_signs_type_and_length(call: Call, s3_client: FakeS3) -> None:
    status, body = call("POST", "/v1/uploads", up("My Logo.PNG", "image/png", 1234))
    assert status == 200
    assert body["key"] == f"uploads/{USER}/{body['uploadId']}/My-Logo.PNG"
    assert body["headers"] == {"Content-Type": "image/png"}
    op, params, _ = s3_client.presigned[-1]
    assert (op, params["ContentType"], params["ContentLength"]) == ("put_object", "image/png", 1234)


@pytest.mark.parametrize(
    "kind",
    sorted(attachments.ALLOWED_TYPES),
)
def test_every_allowed_kind_uploads(call: Call, kind: str) -> None:
    assert call("POST", "/v1/uploads", up("f", kind))[0] == 200


@pytest.mark.parametrize(
    ("body", "code", "message"),
    [
        (up("a.mp4", "video/mp4"), 400, attachments.KIND_REFUSED),
        (up("a.heic", "image/heic"), 400, attachments.KIND_REFUSED),
        (up("a.exe", "application/x-msdownload"), 400, attachments.KIND_REFUSED),
        (up(size=MB20 + 1), 413, attachments.TOO_BIG),
        (up(size=0), 400, None),
        (up(size="10"), 400, None),
        (up(purpose="video"), 400, None),
    ],
)
def test_attachment_upload_refusals(call: Call, body: dict[str, Any], code: int, message: str | None) -> None:
    status, out = call("POST", "/v1/uploads", body)
    assert status == code
    if message:
        assert out["error"]["message"] == message
    if code == 413:
        assert out["error"]["code"] == "too_large"


def test_video_upload_without_purpose_is_unchanged(call: Call) -> None:
    assert call("POST", "/v1/uploads", {"filename": "a.png", "contentType": "image/png", "size": 10})[0] == 400
    assert call("POST", "/v1/uploads", {"filename": "a.mp4", "contentType": "video/mp4", "size": MB20 * 2})[0] == 200


def seeded(s3_client: FakeS3, name: str = "rules.md", size: int = 5, user: str = USER) -> dict[str, Any]:
    key = f"uploads/{user}/01JABCDEFGHJKMNPQRSTVWXYZ{len(s3_client.objects)}/{name}"
    s3_client.objects[key] = b"x" * size
    return {"key": key, "name": name, "type": "text/markdown", "size": size}


def test_job_keeps_its_attachments(call: Call, s3_client: FakeS3) -> None:
    files = [seeded(s3_client), seeded(s3_client, "logo.png") | {"type": "image/png"}]
    status, body = call("POST", "/v1/jobs", {"source": LINK, "notes": "n", "attachments": files})
    assert status == 201
    assert body["job"]["attachments"] == files
    status, read = call("GET", f"/v1/jobs/{body['job']['jobId']}")
    assert read["job"]["attachments"] == files


def test_job_without_attachments_has_no_field(call: Call) -> None:
    for extra in ({}, {"attachments": []}, {"attachments": None}):
        status, body = call("POST", "/v1/jobs", {"source": LINK, **extra})
        assert status == 201
        assert "attachments" not in body["job"]


def test_job_refuses_bad_attachments(call: Call, s3_client: FakeS3) -> None:
    def refused(files: Any) -> tuple[int, str]:
        status, out = call("POST", "/v1/jobs", {"source": LINK, "attachments": files})
        return status, out["error"]["message"]

    ok = seeded(s3_client)
    assert refused([seeded(s3_client) for _ in range(7)])[0] == 400
    assert refused([ok, ok]) == (400, "That file was added twice.")
    assert refused([seeded(s3_client, user=OTHER)]) == (400, "That file does not belong to you.")
    assert refused([ok | {"key": f"uploads/{USER}/../{OTHER}/x/a.md"}])[0] == 400
    assert refused([ok | {"type": "video/mp4"}]) == (400, attachments.KIND_REFUSED)
    assert refused([ok | {"name": "n" * 256}])[0] == 400
    assert refused([ok | {"extra": 1}])[0] == 400
    assert refused([ok | {"size": MB20 + 1}])[0] == 413
    assert refused("nope")[0] == 400
    gone = ok | {"key": f"uploads/{USER}/01JABCDEFGHJKMNPQRSTVWXYZ9/gone.md"}
    assert "Add it again" in refused([gone])[1]
    big = seeded(s3_client, "big.md", size=MB20 + 1) | {"size": 10}
    assert refused([big])[0] == 413  # the stored object is what counts


def test_copies_take_the_originals_files() -> None:
    files = [{"key": "k", "name": "n", "type": "text/plain", "size": 1}]
    assert _attachments_of({"attachments": files}) == {"attachments": files}
    assert _attachments_of({}) == {}
    assert _attachments_of({"attachments": []}) == {}
