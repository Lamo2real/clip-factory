"""Captions garbled by a Mac clipboard (Mac Roman mojibake) are shown, saved and posted as they were written, and
real emoji, accents and other scripts are never changed (seen 22 Nov 2026: 💀 copied into TikTok as an Apple logo
and "üíÄ")."""

from __future__ import annotations

import json

import pytest

from clipfactory_api import db, mojibake
from clipfactory_api.platforms.publishers import caption
from conftest import CAPTIONS, USER, Call, seed_clip
from fakes import FakeHttp
from test_publishers import make_job

# What the owner saw: 💀 (F0 9F 92 80) read as Mac Roman, exactly as macOS pbcopy without a UTF-8 locale makes it.
OWNER_CAPTION = '"stupid good samaritan" üíÄ\nhero or idiot?\n#gta6 #xqc #lucia #gaming #heist'
OWNER_FIXED = '"stupid good samaritan" 💀\nhero or idiot?\n#gta6 #xqc #lucia #gaming #heist'
REAL = "💀🔥 é 日本"


def garble(text: str) -> str:
    """``text`` as macOS turns it when a tool without a UTF-8 locale reads it (each UTF-8 byte one Mac Roman letter)."""
    return text.encode("utf-8").decode("mac_roman")


def test_garble_matches_what_the_owner_saw() -> None:
    assert garble("💀") == "üíÄ"
    assert garble("é") == "√©"
    assert garble("日本") == "Êó•Êú¨"


@pytest.mark.parametrize(
    "text",
    [
        "💀",
        "🔥",
        "💀🔥",
        "é",
        "日本",
        REAL,
        "café crème, naïve, Åsa, smörgås, mañana, ©",
        "“quoted” — it’s 100% real… ❤️ 👍🏽 👨‍👩‍👧",  # noqa: RUF001
        "日本語のテキスト, 한국어, 中文",
        "#gta6 #xqc 💀💀💀 lmao",
    ],
)
def test_repairs_garbled_text_back_to_what_was_written(text: str) -> None:
    assert garble(text) != text
    assert mojibake.repair(garble(text)) == text


def test_repairs_the_owners_caption() -> None:
    assert mojibake.repair(OWNER_CAPTION) == OWNER_FIXED


def test_only_the_garbled_part_changes_next_to_real_emoji() -> None:
    assert mojibake.repair(f"{REAL} and {garble('💀')} in one") == f"{REAL} and 💀 in one"


@pytest.mark.parametrize(
    "text",
    [
        "",
        "plain ascii, #tags and @handles",
        REAL,
        "l’été, l’équipe, d’Été",  # noqa: RUF001 (the curly apostrophe is Mac Roman D5: never a lead byte)
        "–é —à “É” ‘ü’",  # noqa: RUF001 (dashes and curly quotes before accents stay)
        "naïve café Äpfel Ölen über",
        "√2 ≈ 1.41, ¬p, ©2026",  # √ and ¬ alone, or before ASCII
        "\uf8ff Apple logo alone",
        "Ä Å Ç É",
        "Привет мир, Ελληνικά, עברית, العربية, 한국어",
    ],
)
def test_real_text_is_never_changed(text: str) -> None:
    assert mojibake.repair(text) == text


def test_cyrillic_and_other_two_byte_scripts_are_left_as_they_are() -> None:
    # Their Mac Roman leads are the dashes and curly quotes, real punctuation, so they are not guessed at.
    garbled = garble("Привет")
    assert mojibake.repair(garbled) == garbled


def test_repair_captions_keeps_anything_that_is_not_text() -> None:
    assert mojibake.repair_captions(None) is None
    assert mojibake.repair_captions({"tiktok": OWNER_CAPTION, "x": 5}) == {"tiktok": OWNER_FIXED, "x": 5}


# --- The API --------------------------------------------------------------------------------------------------------


def test_a_garbled_stored_caption_is_shown_repaired_and_never_rewritten(call: Call, store: db.Store) -> None:
    clip = seed_clip(store, status="posted", captions={**CAPTIONS, "tiktok": OWNER_CAPTION})
    status, body = call("GET", f"/v1/clips/{clip['clipId']}")
    assert status == 200
    assert body["clip"]["captions"]["tiktok"] == OWNER_FIXED
    _, listed = call("GET", "/v1/clips", query={"status": "all"})
    assert listed["clips"][0]["captions"]["tiktok"] == OWNER_FIXED
    # The owner's data stays exactly as it was stored: the repair is only in what is shown.
    stored = store.get(db.user_pk(USER), db.clip_sk(clip["clipId"]))
    assert stored is not None
    assert stored["captions"]["tiktok"] == OWNER_CAPTION


def test_a_caption_pasted_garbled_is_saved_repaired(call: Call, store: db.Store) -> None:
    clip = seed_clip(store)
    status, body = call("PATCH", f"/v1/clips/{clip['clipId']}", {"captions": {"tiktok": garble(f"wait {REAL}")}})
    assert status == 200
    assert body["clip"]["captions"]["tiktok"] == f"wait {REAL}"
    stored = store.get(db.user_pk(USER), db.clip_sk(clip["clipId"]))
    assert stored is not None
    assert stored["captions"]["tiktok"] == f"wait {REAL}"


@pytest.mark.parametrize("ascii_only", [True, False])
def test_emoji_and_other_scripts_are_saved_exactly(call: Call, store: db.Store, ascii_only: bool) -> None:
    clip = seed_clip(store)
    payload = {"captions": {"tiktok": f"wait {REAL}", "x": "日本 é 💀🔥"}}
    # Both ways a browser may send it: escaped (💀) or raw UTF-8.
    raw = json.dumps(payload, ensure_ascii=ascii_only)
    status, body = call("PATCH", f"/v1/clips/{clip['clipId']}", raw=raw)
    assert status == 200
    assert body["clip"]["captions"]["tiktok"] == f"wait {REAL}"
    assert body["clip"]["captions"]["x"] == "日本 é 💀🔥"
    _, again = call("GET", f"/v1/clips/{clip['clipId']}")
    assert again["clip"]["captions"]["tiktok"] == f"wait {REAL}"


def test_confirm_with_a_garbled_tiktok_caption_saves_it_repaired(call: Call, store: db.Store) -> None:
    clip = seed_clip(store)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"captions": {"tiktok": OWNER_CAPTION}})
    assert status == 200
    assert body["clip"]["captions"]["tiktok"] == OWNER_FIXED


def test_editing_another_caption_keeps_the_shown_tiktok_caption(call: Call, store: db.Store) -> None:
    clip = seed_clip(store, captions={**CAPTIONS, "tiktok": OWNER_CAPTION})
    status, body = call("PATCH", f"/v1/clips/{clip['clipId']}", {"captions": {"x": "new x"}})
    assert status == 200
    assert body["clip"]["captions"]["tiktok"] == OWNER_FIXED
    assert body["clip"]["captions"]["x"] == "new x"


@pytest.mark.parametrize("platform", ["tiktok", "instagram", "facebook", "youtube"])
def test_a_garbled_stored_caption_is_posted_repaired(platform: str) -> None:
    field = {"youtube": "youtubeDescription"}.get(platform, platform)
    job, _, _ = make_job(platform, FakeHttp(), captions={**CAPTIONS, field: OWNER_CAPTION})
    sent = caption(job, platform)
    assert "💀" in sent
    assert "" not in sent
    assert "üíÄ" not in sent
