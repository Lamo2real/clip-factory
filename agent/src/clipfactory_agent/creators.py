"""Who a clip is from: the creator key (docs/CONTRACTS.md §16.12).

"Creator" means the streamer whose stream was clipped. This file is the ONE place that says how a creator is
recognised. The agent has a byte-for-byte copy (``agent/src/clipfactory_agent/creators.py``) that its tests compare
with this file, so the two can never drift apart. It imports nothing from either package.

* A link with a channel id (yt-dlp ``channel_id`` / ``uploader_id``, stored as ``source.channelId``):
  ``"<platform>:id:<channel id>"`` (ids are kept as they are; YouTube ids are case-sensitive).
* A link with only a channel name (every job made before ``channelId`` was stored): ``"<platform>:name:<name>"``
  with the name normalised (case folded, spaces squeezed, a leading "@" dropped).
* An upload, or a link with no channel: no key. Those clips are learned from only owner-wide ("all creators").

A source that has both an id and a name also answers to its name key (``creator_keys``), so clips made before
``channelId`` existed join the same creator once one newer job of that channel is seen.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

ALL_CREATORS = "*"  # the key of lessons learned from every creator's clips together ("all creators")
LINK_PLATFORMS = ("youtube", "twitch", "kick")


def _platform(source: Mapping[str, Any]) -> str:
    return " ".join(str(source.get("platform") or "").split()).casefold()


def _name(value: Any) -> str:
    text = " ".join(str(value or "").split()).casefold()
    return text[1:].strip() if text.startswith("@") else text


def _channel_id(source: Mapping[str, Any]) -> str:
    return "".join(str(source.get("channelId") or "").split())


def creator_keys(source: Mapping[str, Any] | None) -> list[str]:
    """Every key this source answers to, the main one (``creator_key``) first; ``[]`` when it has none."""
    if not isinstance(source, Mapping):
        return []
    platform = _platform(source)
    if platform not in LINK_PLATFORMS:
        return []
    keys: list[str] = []
    channel_id = _channel_id(source)
    if channel_id:
        keys.append(f"{platform}:id:{channel_id}")
    name = _name(source.get("channel"))
    if name:
        keys.append(f"{platform}:name:{name}")
    return keys


def creator_key(source: Mapping[str, Any] | None) -> str | None:
    """The creator of a job's source: its channel id key when it has one, else its channel name key, else None."""
    keys = creator_keys(source)
    return keys[0] if keys else None


def creator_name(source: Mapping[str, Any] | None) -> str:
    """The name to show for a creator (the channel as the site spells it); "" when unknown."""
    if not isinstance(source, Mapping):
        return ""
    return " ".join(str(source.get("channel") or "").split())[:200]
