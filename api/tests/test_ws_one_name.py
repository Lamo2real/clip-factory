"""One name on screen (round 5 E13): every sentence of Lamo Stories' API calls the other app "Clip Factory", as its
switcher does, never "Lamo Clips"; and a sentence about an account with a name says "this {Platform} account
({name})", so an account that is itself named "Lamo Stories" never reads oddly ("Lamo Stories' TikTok (Lamo
Stories)", "Tap Post to Lamo Stories")."""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from clipfactory_api.workspaces import apps, dashboard, onboarding, sentences, social
from clipfactory_api.workspaces import types as ws

WORKSPACES = Path(__file__).resolve().parents[1] / "src" / "clipfactory_api" / "workspaces"
PLATFORMS = ("youtube", "tiktok", "instagram", "facebook", "x")
LABEL = {"youtube": "YouTube", "tiktok": "TikTok", "instagram": "Instagram", "facebook": "Facebook", "x": "X"}
# Not sentences: the built-in workspace's stored name (a contract value of GET /v1/workspaces, §45.5) and two
# programming guards in ``types.py`` that no request can reach.
NOT_SENTENCES = {
    "Lamo Clips",
    "Lamo Clips has no workspace partition: its data is USER#{userId} as it always was",
    "Lamo Clips files are not under ws/",
}


def _docstrings(tree: ast.AST) -> set[int]:
    found: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
                found.add(id(first.value))
    return found


def _strings(path: Path) -> list[str]:
    """Every string the module can show (plain and f-string parts), docstrings left out."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    skip = _docstrings(tree)
    out: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            out.append("".join(v.value if isinstance(v, ast.Constant) else "{…}" for v in node.values))
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skip:
            out.append(node.value)
    return out


def test_no_lamo_stories_api_string_names_lamo_clips() -> None:
    files = sorted(WORKSPACES.rglob("*.py"))
    assert len(files) > 30
    found = [
        (str(path.relative_to(WORKSPACES)), text)
        for path in files
        for text in _strings(path)
        if "Lamo Clips" in text and text not in NOT_SENTENCES
    ]
    assert found == []


# "Stories" alone, not as part of "Funded Clips" (nor of an old name a test or a stored value may still hold).
JUST_STORIES = re.compile(r"(?<![A-Za-z])(?<!Clip )(?<!Lamo )(?<!Factory )Stories(?![A-Za-z])")


def test_no_api_string_calls_the_app_just_stories() -> None:
    found = [
        (str(path.relative_to(WORKSPACES)), text)
        for path in sorted(WORKSPACES.rglob("*.py"))
        for text in _strings(path)
        if JUST_STORIES.search(text)
    ]
    assert found == []
    assert JUST_STORIES.search("Clip Factory's posts always go first. Stories uses what's left.")
    assert not JUST_STORIES.search("Clip Factory's posts always go first. Funded Clips uses what's left.")
    for old in ("Clip Stories", "Lamo Stories", "Clip Factory Stories"):  # an old name is not "Stories" alone
        assert not JUST_STORIES.search(f"Clip Factory's posts always go first. {old} uses what's left.")


@pytest.mark.parametrize("name", [None, "Lamo Stories", "Funded Clips", "Ice Tips"])
@pytest.mark.parametrize("shared", [True, False])
def test_every_posting_sentence_says_clip_factory(name: str | None, shared: bool) -> None:
    for platform in PLATFORMS:
        for kind in sentences.KINDS:
            text = sentences.story_sentence(platform, kind, name, shared=shared)
            assert "Lamo Clips" not in text, (platform, kind)
            assert text[:1].isupper(), (platform, kind, text)
            if name:
                # the account's name only ever follows "{Platform} account"
                assert f"({name})" not in text or f"{LABEL[platform]} account ({name})" in text, (platform, kind)
                assert f"Funded Clips' {LABEL[platform]} ({name})" not in text


def test_the_other_screens_lines_say_clip_factory() -> None:
    lines = [social.TIKTOK_UNSURE, social.TIKTOK_NOT_CONNECTED]
    for platform in PLATFORMS:
        lines.append(onboarding.same_as_clips_line(platform))
        lines.append(social.keys_changed_sentence(platform))
        for choice in (apps.CLIPS, apps.OWN, None):
            lines.extend(social.limits(platform, choice))
        for reason in ("no_choice", "own_missing", "clips_missing"):
            lines.append(apps.not_ready_sentence(platform, reason))
    assert [line for line in lines if "Lamo Clips" in line] == []
    assert onboarding.same_as_clips_line("youtube") == (
        "This is Clip Factory's own account. Funded Clips needs its own separate account: sign in with a different one."
    )
    assert apps.not_ready_sentence("tiktok", "clips_missing") == (
        "Clip Factory has no TikTok app keys yet. Set up TikTok in Clip Factory first (Settings › Posting › Set up "
        "posting, up to the keys step)."
    )
    assert social.TIKTOK_UNSURE.startswith("Funded Clips cannot tell if this is Clip Factory's TikTok")
    assert "Clip Factory's posts always go first. Funded Clips uses what's left." in social.limits("x", apps.CLIPS)
    assert not any("quicker" in line or "Use it for both" in line for line in lines)  # §45.37 G6 d, G8


def test_an_account_named_lamo_stories_reads_plainly() -> None:
    def say(kind: str, platform: str = "tiktok") -> str:
        return sentences.story_sentence(platform, kind, "Lamo Stories")

    assert say("reconnect") == (
        "This TikTok account (Lamo Stories) needs connecting again. Open Funded Clips › Social accounts, then tap "
        "Try again."
    )
    assert say("not_connected", "youtube") == (
        "This YouTube account (Lamo Stories) is not connected. Open Funded Clips › Social accounts, connect it, then "
        "tap Try again."
    )
    assert say("same_as_clips", "instagram") == (
        "This Instagram account (Lamo Stories) is Clip Factory's own account. Funded Clips needs its own "
        "separate account: connect a different one in Funded Clips › Social accounts, then tap Try again."
    )
    assert say("clips_unknown") == (
        "Funded Clips cannot tell if this TikTok account (Lamo Stories) is Clip Factory's TikTok. Tap Try again to "
        "check the account first."
    )
    assert say("changed", "facebook") == (
        "Funded Clips' Facebook is a different account now: this Facebook account (Lamo Stories). Tap Try again to "
        "check where it goes."
    )
    assert (
        say("private", "instagram")
        == "This Instagram account (Lamo Stories) is private. Make it public, then tap Try again."
    )
    assert say("banned", "x") == "X is not letting this X account (Lamo Stories) post right now. Try again tomorrow."
    # with no name the sentence is about Lamo Stories' own account on that platform
    assert sentences.story_sentence("tiktok", "reconnect") == (
        "Funded Clips' TikTok needs connecting again. Open Funded Clips › Social accounts, then tap Try again."
    )
    assert sentences.story_sentence("youtube", "changed") == (
        "Funded Clips' YouTube is a different account now. Tap Try again to check where it goes."
    )
    # the dashboard's own account line
    line = dashboard._account_sentence(
        {"platform": "tiktok", "connectionStatus": "needs_reconnect", "accountName": "Lamo Stories"}
    )
    assert line == "This TikTok account (Lamo Stories) needs connecting again. Open Social accounts and tap Connect."


def test_the_posting_sentences_still_send_account_problems_to_social_accounts() -> None:
    """Fix it opens Social accounts when the sentence names that page (``dashboard._post_href``): the new words keep
    the page's name in every account problem."""
    for platform in PLATFORMS:
        for kind in ("reconnect", "token_dead", "not_connected", "keys_changed", "same_as_clips"):
            text = sentences.story_sentence(platform, kind, "Lamo Stories")
            assert sentences.CONNECTIONS in text, (platform, kind)
            job = {"error": text, "platform": platform}
            assert dashboard._post_href(job, "01J0000000000000000000ST1") == dashboard.SOCIAL_ACCOUNTS
    assert ws.PLATFORMS == PLATFORMS
