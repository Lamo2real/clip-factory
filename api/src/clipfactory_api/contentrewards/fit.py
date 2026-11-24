"""Does this clip fit the campaign? The fit check (docs/CONTRACTS.md §39.3, ADR-63).

``fit`` is pure: it reads stored items only (the clip, its job, the campaign, A's stops and places, ``CRCONN``, the
clip's posts and their ``CRSUB#`` items), never Content Rewards, the public JSON or the network, and is worked out
every time it is asked. The Review card and the clip page show it (``GET /v1/contentrewards/fit``), Confirm and Try
again refuse with it, and the copy route is guarded by it. ``for_clip`` loads one clip's items and asks it.

Each rule gives items (``rule``, ``state``, ``text``, ``fix``, ``platform``). Items show problems first, in the order
``no``, ``todo``, ``remake``, ``fix``, ``check``, ``note``, then the ``ok`` ones; inside a state in the order of
``RULES``, then by platform (STATS_ORDER, an item without a platform first), and otherwise as made (a stable sort).
A ``todo`` with no fix is a **wait** item: it passes by itself. The verdict, in this order: any ``no`` →
``doesnt_fit``; any wait item → ``wait``; any ``remake``, ``todo`` or ``paid_switch`` ``fix`` → ``fixable``; any
``check`` → ``cant_tell``; else ``fits``. ``tags`` and ``ad`` fixes, notes and oks never change it (the publisher puts
the tags and #Ad back, §38.14).

The web re-checks only the four items that change while the owner types or taps (``tags``, ``ad``, ``paid_switch``,
``places``) with ``web/src/lib/crFit.ts``: a port of ``live`` (``api/tests/fixtures/cr_fit_live_cases.json``).
"""

from __future__ import annotations

import math
import re
import urllib.parse
from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime, timedelta
from typing import Any

from ..clock import iso, parse
from ..platforms import campaign_caption as cc
from ..stats import STATS_ORDER
from . import config, connection, gates, links
from .campaigns import LANGUAGES, SITES, allowed_sites, language_words, languages_in, mac_on, possessive
from .util import obj

Item = dict[str, Any]

RULES = (
    "campaign",
    "soft",
    "deadline",
    "length",
    "places",
    "place_link",
    "tags",
    "ad",
    "paid_switch",
    "logo",
    "on_screen",
    "source",
    "language",
    "banned",
    "spoken",
    "uncertain",
    "brief_only",
    "posted",
    "one_campaign",
    "send",
)
STATES = ("no", "todo", "remake", "fix", "check", "note", "ok")  # the order items show in
LIVE = frozenset({"tags", "ad", "paid_switch", "places"})
# The items a copy can't change (``canRemake``); ``logo`` joins them while the campaign has no ready logo.
COPY_KEEPS = frozenset({"campaign", "deadline", "length", "places", "source", "language", "one_campaign"})
# Where a failing item's "Make new clips for this campaign" keeps the clip's own link (the same video is fine).
SAME_VIDEO = frozenset({"length", "banned", "posted", "one_campaign"})
# The caption each place sends (the YouTube title keeps no tags: the description carries them, §38.13).
CAPTION_OF = {
    "youtube": "youtubeDescription",
    "tiktok": "tiktok",
    "instagram": "instagram",
    "facebook": "facebook",
    "x": "x",
}
LABELS = gates.LABELS
# A's stops (§38.4) by how the ``campaign`` row shows them.
OWN_ROWS = frozenset({"deadline", "logo_missing", "no_place", "tiktok_only"})
ELSEWHERE = frozenset(
    {"ended", "budget_gone", "drafts_first", "sound_needed", "overlay_needed", "cap_reached", "not_accepted"}
)
WAITS = frozenset({"waiting", "held", "paused", "rules_reading"})
SOFT_NOTES = frozenset({"budget_half", "low_rate", "not_connected"})
# ``spoken_needed`` is said once, by the ``spoken`` row (§38.13's sentence), not twice.
SOFT_CHECKS = frozenset({"face_needed", "audience"})
UNCERTAIN_MAX = 5
GOING_UP = frozenset({"posted", "queued", "pending_integration"})  # a campaign post that is, or will be, up
SOURCE_KEPT = timedelta(days=13)  # the 14-day rule of §7, with a day to spare
NORMAL_MAX = 10
MIN_CHANNEL_KEY = 3
READING = "Reading the rules… Look again in a minute."
GONE = "This video is gone from Clip Factory. Make new clips for this campaign."
CAMPAIGN_GONE = "Add the campaign again on the Campaigns page."
SPOKEN = "The brand wants “paid partnership” said out loud. Clip Factory can't. This clip may be turned down."
AUTO_SEND = "After it posts, Clip Factory sends it to Content Rewards by itself."
HAND_SEND = "After it posts, send its link to Content Rewards within 30 minutes. I'll remind you."
# The agent's ``campaign_rules`` row when Claude's review never came back (``checklist.RULES_UNCHECKED``, §38.13): it
# reads ``pass: false`` but nothing was judged, so it is a ``check``, never a ``no``.
UNJUDGED = "Claude couldn't check the campaign's rules. Check it yourself."
# The agent's ``logo`` row that passes only because the job's rules didn't ask for a logo.
LOGO_NOT_ASKED = "This campaign does not ask for a logo."
# A campaign clip's TikTok before TikTok approves the app with Your Mac posts TikTok off: only the owner's Mac posts it
# then (gates.TIKTOK_MAC_OFF, tiktok_mac.CAMPAIGN_MAC_OFF), so the note links to the Mac's switch.
TIKTOK_MAC_OFF = gates.TIKTOK_MAC_OFF
MAC_SETTINGS = "/settings/posting/tiktok-mac"
MAC_SWITCH = "Turn on your Mac"
_NOT_WORD = re.compile(r"[\W_]+")
_CHANNEL_PATHS = ("c", "user", "channel")
COUNTS = {3: "all three", 4: "all four", 5: "all five"}


# --- small helpers -------------------------------------------------------------------------------------------------


def _item(rule: str, state: str, text: str, fix: Item | None = None, platform: str | None = None) -> Item:
    out: Item = {"rule": rule, "state": state, "text": text, "fix": fix}
    if platform:
        out["platform"] = platform
    return out


def _open(label: str, href: str, *, external: bool = False) -> Item:
    out: Item = {"kind": "open", "label": label, "href": href}
    if external:
        out["external"] = True
    return out


def _join(items: list[str], word: str = "and") -> str:
    if not items:
        return ""
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + f" {word} " + items[-1]


def _label(platform: str) -> str:
    return LABELS.get(platform) or dict(SITES).get(platform) or platform


def _line(text: Any, limit: int = 160) -> str:
    """Brand text as one plain line, without its last full stop (it goes inside one of our sentences)."""
    out = " ".join(str(text or "").split())
    if len(out) > limit:
        out = out[: limit - 1].rstrip() + "…"
    return out.rstrip(".!? ") if not out.endswith("…") else out


def _day(value: date) -> str:
    return f"{value.day} {value.strftime('%b')}"


def _seconds(n: int) -> str:
    return f"{n} second" if n == 1 else f"{n} seconds"


def _checklist(clip: Mapping[str, Any], key: str) -> Item | None:
    found = obj(clip.get("checklist")).get("items")
    for row in found if isinstance(found, list) else []:
        if isinstance(row, Mapping) and row.get("key") == key:
            return dict(row)
    return None


def _plain(text: Any) -> str:
    return " ".join(str(text or "").split())


def _judged(row: Mapping[str, Any] | None) -> bool:
    """A checklist row the agent really judged: it has a ``pass``, and it isn't the "couldn't check" row."""
    if row is None or not isinstance(row.get("pass"), bool):
        return False
    return not (row.get("pass") is False and _plain(row.get("note")) == UNJUDGED)


def _not_in(current: Iterable[Any], judged: Iterable[Any]) -> list[str]:
    """The lines of ``current`` the job's own rules didn't have (added after the agent judged the clip)."""
    seen = {_plain(j).casefold() for j in judged}
    return [str(c) for c in current if _plain(c) and _plain(c).casefold() not in seen]


def _campaign_href(campaign_id: str, part: str = "") -> str:
    return f"/campaigns/{campaign_id}{part}"


def read_rules(campaign_id: str) -> Item:
    """Every ``check`` item's fix unless its row names another (§39.3)."""
    return _open("Read the rules", _campaign_href(campaign_id, "#rules"))


def _find_another() -> Item:
    return _open(gates.FIND_ANOTHER, config.DISCOVER_URL, external=True)


def _settings() -> Item:
    return _open("Open Content Rewards settings", config.SETTINGS_URL, external=True)


# --- the source's facts (stored by the agent, I: ``sourceLanguage`` and ``source.channelKeys``) -----------------


def channel_key(text: str) -> str:
    """A name or handle reduced to its letters and digits, case-folded ("@FaZe_Clan" and "FaZe Clan" → "fazeclan"),
    the agent's own rule (``sources._channel_key``)."""
    return _NOT_WORD.sub("", text.casefold())


def _handle(url: str) -> str | None:
    try:
        parts = [p for p in urllib.parse.urlparse(url).path.split("/") if p]
    except ValueError:
        return None
    if not parts:
        return None
    if parts[0] in _CHANNEL_PATHS and len(parts) > 1:
        return parts[1]
    return parts[0].lstrip("@")


def channel_matches(
    channels: Iterable[Mapping[str, Any]],
    keys: Iterable[str] | None = None,
    channel: str | None = None,
    channel_id: str | None = None,
) -> bool | None:
    """The agent's ``sources.from_allowed_channel`` (§38.13) over stored facts: a name or handle of one of the
    campaign's channels contains the video's, or the other way round, case-folded. ``keys`` are the job's
    ``source.channelKeys`` (every name and handle yt-dlp gave), else the stored ``channel`` and ``channelId``.
    None when nothing can be said (the campaign names no channel, or nothing is known of the video's)."""
    allowed: list[str] = []
    for c in channels:
        allowed.append(channel_key(str(c.get("name") or "")))
        url = c.get("url")
        if isinstance(url, str):
            allowed.append(channel_key(_handle(url) or ""))
    allowed = [a for a in allowed if len(a) >= MIN_CHANNEL_KEY]
    texts = [str(k) for k in keys] if keys else [t for t in (channel, channel_id) if isinstance(t, str) and t]
    video = [k for k in dict.fromkeys(channel_key(t) for t in texts) if len(k) >= MIN_CHANNEL_KEY]
    if not allowed or not video:
        return None
    return any(a in v or v in a for a in allowed for v in video)


def _source_language(job: Mapping[str, Any]) -> tuple[str, str] | None:
    raw = job.get("sourceLanguage")
    if not isinstance(raw, str) or not raw:
        return None
    primary = raw.split("-", 1)[0].lower()
    return next(((code, name) for code, name in LANGUAGES if code == primary), None)


def _link_of(source: Mapping[str, Any]) -> str | None:
    """The video's link: a link job's, or the one a Mac-fetched job keeps (§35.3)."""
    url = source.get("url")
    if isinstance(url, str) and url and (source.get("type") == "link" or source.get("fetchedBy") == "mac"):
        return url
    return None


def _site_of(source: Mapping[str, Any]) -> str | None:
    if source.get("type") == "link":
        return str(source.get("platform") or "") or None
    if source.get("fetchedBy") == "mac":
        return str(source.get("linkPlatform") or "youtube")
    return None


def source_kept(job: Mapping[str, Any], now: datetime) -> bool:
    """A copy can get the video (without a HEAD): a link job, or a video file or Mac-fetched job made less than 13
    days ago."""
    source = obj(job.get("source"))
    if source.get("type") == "link":
        return True
    created = parse(job.get("createdAt"))
    return created is not None and now - created < SOURCE_KEPT


# --- the rows ------------------------------------------------------------------------------------------------------


class _Ctx:
    """What every row needs about the campaign and the clip."""

    def __init__(
        self,
        clip: Mapping[str, Any],
        job: Mapping[str, Any],
        campaign: Mapping[str, Any],
        posts: Iterable[Mapping[str, Any]] = (),
    ) -> None:
        self.cid = str(campaign.get("campaignId") or "")
        self.name = str(campaign.get("name") or "This campaign")
        self.brand = str(campaign.get("brand") or "") or self.name
        self.rules = obj(campaign.get("rules"))
        # a campaign clip of this campaign (its campaign may be known from its posts only, as clip_fit finds it)
        self.mine = campaign_id_of(clip, job, posts) == self.cid
        snapshot = obj(job.get("campaign"))
        # The rules the agent made and judged the clip by (the job's own copy; {} for a normal clip).
        self.snapshot = snapshot if self.mine else {}
        self.judged_rules = obj(snapshot.get("rules")) if self.mine else {}
        # The words the publisher sends come from the job's own rules (B's campaign_clip): the tags and #Ad are
        # checked against those; a normal clip (whose copy takes today's rules) against the campaign's.
        self.caption_rules = self.judged_rules or self.rules
        self.source = obj(job.get("source"))
        self.copy = f"Make a {self.name} copy"

    def new_clips(self, rule: str) -> Item:
        href = f"/?campaign={self.cid}"
        link = _link_of(self.source)
        if rule in SAME_VIDEO and link:
            href += "&link=" + urllib.parse.quote(link, safe="")
        return {"kind": "new_clips", "label": "Make new clips for this campaign", "href": href}

    def remake(self) -> Item:
        return {"kind": "remake", "label": self.copy}


def campaign_id_of(
    clip: Mapping[str, Any], job: Mapping[str, Any] | None, posts: Iterable[Mapping[str, Any]] = ()
) -> str:
    """The campaign a clip is made for (B's ``campaign_clip``): its job's rules copy, the job's or the clip's
    ``campaignId``, else a post's. "" for a normal clip."""
    snapshot = obj((job or {}).get("campaign"))
    for found in (snapshot.get("campaignId"), (job or {}).get("campaignId"), clip.get("campaignId")):
        if isinstance(found, str) and found:
            return found
    return next((str(p["campaignId"]) for p in posts if p.get("campaignId")), "")


def _campaign_rows(ctx: _Ctx, stops: Sequence[Mapping[str, Any]], conn: Mapping[str, Any], url: str) -> list[Item]:
    out: list[Item] = []
    for stop in stops:
        code = str(stop.get("code"))
        if not stop.get("hard") or code in OWN_ROWS:
            continue
        text = str(stop.get("text") or "")
        if code in ELSEWHERE:
            out.append(_item("campaign", "no", text, _find_another()))
        elif code == "rules_reading":
            out.append(_item("campaign", "todo", READING))
        elif code in WAITS:
            out.append(_item("campaign", "todo", text))
        elif code == "not_checked":
            if gates.looking(conn):
                out.append(_item("campaign", "todo", text))  # connected, CR didn't answer: the next check looks again
            elif connection.refused(conn):
                out.append(_item("campaign", "todo", text, _open(gates.OPEN_CAMPAIGN, _campaign_href(ctx.cid))))
            else:
                out.append(_item("campaign", "todo", text, _open("Connect Content Rewards", config.SETUP_HREF)))
        elif code in ("not_joined", "left"):
            out.append(_item("campaign", "todo", text, _open(gates.OPEN_CAMPAIGN, url, external=True)))
        elif code == "apply_first":
            out.append(_item("campaign", "todo", text, _open("Yes, I applied", _campaign_href(ctx.cid))))
        elif code == "rules_failed":
            out.append(_item("campaign", "todo", text, _open(gates.OPEN_CAMPAIGN, _campaign_href(ctx.cid, "#rules"))))
        else:  # a hard stop this list doesn't know yet: it still stops the upload
            out.append(_item("campaign", "no", text, _find_another()))
    return out


def _soft_rows(ctx: _Ctx, stops: Sequence[Mapping[str, Any]]) -> list[Item]:
    out: list[Item] = []
    for stop in stops:
        code = str(stop.get("code"))
        if stop.get("hard"):
            continue
        text = str(stop.get("text") or "")
        if code == "not_connected":
            out.append(_item("soft", "note", text, _open("Connect Content Rewards", config.SETUP_HREF)))
        elif code in SOFT_NOTES:
            out.append(_item("soft", "note", text))
        elif code in SOFT_CHECKS:
            out.append(_item("soft", "check", text, read_rules(ctx.cid)))
    return out


def soft_codes(stops: Iterable[Mapping[str, Any]]) -> list[str]:
    """The soft stops he hasn't accepted (``anyway``): the copy sends them as ``campaignAnyway``."""
    return [
        str(s["code"]) for s in stops if not s.get("hard") and s.get("code") != "not_connected" and not s.get("anyway")
    ]


def _deadline_rows(ctx: _Ctx, now: datetime) -> list[Item]:
    raw = ctx.rules.get("clipUntil")
    try:
        last = date.fromisoformat(raw) if isinstance(raw, str) else None
    except ValueError:
        last = None
    if last is None:
        return []
    today = now.date()
    if last > today:
        return [_item("deadline", "ok", f"Takes clips until {_day(last)}.")]
    if last == today:
        return [_item("deadline", "note", f"Today is the last day {ctx.name} takes clips.")]
    return [_item("deadline", "no", f"{ctx.name} stopped taking clips on {_day(last)}.", _find_another())]


def _length_words(lo: int | None, hi: int | None) -> tuple[str, str]:
    """What the campaign takes, for an ``ok`` line and for a ``no`` or ``check`` line ("15 to 60" and "15 to 60
    seconds"; one side or an exact length always says "seconds")."""
    if lo is not None and hi is not None:
        if lo == hi:
            return _seconds(lo), _seconds(lo)
        return f"{lo} to {hi}", f"{lo} to {hi} seconds"
    if lo is not None:
        return f"{lo} seconds or more", f"{lo} seconds or more"
    return f"up to {hi} seconds", f"up to {hi} seconds"


def _length_rows(ctx: _Ctx, clip: Mapping[str, Any]) -> list[Item]:
    lo, hi = ctx.rules.get("lengthMinSec"), ctx.rules.get("lengthMaxSec")
    lo = lo if isinstance(lo, int) and not isinstance(lo, bool) else None
    hi = hi if isinstance(hi, int) and not isinstance(hi, bool) else None
    if lo is None and hi is None:
        return []
    takes_ok, takes = _length_words(lo, hi)
    raw = clip.get("durationSec")
    if not isinstance(raw, int | float) or isinstance(raw, bool):
        return [_item("length", "check", f"I couldn't check this clip's length. {ctx.name} takes {takes}.")]
    seconds = float(raw)
    # The agent's own bounds (``Campaign.length``): an exact length ("30 seconds", less than 2 s wide) gets a second
    # each way, so a cut clip can meet it, and its strict length check passed on those.
    low, high = lo, hi
    if lo is not None and hi is not None and hi - lo < 2:
        low, high = max(1, lo - 1), min(600, hi + 1)
    shown = math.floor(seconds + 0.5)  # whole seconds, never a number that reads as the other answer
    if low is not None and seconds < low:
        shown = min(shown, low - 1)
    elif high is not None and seconds > high:
        shown = max(shown, high + 1)
    else:
        shown = max(shown, lo) if lo is not None else shown
        shown = min(shown, hi) if hi is not None else shown
        return [_item("length", "ok", f"{_seconds(shown)}. {ctx.name} takes {takes_ok}.")]
    return [
        _item("length", "no", f"This clip is {_seconds(shown)}. {ctx.name} takes {takes}.", ctx.new_clips("length"))
    ]


def places_live(name: str, upload_places: list[str], chosen: list[str] | None) -> list[Item]:
    """The ``places`` items that change with the card's Upload to chips (a live item)."""
    going = [p for p in upload_places if chosen is None or p in chosen]
    out: list[Item] = []
    if going:
        both = {1: "it", 2: "both"}.get(len(going)) or COUNTS.get(len(going), "all of them")
        out.append(_item("places", "ok", f"Goes to {_join([_label(p) for p in going])}. {name} pays for {both}."))
    for p in upload_places:
        if p not in going:
            out.append(_item("places", "note", f"{_label(p)} pays too. Turn it on to earn there as well.", platform=p))
    return out


def _places_rows(
    ctx: _Ctx,
    campaign: Mapping[str, Any],
    stops: Sequence[Mapping[str, Any]],
    places: list[str],
    conn: Mapping[str, Any],
    *,
    tiktok_waits: bool,
) -> tuple[list[Item], set[str]]:
    """The ``places`` items that don't change on the card, and the places a ``todo`` already named."""
    paid = [p for p in STATS_ORDER if p in {str(x) for x in campaign.get("platformsPaid") or []}]
    linked = connection.crlinked(conn)
    if not paid:
        if campaign.get("membership") in gates.CAN_MAKE:
            text = f"I can't tell where {ctx.name} pays yet. Tap Check now."
            return [_item("places", "todo", text, _open(gates.OPEN_CAMPAIGN, _campaign_href(ctx.cid)))], set()
        return [], set()
    tiktok_only = next((s for s in stops if s.get("code") == "tiktok_only"), None)
    if set(paid) == {"tiktok"} and tiktok_only is not None:
        text = str(tiktok_only.get("text") or "")
        return [_item("places", "no", text or f"{ctx.name} only pays for TikTok.", _find_another())], set()
    if not places:
        first = next((p for p in paid if p != "tiktok"), paid[0])
        if linked.get(first) is False:
            text = f"Add {_label(first)} in Content Rewards first. Then tap I added it."
            return [_item("places", "todo", text, _settings(), first)], {first}
        text = f"Set up {_label(first)} first. {ctx.name} pays for {_join([_label(p) for p in paid])}."
        return [
            _item("places", "todo", text, _open(f"Set up {_label(first)}", f"/settings/posting/setup/{first}"))
        ], set()
    out: list[Item] = []
    for p in paid:
        if p in places or linked.get(p) is False:
            continue  # going, or the place_link row says it
        if p == "tiktok" and tiktok_waits:
            out.append(_item("places", "note", TIKTOK_MAC_OFF, _open(MAC_SWITCH, MAC_SETTINGS), p))
        else:
            out.append(
                _item(
                    "places",
                    "note",
                    f"{_label(p)} pays too. Set it up to earn there as well.",
                    _open(f"Set up {_label(p)}", f"/settings/posting/setup/{p}"),
                    p,
                )
            )
    return out, set()


def _place_link_rows(
    campaign: Mapping[str, Any], places: list[str], conn: Mapping[str, Any], named: set[str]
) -> list[Item]:
    linked = connection.crlinked(conn)
    added = "ready-socials" in {str(s) for s in conn.get("stepsDone") or []}
    out: list[Item] = []
    for p in places:
        if p not in linked and not added:
            text = (
                f"I couldn't check that Content Rewards knows your {_label(p)} account. Look under **Accounts** there."
            )
            out.append(_item("place_link", "check", text, _settings(), p))
    paid = {str(x) for x in campaign.get("platformsPaid") or []}
    for p in STATS_ORDER:
        if p in paid and p not in places and p not in named and linked.get(p) is False:
            text = f"Content Rewards doesn't know your {_label(p)} account. Add it there, then tap I added it."
            out.append(_item("place_link", "note", text, _settings(), p))
    return out


def required_of(rules: Mapping[str, Any]) -> Item:
    """``CampaignFit.required``: the disclosure, the required tokens and the one phrase, as the publisher adds them
    (B's ``campaign_options``)."""
    options = cc.campaign_options(rules)
    disclosure = str(options["disclosure"])
    items = [str(r) for r in options["required"] if str(r).casefold() != disclosure.casefold()]
    tokens = [r for r in items if cc.is_token(r)]
    phrase = next((r for r in items if not cc.is_token(r)), None)
    return {"disclosure": disclosure, "tokens": tokens, "phrase": phrase}


def more_phrases(rules: Mapping[str, Any], required: Mapping[str, Any]) -> list[str]:
    """The required phrases after the first (``required.phrase`` carries one): B's ``required_items`` can hold a
    second when a required tag isn't a whole token ("@faze."). The server checks them too; the card's live check
    knows only ``required``."""
    disclosure = str(required.get("disclosure") or "").casefold()
    phrase = required.get("phrase")
    return [
        str(r)
        for r in cc.required_items(rules)
        if not cc.is_token(str(r)) and str(r).casefold() != disclosure and str(r) != phrase
    ]


def _shown(item: str, phrases: Sequence[str]) -> str:
    return f"“{item}”" if item in phrases else item


def tags_live(
    required: Mapping[str, Any], going: list[str], captions: Mapping[str, Any], extra: Sequence[str] = ()
) -> list[Item]:
    phrase = required.get("phrase")
    phrases = [*([str(phrase)] if phrase else []), *extra]
    wanted = [*[str(t) for t in required.get("tokens") or []], *phrases]
    if not wanted or not going:
        return []
    out: list[Item] = []
    for p in going:
        text = str(captions.get(CAPTION_OF[p]) or "")
        missing = [_shown(w, phrases) for w in wanted if not cc.has_item(text, w)]
        if missing:
            them = "it" if len(missing) == 1 else "them"
            words = f"The {_label(p)} words are missing {_join(missing)}. I'll put {them} back when it uploads."
            out.append(_item("tags", "fix", words, {"kind": "captions", "label": "Fix it for me"}, p))
    if not out:
        out.append(_item("tags", "ok", f"Every caption has {_join([_shown(w, phrases) for w in wanted])}."))
    return out


def ad_live(required: Mapping[str, Any], going: list[str], captions: Mapping[str, Any]) -> list[Item]:
    disclosure = str(required.get("disclosure") or cc.DEFAULT_DISCLOSURE)
    if not going:
        return []
    out = [
        _item(
            "ad",
            "fix",
            f"{disclosure} isn't at the start of the {_label(p)} words. I'll put it there when it uploads.",
            {"kind": "captions", "label": "Fix it for me"},
            p,
        )
        for p in going
        if not cc.ad_first(str(captions.get(CAPTION_OF[p]) or ""), disclosure)
    ]
    return out or [_item("ad", "ok", f"{disclosure} is at the start of every caption.")]


def paid_live(
    going: list[str], tiktok: Mapping[str, Any] | None, disclosure: str = cc.DEFAULT_DISCLOSURE
) -> list[Item]:
    """YouTube and X: the publisher turns paid promotion on (§38.14). TikTok: Branded content is the owner's own tap
    (§17.8), so it is checked only once the card's TikTok choices are known. Instagram and Facebook: no switch."""
    out: list[Item] = []
    auto = [p for p in going if p in ("youtube", "x")]
    if auto:
        out.append(_item("paid_switch", "ok", f"Paid promotion goes on for {_join([_label(p) for p in auto])}."))
    if "tiktok" in going and tiktok is not None:
        if tiktok.get("brandContent") is True:
            out.append(_item("paid_switch", "ok", "Branded content is on for TikTok.", platform="tiktok"))
        else:
            turn_on = {"kind": "tiktok_branded", "label": "Turn on Branded content"}
            out.append(_item("paid_switch", "fix", "Branded content is off on TikTok.", turn_on, "tiktok"))
    meta = [_label(p) for p in going if p in ("instagram", "facebook")]
    if meta:
        verb = "doesn't" if len(meta) == 1 else "don't"
        text = f"{_join(meta)} {verb} let apps turn on Paid partnership. {disclosure} and the words on the video tell viewers."
        out.append(_item("paid_switch", "note", text))
    return out


def _logo_rows(ctx: _Ctx, clip: Mapping[str, Any], campaign: Mapping[str, Any]) -> list[Item]:
    if not gates.logo_needed(campaign):
        return []
    row = _checklist(clip, "logo") if ctx.mine else None
    # The agent's row also passes when the job's rules didn't ask for a logo: only a job made to carry one counts.
    asked = obj(ctx.judged_rules.get("logo")).get("required") is True or bool(ctx.snapshot.get("logoKey"))
    if row is not None and row.get("pass") is True and asked and _plain(row.get("note")) != LOGO_NOT_ASKED:
        return [_item("logo", "ok", f"The {ctx.brand} logo is on the whole clip.")]
    if obj(campaign.get("logo")).get("state") == "ready":
        return [_item("logo", "remake", f"The {ctx.brand} logo isn't on this clip.", ctx.remake())]
    text = f"Add the {ctx.brand} logo on the campaign page first."
    return [_item("logo", "todo", text, _open(gates.OPEN_CAMPAIGN, _campaign_href(ctx.cid)))]


def _on_screen_rows(ctx: _Ctx, clip: Mapping[str, Any]) -> list[Item]:
    words = str(obj(ctx.rules.get("disclosure")).get("onScreen") or "Paid partnership")
    row = _checklist(clip, "disclosure") if ctx.mine else None
    if row is not None and row.get("pass") is True:
        return [_item("on_screen", "ok", f"“{words}” shows for the first 3 seconds.")]
    return [_item("on_screen", "remake", f"“{words}” isn't on the video.", ctx.remake())]


def _source_rows(ctx: _Ctx) -> list[Item]:
    allowed = obj(ctx.rules.get("allowedSources"))
    videos = [str(v.get("url")) for v in ctx.rules.get("sourceVideos") or [] if isinstance(v, Mapping) and v.get("url")]
    link = _link_of(ctx.source)
    site = _site_of(ctx.source)
    owner = possessive(ctx.brand)
    look = "Look yourself."
    if link and any(links.normalize_post_url(link) == links.normalize_post_url(v) for v in videos):
        return [_item("source", "ok", f"From a {ctx.name} video.")]
    if allowed.get("campaignProvidedOnly"):
        if link:
            return [
                _item("source", "no", f"{ctx.name} only pays for clips of its own videos.", ctx.new_clips("source"))
            ]
        text = f"I couldn't check where this video is from. {ctx.name} only pays for clips of its own videos. {look}"
        return [_item("source", "check", text, read_rules(ctx.cid))]
    sites = allowed_sites(ctx.rules)
    if sites and site in dict(SITES) and site not in sites:
        text = f"{ctx.name} doesn't pay for clips of {_label(site)} videos."
        return [_item("source", "no", text, ctx.new_clips("source"))]
    channels = [c for c in allowed.get("channels") or [] if isinstance(c, Mapping) and c.get("name")]
    if channels:
        keys = ctx.source.get("channelKeys")
        matched = channel_matches(
            channels,
            [str(k) for k in keys] if isinstance(keys, list) and keys else None,
            ctx.source.get("channel") if isinstance(ctx.source.get("channel"), str) else None,
            ctx.source.get("channelId") if isinstance(ctx.source.get("channelId"), str) else None,
        )
        if matched is True:
            return [_item("source", "ok", f"From {owner} {_label(site or '') or 'channel'}.")]
        if matched is False:
            text = f"This video may not be from {owner} channels. {ctx.name} only pays for those. {look}"
            return [_item("source", "check", text, read_rules(ctx.cid))]
        text = f"I couldn't check where this video is from. {ctx.name} wants clips from {owner} channels. {look}"
        return [_item("source", "check", text, read_rules(ctx.cid))]
    if allowed.get("notes"):
        text = f"I couldn't check where this video is from. {ctx.name} says: “{_line(allowed['notes'], 120)}”. {look}"
        return [_item("source", "check", text, read_rules(ctx.cid))]
    if sites and len(sites) < len(SITES):
        if site in sites:
            return [_item("source", "ok", f"From a {_label(site or '')} video.")]
        names = _join([_label(s) for s in sites], "or")
        text = f"I couldn't check where this video is from. {ctx.name} wants clips of {names} videos. {look}"
        return [_item("source", "check", text, read_rules(ctx.cid))]
    return [_item("source", "ok", f"Any video is fine for {ctx.name}.")]


def _language_rows(ctx: _Ctx, job: Mapping[str, Any]) -> list[Item]:
    raw = ctx.rules.get("language")
    if not isinstance(raw, str) or not raw.strip():
        return []
    wanted = languages_in(raw)
    words = language_words(raw)
    spoken = _source_language(job)
    if not wanted or spoken is None:
        return [
            _item("language", "check", f"I couldn't check the language. {ctx.name} wants {words}.", read_rules(ctx.cid))
        ]
    if spoken in wanted:
        return [_item("language", "ok", f"In {spoken[1]}.")]
    text = f"This clip is in {spoken[1]}. {ctx.name} wants {words}."
    return [_item("language", "no", text, ctx.new_clips("language"))]


def _banned_words(rules: Mapping[str, Any]) -> str:
    found = []
    for raw in rules.get("bannedContent") or []:
        text = _line(raw, 60)
        if text.lower().startswith("no "):
            text = text[3:]
        if text:
            found.append(text[:1].lower() + text[1:])
    return _join(found, "or")


def _rules_row(ctx: _Ctx, clip: Mapping[str, Any]) -> Item | None:
    """A campaign clip's ``campaign_rules`` row when the agent really judged it (None: never judged, or Claude's
    review didn't come back)."""
    row = _checklist(clip, "campaign_rules") if ctx.mine else None
    return row if _judged(row) else None


def _banned_rows(ctx: _Ctx, clip: Mapping[str, Any]) -> list[Item]:
    what = _banned_words(ctx.rules)
    row = _rules_row(ctx, clip)
    if row is not None and row.get("pass") is False:
        note = _line(row.get("note"), 200)
        text = f"{note}." if note else f"This clip doesn't follow {possessive(ctx.name)} rules."
        return [_item("banned", "no", text, ctx.new_clips("banned"))]
    if not what:
        return []
    if row is not None:
        # judged against the job's own list: a banned item added since was never looked at
        later = _not_in(ctx.rules.get("bannedContent") or [], ctx.judged_rules.get("bannedContent") or [])
        if not later:
            return [_item("banned", "ok", f"No {what}. Checked.")]
        what = _banned_words({"bannedContent": later})
    return [_item("banned", "check", f"I couldn't check: no {what}. Look yourself.", read_rules(ctx.cid))]


def _spoken_rows(ctx: _Ctx) -> list[Item]:
    if obj(ctx.rules.get("disclosure")).get("spoken") is True:
        return [_item("spoken", "check", SPOKEN, read_rules(ctx.cid))]
    return []


def _uncertain_rows(ctx: _Ctx, clip: Mapping[str, Any], campaign: Mapping[str, Any]) -> list[Item]:
    lines = [str(u) for u in ctx.rules.get("uncertain") or campaign.get("uncertain") or [] if str(u).strip()]
    other = [str(r) for r in ctx.rules.get("otherRules") or [] if str(r).strip()]
    if _rules_row(ctx, clip) is None:  # a normal clip, or the review never came back: nothing judged them
        lines += other
    else:  # a campaign clip's other rules were judged in its campaign_rules item (§38.13), all but newer ones
        lines += _not_in(other, ctx.judged_rules.get("otherRules") or [])
    out = [
        _item("uncertain", "check", f"I couldn't check: {_line(line)}. Look yourself.", read_rules(ctx.cid))
        for line in lines[:UNCERTAIN_MAX]
    ]
    if len(lines) > UNCERTAIN_MAX:
        more = len(lines) - UNCERTAIN_MAX
        out.append(_item("uncertain", "note", f"And {more} more on the campaign page.", read_rules(ctx.cid)))
    return out


def _brief_only_rows(ctx: _Ctx) -> list[Item]:
    out = []
    if ctx.rules.get("coverImageRequired") is True:
        out.append(_item("brief_only", "check", "I couldn't check: the brand's cover picture.", read_rules(ctx.cid)))
    notes = ctx.rules.get("layoutNotes")
    if isinstance(notes, str) and notes.strip():
        out.append(_item("brief_only", "check", f"I couldn't check: {_line(notes)}.", read_rules(ctx.cid)))
    return out


def _posted_rows(ctx: _Ctx, posts: Sequence[Mapping[str, Any]]) -> list[Item]:
    normal = [p for p in posts if not p.get("campaignId") and p.get("status") in ("posted", "queued")]
    if not normal:
        return []
    first = min(normal, key=lambda p: (p.get("status") != "posted", STATS_ORDER.index(str(p.get("platform")))))
    where = _label(str(first.get("platform")))
    up = "already up on" if first.get("status") == "posted" else "already going up on"
    text = f"This clip is {up} {where}. Content Rewards only takes a post sent in its first 30 minutes."
    return [_item("posted", "remake", text, ctx.remake())]


def _one_campaign_rows(  # noqa: PLR0917 (one call site)
    ctx: _Ctx,
    clip: Mapping[str, Any],
    job: Mapping[str, Any],
    posts: Sequence[Mapping[str, Any]],
    crsubs: Sequence[Mapping[str, Any]],
    others: Sequence[Mapping[str, Any]],
) -> list[Item]:
    names = {str(o.get("campaignId")): str(o.get("name") or "") for o in others}
    snapshot = obj(job.get("campaign"))
    if snapshot.get("campaignId"):
        names.setdefault(str(snapshot["campaignId"]), str(snapshot.get("name") or ""))
    owners = [
        clip.get("campaignId"),
        job.get("campaignId"),
        snapshot.get("campaignId"),
        *(p.get("campaignId") for p in posts),
        *(s.get("campaignId") for s in crsubs),
        *(o.get("campaignId") for o in others),
    ]
    other = next((str(c) for c in owners if isinstance(c, str) and c and c != ctx.cid), None)
    if other is None:
        return []
    name = names.get(other) or "another campaign"
    text = f"This clip is for {name}. One clip can earn on one campaign only."
    return [_item("one_campaign", "no", text, ctx.new_clips("one_campaign"))]


def _send_rows(campaign: Mapping[str, Any], conn: Mapping[str, Any], now: datetime) -> list[Item]:
    auto = (
        connection.can_submit(conn, now)
        and campaign.get("membership") == "in"
        and campaign.get("idMatch") != "ambiguous"
    )
    return [_item("send", "note", AUTO_SEND if auto else HAND_SEND)]


# --- the verdict -------------------------------------------------------------------------------------------------


def is_wait(item: Mapping[str, Any]) -> bool:
    return item.get("state") == "todo" and not item.get("fix")


def _order(item: Mapping[str, Any]) -> tuple[int, int, int]:
    platform = item.get("platform")
    where = STATS_ORDER.index(str(platform)) if platform in STATS_ORDER else -1
    return STATES.index(str(item["state"])), RULES.index(str(item["rule"])), where


def sort_items(items: Iterable[Item]) -> list[Item]:
    return sorted(items, key=_order)


def verdict(items: Sequence[Mapping[str, Any]]) -> str:
    states = {str(i.get("state")) for i in items}
    if "no" in states:
        return "doesnt_fit"
    if any(is_wait(i) for i in items):
        return "wait"
    if states & {"remake", "todo"} or any(i["rule"] == "paid_switch" and i["state"] == "fix" for i in items):
        return "fixable"
    return "cant_tell" if "check" in states else "fits"


def headline(found: str, name: str, items: Sequence[Mapping[str, Any]]) -> str:
    if found == "fits":
        return f"Can earn on {name}"
    if found == "wait":
        return f"Wait a little for {name}"
    if found == "doesnt_fit":
        return f"This clip can't earn on {name}"
    if found == "cant_tell":
        n = sum(1 for i in items if i.get("state") == "check")
        return "Check 1 thing, then upload" if n == 1 else f"Check {n} things, then upload"
    if any(i.get("state") == "todo" for i in items):
        return f"One thing first for {name}"
    if any(i.get("state") == "remake" for i in items):
        return f"{name} needs a copy of this clip"
    return f"Almost ready for {name}"


def can_upload(items: Sequence[Mapping[str, Any]]) -> bool:
    """The campaign way may go up now: no ``no``, ``remake`` or ``todo``, and TikTok's Branded content is on."""
    return not any(
        i.get("state") in ("no", "remake", "todo") or (i.get("rule") == "paid_switch" and i.get("state") == "fix")
        for i in items
    )


def _can_remake(items: Sequence[Mapping[str, Any]], campaign: Mapping[str, Any], *, ready: bool) -> bool:
    if not ready or any(is_wait(i) for i in items):
        return False
    keeps = set(COPY_KEEPS)
    if obj(campaign.get("logo")).get("state") != "ready":
        keeps.add("logo")
    return not any(i.get("rule") in keeps and i.get("state") in ("no", "todo") for i in items)


def _finish(cf: Item) -> Item:
    items = sort_items(cf["items"])
    found = verdict(items)
    cf["items"] = items
    cf["verdict"] = found
    cf["headline"] = headline(found, str(cf["campaignName"]), items)
    cf["canUpload"] = can_upload(items)
    return cf


# --- the fit -------------------------------------------------------------------------------------------------------


def fit(
    clip: Mapping[str, Any],
    job: Mapping[str, Any] | None,
    campaign: Mapping[str, Any],
    *,
    stops: Sequence[Mapping[str, Any]],
    places: list[str],
    conn: Mapping[str, Any],
    posts: Sequence[Mapping[str, Any]],
    crsubs: Sequence[Mapping[str, Any]],
    others: Sequence[Mapping[str, Any]],
    source_kept: bool,
    remake_on: bool,
    now: datetime,
    captions: Mapping[str, Any] | None = None,
    chosen: list[str] | None = None,
    tiktok: Mapping[str, Any] | None = None,
    tiktok_waits: bool = False,
) -> Item:
    """``CampaignFit``: this clip against this campaign. ``stops`` and ``places`` are A's ``gates.stops`` and
    ``gates.upload_places``; ``others`` the campaigns (``{campaignId, name}``) that already own this moment through
    the clip's live copies, its original and the original's other live copies; ``captions`` the card's (or Confirm's
    merged) captions, else the clip's; ``chosen`` the places he picked (None: every place); ``tiktok`` the card's
    TikTok choices (None: not known yet, so TikTok's Branded content is left to the card's live check)."""
    job = job or {}
    ctx = _Ctx(clip, job, campaign, posts)
    words = captions if captions is not None else obj(clip.get("captions"))
    required = required_of(ctx.caption_rules)
    if any(s.get("code") == "tiktok_only" for s in stops):
        places = []  # A's tiktok_only stop: no place can earn (the places row says why)
    going = [p for p in places if chosen is None or p in chosen]
    places_fixed, named = _places_rows(ctx, campaign, stops, places, conn, tiktok_waits=tiktok_waits)
    # A normal clip never goes up the campaign way itself: its copy gets the tags, #Ad and the paid switches.
    upload = going if ctx.mine else []
    items: list[Item] = [
        *_campaign_rows(ctx, stops, conn, links.campaign_url(ctx.cid)),
        *_soft_rows(ctx, stops),
        *_deadline_rows(ctx, now),
        *_length_rows(ctx, clip),
        *places_fixed,
        *places_live(ctx.name, places, chosen),
        *_place_link_rows(campaign, places, conn, named),
        *tags_live(required, upload, words, more_phrases(ctx.caption_rules, required)),
        *ad_live(required, upload, words),
        *paid_live(upload, tiktok, str(required["disclosure"])),
        *_logo_rows(ctx, clip, campaign),
        *_on_screen_rows(ctx, clip),
        *_source_rows(ctx),
        *_language_rows(ctx, job),
        *_banned_rows(ctx, clip),
        *_spoken_rows(ctx),
        *_uncertain_rows(ctx, clip, campaign),
        *_brief_only_rows(ctx),
        *_posted_rows(ctx, posts),
        *_one_campaign_rows(ctx, clip, job, posts, crsubs, others),
        *_send_rows(campaign, conn, now),
    ]
    if not remake_on or not source_kept:
        reason = (
            f"Clip Factory can't make a {ctx.name} copy yet. Make new clips for this campaign."
            if not remake_on
            else GONE
        )
        first = True
        for item in items:
            if item["state"] == "remake":
                item["state"] = "no"
                item["fix"] = ctx.new_clips(str(item["rule"]))
                if first:
                    item["text"] = f"{item['text']} {reason}"
                    first = False
    cf: Item = {
        "campaignId": ctx.cid,
        "campaignName": ctx.name,
        "items": items,
        "canRemake": _can_remake(items, campaign, ready=remake_on and source_kept),
        "softCodes": soft_codes(stops),
        "required": required,
        "uploadPlaces": list(places),
        "checkedAt": iso(now),
    }
    return _order_keys(_finish(cf))


def _order_keys(cf: Item) -> Item:
    """``CampaignFit`` with its keys in the contract's order (a stable JSON for the golden cases)."""
    keys = ("campaignId", "campaignName", "verdict", "headline", "canUpload", "canRemake", "items", "softCodes")
    return {k: cf[k] for k in (*keys, "required", "uploadPlaces", "checkedAt")}


def gone(clip: Mapping[str, Any], job: Mapping[str, Any] | None, campaign_id: str, now: datetime) -> Item:
    """The fit of a campaign clip whose ``CAMPAIGN#`` was removed: it can't go up the campaign way."""
    name = str(obj((job or {}).get("campaign")).get("name") or "this campaign")
    cf: Item = {
        "campaignId": campaign_id,
        "campaignName": name,
        "items": [_item("campaign", "no", CAMPAIGN_GONE, _open("Open Campaigns", "/campaigns"))],
        "canRemake": False,
        "softCodes": [],
        "required": required_of(obj(obj((job or {}).get("campaign")).get("rules"))),
        "uploadPlaces": [],
        "checkedAt": iso(now),
    }
    return _order_keys(_finish(cf))


def live(
    cf: Mapping[str, Any],
    *,
    captions: Mapping[str, Any],
    chosen: list[str] | None,
    tiktok: Mapping[str, Any] | None,
) -> Item:
    """A campaign clip's four live items again for the card's captions, Upload to chips and TikTok choices, then
    the verdict, headline and ``canUpload`` (``canRemake`` stays: no live item changes what a copy can do). The web's
    ``lib/crFit.ts`` is a port of this function."""
    upload_places = [str(p) for p in cf.get("uploadPlaces") or []]
    going = [p for p in upload_places if chosen is None or p in chosen]
    kept = [
        dict(i)
        for i in cf.get("items") or []
        if i.get("rule") not in ("tags", "ad", "paid_switch")
        and not (i.get("rule") == "places" and (i.get("state") == "ok" or i.get("platform") in upload_places))
    ]
    required = obj(cf.get("required"))
    items = [
        *kept,
        *places_live(str(cf.get("campaignName")), upload_places, chosen),
        *tags_live(required, going, captions),
        *ad_live(required, going, captions),
        *paid_live(going, tiktok, str(required.get("disclosure") or cc.DEFAULT_DISCLOSURE)),
    ]
    out = {**dict(cf), "items": items}
    return _order_keys(_finish(out))


def upload_refusal(cf: Mapping[str, Any]) -> str | None:
    """Confirm's and Try again's 409 words (§39.3), or None when the campaign way may go up: the first ``no``,
    ``remake`` or ``todo`` item."""
    items = [i for i in cf.get("items") or [] if i.get("state") in ("no", "remake", "todo")]
    if not items:
        return None
    first = items[0]
    name = cf.get("campaignName")
    if is_wait(first):
        return f"Not yet for {name}: {first['text']}"
    return f"This clip can't earn on {name}: {first['text']}"


def remake_refusal(cf: Mapping[str, Any], *, kept: bool) -> str | None:
    """Why the copy route refuses (409, §39.3), or None when ``canRemake``."""
    if cf.get("canRemake"):
        return None
    if not kept:
        return GONE
    items = list(cf.get("items") or [])
    wait = next((i for i in items if is_wait(i)), None)
    if wait is not None:
        return f"Not yet for {cf.get('campaignName')}: {wait['text']}"
    # the items a copy can't change (a logo todo: the campaign has no ready logo yet)
    blocking = next(
        (
            i
            for i in items
            if i.get("state") in ("no", "todo") and (i.get("rule") in COPY_KEEPS or i.get("rule") == "logo")
        ),
        None,
    )
    return str(blocking["text"]) if blocking else f"Clip Factory can't make a {cf.get('campaignName')} copy yet."


def nothing_to_copy(cf: Mapping[str, Any], posts: Iterable[Mapping[str, Any]]) -> str | None:
    """The copy route's 409 when a copy would only be a second post of one moment for one campaign (a reused edit):
    the clip already went up, or is going up, the campaign way, or nothing on it needs a copy (no ``remake`` item and
    no ``banned`` ``no``: tags and #Ad go back in at upload). None when a copy is needed."""
    name = cf.get("campaignName")
    going = [p for p in posts if p.get("campaignId") == cf.get("campaignId") and p.get("status") in GOING_UP]
    if going:
        up = "already up" if any(p.get("status") == "posted" for p in going) else "already going up"
        return f"This clip is {up} for {name}."
    needed = any(
        i.get("state") == "remake" or (i.get("rule") == "banned" and i.get("state") == "no")
        for i in cf.get("items") or []
    )
    return None if needed else f"This clip can already earn on {name}."


# --- loading one owner's items -----------------------------------------------------------------------------------


class Loader:
    """One request's reads (the clips of a GET with ``clipIds`` share the connection, setups and campaigns)."""

    def __init__(self, deps: Any, user_id: str, now: datetime) -> None:
        from .. import db
        from ..oauth import setup as oauth_setup

        self.deps = deps
        self.store = deps.store
        self.user_id = user_id
        self.now = now
        self.pk = db.user_pk(user_id)
        self.conn = connection.load(deps.store, user_id)
        self.setups = oauth_setup.all_setups(deps.store, user_id, now)
        self.mac_on = mac_on(deps.store, user_id)
        self._campaigns: dict[str, Item | None] = {}
        self._jobs: dict[str, Item | None] = {}
        self._alive: dict[str, bool] = {}
        self._posts: dict[str, list[Item]] = {}
        self._subs: dict[str, list[Item]] = {}

    def clip(self, clip_id: str) -> Item | None:
        from .. import db
        from ..ids import is_ulid

        return self.store.get(self.pk, db.clip_sk(clip_id)) if is_ulid(clip_id) else None

    def job(self, job_id: Any) -> Item | None:
        from .. import db

        key = str(job_id or "")
        if key and key not in self._jobs:
            self._jobs[key] = self.store.get(self.pk, db.job_sk(key))
        return self._jobs.get(key)

    def campaign(self, campaign_id: str) -> Item | None:
        from . import campaigns

        if campaign_id not in self._campaigns:
            self._campaigns[campaign_id] = campaigns.get(self.store, self.user_id, campaign_id)
        return self._campaigns[campaign_id]

    def joined(self) -> list[Item]:
        """The campaigns he is in (``in`` or ``manual``), newest ``inSince`` first, at most 10."""
        from . import campaigns

        found = [c for c in campaigns.all_for(self.store, self.user_id) if c.get("membership") in gates.CAN_MAKE]
        for c in found:
            self._campaigns[str(c["campaignId"])] = c
        found.sort(key=lambda c: str(c.get("inSince") or ""), reverse=True)
        return found[:NORMAL_MAX]

    def posts(self, clip_id: str) -> list[Item]:
        from .. import posts

        if clip_id not in self._posts:
            self._posts[clip_id] = posts.posts_for_clip(self.store, self.user_id, clip_id)
        return self._posts[clip_id]

    def crsubs(self, rows: list[Item]) -> list[Item]:
        from . import submissions

        if not rows:
            return []
        key = ",".join(sorted(str(p["postId"]) for p in rows))
        if key not in self._subs:
            found = submissions.for_clip(self.store, self.user_id, [str(p["postId"]) for p in rows])
            self._subs[key] = list(found.values())
        return self._subs[key]

    def alive(self, entry: Mapping[str, Any]) -> bool:
        """A copy's job still counts (it isn't failed, canceled or deleted, and its clip wasn't thrown away)."""
        from . import remake

        job_id = str(entry.get("jobId") or "")
        if job_id not in self._alive:
            self._alive[job_id] = remake.alive(self.store, self.user_id, entry, self.now)
        return self._alive[job_id]

    def places(self, item: Mapping[str, Any]) -> list[str]:
        paid = [str(p) for p in item.get("platformsPaid") or []]
        return gates.upload_places(paid, self.setups, connection.crlinked(self.conn), mac_on=self.mac_on)

    def waits(self, item: Mapping[str, Any]) -> bool:
        paid = [str(p) for p in item.get("platformsPaid") or []]
        return gates.tiktok_waits(paid, self.setups, mac_on=self.mac_on)

    def stops(self, item: Mapping[str, Any]) -> list[Item]:
        return gates.stops(item, self.conn, self.places(item), self.now, tiktok_waits=self.waits(item))

    def name(self, campaign_id: str) -> str:
        found = self.campaign(campaign_id)
        return str((found or {}).get("name") or "another campaign")

    def others(self, clip: Mapping[str, Any], campaign_id: str) -> list[Item]:
        """The campaigns that own this clip's moment elsewhere: its live copies, its original (its campaign, posts and
        their submissions) and the original's other live copies."""
        found: list[str] = []
        for cid, entry in obj(clip.get("remakes")).items():
            if isinstance(entry, Mapping) and self.alive(entry):
                found.append(str(cid))
        ref = obj(clip.get("remakeOf"))
        original = self.clip(str(ref.get("clipId") or "")) if ref.get("clipId") else None
        if original is not None:
            rows = self.posts(str(original["clipId"]))
            found.append(campaign_id_of(original, self.job(original.get("jobId")), rows))
            found += [str(p.get("campaignId") or "") for p in rows]
            found += [str(s.get("campaignId") or "") for s in self.crsubs(rows)]
            for cid, entry in obj(original.get("remakes")).items():
                if not isinstance(entry, Mapping) or entry.get("jobId") == clip.get("jobId"):
                    continue
                if self.alive(entry):
                    found.append(str(cid))
        return [{"campaignId": c, "name": self.name(c)} for c in dict.fromkeys(found) if c and c != campaign_id]

    def fit_one(
        self,
        clip: Mapping[str, Any],
        campaign_id: str,
        *,
        captions: Mapping[str, Any] | None = None,
        chosen: list[str] | None = None,
        tiktok: Mapping[str, Any] | None = None,
    ) -> Item:
        from . import remake

        job = self.job(clip.get("jobId"))
        item = self.campaign(campaign_id)
        if item is None:
            return gone(clip, job, campaign_id, self.now)
        places = self.places(item)
        rows = self.posts(str(clip["clipId"]))
        return fit(
            clip,
            job,
            item,
            stops=self.stops(item),
            places=places,
            conn=self.conn,
            posts=rows,
            crsubs=self.crsubs(rows),
            others=self.others(clip, campaign_id),
            source_kept=source_kept(job or {}, self.now),
            remake_on=remake.enabled(),
            now=self.now,
            captions=captions,
            chosen=chosen,
            tiktok=tiktok,
            tiktok_waits=self.waits(item),
        )

    def clip_fit(
        self,
        clip: Mapping[str, Any],
        *,
        captions: Mapping[str, Any] | None = None,
        chosen: list[str] | None = None,
        tiktok: Mapping[str, Any] | None = None,
    ) -> Item:
        """``ClipFit``: a campaign clip against its own campaign; a normal clip against every campaign he is in."""
        job = self.job(clip.get("jobId"))
        own = campaign_id_of(clip, job, self.posts(str(clip["clipId"])))
        kw: dict[str, Any] = {"captions": captions, "chosen": chosen, "tiktok": tiktok}
        if own:
            fits = [self.fit_one(clip, own, **kw)]
        else:
            fits = [self.fit_one(clip, str(c["campaignId"]), **kw) for c in self.joined()]
        suggestion = None
        if not own:
            found = next(
                (
                    f
                    for f in fits
                    if f["canRemake"] and any(i["rule"] == "source" and i["state"] == "ok" for i in f["items"])
                ),
                None,
            )
            if found is not None:
                suggestion = {"campaignId": found["campaignId"], "name": found["campaignName"]}
        remakes = {
            str(k): {"jobId": str(v.get("jobId")), "at": str(v.get("at") or "")}
            for k, v in obj(clip.get("remakes")).items()
            if isinstance(v, Mapping)
        }
        return {
            "clipId": str(clip["clipId"]),
            "mode": "campaign" if own else "normal",
            "fits": fits,
            "suggestion": suggestion,
            "remakes": remakes,
        }


def for_clip(
    deps: Any,
    user_id: str,
    clip_id: str,
    now: datetime,
    *,
    captions: Mapping[str, Any] | None = None,
    chosen: list[str] | None = None,
    tiktok: Mapping[str, Any] | None = None,
) -> Item:
    """``ClipFit`` of one clip (404 when it isn't his)."""
    from ..errors import not_found

    loader = Loader(deps, user_id, now)
    clip = loader.clip(clip_id)
    if clip is None:
        raise not_found("We could not find that clip.")
    return loader.clip_fit(clip, captions=captions, chosen=chosen, tiktok=tiktok)
