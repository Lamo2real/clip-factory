"""It's on TikTok (docs/CONTRACTS.md §42): reading pasted links, It's on TikTok with a link, without one (``noLink``)
and Find it for me (which never saves without a link), Undo, and Save the video."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from clipfactory_api import day7, db, posts, tiktok_find, tiktok_link, tiktok_self
from clipfactory_api.app import App
from clipfactory_api.ids import ulid
from clipfactory_api.platforms.base import HttpRequest, HttpResponse, NetworkError
from conftest import USER, Call, seed_clip
from fakes import FakeHttp, FakeS3, FakeSecretsManager, FakeTable
from test_setup_routes import connect_account, put_token, save_keys

VIDEO_ID = "7710644811602169121"
FULL = f"https://www.tiktok.com/@lamo.clips/video/{VIDEO_ID}?is_from_webapp=1&sender_device=pc"


# --- reading links ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        FULL,
        f"tiktok.com/@lamo.clips/video/{VIDEO_ID}",
        f"Look at this! https://www.tiktok.com/@lamo.clips/video/{VIDEO_ID}.",
        f"https://m.tiktok.com/@lamo.clips/photo/{VIDEO_ID}/",
    ],
)
def test_full_links_are_read_without_opening_anything(text: str) -> None:
    def never(_req: HttpRequest) -> HttpResponse:
        raise AssertionError("a full link is never opened")

    video = tiktok_link.resolve(text, never)
    assert video.video_id == VIDEO_ID
    assert video.handle == "lamo.clips"
    assert video.url == f"https://www.tiktok.com/@lamo.clips/video/{VIDEO_ID}"


def test_a_mobile_v_link_has_the_id_but_no_name() -> None:
    video = tiktok_link.resolve(f"https://m.tiktok.com/v/{VIDEO_ID}.html", lambda _r: HttpResponse(500, {}, b""))
    assert video.video_id == VIDEO_ID
    assert video.handle is None


@pytest.mark.parametrize(
    "short",
    ["https://vm.tiktok.com/ZMabc123/", "https://vt.tiktok.com/ZSabc123/", "https://www.tiktok.com/t/ZTabc123/"],
)
def test_short_links_follow_their_redirect_on_tiktok_only(short: str) -> None:
    seen: list[str] = []

    def opener(req: HttpRequest) -> HttpResponse:
        seen.append(req.url)
        return HttpResponse(301, {"location": FULL}, b"")

    video = tiktok_link.resolve(short, opener)
    assert video.video_id == VIDEO_ID
    assert seen == [short]


def test_a_redirect_away_from_tiktok_is_refused() -> None:
    with pytest.raises(tiktok_link.LinkError):
        tiktok_link.resolve(
            "https://vm.tiktok.com/ZMabc123/", lambda _r: HttpResponse(302, {"location": "https://evil.example/x"}, b"")
        )


def test_redirects_stop_after_three_hops() -> None:
    calls: list[str] = []

    def loop(req: HttpRequest) -> HttpResponse:
        calls.append(req.url)
        return HttpResponse(302, {"location": "https://www.tiktok.com/t/ZTloop/"}, b"")

    with pytest.raises(tiktok_link.LinkError):
        tiktok_link.resolve("https://vm.tiktok.com/ZMabc123/", loop)
    assert len(calls) == tiktok_link.MAX_HOPS


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("hello", tiktok_link.NOT_A_LINK),
        ("https://youtube.com/watch?v=1", tiktok_link.NOT_A_LINK),
        ("https://www.tiktok.com/@lamo.clips", tiktok_link.NOT_A_VIDEO),
        ("https://eviltiktok.com/@a/video/7710644811602169121", tiktok_link.NOT_A_LINK),
    ],
)
def test_text_that_is_not_a_video_link_gets_a_plain_sentence(text: str, message: str) -> None:
    with pytest.raises(tiktok_link.LinkError) as e:
        tiktok_link.resolve(text, lambda _r: HttpResponse(404, {}, b""))
    assert str(e.value) == message


def test_a_short_link_tiktok_does_not_answer() -> None:
    def down(_req: HttpRequest) -> HttpResponse:
        raise NetworkError("timeout")

    with pytest.raises(tiktok_link.LinkError) as e:
        tiktok_link.resolve("https://vm.tiktok.com/ZMabc123/", down)
    assert str(e.value) == tiktok_link.NO_ANSWER


def test_the_real_opener_only_opens_tiktok() -> None:
    with pytest.raises(NetworkError):
        tiktok_link.open_once(HttpRequest("GET", "https://example.com/", {}, None))
    with pytest.raises(NetworkError):
        tiktok_link.open_once(HttpRequest("GET", "http://vm.tiktok.com/ZM1/", {}, None))


# --- It's on TikTok -------------------------------------------------------------------------------------------


def _connect_tiktok(store: db.Store, handle: str = "@lamo.clips") -> None:
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": "ACCOUNT#tiktok",
            "type": "account",
            "userId": USER,
            "platform": "tiktok",
            "status": "connected",
            "handle": handle,
        }
    )


def _post(store: db.Store, clip: dict[str, Any], platform: str, **fields: Any) -> dict[str, Any]:
    post_id = ulid()
    item = {
        "pk": db.user_pk(USER),
        "sk": db.post_sk(post_id),
        "gsi1pk": f"CLIP#{clip['clipId']}",
        "gsi1sk": f"POST#{platform}",
        "type": "post",
        "userId": USER,
        "postId": post_id,
        "clipId": clip["clipId"],
        "platform": platform,
        "createdAt": "2026-11-21T10:00:00.000Z",
        **fields,
    }
    store.put(item)
    stored = store.get(clip["pk"], clip["sk"]) or clip
    store.update(clip["pk"], clip["sk"], {"postIds": [*(stored.get("postIds") or []), post_id]})
    return item


def _uploaded(store: db.Store, status: str = "posted", **fields: Any) -> dict[str, Any]:
    return seed_clip(
        store, status=status, postsCreated=True, postIds=[], decidedAt="2026-11-21T10:00:00.000Z", **fields
    )


def _tiktok(body: dict[str, Any]) -> dict[str, Any]:
    return next(p for p in body["posts"] if p["platform"] == "tiktok")


def _short_links(app: App, target: str = FULL) -> list[str]:
    seen: list[str] = []

    def opener(req: HttpRequest) -> HttpResponse:
        seen.append(req.url)
        return HttpResponse(301, {"location": target}, b"")

    app.tiktok_open = opener
    return seen


def test_no_link_adds_a_tiktok_post_to_a_clip_that_had_none(call: Call, store: db.Store, table: FakeTable) -> None:
    clip = _uploaded(store)
    _post(store, clip, "youtube", status="posted", privacy="public", url="https://youtu.be/x")
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"noLink": True})
    assert status == 200
    tiktok = _tiktok(body)
    assert tiktok["status"] == "posted"
    assert tiktok["by"] == "you"
    assert tiktok["privacy"] == "public"
    assert "url" not in tiktok
    raw = table.raw(db.user_pk(USER), db.post_sk(tiktok["postId"]))
    assert raw is not None
    assert raw["madeByYou"] is True
    assert "statsId" not in raw
    assert "gsi2pk" not in raw
    stored = table.raw(clip["pk"], clip["sk"])
    assert stored is not None
    assert tiktok["postId"] in stored["postIds"]
    assert "beforeYou" not in tiktok
    assert "madeByYou" not in tiktok


def test_a_link_puts_the_post_on_the_poller(call: Call, store: db.Store, table: FakeTable) -> None:
    _connect_tiktok(store)
    clip = _uploaded(store)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"link": FULL})
    assert status == 200
    tiktok = _tiktok(body)
    assert tiktok["url"] == f"https://www.tiktok.com/@lamo.clips/video/{VIDEO_ID}"
    assert "note" not in body
    raw = table.raw(db.user_pk(USER), db.post_sk(tiktok["postId"]))
    assert raw is not None
    assert raw["statsId"] == VIDEO_ID
    assert raw["gsi2pk"] == db.STATS_GSI_PK
    assert raw["gsi2sk"].endswith(f"#{tiktok['postId']}")


def test_a_short_link_is_opened_once(app: App, call: Call, store: db.Store) -> None:
    _connect_tiktok(store)
    seen = _short_links(app)
    clip = _uploaded(store)
    status, body = call(
        "POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"link": "https://vm.tiktok.com/ZMabc123/"}
    )
    assert status == 200
    assert seen == ["https://vm.tiktok.com/ZMabc123/"]
    assert _tiktok(body)["url"].endswith(VIDEO_ID)


def test_a_link_from_another_account_is_kept_without_numbers(call: Call, store: db.Store, table: FakeTable) -> None:
    _connect_tiktok(store, handle="@someone.else")
    clip = _uploaded(store)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"link": FULL})
    assert status == 200
    assert body["note"].startswith("Saved.")
    raw = table.raw(db.user_pk(USER), db.post_sk(_tiktok(body)["postId"]))
    assert raw is not None
    assert raw["url"].endswith(VIDEO_ID)
    assert "statsId" not in raw


def test_a_display_name_handle_is_not_compared(call: Call, store: db.Store, table: FakeTable) -> None:
    # Without a TikTok username the connection stores the display name, which no link carries.
    _connect_tiktok(store, handle="Lamo Clips")
    clip = _uploaded(store)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"link": FULL})
    assert status == 200
    assert "note" not in body
    raw = table.raw(db.user_pk(USER), db.post_sk(_tiktok(body)["postId"]))
    assert raw is not None
    assert raw["statsId"] == VIDEO_ID


def test_a_bad_link_is_a_plain_400(call: Call, store: db.Store) -> None:
    clip = _uploaded(store)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"link": "not a link"})
    assert status == 400
    assert body["error"]["message"] == tiktok_link.NOT_A_LINK


def test_it_replaces_clip_factorys_private_post_and_undo_puts_it_back(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    _connect_tiktok(store)
    clip = _uploaded(store)
    private = _post(
        store,
        clip,
        "tiktok",
        status="posted",
        privacy="private",
        url="https://www.tiktok.com/@lamo.clips",
        postedAt="2026-11-21T10:05:00.000Z",
        platformPostId="v_pub_1",
    )
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"link": FULL})
    assert status == 200
    tiktok = _tiktok(body)
    assert tiktok["postId"] == private["postId"]
    assert (tiktok["by"], tiktok["privacy"]) == ("you", "public")
    raw = table.raw(db.user_pk(USER), db.post_sk(private["postId"]))
    assert raw is not None
    assert raw["beforeYou"]["privacy"] == "private"
    assert "platformPostId" not in raw

    status, body = call("DELETE", f"/v1/clips/{clip['clipId']}/tiktok/posted")
    assert status == 200
    back = _tiktok(body)
    assert back["privacy"] == "private"
    assert back["url"] == "https://www.tiktok.com/@lamo.clips"
    assert "by" not in back
    raw = table.raw(db.user_pk(USER), db.post_sk(private["postId"]))
    assert raw is not None
    assert raw["platformPostId"] == "v_pub_1"
    assert "statsId" not in raw
    assert "gsi2pk" not in raw
    assert "beforeYou" not in raw


def test_a_failed_tiktok_upload_becomes_posted_and_the_clip_too(call: Call, store: db.Store, table: FakeTable) -> None:
    clip = _uploaded(store, status="failed")
    _post(
        store,
        clip,
        "tiktok",
        status="failed",
        error="TikTok only takes Clip Factory's own uploads on a private account for now, so your Mac posts it for everyone.",
    )
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"noLink": True})
    assert status == 200
    assert body["clip"]["status"] == "posted"
    assert "error" not in _tiktok(body)
    status, body = call("DELETE", f"/v1/clips/{clip['clipId']}/tiktok/posted")
    assert status == 200
    assert body["clip"]["status"] == "failed"
    assert _tiktok(body)["status"] == "failed"


def test_undo_deletes_a_post_made_here(call: Call, store: db.Store, table: FakeTable) -> None:
    clip = _uploaded(store, status="confirmed")
    _post(store, clip, "youtube", status="pending_integration")
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"noLink": True})
    assert status == 200
    assert body["clip"]["status"] == "posted"
    post_id = _tiktok(body)["postId"]
    status, body = call("DELETE", f"/v1/clips/{clip['clipId']}/tiktok/posted")
    assert status == 200
    assert [p["platform"] for p in body["posts"]] == ["youtube"]
    assert body["clip"]["status"] == "confirmed"
    assert table.raw(db.user_pk(USER), db.post_sk(post_id)) is None
    stored = table.raw(clip["pk"], clip["sk"])
    assert stored is not None
    assert post_id not in stored["postIds"]


def test_adding_the_link_later_keeps_the_first_time(call: Call, store: db.Store) -> None:
    _connect_tiktok(store)
    clip = _uploaded(store)
    _, first = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"noLink": True})
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"link": FULL})
    assert status == 200
    assert _tiktok(body)["postedAt"] == _tiktok(first)["postedAt"]
    assert _tiktok(body)["postId"] == _tiktok(first)["postId"]
    assert _tiktok(body)["url"].endswith(VIDEO_ID)
    assert len([p for p in body["posts"] if p["platform"] == "tiktok"]) == 1


@pytest.mark.parametrize(
    ("clip_status", "post_fields", "message"),
    [
        ("review", None, "Upload this clip first. Then your Mac can post it on TikTok."),
        ("declined", None, "Upload this clip first. Then your Mac can post it on TikTok."),
        (
            "publishing",
            {"status": "queued"},
            "This clip is still uploading to TikTok. Wait until it is done, then try again.",
        ),
        ("posted", {"status": "posted", "privacy": "public"}, "This clip is already on TikTok for everyone."),
    ],
)
@pytest.mark.parametrize("body_in", [{"noLink": True}, {}])
def test_when_it_cannot_be_marked(
    call: Call,
    store: db.Store,
    monkeypatch: pytest.MonkeyPatch,
    clip_status: str,
    post_fields: dict[str, Any] | None,
    message: str,
    body_in: dict[str, Any],
) -> None:
    # Find it for me (no link, no noLink) answers the same refusals before TikTok is asked anything.
    _connect_tiktok(store)
    monkeypatch.setattr(tiktok_find, "find_recent", lambda *_a, **_k: pytest.fail("TikTok is never asked"))
    clip = _uploaded(store, status=clip_status)
    if post_fields is not None:
        _post(store, clip, "tiktok", **post_fields)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", body_in)
    assert status == 409
    assert body["error"]["message"] == message


def test_a_clip_whose_posts_are_not_made_yet_waits(call: Call, store: db.Store) -> None:
    clip = seed_clip(store, status="confirmed")
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"noLink": True})
    assert status == 409
    assert "Try again in a minute" in body["error"]["message"]


def test_undo_with_nothing_to_undo(call: Call, store: db.Store) -> None:
    clip = _uploaded(store)
    status, _ = call("DELETE", f"/v1/clips/{clip['clipId']}/tiktok/posted")
    assert status == 409


def test_unknown_fields_are_refused(call: Call, store: db.Store) -> None:
    clip = _uploaded(store)
    status, _ = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"url": FULL})
    assert status == 400


def test_another_owners_clip_is_not_found(call: Call, store: db.Store) -> None:
    clip = seed_clip(store, user="someone-else", status="posted", postsCreated=True)
    status, _ = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"noLink": True})
    assert status == 404


# --- Save the video -------------------------------------------------------------------------------------------


def test_the_file_link_saves_the_video_with_a_readable_name(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    clip = _uploaded(store, hook="He lost it! 😱")
    status, body = call("GET", f"/v1/clips/{clip['clipId']}/file")
    assert status == 200
    assert body["filename"].startswith("clip-factory-He-lost-it")
    assert body["filename"].endswith(".mp4")
    op, params, _ = s3_client.presigned[-1]
    assert op == "get_object"
    assert params["ResponseContentDisposition"] == f'attachment; filename="{body["filename"]}"'
    assert params["ResponseContentType"] == "video/mp4"


def test_a_thrown_away_clip_has_no_file(call: Call, store: db.Store) -> None:
    clip = seed_clip(store, status="declined")
    status, _ = call("GET", f"/v1/clips/{clip['clipId']}/file")
    assert status == 404


# --- finding the post on his TikTok (no link) ----------------------------------------------------------------------


def _tiktok_ready(call: Call, store: db.Store, secrets_client: FakeSecretsManager) -> None:
    save_keys(call, "tiktok")
    connect_account(store, "tiktok", handle="@lamo.clips")
    put_token(secrets_client, "tiktok", {"accessToken": "AT", "expiresAt": "2026-11-15T14:00:00.000Z"})


def _video(vid: str, at: str, text: str) -> dict[str, Any]:
    made = int(datetime.fromisoformat(at.replace("Z", "+00:00")).timestamp())
    return {
        "id": vid,
        "create_time": made,
        "video_description": text,
        "share_url": f"https://www.tiktok.com/@lamo.clips/video/{vid}?utm_campaign=tt4d",
    }


def _listed(*videos: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    return (200, {"data": {"videos": list(videos), "has_more": False}, "error": {"code": "ok", "message": ""}})


def test_no_link_finds_the_new_post_by_its_caption(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp, table: FakeTable
) -> None:
    _tiktok_ready(call, store, secrets_client)
    clip = _uploaded(store)
    http.answers.append(
        _listed(
            _video("7710644811602169999", "2026-11-15T11:58:00Z", "something else entirely"),
            _video(VIDEO_ID, "2026-11-15T11:55:00Z", "wait for it #fyp"),
            _video("7700000000000000001", "2026-11-10T10:00:00Z", "wait for it"),
        )
    )
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"since": "2026-11-15T11:50:00.000Z"})
    assert status == 200
    assert "note" not in body
    tiktok = _tiktok(body)
    assert tiktok["url"] == f"https://www.tiktok.com/@lamo.clips/video/{VIDEO_ID}"
    raw = table.raw(db.user_pk(USER), db.post_sk(tiktok["postId"]))
    assert raw is not None
    assert raw["statsId"] == VIDEO_ID
    assert http.calls[-1].url.startswith("https://open.tiktokapis.com/v2/video/list/")
    assert http.calls[-1].headers["Authorization"] == "Bearer AT"


def test_one_new_post_without_a_caption_match_is_still_it(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    _tiktok_ready(call, store, secrets_client)
    clip = _uploaded(store)
    http.answers.append(_listed(_video(VIDEO_ID, "2026-11-15T11:55:00Z", "I changed the words")))
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"since": "2026-11-15T11:50:00.000Z"})
    assert status == 200
    assert _tiktok(body)["url"].endswith(VIDEO_ID)


def test_find_it_for_me_saves_nothing_when_nothing_is_found(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp, table: FakeTable
) -> None:
    # D3: a button named Find it for me never commits without a link.
    _tiktok_ready(call, store, secrets_client)
    clip = _uploaded(store)
    # Two new posts, neither with this caption: too unsure to pick one.
    http.answers.append(
        _listed(
            _video("7710644811602169998", "2026-11-15T11:56:00Z", "other one"),
            _video("7710644811602169997", "2026-11-15T11:55:00Z", "and another"),
        )
    )
    before = table.all()
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"since": "2026-11-15T11:50:00.000Z"})
    assert (status, body["error"]["message"]) == (409, "Not found yet. Try again in a minute, or paste the link.")
    assert table.all() == before
    # A minute later it is there: found and saved with its link.
    http.answers.append(_listed(_video(VIDEO_ID, "2026-11-15T11:55:00Z", "wait for it")))
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"since": "2026-11-15T11:50:00.000Z"})
    assert status == 200
    assert "note" not in body
    assert _tiktok(body)["url"].endswith(VIDEO_ID)


def test_tiktok_down_saves_nothing(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp, table: FakeTable
) -> None:
    _tiktok_ready(call, store, secrets_client)
    clip = _uploaded(store)
    http.answers.append(NetworkError("timeout"))
    before = table.all()
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {})
    assert (status, body["error"]["message"]) == (409, "Not found yet. Try again in a minute, or paste the link.")
    assert table.all() == before


def test_find_it_for_me_without_tiktok_connected_says_paste_the_link(
    app: App, call: Call, store: db.Store, table: FakeTable
) -> None:
    clip = _uploaded(store)
    before = table.all()
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {})
    sentence = "Clip Factory can't look on your TikTok until TikTok is connected. Paste the link instead."
    assert (status, body["error"]["message"]) == (409, sentence)
    _connect_tiktok(store)
    app.oauth = None  # no OAuth client configured: it can't look either
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {})
    assert (status, body["error"]["message"]) == (409, sentence)
    assert [i for i in table.all() if i.get("type") == "post"] == [i for i in before if i.get("type") == "post"]


def test_find_it_for_me_on_a_post_already_his_with_a_link_changes_nothing(
    call: Call, store: db.Store, table: FakeTable, monkeypatch: pytest.MonkeyPatch
) -> None:
    _connect_tiktok(store)
    clip = _uploaded(store)
    assert call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"link": FULL})[0] == 200
    monkeypatch.setattr(tiktok_find, "find_recent", lambda *_a, **_k: pytest.fail("nothing to find"))
    before = table.all()
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {})
    assert status == 200
    assert _tiktok(body)["url"].endswith(VIDEO_ID)
    assert table.all() == before


@pytest.mark.parametrize(
    ("body_in", "sentence"),
    [
        ({"link": FULL, "noLink": True}, "Send a link or noLink, not both."),
        ({"noLink": "yes"}, "noLink must be true or false."),
        ({"noLink": None}, "noLink must be true or false."),
    ],
)
def test_no_link_is_checked(
    call: Call, store: db.Store, table: FakeTable, body_in: dict[str, Any], sentence: str
) -> None:
    clip = _uploaded(store)
    before = table.all()
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", body_in)
    assert (status, body["error"]["message"]) == (400, sentence)
    assert table.all() == before


def test_no_link_never_asks_the_finder(call: Call, store: db.Store, monkeypatch: pytest.MonkeyPatch) -> None:
    _connect_tiktok(store)
    monkeypatch.setattr(tiktok_find, "find_recent", lambda *_a, **_k: pytest.fail("noLink never looks"))
    clip = _uploaded(store)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"noLink": True, "link": "  "})
    assert status == 200
    assert "note" not in body
    assert (_tiktok(body)["by"], "url" in _tiktok(body)) == ("you", False)


def test_a_short_link_that_lands_on_tiktoks_home_page(app: App, call: Call, store: db.Store) -> None:
    _short_links(app, target="https://www.tiktok.com/?_r=1")
    clip = _uploaded(store)
    status, body = call(
        "POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"link": "https://www.tiktok.com/t/ZTabc/"}
    )
    assert status == 400
    assert body["error"]["message"] == tiktok_link.SHORT_UNREAD


def test_pick_prefers_the_caption_and_skips_old_posts() -> None:
    since = datetime(2026, 11, 15, 11, 50, tzinfo=UTC)
    old = _video("1000000000000000001", "2026-11-15T10:00:00Z", "wait for it")
    assert tiktok_find.pick([old], since=since, caption="wait for it") is None
    a = _video("1000000000000000002", "2026-11-15T11:59:00Z", "nope")
    b = _video("1000000000000000003", "2026-11-15T11:52:00Z", "Wait for it!! #fyp")
    assert tiktok_find.pick([a, b], since=since, caption="wait for it") == b
    assert tiktok_find.pick([a, b], since=since, caption="") is None


# --- review fixes: old clips without postIds, day-7 fields, two taps at once ---------------------------------------


def _bare_post(store: db.Store, clip: dict[str, Any], platform: str, **fields: Any) -> dict[str, Any]:
    """A post written the way clips confirmed before ``postIds`` existed were: the clip does not list it."""
    post_id = ulid()
    item = {
        "pk": db.user_pk(USER),
        "sk": db.post_sk(post_id),
        "gsi1pk": f"CLIP#{clip['clipId']}",
        "gsi1sk": f"POST#{platform}",
        "type": "post",
        "userId": USER,
        "postId": post_id,
        "clipId": clip["clipId"],
        "platform": platform,
        **fields,
    }
    store.put(item)
    return item


def test_an_old_clip_without_post_ids_keeps_all_its_posts(call: Call, store: db.Store, table: FakeTable) -> None:
    clip = seed_clip(store, status="failed", postsCreated=True, decidedAt="2026-11-15T10:00:00.000Z")
    youtube = _bare_post(store, clip, "youtube", status="failed", error="YouTube said no.")
    instagram = _bare_post(store, clip, "instagram", status="posted", privacy="public")
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"noLink": True})
    assert status == 200
    assert sorted(p["platform"] for p in body["posts"]) == ["instagram", "tiktok", "youtube"]
    stored = table.raw(clip["pk"], clip["sk"])
    assert stored is not None
    assert set(stored["postIds"]) == {youtube["postId"], instagram["postId"], _tiktok(body)["postId"]}
    seen = posts.posts_for_clip(store, USER, clip["clipId"], consistent=True)
    assert sorted(p["platform"] for p in seen) == ["instagram", "tiktok", "youtube"]
    status, body = call("DELETE", f"/v1/clips/{clip['clipId']}/tiktok/posted")
    assert status == 200
    assert sorted(p["platform"] for p in body["posts"]) == ["instagram", "youtube"]
    stored = table.raw(clip["pk"], clip["sk"])
    assert stored is not None
    assert set(stored["postIds"]) == {youtube["postId"], instagram["postId"]}
    assert "tiktokByYou" not in stored


def test_what_was_learned_from_the_private_video_starts_fresh_and_comes_back_on_undo(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    clip = _uploaded(store)
    private = _post(
        store,
        clip,
        "tiktok",
        status="posted",
        privacy="private",
        postedAt="2026-11-01T10:00:00.000Z",
        day7State="missing",
        day7CheckedAt="2026-11-10T10:00:00.000Z",
        lastSnapshotAt="2026-11-02T10:00:00.000Z",
    )
    status, _ = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"noLink": True})
    assert status == 200
    raw = table.raw(db.user_pk(USER), db.post_sk(private["postId"]))
    assert raw is not None
    for key in ("day7State", "day7CheckedAt", "lastSnapshotAt"):
        assert key not in raw
    # Its own day-7 window starts now: once it closes, the public post is due for its day-7 views.
    assert day7.due(raw, datetime(2026, 11, 30, tzinfo=UTC))
    status, _ = call("DELETE", f"/v1/clips/{clip['clipId']}/tiktok/posted")
    assert status == 200
    raw = table.raw(db.user_pk(USER), db.post_sk(private["postId"]))
    assert raw is not None
    assert raw["day7State"] == "missing"
    assert raw["lastSnapshotAt"] == "2026-11-02T10:00:00.000Z"


def test_two_taps_at_once_make_one_tiktok_post(app: App, store: db.Store, monkeypatch: pytest.MonkeyPatch) -> None:
    clip = _uploaded(store)
    stale = store.get(clip["pk"], clip["sk"])
    assert stale is not None
    tiktok_self.mark_posted(store, stale, None, app.clock(), min_interval=15)
    # The second tap read the clip and its posts before the first one wrote: its create is refused, never a second
    # TikTok post for the clip.
    monkeypatch.setattr(tiktok_self, "posts_for_clip", lambda *_a, **_k: [])
    with pytest.raises(db.ConditionFailed):
        tiktok_self.mark_posted(store, stale, None, app.clock(), min_interval=15)
    monkeypatch.undo()
    assert [p["platform"] for p in posts.posts_for_clip(store, USER, clip["clipId"], consistent=True)] == ["tiktok"]


def test_the_route_turns_a_lost_race_into_the_same_answer(
    app: App, call: Call, store: db.Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    clip = _uploaded(store)
    real = tiktok_self.mark_posted
    calls: list[int] = []

    def racing(*args: Any, **kwargs: Any) -> None:
        calls.append(1)
        if len(calls) == 1:
            stale = store.get(clip["pk"], clip["sk"])
            real(store, stale, None, app.clock(), min_interval=15)  # the other tap wins first
            raise db.ConditionFailed("lost the race")
        real(*args, **kwargs)

    monkeypatch.setattr(tiktok_self, "mark_posted", racing)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"noLink": True})
    assert len(calls) == 2
    assert status == 200
    assert [p["platform"] for p in body["posts"]] == ["tiktok"]
