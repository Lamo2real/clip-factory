"""Lamo Stories' own sentences for posting problems (docs/CONTRACTS.md §45.14 "Sentences").

The platform publishers and the token helpers were written for Lamo Clips: their sentences send the owner to Lamo
Clips' Settings. The story flow never stores one of those. Every ``Problem.kind`` (and the few kinds only the story
flow has) maps to a sentence here that names Lamo Stories' own Social accounts page and the account it is about.

Pure: no I/O.
"""

from __future__ import annotations

from typing import Final

from ..platforms.stub import LABELS

# Problem.kind (platforms.errors) plus the story flow's own kinds.
KINDS: Final = (
    "reconnect",
    "credits",
    "rate",
    "daily",
    "file",
    "banned",
    "private",
    "down",
    "duplicate",
    "other",
    "not_connected",
    "token_dead",
    # the story flow's own
    "keys_changed",
    "same_as_clips",
    "clips_unknown",
    "changed",
    "story",
    "workspace",
    "x_cap",
    "unsure",
    "too_long",
    "privacy",
    "too_slow",
    "not_started",
    "ai_label",
)
# The kinds the owner has to fix in Lamo Stories › Social accounts (or on the platform) before Try again can work: the
# job is ``needs_attention``; every other kind is ``failed``.
NEEDS_YOU: Final = frozenset(
    {
        "reconnect",
        "token_dead",
        "not_connected",
        "keys_changed",
        "same_as_clips",
        "clips_unknown",
        "changed",
        "story",
        "workspace",
        "credits",
        "private",
        "x_cap",
        "banned",
        "ai_label",
    }
)
CONNECTIONS: Final = "Lamo Stories › Social accounts"  # the page's name (§45.34: never "Connections")


def label(platform: str) -> str:
    return LABELS.get(platform, platform)


def _who(platform: str, account_name: str | None) -> str:
    name = (account_name or "").strip()
    return f"Lamo Stories' {label(platform)} ({name})" if name else f"Lamo Stories' {label(platform)}"


def story_sentence(platform: str, kind: str, account_name: str | None = None, *, shared: bool = True) -> str:
    """One plain sentence for a posting problem of a Lamo Stories publishing job. Never names Lamo Clips' Settings.
    ``shared``: the platform uses Clip Factory's developer app, so its limits are shared with Lamo Clips (§45.30);
    with Lamo Stories' own app they are its own."""
    name = label(platform)
    who = _who(platform, account_name)
    if kind in {"reconnect", "token_dead"}:
        return f"{who} needs connecting again. Open {CONNECTIONS}, then tap Try again."
    if kind == "not_connected":
        return f"{who} is not connected. Open {CONNECTIONS}, connect it, then tap Try again."
    if kind == "keys_changed":
        return f"The {name} app keys changed. Connect {name} again in {CONNECTIONS}, then tap Try again."
    if kind == "same_as_clips":
        return (
            f"{who} is the same place Lamo Clips posts to. Pick another in {CONNECTIONS}, or tap Use it for both there."
        )
    if kind == "clips_unknown":
        return f"Lamo Stories cannot tell if {who} is Lamo Clips' {name}. Tap Try again to check the account first."
    if kind == "changed":
        return f"{who} is a different account now. Tap Try again to check where it goes."
    if kind == "story":
        return "This story is not ready to post. Approve it first, then tap Try again."
    if kind == "workspace":
        return "We could not find this Lamo Stories workspace."
    if kind == "x_cap":
        if not shared:
            return "Lamo Stories stopped X: this month's Lamo Stories X limit is used up. Try again next month."
        return "Lamo Stories stopped X: this month's X limit is used up (it is shared with Lamo Clips)."
    if kind == "credits":
        return "X has no credits left. Buy more in console.x.com › Billing › Credits, then tap Try again."
    if kind == "private":
        if platform == "tiktok":
            return "Make the Lamo Stories TikTok account private until TikTok approves the app, then tap Try again."
        return f"{who} is private. Make it public, then tap Try again."
    if kind == "rate":
        return f"{name} says slow down. Tap Try again in a few minutes."
    if kind == "daily":
        if platform == "youtube" and shared:
            return "YouTube's daily upload limit is used up (it is shared with Lamo Clips). Tap Try again tomorrow."
        return f"{name}'s daily limit is reached. Tap Try again tomorrow."
    if kind == "file":
        return f"{name} did not accept this video file. Make the video again, then tap Try again."
    if kind == "too_long":
        return f"This video is longer than {name} allows for this account. Make a shorter one, then tap Try again."
    if kind == "privacy":
        return f"Pick who can see it on {name} again, then tap Try again."
    if kind == "banned":
        return f"{name} is not letting {who} post right now. Try again tomorrow."
    if kind == "down":
        return f"{name} did not answer. Tap Try again in a few minutes."
    if kind == "duplicate":
        return f"{name} already has this post."
    if kind == "unsure":
        return f"We are not sure it posted. Look on {name} before you tap Try again."
    if kind == "too_slow":
        return f"{name} could not finish this video. Tap Try again."
    if kind == "not_started":
        return "Posting did not start. Tap Try again."
    if kind == "ai_label":
        return (
            f"This video has realistic AI shots, and Lamo Stories cannot mark them as AI on {name}. "
            "Post it to YouTube or TikTok instead."
        )
    return f"Posting to {name} did not work. Tap Try again."


def needs_you(kind: str) -> bool:
    return kind in NEEDS_YOU


def kind_of_message(message: str) -> str:
    """The kind of a plain ``PublishError`` (one without a ``Problem``), from its words. Its text is never stored."""
    text = message.lower()
    if "longer than" in text:
        return "too_long"
    if "pick who can see it" in text:
        return "privacy"
    if "daily limit" in text or ("slow down" in text and "tomorrow" in text):
        return "daily"
    if "duplicate" in text or "already has this post" in text:
        return "duplicate"
    if "video file" in text or "did not accept this video" in text or "3 to 90 seconds" in text:
        return "file"
    if "credits" in text:
        return "credits"
    if "$10 limit" in text:
        return "x_cap"
    if "slow down" in text:
        return "rate"
    if "did not answer" in text:
        return "down"
    if "not sure it posted" in text:
        return "unsure"
    if "may have posted" in text or "look on" in text:
        return "unsure"
    return "other"
