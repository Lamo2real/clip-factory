"""Does this clip fit the campaign? (docs/CONTRACTS.md §39.3, tests §39.5 "api (G)").

The golden cases (``cr_fit_cases.py`` writes ``fixtures/cr_fit_cases.json``, ``cr_fit_live_cases.json`` and
``channel_match_cases.json``), each rule's states and words by hand, the verdict and its order, ``canUpload``,
``canRemake`` and ``softCodes``, the clip loader (which campaigns, the suggestion, the campaigns that own a moment),
``GET /v1/contentrewards/fit`` (stored items only: its fakes answer no network call) and "Fix it for me". Offline:
in-memory items and a ``FakeCR`` that fails any call.
"""

from __future__ import annotations

import copy
import json
from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.clock import iso
from clipfactory_api.contentrewards import campaigns, fit, public, rules
from clipfactory_api.platforms.campaign_caption import campaign_caption, campaign_options
from conftest import NOW, USER, Call, Clock, seed_clip, seed_job
from cr_fit_cases import (
    CHANNEL_FILE,
    FIT_FILE,
    GOOD,
    LIVE_FILE,
    TIKTOK_OFF,
    TIKTOK_ON,
    base_campaign,
    base_rules,
    build,
    case,
    channel_keys,
    normal_clip,
    normal_job,
    run,
)
from cr_fit_cases import (
    campaign_job as fit_job,
)
from cr_support import UUID, UUID2, FakeCR, FakeInvoker, make_deps, seed_campaign, seed_connection, seed_setup
from fakes import FakeSecretsManager

FITS = json.loads(FIT_FILE.read_text())
LIVE = json.loads(LIVE_FILE.read_text())
CHANNELS = json.loads(CHANNEL_FILE.read_text())
BY_NAME = {c["name"]: c for c in FITS}
OTHER = "b2cefc3b-4533-438f-8e70-a7299550f1cf"


def expect(name: str) -> dict[str, Any]:
    return BY_NAME[name]["expect"]  # type: ignore[no-any-return]


def items_of(found: dict[str, Any], rule: str) -> list[dict[str, Any]]:
    return [i for i in found["items"] if i["rule"] == rule]


def one(found: dict[str, Any], rule: str) -> dict[str, Any]:
    rows = items_of(found, rule)
    assert len(rows) == 1, rows
    return rows[0]


# --- the golden files ------------------------------------------------------------------------------------------


def test_the_golden_files_are_current() -> None:
    found = build()
    assert found["fit"] == FITS, "run: uv run python tests/cr_fit_cases.py"
    assert found["live"] == LIVE, "run: uv run python tests/cr_fit_cases.py"
    assert found["channel"] == CHANNELS, "run: uv run python tests/cr_fit_cases.py"


@pytest.mark.parametrize("c", FITS, ids=[c["name"] for c in FITS])
def test_each_fit_case(c: dict[str, Any]) -> None:
    assert run(c) == c["expect"]


@pytest.mark.parametrize("c", LIVE, ids=[c["name"] for c in LIVE])
def test_each_live_case(c: dict[str, Any]) -> None:
    card = c["card"]
    assert fit.live(c["fit"], captions=card["captions"], chosen=card["chosen"], tiktok=card["tiktok"]) == c["expect"]


def test_live_with_the_server_state_changes_nothing() -> None:
    """The web's first live check (the card as the server saw it) gives back the server's own answer."""
    for c in FITS:
        if not c["clip"].get("campaignId") or c["captions"] is not None:
            continue
        cf = c["expect"]
        again = fit.live(cf, captions=c["clip"]["captions"], chosen=c["chosen"], tiktok=c["tiktok"])
        assert again == cf, c["name"]


@pytest.mark.parametrize("c", CHANNELS, ids=[c["name"] for c in CHANNELS])
def test_channel_cases(c: dict[str, Any]) -> None:
    assert channel_keys(c["info"]) == c["channelKeys"]
    assert fit.channel_matches(c["channels"], c["channelKeys"] or None) is c["matches"]


def test_channel_keys_win_over_the_stored_name() -> None:
    faze = [{"name": "FaZe Clan", "url": None}]
    assert fit.channel_matches(faze, None, "FaZe Clan", "UCx") is True  # before I: channel and channelId
    assert fit.channel_matches(faze, None, "Valorant Daily", "UCvalo") is False
    assert fit.channel_matches(faze, ["fazeclan"], "Valorant Daily", "UCvalo") is True  # the stored keys win
    assert fit.channel_matches(faze, None, None, None) is None
    assert fit.channel_matches([], None, "FaZe Clan", None) is None


# --- each rule, by hand ----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "text"),
    [
        ("held is a wait", "Content Rewards wants the brand to check your other clips first."),
        ("paused is a wait", "The brand paused this campaign."),
        ("waiting for the brand is a wait", "Nothing to do. I'll tell you when you're in."),
        ("reading the rules is a wait", "Reading the rules… Look again in a minute."),
    ],
)
def test_held_paused_waiting_and_reading_are_waits(name: str, text: str) -> None:
    found = expect(name)
    assert (found["verdict"], found["headline"]) == ("wait", "Wait a little for FaZe Clips")
    assert (found["canUpload"], found["canRemake"]) == (False, False)
    wait = one(found, "campaign")
    assert (wait["state"], wait["fix"]) == ("todo", None)
    assert wait["text"].startswith(text)
    assert fit.upload_refusal(found) == f"Not yet for FaZe Clips: {wait['text']}"


def test_hard_stops_that_send_him_elsewhere_are_no() -> None:
    for name in (
        "ended",
        "the money is gone",
        "the brand wants its own picture on top",
        "drafts first",
        "not accepted",
    ):
        found = expect(name)
        row = one(found, "campaign")
        assert (found["verdict"], row["state"]) == ("doesnt_fit", "no"), name
        assert row["fix"] == {
            "kind": "open",
            "label": "Find another campaign",
            "href": fit.config.DISCOVER_URL,
            "external": True,
        }
    assert one(expect("the brand wants its own picture on top"), "campaign")["text"].startswith(
        "This campaign wants its own picture on top of the video."
    )


def test_membership_todos_have_their_buttons() -> None:
    assert one(expect("not connected: connect first"), "campaign")["fix"] == {
        "kind": "open",
        "label": "Connect Content Rewards",
        "href": "/settings/posting/setup/contentrewards",
    }
    assert one(expect("not joined"), "campaign")["fix"]["label"] == "Open campaign"
    assert one(expect("not joined"), "campaign")["fix"]["external"] is True
    assert one(expect("apply first"), "campaign")["fix"] == {
        "kind": "open",
        "label": "Yes, I applied",
        "href": f"/campaigns/{UUID}",
    }
    assert one(expect("the rules failed"), "campaign")["fix"]["href"] == f"/campaigns/{UUID}#rules"
    for name in ("not joined", "left", "apply first", "the rules failed", "not connected: connect first"):
        found = expect(name)
        assert (found["verdict"], found["headline"], found["canUpload"]) == (
            "fixable",
            "One thing first for FaZe Clips",
            False,
        ), name


def test_a_channel_mismatch_is_a_check_and_never_blocks() -> None:
    found = expect("the channel doesn't match: look yourself")
    row = one(found, "source")
    assert row == {
        "rule": "source",
        "state": "check",
        "text": "This video may not be from FaZe's channels. FaZe Clips only pays for those. Look yourself.",
        "fix": {"kind": "open", "label": "Read the rules", "href": f"/campaigns/{UUID}#rules"},
    }
    assert (found["verdict"], found["canUpload"]) == ("cant_tell", True)


def test_exact_facts_say_no() -> None:
    outside = expect("only its own videos: another link")
    assert one(outside, "source")["text"] == "FaZe Clips only pays for clips of its own videos."
    assert one(outside, "source")["fix"]["kind"] == "new_clips"
    assert one(outside, "source")["fix"]["href"] == f"/?campaign={UUID}"  # another video: the box starts empty
    ruled_out = expect("a ruled-out site")
    assert one(ruled_out, "source")["text"] == "FaZe Clips doesn't pay for clips of Kick videos."
    for found in (outside, ruled_out):
        assert (found["verdict"], found["canUpload"], found["canRemake"]) == ("doesnt_fit", False, False)
    assert one(expect("only its own videos: a video file"), "source")["state"] == "check"
    assert one(expect("a campaign video"), "source")["text"] == "From a FaZe Clips video."
    assert one(expect("the channel matches by its stored keys"), "source")["text"] == "From FaZe's YouTube."
    assert one(expect("a Mac-fetched video keeps its link and site"), "source")["state"] == "ok"
    assert one(expect("a clean campaign clip fits"), "source")["text"] == "Any video is fine for FaZe Clips."
    assert one(expect("source notes can't be checked"), "source")["state"] == "check"


def test_language_free_text() -> None:
    assert one(expect("the language matches one of two"), "language")["text"] == "In Spanish."
    assert one(expect("EN only"), "language")["text"] == "In English."
    wrong = one(expect("the wrong language"), "language")
    assert (wrong["state"], wrong["text"]) == ("no", "This clip is in Spanish. FaZe Clips wants English.")
    assert (
        one(expect("no stored language"), "language")["text"]
        == "I couldn't check the language. FaZe Clips wants English."
    )
    assert one(expect("a rule that names no known language"), "language") == {
        "rule": "language",
        "state": "check",
        "text": "I couldn't check the language. FaZe Clips wants Tagalog.",
        "fix": {"kind": "open", "label": "Read the rules", "href": f"/campaigns/{UUID}#rules"},
    }
    assert fit.languages_in("English or Spanish") == [("en", "English"), ("es", "Spanish")]
    assert fit.languages_in("EN only") == [("en", "English")]
    assert fit.languages_in("Englisch") == []  # whole words only
    assert fit.languages_in("es-MX please") == [("es", "Spanish")]
    assert fit.languages_in("EN-US or pt-BR") == [("en", "English"), ("pt", "Portuguese")]
    # codes count only as codes are written: ordinary words are never a language
    for words in ("Español de España", "Any, as long as it is clear", "keep it clean", "en français", "hi there"):
        assert fit.languages_in(words) == [], words
        found = run(case(words, campaign=base_campaign(rules=base_rules(language=words))))
        assert (one(found, "language")["state"], found["canUpload"]) == ("check", True), words
    assert fit.languages_in("english, ITALIAN") == [("en", "English"), ("it", "Italian")]
    italian = run(case("italian", campaign=base_campaign(rules=base_rules(language="English, or Spanish if it fits"))))
    assert one(italian, "language")["text"] == "In English."
    wrong = run(
        case(
            "italian clip",
            campaign=base_campaign(rules=base_rules(language="English, or Spanish if it fits")),
            job=fit_job(sourceLanguage="it-IT"),
        )
    )
    assert one(wrong, "language")["text"] == "This clip is in Italian. FaZe Clips wants English or Spanish."
    rule = campaigns.language_rule_text({"name": "FaZe Clips", "rules": {"language": "Español de España"}})
    assert rule == "FaZe Clips wants clips in Español de España."
    assert not items_of(expect("a clean campaign clip fits"), "language")  # no language rule: not listed


def test_the_logo_from_the_clips_own_checklist() -> None:
    kept = expect("the logo is on the clip, even after the campaign's logo was deleted")
    assert one(kept, "logo") == {
        "rule": "logo",
        "state": "ok",
        "text": "The FaZe logo is on the whole clip.",
        "fix": None,
    }
    copy_it = expect("the logo is missing and a ready logo can be put on a copy")
    assert one(copy_it, "logo")["fix"] == {"kind": "remake", "label": "Make a FaZe Clips copy"}
    assert (copy_it["verdict"], copy_it["headline"], copy_it["canRemake"]) == (
        "fixable",
        "FaZe Clips needs a copy of this clip",
        True,
    )
    first = expect("the logo is missing and the campaign has none yet")
    assert one(first, "logo")["state"] == "todo"
    assert first["canRemake"] is False  # no ready logo: a copy couldn't add it either


def test_no_place_without_platforms_paid_is_a_todo() -> None:
    found = expect("where it pays isn't known yet")
    assert one(found, "places") == {
        "rule": "places",
        "state": "todo",
        "text": "I can't tell where FaZe Clips pays yet. Tap Check now.",
        "fix": {"kind": "open", "label": "Open campaign", "href": f"/campaigns/{UUID}"},
    }
    assert found["uploadPlaces"] == []
    tiktok = expect("tiktok only")
    assert one(tiktok, "places")["state"] == "no"
    assert tiktok["uploadPlaces"] == []


def test_place_link_checks_and_notes() -> None:
    unknown = expect("accounts added: not checked")
    assert [i["platform"] for i in items_of(unknown, "place_link")] == ["youtube", "instagram"]
    assert all(i["state"] == "check" and i["fix"]["external"] for i in items_of(unknown, "place_link"))
    assert not items_of(expect("a clean campaign clip fits"), "place_link")  # "I added them" is done
    refused = one(expect("content rewards doesn't know instagram"), "place_link")
    assert (refused["state"], refused["platform"]) == ("note", "instagram")
    assert refused["text"] == "Content Rewards doesn't know your Instagram account. Add it there, then tap I added it."
    only = expect("content rewards doesn't know the only place")
    assert one(only, "places")["text"] == "Add YouTube in Content Rewards first. Then tap I added it."
    assert not items_of(only, "place_link")  # said once


def test_a_rules_review_that_never_came_back_is_a_check() -> None:
    """The agent's "couldn't check" row (``pass: false``, §38.13) is never a ``no``: the banned list and the other
    rules are his own checks, and the word "Claude" never reaches the screen."""
    found = expect("the review never came back: look yourself, never a no")
    assert (found["verdict"], found["canUpload"], found["headline"]) == (
        "cant_tell",
        True,
        "Check 2 things, then upload",
    )
    assert one(found, "banned")["text"] == "I couldn't check: no gambling. Look yourself."
    assert [i["text"] for i in items_of(found, "uncertain")] == [
        "I couldn't check: Show the scoreboard. Look yourself."
    ]
    assert fit.upload_refusal(found) is None
    assert all("Claude" not in i["text"] for c in FITS for i in c["expect"]["items"])
    nothing = expect("the review never came back and nothing is banned")
    assert not items_of(nothing, "banned")
    assert nothing["verdict"] == "fits"
    found_it = expect("banned content found")
    assert (one(found_it, "banned")["state"], one(found_it, "banned")["text"]) == ("no", "Shows gambling at 0:12.")


def test_checked_only_against_what_the_agent_judged() -> None:
    """The agent judged the clip by its job's own rules: a logo row that passed because that job asked for no logo,
    or a banned item or other rule added since, is never shown as done."""
    logo = expect("the logo row passed only because the job didn't ask for one")
    assert one(logo, "logo")["state"] == "remake"
    later = expect("banned content added after the clip was judged")
    assert one(later, "banned")["text"] == "I couldn't check: no gambling. Look yourself."  # swearing was judged
    assert one(expect("banned content checked and fine"), "banned")["text"] == "No swearing or gambling. Checked."
    newer = expect("an other rule added after the clip was judged")
    assert [i["text"] for i in items_of(newer, "uncertain")] == ["I couldn't check: Keep the music. Look yourself."]


def test_a_campaign_clip_known_from_its_posts_only() -> None:
    found = expect("a campaign clip known from its posts only")
    assert one(found, "on_screen")["state"] == "ok"  # its own checklist counts: it is this campaign's clip
    assert (found["verdict"], found["canUpload"]) == ("fits", True)


def test_every_required_phrase_is_checked() -> None:
    """``required.phrase`` carries one phrase; a second (a tag that isn't a whole token) is checked by the server."""
    rules_then = base_rules(requiredTags=["@FaZeClan", "@faze."], requiredCaptionText="Use code FAZE")
    c = case(
        "two phrases",
        campaign=base_campaign(rules=rules_then),
        job=fit_job(campaign={"campaignId": UUID, "name": "FaZe Clips", "rules": rules_then}),
    )
    found = run(c)
    assert found["required"]["phrase"] == "@faze."
    youtube = next(i for i in items_of(found, "tags") if i.get("platform") == "youtube")
    assert (
        youtube["text"]
        == "The YouTube words are missing “@faze.” and “Use code FAZE”. I'll put them back when it uploads."
    )
    good = {k: f"{v} @faze. Use code FAZE" for k, v in GOOD.items()}
    fine = run({**c, "captions": good})
    assert one(fine, "tags")["text"] == "Every caption has #FaZe, @FaZeClan, “@faze.” and “Use code FAZE”."


def test_other_rules_are_checks_for_a_normal_clip_only() -> None:
    normal = expect("a normal clip with other rules and banned content")
    assert [i["text"] for i in items_of(normal, "uncertain")] == [
        "I couldn't check: Show the scoreboard. Look yourself."
    ]
    assert one(normal, "banned")["text"] == "I couldn't check: no swearing. Look yourself."
    judged = expect("a campaign clip's other rules were judged")
    assert not items_of(judged, "uncertain")


def test_uncertain_read_from_the_rules_first() -> None:
    c = case(
        "uncertain from the rules",
        campaign=base_campaign(rules=base_rules(uncertain=["From the rules."]), uncertain=["From the item."]),
    )
    assert [i["text"] for i in items_of(run(c), "uncertain")] == ["I couldn't check: From the rules. Look yourself."]
    many = expect("uncertain lines from the item when the rules have none, and at most five")
    assert [i["state"] for i in items_of(many, "uncertain")] == ["check"] * 5 + ["note"]
    assert items_of(many, "uncertain")[-1]["text"] == "And 2 more on the campaign page."
    assert many["headline"] == "Check 5 things, then upload"


def test_tags_and_ad_fixes_never_block() -> None:
    for name in (
        "a missing tag still fits",
        "#Ad not at the start still fits",
        "the brand's own disclosure and a phrase",
    ):
        found = expect(name)
        assert (found["verdict"], found["canUpload"]) == ("fits", True), name
        assert any(
            i["state"] == "fix" and i["fix"] == {"kind": "captions", "label": "Fix it for me"} for i in found["items"]
        )
    assert fit.upload_refusal(expect("a missing tag still fits")) is None
    phrase = expect("the brand's own disclosure and a phrase")
    assert phrase["required"] == {
        "disclosure": "#Sponsored",
        "tokens": ["#FaZe", "@FaZeClan"],
        "phrase": "Use code FAZE",
    }


def test_tiktok_branded_content() -> None:
    off = expect("tiktok branded content off is almost ready")
    row = next(i for i in off["items"] if i["rule"] == "paid_switch" and i.get("platform") == "tiktok")
    assert row == {
        "rule": "paid_switch",
        "state": "fix",
        "text": "Branded content is off on TikTok.",
        "fix": {"kind": "tiktok_branded", "label": "Turn on Branded content"},
        "platform": "tiktok",
    }
    assert (off["verdict"], off["headline"], off["canUpload"]) == ("fixable", "Almost ready for FaZe Clips", False)
    on = expect("tiktok branded content on")
    assert (on["verdict"], on["canUpload"]) == ("fits", True)
    unknown = run(case("tiktok not known", campaign=base_campaign(platformsPaid=["youtube", "tiktok"])))
    assert not [i for i in unknown["items"] if i.get("platform") == "tiktok" and i["rule"] == "paid_switch"]


def test_the_verdict_order_and_headlines() -> None:
    assert expect("a clean campaign clip fits")["headline"] == "Can earn on FaZe Clips"
    assert expect("two things to check yourself")["headline"] == "Check 2 things, then upload"
    assert expect("one thing to check yourself")["headline"] == "Check 1 thing, then upload"
    assert expect("too long")["headline"] == "This clip can't earn on FaZe Clips"
    # a no beats a wait, a wait beats a fix, a todo names the headline before a copy
    both = run(
        case(
            "no and wait", campaign=base_campaign(state="paused"), clip=normal_clip(durationSec=99.0), job=normal_job()
        )
    )
    assert both["verdict"] == "doesnt_fit"
    held = expect("a normal clip of a held campaign can't be copied yet")
    assert (held["verdict"], held["canRemake"]) == ("wait", False)
    first = expect("a normal clip, the logo missing on the campaign page first")
    assert (first["verdict"], first["headline"]) == ("fixable", "One thing first for FaZe Clips")
    states = [i["state"] for i in expect("a normal clip with other rules and banned content")["items"]]
    assert states == sorted(states, key=fit.STATES.index)  # problems first, then the ok ones


def test_length_words() -> None:
    assert one(expect("a clean campaign clip fits"), "length")["text"] == "42 seconds. FaZe Clips takes 15 to 60."
    too_long = one(expect("too long"), "length")
    assert too_long["text"] == "This clip is 72 seconds. FaZe Clips takes 15 to 60 seconds."
    assert too_long["fix"]["href"] == f"/?campaign={UUID}&link=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dfaze123"
    assert one(expect("too short"), "length")["text"] == "This clip is 13 seconds. FaZe Clips takes 15 to 60 seconds."
    edge = run(case("just over", clip=normal_clip(durationSec=60.3), job=normal_job()))
    assert one(edge, "length")["text"].startswith("This clip is 61 seconds.")  # never "60 seconds" for a no
    assert one(expect("only a minimum"), "length")["text"] == "42 seconds. FaZe Clips takes 15 seconds or more."
    assert one(expect("only a maximum"), "length")["text"] == "42 seconds. FaZe Clips takes up to 60 seconds."
    assert not items_of(expect("no length rule is not listed"), "length")
    short = run(
        case(
            "one side short",
            campaign=base_campaign(rules=base_rules(lengthMaxSec=None)),
            clip=normal_clip(durationSec=9.0),
            job=normal_job(),
        )
    )
    assert one(short, "length")["text"] == "This clip is 9 seconds. FaZe Clips takes 15 seconds or more."


def test_an_exact_length_uses_the_agents_second_each_way() -> None:
    """The agent widens an exact length by 1 s each way (``Campaign.length``) and its strict check passed a 30.6 s
    clip of a "30 seconds" campaign: the fit agrees, and never says a number that reads as the other answer."""
    near = expect("an exact length: a cut clip a little over still fits")
    assert one(near, "length") == {
        "rule": "length",
        "state": "ok",
        "text": "30 seconds. FaZe Clips takes 30 seconds.",
        "fix": None,
    }
    assert (near["verdict"], near["canUpload"]) == ("fits", True)
    over = expect("an exact length: two seconds over is too long")
    assert (one(over, "length")["state"], one(over, "length")["text"]) == (
        "no",
        "This clip is 32 seconds. FaZe Clips takes 30 seconds.",
    )
    exact = base_campaign(rules=base_rules(lengthMinSec=30, lengthMaxSec=30))
    for seconds, state in ((28.9, "no"), (29.0, "ok"), (31.0, "ok"), (31.1, "no")):
        found = run(case(f"{seconds}", campaign=exact, clip=normal_clip(durationSec=seconds), job=normal_job()))
        assert one(found, "length")["state"] == state, seconds
    narrow = base_campaign(rules=base_rules(lengthMinSec=29, lengthMaxSec=30))
    found = run(case("29 to 30", campaign=narrow, clip=normal_clip(durationSec=30.8), job=normal_job()))
    assert one(found, "length")["text"] == "30 seconds. FaZe Clips takes 29 to 30."
    wide = run(case("15 to 60 keeps its bounds", clip=normal_clip(durationSec=60.4), job=normal_job()))
    assert one(wide, "length")["state"] == "no"  # 2 s or wider: exactly the campaign's own bounds


def test_deadline_words() -> None:
    assert one(expect("the deadline is later"), "deadline")["text"] == "Takes clips until 23 Nov."
    assert one(expect("today is the last day"), "deadline")["state"] == "note"
    passed = one(expect("the deadline passed"), "deadline")
    assert (passed["state"], passed["text"]) == ("no", "FaZe Clips stopped taking clips on 14 Nov.")


def test_soft_stops_and_soft_codes() -> None:
    found = expect("soft stops: notes and checks, and the ones not accepted")
    assert found["softCodes"] == ["budget_half", "audience"]  # face_needed was accepted
    assert [i["state"] for i in items_of(found, "soft")] == ["check", "check", "note"]
    said = expect("the brand wants it said out loud: one check, not two")
    assert not items_of(said, "soft")
    assert one(said, "spoken")["text"] == fit.SPOKEN
    assert said["softCodes"] == ["spoken_needed"]
    assert one(expect("in by hand and not connected: send it yourself"), "send")["text"] == fit.HAND_SEND
    assert one(expect("a clean campaign clip fits"), "send")["text"] == fit.AUTO_SEND
    assert one(expect("send by hand when the ids are ambiguous"), "send")["text"] == fit.HAND_SEND


def test_a_normal_clip_could_earn_with_a_copy() -> None:
    found = expect("a normal clip that could earn")
    assert one(found, "on_screen") == {
        "rule": "on_screen",
        "state": "remake",
        "text": "“Paid partnership” isn't on the video.",
        "fix": {"kind": "remake", "label": "Make a FaZe Clips copy"},
    }
    assert (found["verdict"], found["canUpload"], found["canRemake"]) == ("fixable", False, True)
    assert not items_of(found, "tags")  # the copy gets them
    assert not items_of(found, "ad")
    posted = expect("a normal clip already up on YouTube")
    assert one(posted, "posted")["text"] == (
        "This clip is already up on YouTube. Content Rewards only takes a post sent in its first 30 minutes."
    )
    other = expect("a normal clip whose moment is on another campaign")
    assert (
        one(other, "one_campaign")["text"] == "This clip is for Valorant Clips. One clip can earn on one campaign only."
    )
    assert other["canRemake"] is False
    assert expect("a normal clip with a soft stop not accepted")["softCodes"] == ["budget_half"]


def test_a_copy_that_cant_be_made() -> None:
    off = expect("a normal clip while copies are off")
    row = one(off, "on_screen")
    assert row["state"] == "no"
    assert row["text"].endswith("Clip Factory can't make a FaZe Clips copy yet. Make new clips for this campaign.")
    assert row["fix"]["kind"] == "new_clips"
    assert (off["verdict"], off["canRemake"]) == ("doesnt_fit", False)
    gone = expect("a normal clip whose video is gone")
    assert one(gone, "on_screen")["text"].endswith(fit.GONE)
    assert fit.remake_refusal(gone, kept=False) == fit.GONE


def test_source_kept() -> None:
    link = {"source": {"type": "link"}, "createdAt": iso(NOW - timedelta(days=40))}
    assert fit.source_kept(link, NOW) is True
    for kind in ({"type": "upload"}, {"type": "upload", "fetchedBy": "mac"}):
        assert fit.source_kept({"source": kind, "createdAt": iso(NOW - timedelta(days=12))}, NOW) is True
        assert fit.source_kept({"source": kind, "createdAt": iso(NOW - timedelta(days=13))}, NOW) is False


def test_upload_refusal_words() -> None:
    assert fit.upload_refusal(expect("too long")) == (
        "This clip can't earn on FaZe Clips: This clip is 72 seconds. FaZe Clips takes 15 to 60 seconds."
    )
    assert fit.upload_refusal(expect("paid partnership isn't on the video")) == (
        "This clip can't earn on FaZe Clips: “Paid partnership” isn't on the video."
    )
    assert fit.upload_refusal(expect("a clean campaign clip fits")) is None
    assert fit.upload_refusal(expect("two things to check yourself")) is None  # checks never block


# --- the loader: which campaigns, the suggestion and the moment's other campaigns ------------------------------


@pytest.fixture
def cr(app: App, secrets_client: FakeSecretsManager, clock: Clock) -> Any:
    public.reset_limit()
    deps = make_deps(app.store, secrets_client, FakeCR(), clock, media=app.media, invoker=FakeInvoker())
    app.contentrewards = deps
    seed_connection(deps, USER, clock.now, stepsDone=["connect", "ready-account", "ready-socials"])
    seed_setup(deps.store, USER, "youtube")
    seed_setup(deps.store, USER, "instagram")
    return deps


def _campaign(deps: Any, uuid: str, n: int, **fields: Any) -> dict[str, Any]:
    named = {"name": f"Campaign {n}", "inSince": iso(NOW - timedelta(days=n)), **fields}
    return seed_campaign(deps.store, USER, NOW, uuid, **named)


def _uuid(n: int) -> str:
    return f"{n:08x}-be80-4db8-b552-8e32b148604e"


def test_a_normal_clip_is_checked_against_his_campaigns_newest_first(cr: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CR_REMAKE", "on")
    for n in range(1, 13):
        _campaign(cr, _uuid(n), n)
    _campaign(cr, _uuid(20), 0, membership="not_joined")  # not in: never checked
    _campaign(cr, _uuid(21), 0, membership="manual", name="By hand")
    job = seed_job(
        cr.store, status="ready", source={"type": "link", "platform": "youtube", "url": "https://youtu.be/x"}
    )
    clip = seed_clip(cr.store, job_id=job["jobId"])
    found = fit.for_clip(cr, USER, clip["clipId"], NOW)
    assert found["mode"] == "normal"
    assert [f["campaignName"] for f in found["fits"]] == ["By hand", *[f"Campaign {n}" for n in range(1, 10)]]
    assert found["suggestion"] == {"campaignId": _uuid(21), "name": "By hand"}
    assert found["remakes"] == {}
    assert cr.net.requests == []  # stored items only: no CR, no public JSON, no network


def test_the_suggestion_needs_a_source_ok(cr: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CR_REMAKE", "on")
    channels = {**rules.empty()["allowedSources"], "channels": [{"name": "FaZe Clan", "url": None}]}
    _campaign(cr, _uuid(1), 1, rules={**base_rules(), "allowedSources": channels})
    _campaign(cr, _uuid(2), 2)
    job = seed_job(
        cr.store,
        status="ready",
        source={"type": "link", "platform": "youtube", "url": "https://youtu.be/x", "channel": "Valorant"},
    )
    clip = seed_clip(cr.store, job_id=job["jobId"])
    found = fit.for_clip(cr, USER, clip["clipId"], NOW)
    assert found["suggestion"] == {"campaignId": _uuid(2), "name": "Campaign 2"}  # the first one can't tell
    monkeypatch.setenv("CR_REMAKE", "off")
    assert fit.for_clip(cr, USER, clip["clipId"], NOW)["suggestion"] is None  # no copy yet: nothing to offer


def test_a_campaign_clip_is_checked_against_its_own_campaign_only(cr: Any) -> None:
    seed_campaign(cr.store, USER, NOW)
    seed_campaign(cr.store, USER, NOW, UUID2, name="Valorant Clips")
    job = seed_job(
        cr.store,
        status="ready",
        campaignId=UUID,
        campaign={"campaignId": UUID, "name": "FaZe Clips", "rules": base_rules()},
    )
    clip = seed_clip(cr.store, job_id=job["jobId"], campaignId=UUID, captions=dict(GOOD))
    found = fit.for_clip(cr, USER, clip["clipId"], NOW)
    assert (found["mode"], [f["campaignId"] for f in found["fits"]], found["suggestion"]) == ("campaign", [UUID], None)
    cr.store.delete(db.user_pk(USER), db.campaign_sk(UUID))  # the campaign was removed
    gone = fit.for_clip(cr, USER, clip["clipId"], NOW)["fits"][0]
    assert (gone["verdict"], gone["campaignName"], gone["items"][0]["text"]) == (
        "doesnt_fit",
        "FaZe Clips",
        "Add the campaign again on the Campaigns page.",
    )


def test_one_campaign_per_moment_through_copies_and_the_original(cr: Any) -> None:
    seed_campaign(cr.store, USER, NOW)
    seed_campaign(cr.store, USER, NOW, UUID2, name="Valorant Clips")
    copy_job = seed_job(cr.store, status="running", campaignId=UUID2)
    original_job = seed_job(cr.store, status="ready")
    original = seed_clip(
        cr.store,
        job_id=original_job["jobId"],
        remakes={UUID2: {"jobId": copy_job["jobId"], "at": iso(NOW)}},
    )
    found = fit.for_clip(cr, USER, original["clipId"], NOW)
    faze = next(f for f in found["fits"] if f["campaignId"] == UUID)
    assert (
        one(faze, "one_campaign")["text"] == "This clip is for Valorant Clips. One clip can earn on one campaign only."
    )
    assert found["remakes"] == {UUID2: {"jobId": copy_job["jobId"], "at": iso(NOW)}}
    # a copy whose job failed no longer counts
    cr.store.update(copy_job["pk"], copy_job["sk"], {"status": "failed"})
    faze = next(f for f in fit.for_clip(cr, USER, original["clipId"], NOW)["fits"] if f["campaignId"] == UUID)
    assert not items_of(faze, "one_campaign")
    # a copy for FaZe sees its original's other live copy (for Valorant) and stops
    cr.store.update(copy_job["pk"], copy_job["sk"], {"status": "running"})
    faze_job = seed_job(
        cr.store,
        status="ready",
        campaignId=UUID,
        campaign={"campaignId": UUID, "name": "FaZe Clips", "rules": base_rules()},
    )
    faze_copy = seed_clip(
        cr.store,
        job_id=faze_job["jobId"],
        campaignId=UUID,
        remakeOf={"clipId": original["clipId"], "jobId": original_job["jobId"]},
    )
    cf = fit.for_clip(cr, USER, faze_copy["clipId"], NOW)["fits"][0]
    assert one(cf, "one_campaign")["text"].startswith("This clip is for Valorant Clips.")


def test_get_fit_routes(call: Call, cr: Any) -> None:
    seed_campaign(cr.store, USER, NOW)
    job = seed_job(
        cr.store,
        status="ready",
        campaignId=UUID,
        campaign={"campaignId": UUID, "name": "FaZe Clips", "rules": base_rules()},
    )
    clip = seed_clip(cr.store, job_id=job["jobId"], campaignId=UUID, captions=dict(GOOD))
    other = seed_clip(cr.store, job_id=seed_job(cr.store)["jobId"])
    status, body = call("GET", "/v1/contentrewards/fit", query={"clipId": clip["clipId"]})
    assert status == 200
    assert (body["clipId"], body["mode"], len(body["fits"])) == (clip["clipId"], "campaign", 1)
    status, body = call(
        "GET",
        "/v1/contentrewards/fit",
        query={"clipIds": f"{clip['clipId']},{other['clipId']},01J0000000000000000000NOPE"},
    )
    assert status == 200
    assert [c["clipId"] for c in body["clips"]] == [clip["clipId"], other["clipId"]]  # items only
    assert call("GET", "/v1/contentrewards/fit", query={"clipId": "01J0000000000000000000NOPE"})[0] == 404
    assert call("GET", "/v1/contentrewards/fit", query={"clipId": "nope"})[0] == 404
    assert call("GET", "/v1/contentrewards/fit")[0] == 400
    many = ",".join(seed_clip(cr.store)["clipId"] for _ in range(21))
    assert call("GET", "/v1/contentrewards/fit", query={"clipIds": many})[0] == 400
    assert cr.net.requests == []  # stored items only


def test_fit_is_unavailable_while_content_rewards_is_off(call: Call) -> None:
    status, body = call("GET", "/v1/contentrewards/fit", query={"clipId": "01J0000000000000000000NOPE"})
    assert (status, body["error"]["code"]) == (503, "unavailable")
    assert call("POST", "/v1/contentrewards/fit/captions", {})[0] == 503


def test_fix_it_for_me_uses_campaign_caption(call: Call, cr: Any) -> None:
    seed_campaign(cr.store, USER, NOW)
    snapshot_rules = {**base_rules(), "requiredHashtags": ["#FaZeJob"]}  # the job's own copy of the rules wins
    job = seed_job(
        cr.store,
        status="ready",
        campaignId=UUID,
        campaign={"campaignId": UUID, "name": "FaZe Clips", "rules": snapshot_rules},
    )
    clip = seed_clip(cr.store, job_id=job["jobId"], campaignId=UUID)
    card = {"instagram": "the clutch", "x": "the clutch #FaZeJob @FaZeClan"}
    status, body = call(
        "POST", "/v1/contentrewards/fit/captions", {"clipId": clip["clipId"], "campaignId": UUID, "captions": card}
    )
    assert status == 200
    options = campaign_options(snapshot_rules)
    assert body["captions"]["instagram"] == campaign_caption("instagram", "the clutch", options)
    assert body["captions"]["instagram"].startswith("#Ad the clutch")
    assert "#FaZeJob" in body["captions"]["instagram"]
    assert body["captions"]["x"] == campaign_caption("x", card["x"], options)
    assert body["captions"]["youtubeTitle"] == clip["captions"]["youtubeTitle"]  # the title keeps no tags
    assert body["captions"]["youtubeDescription"] == campaign_caption(
        "youtube", clip["captions"]["youtubeDescription"], options
    )
    stored = cr.store.get(db.user_pk(USER), db.clip_sk(clip["clipId"]))
    assert stored["captions"] == clip["captions"]  # nothing saved: the card keeps them until Upload
    # refusals
    normal = seed_clip(cr.store, job_id=seed_job(cr.store)["jobId"])
    body_of = {"clipId": normal["clipId"], "campaignId": UUID, "captions": card}
    assert call("POST", "/v1/contentrewards/fit/captions", body_of)[0] == 400
    cr.store.update(clip["pk"], clip["sk"], {"status": "posted"})
    assert call("POST", "/v1/contentrewards/fit/captions", {**body_of, "clipId": clip["clipId"]})[0] == 400
    assert (
        call("POST", "/v1/contentrewards/fit/captions", {**body_of, "clipId": "01J0000000000000000000NOPE"})[0] == 404
    )
    assert call("POST", "/v1/contentrewards/fit/captions", {**body_of, "captions": {"nope": "x"}})[0] == 400


def test_campaigns_carry_the_next_step_kind_and_rule_lines(call: Call, cr: Any) -> None:
    allowed = {
        **rules.empty()["allowedSources"],
        "youtube": True,
        "twitch": True,
        "channels": [{"name": "FaZe", "url": None}],
    }
    seed_campaign(
        cr.store, USER, NOW, rules={**base_rules(), "allowedSources": allowed, "language": "English"}, publicAt=iso(NOW)
    )
    seed_campaign(cr.store, USER, NOW, UUID2, membership="not_joined", name="Valorant Clips")
    status, body = call("GET", "/v1/contentrewards/campaigns")
    assert status == 200
    kinds = {c["campaignId"]: c["nextStepKind"] for c in body["campaigns"]}
    assert kinds == {UUID: "make_clips", UUID2: "join"}
    found = call("GET", f"/v1/contentrewards/campaigns/{UUID}")[1]["campaign"]
    assert found["sourceRuleText"] == "FaZe Clips pays only for clips of FaZe's YouTube and Twitch."
    assert found["languageRuleText"] == "FaZe Clips wants clips in English."


def test_the_live_items_follow_the_card() -> None:
    """A spot check of the port target: a missing tag, a place turned off, Branded content, by hand."""
    server = copy.deepcopy(expect("tiktok branded content on"))
    off = fit.live(server, captions=GOOD, chosen=["youtube", "tiktok"], tiktok=TIKTOK_OFF)
    assert (off["verdict"], off["canUpload"]) == ("fixable", False)
    on = fit.live(server, captions=GOOD, chosen=["youtube", "tiktok"], tiktok=TIKTOK_ON)
    assert (on["verdict"], on["canUpload"]) == ("fits", True)
    one_place = fit.live(server, captions=GOOD, chosen=["youtube"], tiktok=None)
    texts = [i["text"] for i in items_of(one_place, "places")]
    assert texts == ["TikTok pays too. Turn it on to earn there as well.", "Goes to YouTube. FaZe Clips pays for it."]


def test_the_copy_is_refused_with_the_item_a_copy_cant_change() -> None:
    """A copy re-does banned content, so a found gambling scene never names the refusal while a moment owned by
    another campaign does."""
    c = case(
        "banned and another campaign",
        campaign=base_campaign(rules=base_rules(bannedContent=["gambling"])),
        clip=normal_clip(),
        job=normal_job(),
        others=[{"campaignId": OTHER, "name": "Valorant Clips"}],
    )
    found = run(c)
    assert found["canRemake"] is False
    assert (
        fit.remake_refusal(found, kept=True)
        == "This clip is for Valorant Clips. One clip can earn on one campaign only."
    )
    assert fit.remake_refusal(expect("a normal clip that could earn"), kept=True) is None
    first = expect("a normal clip, the logo missing on the campaign page first")
    assert fit.remake_refusal(first, kept=True) == "Add the FaZe logo on the campaign page first."
