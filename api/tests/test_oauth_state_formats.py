"""The signed OAuth state, PKCE and the key formats (docs/CONTRACTS.md §17.4, §17.12)."""

from __future__ import annotations

import hashlib

import pytest

from clipfactory_api.errors import ApiError
from clipfactory_api.oauth import formats, state

KEY = b"k" * 64
NOW = 1_794_830_400  # 2026-11-16

# One good and one bad sample per row of the key formats table (the web's keyFormats test uses the same values).
YOUTUBE_ID = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps." + "googleusercontent.com"
YOUTUBE_SECRET = "GOCSPX-" + "AbCdEfGhIjKlMnOpQrStUvWxYz12"
TIKTOK_ID = "awabcdef1234567890"
TIKTOK_SECRET = "Zx9-Yw8_Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0"
META_ID = "1234567890123456"
META_SECRET = "0123456789abcdef0123456789abcdef"
META_CONFIG = "987654321098765"
X_ID = "VGhpcy1pcy1hLWNsaWVudC1pZA"
X_SECRET = "Q2xpcF9GYWN0b3J5X3NlY3JldF9mb3JfWF9hcHBfdGVzdA-xyz12"
GOOD = {
    "youtube": {"clientId": YOUTUBE_ID, "clientSecret": YOUTUBE_SECRET},
    "tiktok": {"clientId": TIKTOK_ID, "clientSecret": TIKTOK_SECRET},
    "instagram": {"clientId": META_ID, "clientSecret": META_SECRET, "configId": META_CONFIG},
    "facebook": {"clientId": META_ID, "clientSecret": META_SECRET, "configId": META_CONFIG},
    "x": {"clientId": X_ID, "clientSecret": X_SECRET},
}
BAD = {
    ("youtube", "clientId"): ("123456789012-abc.apps.google.com", "ends with .apps.googleusercontent.com"),
    ("youtube", "clientSecret"): ("AIzaSyD-not-a-secret-0123456789", "starts with GOCSPX-"),
    ("tiktok", "clientId"): ("short", "letters and numbers only"),
    ("tiktok", "clientSecret"): ("has spaces in it which is wrong", "long line of letters"),
    ("instagram", "clientId"): ("12345abc", "only numbers"),
    ("instagram", "clientSecret"): ("0123456789ABCDEF0123456789ABCDEF", "32 letters and numbers"),
    ("instagram", "configId"): ("config-1", "only numbers"),
    ("facebook", "clientId"): ("1234", "only numbers"),
    ("facebook", "clientSecret"): ("0123456789abcdef", "32 letters and numbers"),
    ("facebook", "configId"): ("abc", "only numbers"),
    ("x", "clientId"): ("tooshort", "long line of letters"),
    ("x", "clientSecret"): ("not long enough at all", "long line of letters"),
}


# --- state -------------------------------------------------------------------------------------------------------


def test_state_round_trip() -> None:
    nonce = state.new_nonce()
    assert len(nonce) == 22
    signed = state.sign(KEY, "youtube", nonce, NOW + 600)
    assert signed.startswith(f"v1.{nonce}.{NOW + 600}.")
    assert state.verify(KEY, "youtube", signed, NOW) == nonce


def test_nonces_are_random() -> None:
    assert len({state.new_nonce() for _ in range(50)}) == 50


@pytest.mark.parametrize(
    "case",
    ["tampered_signature", "tampered_exp", "wrong_platform", "expired", "other_key", "garbage", "too_long", "v2"],
)
def test_state_rejects(case: str) -> None:
    nonce = state.new_nonce()
    signed = state.sign(KEY, "youtube", nonce, NOW + 600)
    version, n, exp, sig = signed.split(".")
    platform, key, now = "youtube", KEY, NOW
    match case:
        case "tampered_signature":
            signed = f"{version}.{n}.{exp}.{('A' if sig[0] != 'A' else 'B') + sig[1:]}"
        case "tampered_exp":
            signed = f"{version}.{n}.{int(exp) + 3600}.{sig}"
        case "wrong_platform":
            platform = "x"
        case "expired":
            now = NOW + 601
        case "other_key":
            key = b"o" * 64
        case "garbage":
            signed = "not-a-state"
        case "too_long":
            signed = signed + "x" * 300
        case "v2":
            signed = "v2" + signed[2:]
    with pytest.raises(state.StateError):
        state.verify(key, platform, signed, now)


def test_pkce_is_deterministic_and_s256() -> None:
    verifier, challenge = state.pkce(KEY, "abcdefghijklmnopqrstuv")
    again = state.pkce(KEY, "abcdefghijklmnopqrstuv")
    assert (verifier, challenge) == again
    assert len(verifier) == 43
    assert challenge == state.b64url(hashlib.sha256(verifier.encode()).digest())
    assert state.pkce(KEY, "bbcdefghijklmnopqrstuv")[0] != verifier


# --- key formats -------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("platform", list(GOOD))
def test_good_keys_pass(platform: str) -> None:
    for name, value in GOOD[platform].items():
        assert formats.check(platform, name, value) == value


@pytest.mark.parametrize(("where", "case"), list(BAD.items()))
def test_bad_keys_say_what_the_value_looks_like(where: tuple[str, str], case: tuple[str, str]) -> None:
    platform, name = where
    value, words = case
    with pytest.raises(ApiError) as e:
        formats.check(platform, name, value)
    assert e.value.status == 400
    assert words in e.value.message
    assert value not in e.value.message  # never echo what was pasted


def test_values_are_cleaned_before_checking() -> None:
    pasted = f' "{YOUTUBE_ID}"\u200b\n'
    assert formats.check("youtube", "clientId", pasted) == YOUTUBE_ID
    assert formats.check("tiktok", "clientSecret", f"﻿{TIKTOK_SECRET} ") == TIKTOK_SECRET


def test_login_url_gives_the_config_id() -> None:
    url = (
        "https://www.facebook.com/v27.0/dialog/oauth?client_id=1234567890123456&config_id=987654321098765"
        "&redirect_uri=https%3A%2F%2Fexample.com&response_type=code"
    )
    assert formats.check("instagram", "configId", url) == META_CONFIG
    assert formats.config_id_from("12345") == "12345"


def test_hints_are_masked() -> None:
    assert formats.hint("clientId", YOUTUBE_ID) == "123456….com"
    assert formats.hint("clientSecret", YOUTUBE_SECRET) == "••••Yz12"
    assert formats.hint("configId", META_CONFIG) == "8765"
    for name, value in GOOD["x"].items():
        assert value not in formats.hint(name, value)
