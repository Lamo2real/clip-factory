"""The owner's logo library (docs/CONTRACTS.md §53 C4, C6): routes, the checks on the file, the limit of 60 and the copy
of a campaign's own logo. In-memory items and the fake bucket only."""

from __future__ import annotations

import struct
from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db, logos
from conftest import NOW, OTHER, USER, Call, Clock
from fakes import FakeS3, FakeTable

SENTENCE = "Use a PNG, JPG or WebP picture under 10 MB."
CAMPAIGN = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
OTHER_CAMPAIGN = "11111111-2222-4333-8444-555555555555"


def png(width: int = 200, height: int = 100, pad: int = 20) -> bytes:
    ihdr = struct.pack(">II", width, height) + b"\x08\x06\x00\x00\x00"
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + ihdr + b"\x00" * pad


def jpeg(width: int = 640, height: int = 480) -> bytes:
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00" + b"\x00" * 9
    sof = b"\xff\xc0" + struct.pack(">HBHHB", 11, 8, height, width, 1) + b"\x01\x11\x00"
    return b"\xff\xd8" + app0 + sof + b"\xff\xda\x00\x02"


def webp_x(width: int = 300, height: int = 150) -> bytes:
    body = b"WEBP" + b"VP8X" + struct.pack("<I", 10) + b"\x00\x00\x00\x00"
    body += (width - 1).to_bytes(3, "little") + (height - 1).to_bytes(3, "little")
    return b"RIFF" + struct.pack("<I", len(body)) + body


def webp_lossy(width: int = 90, height: int = 60) -> bytes:
    frame = b"\x00\x00\x00" + b"\x9d\x01\x2a" + struct.pack("<HH", width, height)
    body = b"WEBP" + b"VP8 " + struct.pack("<I", len(frame)) + frame
    return b"RIFF" + struct.pack("<I", len(body)) + body


def webp_lossless(width: int = 50, height: int = 40) -> bytes:
    bits = (width - 1) | ((height - 1) << 14)
    chunk = b"\x2f" + struct.pack("<I", bits)
    body = b"WEBP" + b"VP8L" + struct.pack("<I", len(chunk)) + chunk
    return b"RIFF" + struct.pack("<I", len(body)) + body


def add(
    call: Call, s3_client: FakeS3, data: bytes, *, content_type: str = "image/png", name: str = "My Logo.png"
) -> tuple[int, Any, str]:
    """POST, "upload" to the fake bucket, complete. Returns (status, body) of the complete call and the id."""
    status, made = call("POST", "/v1/logos", {"filename": name, "contentType": content_type, "size": len(data)})
    assert status == 201, made
    logo_id = made["logoId"]
    key = next(k for k in _keys(s3_client, logo_id))
    s3_client.objects[key] = data
    return (*call("POST", f"/v1/logos/{logo_id}/complete"), logo_id)


def _keys(s3_client: FakeS3, logo_id: str) -> list[str]:
    # The object is not there before the upload: the signed URL names the key.
    return [p[1]["Key"] for p in s3_client.presigned if p[0] == "put_object" and logo_id in p[1]["Key"]]


def item(table: FakeTable, logo_id: str, user: str = USER) -> dict[str, Any] | None:
    return table.raw(db.user_pk(user), db.logo_sk(logo_id))


# --- adding one --------------------------------------------------------------------------------------------------


def test_create_gives_a_signed_put_and_an_uploading_item(call: Call, table: FakeTable, s3_client: FakeS3) -> None:
    status, body = call("POST", "/v1/logos", {"filename": "Brand Logo.png", "contentType": "image/png", "size": 5000})
    assert status == 201
    logo_id = body["logoId"]
    assert body["uploadUrl"].startswith("https://cf-prod-media-123.s3.eu-north-1.amazonaws.com/logos/")
    assert body["headers"] == {"Content-Type": "image/png"}
    op, params, seconds = s3_client.presigned[-1]
    assert (op, params["Key"], params["ContentType"], params["ContentLength"]) == (
        "put_object",
        f"logos/{USER}/{logo_id}.png",
        "image/png",
        5000,
    )
    assert seconds == 900
    stored = item(table, logo_id)
    assert stored is not None
    assert (stored["status"], stored["name"], stored["key"]) == (
        "uploading",
        "Brand-Logo",
        f"logos/{USER}/{logo_id}.png",
    )


@pytest.mark.parametrize(
    "body",
    [
        {"filename": "a.gif", "contentType": "image/gif", "size": 10},
        {"filename": "a.svg", "contentType": "image/svg+xml", "size": 10},
        {"filename": "a.png", "contentType": "image/png", "size": 10 * 1024 * 1024 + 1},
        {"filename": "a.png", "contentType": "image/png", "size": 0},
        {"filename": "a.png", "contentType": "image/png", "size": "big"},
        {"filename": "a.png", "contentType": "image/png"},
    ],
)
def test_create_refuses_other_types_and_sizes_with_one_sentence(
    call: Call, table: FakeTable, body: dict[str, Any]
) -> None:
    status, out = call("POST", "/v1/logos", body)
    assert (status, out["error"]["message"]) == (400, SENTENCE)
    assert not [i for i in table.all() if i["sk"].startswith("LOGO#")]


def test_create_refuses_unknown_fields_and_missing_filename(call: Call) -> None:
    assert call("POST", "/v1/logos", {"filename": "a.png", "contentType": "image/png", "size": 1, "x": 1})[0] == 400
    assert call("POST", "/v1/logos", {"contentType": "image/png", "size": 1})[0] == 400


@pytest.mark.parametrize(
    ("data", "content_type", "name", "size"),
    [
        (png(200, 100), "image/png", "a.png", (200, 100)),
        (jpeg(640, 480), "image/jpeg", "photo.jpg", (640, 480)),
        (webp_x(300, 150), "image/webp", "x.webp", (300, 150)),
        (webp_lossy(90, 60), "image/webp", "y.webp", (90, 60)),
        (webp_lossless(50, 40), "image/webp", "z.webp", (50, 40)),
    ],
)
def test_complete_reads_the_type_and_size_from_the_bytes(
    call: Call, table: FakeTable, s3_client: FakeS3, data: bytes, content_type: str, name: str, size: tuple[int, int]
) -> None:
    status, body, logo_id = add(call, s3_client, data, content_type=content_type, name=name)
    assert status == 200
    logo = body["logo"]
    assert (logo["logoId"], logo["width"], logo["height"]) == (logo_id, *size)
    assert logo["url"].startswith("https://cf-prod-media-123.s3.eu-north-1.amazonaws.com/logos/")
    assert logo["createdAt"] == "2026-11-15T12:00:00.000Z"
    assert "key" not in logo
    assert "status" not in logo
    assert item(table, logo_id)["status"] == "ready"  # type: ignore[index]
    # Safe to repeat: it answers with the same logo.
    assert call("POST", f"/v1/logos/{logo_id}/complete")[1]["logo"]["logoId"] == logo_id


@pytest.mark.parametrize(
    ("data", "content_type"),
    [
        (b"<svg xmlns='http://www.w3.org/2000/svg'></svg>", "image/png"),
        (b"GIF89a" + b"\x00" * 30, "image/png"),
        (b"<html>not a picture</html>", "image/jpeg"),
        (b"\x89PNG\r\n\x1a\n" + b"\x00" * 3, "image/png"),  # a signature and nothing else: no size to read
        (png(), "image/jpeg"),  # a PNG named and typed as a JPEG: not what it said it was
        (png(0, 10), "image/png"),
        (png(20_000, 10), "image/png"),
    ],
)
def test_complete_deletes_a_file_that_is_not_a_good_picture(
    call: Call, table: FakeTable, s3_client: FakeS3, data: bytes, content_type: str
) -> None:
    status, body, logo_id = add(call, s3_client, data, content_type=content_type)
    assert (status, body["error"]["message"]) == (400, SENTENCE)
    assert item(table, logo_id) is None
    assert not [k for k in s3_client.objects if k.startswith("logos/")]
    assert call("GET", "/v1/logos")[1] == {"logos": []}


def test_complete_with_no_file_uploaded_is_one_sentence_and_keeps_the_item(call: Call, table: FakeTable) -> None:
    logo_id = call("POST", "/v1/logos", {"filename": "a.png", "contentType": "image/png", "size": 9})[1]["logoId"]
    status, body = call("POST", f"/v1/logos/{logo_id}/complete")
    assert (status, body["error"]["message"]) == (400, SENTENCE)
    assert item(table, logo_id)["status"] == "uploading"  # type: ignore[index]


def test_complete_unknown_or_not_yours_is_404(call: Call, s3_client: FakeS3) -> None:
    _status, _body, logo_id = add(call, s3_client, png(), name="mine.png")
    assert call("POST", f"/v1/logos/{logo_id}/complete", sub=OTHER)[0] == 404
    assert call("POST", "/v1/logos/NOPE/complete")[0] == 404
    assert call("POST", "/v1/logos/bad id/complete")[0] == 404


# --- the library -------------------------------------------------------------------------------------------------


def test_list_is_ready_logos_newest_first_and_only_yours(call: Call, clock: Clock, s3_client: FakeS3) -> None:
    ids = []
    for n in range(3):
        clock.now = NOW + timedelta(minutes=n)
        ids.append(add(call, s3_client, png(100 + n, 50), name=f"logo{n}.png")[2])
    pending = call("POST", "/v1/logos", {"filename": "p.png", "contentType": "image/png", "size": 9})[1]["logoId"]
    status, body = call("GET", "/v1/logos")
    assert status == 200
    assert [logo["logoId"] for logo in body["logos"]] == [ids[2], ids[1], ids[0]]  # newest first, no unfinished one
    assert pending not in [logo["logoId"] for logo in body["logos"]]
    assert [logo["width"] for logo in body["logos"]] == [102, 101, 100]
    assert all({"logoId", "name", "url", "width", "height", "createdAt"} <= set(logo) for logo in body["logos"])
    assert all("key" not in logo and "status" not in logo for logo in body["logos"])
    assert call("GET", "/v1/logos", sub=OTHER)[1] == {"logos": []}


def test_delete_removes_the_item_and_the_file_and_is_safe_to_repeat(
    call: Call, table: FakeTable, s3_client: FakeS3
) -> None:
    _s, _b, logo_id = add(call, s3_client, png())
    key = f"logos/{USER}/{logo_id}.png"
    assert key in s3_client.objects
    assert call("DELETE", f"/v1/logos/{logo_id}") == (204, None)
    assert item(table, logo_id) is None
    assert key not in s3_client.objects
    assert call("DELETE", f"/v1/logos/{logo_id}") == (204, None)
    assert call("DELETE", "/v1/logos/NOPE") == (204, None)


def test_delete_never_touches_another_owners_logo(call: Call, table: FakeTable, s3_client: FakeS3) -> None:
    _s, _b, logo_id = add(call, s3_client, png())
    assert call("DELETE", f"/v1/logos/{logo_id}", sub=OTHER) == (204, None)
    assert item(table, logo_id) is not None
    assert f"logos/{USER}/{logo_id}.png" in s3_client.objects


def test_a_clip_edited_with_a_logo_keeps_its_edit_when_the_logo_goes(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    from conftest import seed_clip

    _s, _b, logo_id = add(call, s3_client, png())
    clip = seed_clip(
        store,
        s3_client,
        cr={"active": True},
        overlay={"rev": 1, "status": "ready", "logo": {"logoId": logo_id, "x": 0.8, "y": 0.1, "size": 0.2}},
    )
    assert call("DELETE", f"/v1/logos/{logo_id}") == (204, None)
    shown = call("GET", f"/v1/clips/{clip['clipId']}")[1]["clip"]
    assert shown["overlay"]["status"] == "ready"
    assert shown["overlay"]["logo"]["logoId"] == logo_id


# --- the limit of 60 ---------------------------------------------------------------------------------------------


def seed_logo(store: db.Store, n: int, *, status: str = "ready", created: str = "2026-11-15T11:00:00.000Z") -> None:
    logo_id = f"L{n:04d}"
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.logo_sk(logo_id),
            "type": "logo",
            "userId": USER,
            "logoId": logo_id,
            "name": f"logo {n}",
            "key": f"logos/{USER}/{logo_id}.png",
            "status": status,
            "createdAt": created,
        }
    )


def test_the_sixtieth_logo_is_the_last(call: Call, store: db.Store) -> None:
    for n in range(59):
        seed_logo(store, n)
    assert call("POST", "/v1/logos", {"filename": "a.png", "contentType": "image/png", "size": 9})[0] == 201
    status, body = call("POST", "/v1/logos", {"filename": "b.png", "contentType": "image/png", "size": 9})
    assert (status, body["error"]["message"]) == (409, logos.FULL)


def test_unfinished_uploads_older_than_an_hour_are_cleared_and_do_not_count(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3
) -> None:
    for n in range(59):
        seed_logo(store, n)
    seed_logo(store, 900, status="uploading", created="2026-11-15T10:00:00.000Z")  # two hours old
    s3_client.objects[f"logos/{USER}/L0900.png"] = b"half"
    assert call("POST", "/v1/logos", {"filename": "a.png", "contentType": "image/png", "size": 9})[0] == 201
    assert item(table, "L0900") is None
    assert f"logos/{USER}/L0900.png" not in s3_client.objects
    seed_logo(store, 901, status="uploading", created="2026-11-15T11:50:00.000Z")  # ten minutes old: still going
    assert call("POST", "/v1/logos", {"filename": "a.png", "contentType": "image/png", "size": 9})[0] == 409


# --- C6: a campaign's own logo -----------------------------------------------------------------------------------


def seed_campaign(
    store: db.Store, s3_client: FakeS3, *, uuid: str = CAMPAIGN, user: str = USER, logo: bytes | None = None
) -> str:
    key = f"campaigns/{user}/{uuid}/logo-2.png"
    fields: dict[str, Any] = {"logo": {"needed": True, "state": "none"}}
    if logo is not None:
        s3_client.objects[key] = logo
        fields = {"logo": {"needed": True, "state": "ready"}, "logoKey": key, "logoRev": 2}
    store.put(
        {
            "pk": db.user_pk(user),
            "sk": db.campaign_sk(uuid),
            "type": "campaign",
            "userId": user,
            "campaignId": uuid,
            "name": "Spring Push",
            **fields,
        }
    )
    return key


def test_from_campaign_copies_the_campaigns_logo_once(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3
) -> None:
    source = seed_campaign(store, s3_client, logo=png(320, 160))
    status, body = call("POST", "/v1/logos/from-campaign", {"campaignId": CAMPAIGN})
    assert status == 200
    logo = body["logo"]
    assert (logo["campaignId"], logo["name"], logo["width"], logo["height"]) == (CAMPAIGN, "Spring Push", 320, 160)
    copied = f"logos/{USER}/{logo['logoId']}.png"
    assert s3_client.objects[copied] == s3_client.objects[source]  # a copy: the campaign's own file stays
    assert s3_client.put_types[copied] == "image/png"
    again = call("POST", "/v1/logos/from-campaign", {"campaignId": CAMPAIGN.upper()})
    assert (again[0], again[1]["logo"]["logoId"]) == (200, logo["logoId"])
    assert len([i for i in table.all() if i["sk"].startswith("LOGO#")]) == 1
    assert [x["logoId"] for x in call("GET", "/v1/logos")[1]["logos"]] == [logo["logoId"]]
    # It can be deleted like any other, and the campaign's own logo is untouched.
    assert call("DELETE", f"/v1/logos/{logo['logoId']}") == (204, None)
    assert source in s3_client.objects


def test_from_campaign_without_a_ready_logo_is_404(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    seed_campaign(store, s3_client)  # needs a logo, has none
    status, body = call("POST", "/v1/logos/from-campaign", {"campaignId": CAMPAIGN})
    assert (status, body["error"]["message"]) == (404, logos.NO_CAMPAIGN_LOGO)
    assert call("GET", "/v1/logos")[1] == {"logos": []}


def test_from_campaign_unknown_other_owners_and_bad_ids_are_404(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    seed_campaign(store, s3_client, uuid=OTHER_CAMPAIGN, user=OTHER, logo=png())
    assert call("POST", "/v1/logos/from-campaign", {"campaignId": OTHER_CAMPAIGN})[0] == 404
    assert call("POST", "/v1/logos/from-campaign", {"campaignId": CAMPAIGN})[0] == 404
    assert call("POST", "/v1/logos/from-campaign", {"campaignId": "nope"})[0] == 404
    assert call("POST", "/v1/logos/from-campaign", {})[0] == 400
    assert call("POST", "/v1/logos/from-campaign", {"campaignId": CAMPAIGN, "x": 1})[0] == 400


def test_from_campaign_refuses_a_logo_that_is_not_a_picture_or_lies_outside_the_campaign(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    seed_campaign(store, s3_client, logo=b"<html></html>")
    assert call("POST", "/v1/logos/from-campaign", {"campaignId": CAMPAIGN})[0] == 404
    raw = store.get(db.user_pk(USER), db.campaign_sk(CAMPAIGN))
    assert raw is not None
    s3_client.objects[f"uploads/{USER}/x/secret.png"] = png()
    store.put({**raw, "logoKey": f"uploads/{USER}/x/secret.png"})  # a key outside the campaign's own folder
    assert call("POST", "/v1/logos/from-campaign", {"campaignId": CAMPAIGN})[0] == 404


def test_from_campaign_stops_at_sixty(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    for n in range(60):
        seed_logo(store, n)
    seed_campaign(store, s3_client, logo=png())
    status, body = call("POST", "/v1/logos/from-campaign", {"campaignId": CAMPAIGN})
    assert (status, body["error"]["message"]) == (409, logos.FULL)


# --- the helpers -------------------------------------------------------------------------------------------------


def test_image_size_never_raises_on_cut_off_or_odd_bytes() -> None:
    for kind in ("png", "jpg", "webp"):
        for data in (b"", b"\xff", jpeg()[:5], png()[:10], webp_x()[:14]):
            assert logos.image_size(data, kind) is None or isinstance(logos.image_size(data, kind), tuple)
    assert logos.image_size(jpeg(70, 50), "jpg") == (70, 50)


def test_names_are_short_and_plain() -> None:
    assert logos.display_name("../../Brand Mark (final).PNG") == "Brand-Mark-final"
    assert logos.display_name("???.png") == "logo"
    assert len(logos.display_name("x" * 200 + ".png")) == logos.NAME_MAX
