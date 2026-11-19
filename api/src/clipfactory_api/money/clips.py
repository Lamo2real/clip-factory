"""Money per clip for the dashboard (docs/CONTRACTS.md §27.5, ADR-50): ``GET /v1/money/clips``.

One Query of the owner's ``POST#`` items, grouped by clip, sorted here, and only the page asked for reads its
``CLIP#`` items (one BatchGetItem) and signs its covers. Money per clip is only what YouTube reported for that video:

* ``period=all``: the Post's lifetime ``revenue`` (``dimensions=video`` from the video's post day).
* ``period=7|30|90``: the Post's ``revenueWindows[period]``, read by the collector over the same days as its own
  ``views`` (§27.6). Only a window over the list's own days counts: one left from an older run (that period's read
  failed later) is "not reported yet", never ranked beside fresh ones.
* YouTube's money counts only while YouTube is connected with the money permission, the same as the summary: without
  it the rows say so ("needs_permission" / "not_connected") and the list is sorted by views.

``per1000Views`` is worked out here only when the money and the views come from the same stored YouTube report and
those views are at least 1,000. Every other app shows nothing for it: TikTok, Instagram and X have no money API,
and Facebook's money is per Page, not per video. Views are each post's lifetime views ("so far").
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from collections.abc import Mapping
from typing import Any

from .. import db, posts, s3
from ..errors import bad_request
from . import MONEY_ORDER, label, rules, sources
from .summary import MONEY_PLATFORMS, div_round, order
from .view import money_shown, tag

Item = dict[str, Any]

PERIODS = ("7", "30", "90", "all")
SORTS = ("money", "views")
PER_1000_MIN_VIEWS = 1000
PER_1000_TAG = "YouTube's numbers"
COVER_SECONDS = 3600
CHANGED = "This list changed. Load it again."


def _int(value: Any) -> int | None:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def _views(post: Mapping[str, Any]) -> int | None:
    metrics = post.get("metrics")
    return _int(metrics.get("views")) if isinstance(metrics, Mapping) else None


def _money(post: Mapping[str, Any], period: str) -> tuple[Item | None, Item | None]:
    """``(money, per1000Views)`` from one YouTube Post, or ``(None, None)`` when nothing was reported."""
    if period == "all":
        found = post.get("revenue")
        start = str(post.get("postedAt") or "")[:10] or None
        end_key = "through"
    else:
        windows = post.get("revenueWindows")
        found = windows.get(period) if isinstance(windows, Mapping) else None
        start = str(found.get("from") or "") or None if isinstance(found, Mapping) else None
        end_key = "to"
    if not isinstance(found, Mapping) or _int(found.get("amountMicros")) is None:
        return None, None
    amount = int(found["amountMicros"])
    currency = str(found.get("currency") or "USD")
    money = {
        "amountMicros": amount,
        "currency": currency,
        "from": start,
        "to": str(found.get(end_key) or ""),
        "tag": tag("youtube"),
        "source": str(found.get("source") or "youtube.estimatedRevenue"),
    }
    views = _int(found.get("views"))
    per = None
    if views is not None and views >= PER_1000_MIN_VIEWS:
        per = {
            "amountMicros": div_round(amount * 1000, views),
            "currency": currency,
            "views": views,
            "tag": PER_1000_TAG,
        }
    return money, per


def _state(platform: str, cfg: rules.Monetization) -> str:
    if platform not in MONEY_PLATFORMS:
        return "not_shared"
    if platform == "facebook":
        return "not_shared" if money_shown(cfg, platform) else "coming_soon"
    return "not_reported_yet"


def _names(platforms: list[str]) -> str:
    names = [label(p) for p in platforms]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def _cursor_hash(platforms: list[str], period: str, sort: str, to: str | None) -> str:
    raw = f"{','.join(platforms)}|{period}|{sort}|{to or ''}".encode()
    return hashlib.sha256(raw).hexdigest()[:16]


def encode(offset: int, digest: str) -> str:
    raw = json.dumps({"o": offset, "h": digest}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode(cursor: str, digest: str) -> int:
    try:
        found = json.loads(base64.urlsafe_b64decode((cursor + "=" * (-len(cursor) % 4)).encode()))
    except (ValueError, binascii.Error) as e:
        raise bad_request(CHANGED) from e
    if (
        not isinstance(found, dict)
        or found.get("h") != digest
        or not isinstance(found.get("o"), int)
        or isinstance(found.get("o"), bool)
        or found["o"] < 0
    ):
        raise bad_request(CHANGED)
    return int(found["o"])


def _row(
    clip_id: str,
    items: list[Item],
    chosen: list[str],
    period: str,
    cfg: rules.Monetization,
    *,
    youtube: str,
    window: tuple[str | None, str | None],
) -> Item | None:
    """One clip's line per selected app it was posted to, and its money per currency (only YouTube's numbers).
    ``youtube``: "ok", "needs_permission" or "not_connected". ``window``: the list's ``(from, to)`` for a period."""
    lines = []
    totals: dict[str, int] = {}
    views_total = 0
    any_views = False
    for platform in chosen:
        post = next((i for i in items if i.get("platform") == platform), None)
        if post is None:
            continue
        views = _views(post)
        if views is not None:
            views_total += views
            any_views = True
        money, per = (None, None)
        state = _state(platform, cfg)
        if platform == "youtube" and youtube != "ok":
            state = youtube
        elif platform == "youtube":
            money, per = _money(post, period)
            if money is not None and period != "all" and (money["from"], money["to"]) != window:
                money, per = None, None  # an older run's window: other days than the list's
            if money is not None:
                state = "reported"
                totals[money["currency"]] = totals.get(money["currency"], 0) + money["amountMicros"]
        line: Item = {
            "platform": platform,
            "postId": str(post.get("postId") or ""),
            "postedAt": str(post.get("postedAt") or ""),
            "views": views,
            "money": money,
            "per1000Views": per,
            "moneyState": state,
        }
        if isinstance(post.get("url"), str):
            line["url"] = post["url"]
        lines.append(line)
    if not lines:
        return None
    return {
        "clipId": clip_id,
        "firstPostedAt": min(line["postedAt"] for line in lines),
        "views": views_total if any_views else None,
        "totals": sorted(
            ({"currency": c, "amountMicros": a} for c, a in totals.items()),
            key=lambda t: (-t["amountMicros"], t["currency"]),
        ),
        "platforms": lines,
    }


def _sort(rows: list[Item], by: str) -> None:
    """Most money: total, then views, then newest. Most views: views, then newest. Stable sorts, newest first."""

    def views_key(r: Item) -> int:
        return int(r["views"]) if r["views"] is not None else -1

    def money_key(r: Item) -> int:
        return int(r["totals"][0]["amountMicros"]) if r["totals"] else -1

    rows.sort(key=lambda r: r["firstPostedAt"], reverse=True)
    if by == "money":
        rows.sort(key=lambda r: (money_key(r), views_key(r)), reverse=True)
    else:
        rows.sort(key=views_key, reverse=True)


def _details(store: db.Store, media: s3.Media | None, pk: str, page: list[Item]) -> list[Item]:
    """Title and cover for this page only: one BatchGetItem, and covers signed for 1 hour."""
    clip_items = {
        str(c.get("clipId")): c for c in store.batch_get((pk, db.clip_sk(r["clipId"])) for r in page) if c.get("clipId")
    }
    out = []
    for r in page:
        clip = clip_items.get(r["clipId"], {})
        found = clip.get("captions")
        captions: Mapping[str, Any] = found if isinstance(found, Mapping) else {}
        title = str(captions.get("youtubeTitle") or "").strip() or str(clip.get("hook") or "").strip() or "Your clip"
        item: Item = {"clipId": r["clipId"], "title": title}
        if media is not None and clip.get("coverKey") and clip.get("status") != "declined":
            item["coverUrl"] = media.presign_get(str(clip["coverKey"]), COVER_SECONDS)
        out.append({**item, **{k: v for k, v in r.items() if k != "clipId"}})
    return out


def money_clips(
    store: db.Store,
    media: s3.Media | None,
    user_id: str,
    *,
    platforms: list[str],
    period: str,
    sort: str,
    cursor: str | None,
    limit: int,
    cfg: rules.Monetization | None = None,
) -> Item:
    cfg = cfg or rules.load()
    chosen = order(platforms) or list(MONEY_ORDER)
    pk = db.user_pk(user_id)
    posted = [
        p
        for p in store.query_all(pk, "POST#")
        if p.get("type") == "post" and p.get("status") == "posted" and p.get("platform") in chosen and p.get("clipId")
    ]
    # Only YouTube reports money per video (Facebook's is per Page), and only while it may read it (as the summary).
    youtube = "ok"
    if "youtube" in chosen:
        account = posts.connected_account(store, user_id, "youtube")
        if account is None:
            youtube = "not_connected"
        elif sources.MONETARY_SCOPE not in {str(s) for s in account.get("scopes") or []}:
            youtube = "needs_permission"
    per_video = "youtube" in chosen and youtube == "ok" and money_shown(cfg, "youtube")
    # The money's days: YouTube's newest window for this period (it ends on YouTube's newest reported day).
    reported = [m for m, _ in (_money(p, period) for p in posted if p.get("platform") == "youtube") if m is not None]
    to = max((m["to"] for m in reported if m["to"]), default=None) if per_video else None
    start = (
        min((m["from"] for m in reported if m["from"] and m["to"] == to), default=None)
        if to and period != "all"
        else None
    )
    groups: dict[str, list[Item]] = {}
    for p in posted:
        day = str(p.get("postedAt") or "")[:10]
        if to is not None and day and day > to:
            continue  # posted after the money's last day: nothing could be reported for it yet
        groups.setdefault(str(p["clipId"]), []).append(p)
    rows = [
        r
        for clip_id, items in groups.items()
        if (r := _row(clip_id, items, chosen, period, cfg, youtube=youtube, window=(start, to))) is not None
    ]
    sorted_by = sort if per_video else "views"
    _sort(rows, sorted_by)

    digest = _cursor_hash(chosen, period, sort, to)
    offset = decode(cursor, digest) if cursor else 0
    if offset > len(rows):
        raise bad_request(CHANGED)
    out: Item = {
        "period": period if period == "all" else int(period),
        "from": start,
        "to": to,
        "sort": sort,
        "sortedBy": sorted_by,
        "clips": _details(store, media, pk, rows[offset : offset + limit]),
    }
    if not per_video:
        if youtube == "needs_permission":
            out["note"] = "YouTube needs your OK first. Sorted by views."
        elif youtube == "not_connected":
            out["note"] = "Connect YouTube to see money per video. Sorted by views."
        else:
            verb = "doesn't" if len(chosen) == 1 else "don't"
            out["note"] = f"{_names(chosen)} {verb} share money per video. Sorted by views."
    if offset + limit < len(rows):
        out["nextCursor"] = encode(offset + limit, digest)
    return out


__all__ = ["PERIODS", "SORTS", "money_clips"]
