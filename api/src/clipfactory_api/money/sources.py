"""The platform reads of the money collector (docs/CONTRACTS.md §25.2–§25.3).

Each ``read_*`` takes the platform's HTTP client, an access token and what it needs about the account, and returns a
``Reading``: the account's own numbers (``numbers``, keyed by the metrics of ``rules.METRICS``), the snapshot written
as ``ACCTSTAT#``, the money days a platform reported, and plain sentences for anything it did not share. Nothing
here invents a number: a value the platform did not return stays out (``missing`` says why), never 0.

Raw platform bodies never leave this module except Facebook's earnings answer while it is unverified, which is
stripped of tokens and paging links and cut to 8 KB (``strip_raw``).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import quote, urlencode

from ..platforms.base import HttpClient, HttpRequest, HttpResponse, NetworkError, obj, to_int, to_number
from . import MICROS, label

YT_DATA = "https://www.googleapis.com/youtube/v3"
YT_REPORTS = "https://youtubeanalytics.googleapis.com/v2/reports"
GRAPH = "https://graph.facebook.com"
TIKTOK_API = "https://open.tiktokapis.com"
X_ME = "https://api.x.com/2/users/me"
MONETARY_SCOPE = "https://www.googleapis.com/auth/yt-analytics-monetary.readonly"
TIKTOK_STATS_SCOPE = "user.info.stats"
VIDEO_IDS_PER_REPORT = 50
MAX_PLAYLIST_PAGES = 2
MAX_TIKTOK_PAGES = 50
RAW_MAX_BYTES = 8 * 1024
LONG_VIDEO_SECONDS = 60
NEWEST_FOR_LONG = 20
PREMIUM_TYPES = frozenset({"Premium", "PremiumPlus", "PremiumBusiness"})
NOT_PREMIUM_TYPES = frozenset({"None", "Basic"})
NOT_SHARED = "{name} didn't share this."

# YouTube Analytics 403 reasons that are never "not in the Partner Program yet" (§25.1).
YT_FIX = {
    "accessNotConfigured": "Ask a grown-up: turn on YouTube Analytics API. The steps are in Settings › Posting › Set up posting › YouTube.",
    "quotaExceeded": "YouTube's daily limit is used up. Clip Factory checks again tomorrow.",
    "dailyLimitExceeded": "YouTube's daily limit is used up. Clip Factory checks again tomorrow.",
    "rateLimitExceeded": "YouTube asked us to slow down. Clip Factory checks again tomorrow.",
    "insufficientPermissions": "Press Allow money reading so YouTube lets Clip Factory read money.",
}
YT_OTHER = "YouTube didn't answer. Clip Factory checks again tomorrow."


@dataclass
class Reading:
    numbers: dict[str, Any] = field(default_factory=dict)
    missing: dict[str, str] = field(default_factory=dict)  # metric → plain sentence
    snapshot: dict[str, Any] = field(default_factory=dict)  # stored as ACCTSTAT#{platform}#{day}
    days: list[dict[str, Any]] = field(default_factory=list)  # {date, amountMicros, currency, unit, source, breakdown}
    # YouTube: "ok" (in the programme), "forbidden" (not yet), "missing_scope", "error", or None (not asked).
    monetary: str | None = None
    fix: str | None = None  # a plain fix sentence for an error
    split: dict[str, Any] | None = None  # YouTube: this month's money by content type (hidden when the API says 400)
    videos: dict[str, int] = field(default_factory=dict)  # YouTube videoId → micros since the clip's first day
    videos_through: str | None = None
    video_views: dict[str, int] = field(default_factory=dict)  # the same lifetime report's views (§27.6)
    # §27.6: per-video money over the last 7, 30 and 90 reported days. "7" → {"from", "to", "videos": {id: {amount,
    # views}}}; a period whose report failed is in `windows_failed` (its stored value is kept).
    windows: dict[str, dict[str, Any]] = field(default_factory=dict)
    windows_failed: dict[str, str] = field(default_factory=dict)
    raw: dict[str, Any] | None = None  # Facebook while unverified: the stripped answer, never shown
    approx_month: dict[str, Any] | None = None  # Facebook: monetization_approximate_earnings this month
    long_videos: int | None = None  # TikTok: videos of 1 minute or longer among the newest 20
    error: str | None = None  # the whole read failed: one plain sentence
    requests: int = 0


# --- small helpers ---------------------------------------------------------------------------------------------


def _get(http: HttpClient, url: str, token: str) -> HttpResponse:
    return http(HttpRequest("GET", url, {"Authorization": f"Bearer {token}", "Accept": "application/json"}))


def _body(resp: HttpResponse) -> dict[str, Any]:
    found = resp.json()
    return found if isinstance(found, dict) else {}


def micros(value: Any) -> int | None:
    """A platform's decimal money amount (in its own currency) as a whole number of millionths. No conversion."""
    number = to_number(value)
    if number is None:
        return None
    return round(float(number) * MICROS)


def _rows(body: dict[str, Any]) -> list[dict[str, Any]]:
    headers = [str(h.get("name")) for h in body.get("columnHeaders") or [] if isinstance(h, dict)]
    out = []
    for row in body.get("rows") or []:
        if isinstance(row, list) and len(row) == len(headers):
            out.append(dict(zip(headers, row, strict=True)))
    return out


def _yt_reason(resp: HttpResponse) -> str:
    error = obj(_body(resp).get("error"))
    reasons = [str(e.get("reason")) for e in error.get("errors") or [] if isinstance(e, dict) and e.get("reason")]
    return reasons[0] if reasons else str(resp.status)


def month_start(day: date, back: int = 0) -> date:
    year, month = day.year, day.month - back
    while month < 1:
        month += 12
        year -= 1
    return date(year, month, 1)


def last_processed_day(now: datetime) -> date:
    """YouTube and Meta finish a day's numbers later; yesterday is the newest day asked for (the 2–3 day lag shows
    as a note, and the daily re-read fills the days in)."""
    return now.date() - timedelta(days=1)


def strip_raw(body: Any) -> dict[str, Any]:
    """A platform answer safe to keep: no ``access_token`` and no ``paging`` (Meta's paging URLs carry the token),
    at most ``RAW_MAX_BYTES``."""

    def clean(node: Any) -> Any:
        if isinstance(node, dict):
            return {k: clean(v) for k, v in node.items() if k not in {"access_token", "paging", "next", "previous"}}
        if isinstance(node, list):
            return [clean(v) for v in node]
        return node

    text = json.dumps(clean(body), separators=(",", ":"), sort_keys=True)
    if len(text.encode()) > RAW_MAX_BYTES:
        return {"truncated": True, "text": text.encode()[:RAW_MAX_BYTES].decode(errors="ignore")}
    out = json.loads(text)
    return out if isinstance(out, dict) else {"value": out}


# --- YouTube -------------------------------------------------------------------------------------------------------


def _report(http: HttpClient, token: str, **params: str) -> HttpResponse:
    query = urlencode({"ids": "channel==MINE", **params}, quote_via=quote, safe="=,-")
    return _get(http, f"{YT_REPORTS}?{query}", token)


def read_youtube(
    http: HttpClient,
    token: str,
    *,
    scopes: list[str],
    now: datetime,
    video_ids: dict[str, str],
    data_api_allowed: Callable[[int], bool] = lambda _units: True,
) -> Reading:
    """``video_ids``: YouTube video id → the day Clip Factory posted it (``yyyy-mm-dd``), for per-clip money.
    ``data_api_allowed(units)`` reserves Data API quota in the shared budget (False: skip that read today)."""
    out = Reading()
    end = last_processed_day(now)
    _youtube_channel(http, token, now=now, out=out, allowed=data_api_allowed)
    # 3. Shorts engaged views, 90 days (Analytics: its own quota).
    shorts = _report(
        http,
        token,
        startDate=(end - timedelta(days=89)).isoformat(),
        endDate=end.isoformat(),
        metrics="engagedViews",
        filters="creatorContentType==SHORTS",
    )
    out.requests += 1
    nonmoney_ok = shorts.status == 200
    if nonmoney_ok:
        rows = _rows(_body(shorts))
        out.numbers["shortsViews90"] = sum(to_int(r.get("engagedViews")) or 0 for r in rows)
    else:
        out.missing["shortsViews90"] = YT_FIX.get(_yt_reason(shorts), NOT_SHARED.format(name="YouTube"))
    # 4. Watch hours of long videos and lives, 365 days (labelled "about": Studio's number is the official one).
    watch = _report(
        http,
        token,
        startDate=(end - timedelta(days=364)).isoformat(),
        endDate=end.isoformat(),
        metrics="estimatedMinutesWatched",
        dimensions="creatorContentType",
    )
    out.requests += 1
    if watch.status == 200:
        minutes = sum(
            float(to_number(r.get("estimatedMinutesWatched")) or 0)
            for r in _rows(_body(watch))
            if r.get("creatorContentType") in {"VIDEO_ON_DEMAND", "LIVE_STREAM"}
        )
        out.numbers["watchHours365"] = int(minutes // 60)
    else:
        out.missing["watchHours365"] = YT_FIX.get(_yt_reason(watch), NOT_SHARED.format(name="YouTube"))
    out.snapshot.update(
        {k: out.numbers[k] for k in ("shortsViews90", "watchHours365", "uploads90") if k in out.numbers}
    )
    # 5. Money: only with the monetary scope. 200 = in the Partner Program; 403 forbidden = not yet.
    if MONETARY_SCOPE not in scopes:
        out.monetary = "missing_scope"
        return out
    start = month_start(end, 2)
    money = _report(
        http,
        token,
        startDate=start.isoformat(),
        endDate=end.isoformat(),
        metrics="estimatedRevenue,estimatedAdRevenue",
        dimensions="day",
    )
    out.requests += 1
    if money.status == 200:
        out.monetary = "ok"
        for r in _rows(_body(money)):
            day = str(r.get("day") or "")
            amount = micros(r.get("estimatedRevenue"))
            if len(day) != 10 or amount is None:
                continue
            ads = micros(r.get("estimatedAdRevenue"))
            out.days.append(
                {
                    "date": day,
                    "amountMicros": amount,
                    "currency": "USD",  # Analytics reports USD unless asked otherwise; never converted here
                    "unit": "USD",
                    "source": "youtube.estimatedRevenue",
                    "breakdown": {"adsMicros": ads} if ads is not None else {},
                }
            )
        out.split = _youtube_split(http, token, end, out)
        out.videos, out.videos_through = _youtube_videos(http, token, end, video_ids, out), end.isoformat()
        _youtube_windows(http, token, video_ids, out)
        return out
    reason = _yt_reason(money)
    if money.status == 403 and reason == "forbidden" and nonmoney_ok:
        out.monetary = "forbidden"
    elif reason == "insufficientPermissions":
        out.monetary = "missing_scope"
    else:
        out.monetary = "error"
        out.fix = YT_FIX.get(reason, YT_OTHER)
    return out


def _youtube_channel(
    http: HttpClient, token: str, *, now: datetime, out: Reading, allowed: Callable[[int], bool]
) -> None:
    """Rounded subscribers and the uploads playlist (1 unit), then public uploads in 90 days (1–2 units)."""
    data_api_allowed = allowed
    # 1. Rounded subscribers and the uploads playlist (1 unit).
    uploads = None
    if data_api_allowed(1):
        resp = _get(http, f"{YT_DATA}/channels?part=statistics,contentDetails&mine=true", token)
        out.requests += 1
        items = _body(resp).get("items") if resp.status == 200 else None
        channel = obj(items[0]) if isinstance(items, list) and items else {}
        stats = obj(channel.get("statistics"))
        if stats and not stats.get("hiddenSubscriberCount"):
            subs = to_int(stats.get("subscriberCount"))
            if subs is not None:
                out.numbers["subscribers"] = subs
                out.snapshot["subscribers"] = subs
        elif stats.get("hiddenSubscriberCount"):
            out.missing["subscribers"] = "Your subscriber count is hidden on YouTube."
        uploads = obj(obj(channel.get("contentDetails")).get("relatedPlaylists")).get("uploads")
        if resp.status >= 400:
            out.missing.setdefault("subscribers", NOT_SHARED.format(name="YouTube"))
    else:
        out.missing["subscribers"] = "YouTube's daily limit is used up. Clip Factory checks again tomorrow."
    # 2. Public uploads in the last 90 days: newest first, stop at the first older one (1–2 units).
    if isinstance(uploads, str) and uploads:
        out.numbers["uploads90"] = _public_uploads(http, token, uploads, now=now, out=out, allowed=data_api_allowed)


def _public_uploads(
    http: HttpClient, token: str, playlist: str, *, now: datetime, out: Reading, allowed: Callable[[int], bool]
) -> int:
    oldest = now - timedelta(days=90)
    count = 0
    page: str | None = None
    for _ in range(MAX_PLAYLIST_PAGES):
        if not allowed(1):
            break
        url = f"{YT_DATA}/playlistItems?part=status,contentDetails&maxResults=50&playlistId={quote(playlist, safe='')}"
        if page:
            url += f"&pageToken={quote(page, safe='')}"
        resp = _get(http, url, token)
        out.requests += 1
        body = _body(resp)
        if resp.status != 200:
            break
        for item in body.get("items") or []:
            details = obj(obj(item).get("contentDetails"))
            published = str(details.get("videoPublishedAt") or "")
            try:
                moment = datetime.fromisoformat(published.replace("Z", "+00:00"))
            except ValueError:
                continue
            if moment < oldest:
                return count
            if obj(obj(item).get("status")).get("privacyStatus") == "public":
                count += 1
        page = body.get("nextPageToken") if isinstance(body.get("nextPageToken"), str) else None
        if not page:
            break
    return count


def _youtube_split(http: HttpClient, token: str, end: date, out: Reading) -> dict[str, Any] | None:
    """This month's money by Shorts / long videos / lives. Not verified live (§25.8): a 400 hides it."""
    resp = _report(
        http,
        token,
        startDate=month_start(end).isoformat(),
        endDate=end.isoformat(),
        metrics="estimatedRevenue",
        dimensions="creatorContentType",
    )
    out.requests += 1
    if resp.status != 200:
        return None
    names = {"SHORTS": "shortsMicros", "VIDEO_ON_DEMAND": "longMicros", "LIVE_STREAM": "liveMicros"}
    split: dict[str, Any] = {"month": end.strftime("%Y-%m")}
    for r in _rows(_body(resp)):
        key = names.get(str(r.get("creatorContentType")))
        amount = micros(r.get("estimatedRevenue"))
        if key and amount is not None:
            split[key] = amount
    return split if len(split) > 1 else None


def _video_rows(
    http: HttpClient, token: str, chunk: list[str], *, start: str, end: str, out: Reading
) -> tuple[bool, dict[str, tuple[int, int | None]]]:
    """One ``dimensions=video`` report: ``(ok, {videoId: (micros, views)})`` for the chunk's ids."""
    resp = _report(
        http,
        token,
        startDate=start,
        endDate=end,
        metrics="estimatedRevenue,views",
        dimensions="video",
        filters="video==" + ",".join(chunk),
        sort="-estimatedRevenue",
        maxResults=str(VIDEO_IDS_PER_REPORT),
    )
    out.requests += 1
    if resp.status != 200:
        return False, {}
    found: dict[str, tuple[int, int | None]] = {}
    for r in _rows(_body(resp)):
        video = str(r.get("video") or "")
        amount = micros(r.get("estimatedRevenue"))
        if video in chunk and amount is not None:
            found[video] = (amount, to_int(r.get("views")))
    return True, found


def _youtube_videos(http: HttpClient, token: str, end: date, video_ids: dict[str, str], out: Reading) -> dict[str, int]:
    """Money per Clip Factory video since its first day (≤ 50 ids a call, so no video is ever cut off), with the same
    report's views (``video_views``)."""
    found: dict[str, int] = {}
    ids = sorted(video_ids, key=lambda v: video_ids[v])
    for i in range(0, len(ids), VIDEO_IDS_PER_REPORT):
        chunk = ids[i : i + VIDEO_IDS_PER_REPORT]
        start = min(video_ids[v] for v in chunk)
        if start > end.isoformat():
            continue
        ok, rows = _video_rows(http, token, chunk, start=start, end=end.isoformat(), out=out)
        if not ok:
            continue
        for video, (amount, views) in rows.items():
            found[video] = amount
            if views is not None:
                out.video_views[video] = views
    return found


WINDOW_DAYS = (7, 30, 90)


def _youtube_windows(http: HttpClient, token: str, video_ids: dict[str, str], out: Reading) -> None:
    """§27.6: money and views per video over the last 7, 30 and 90 days YouTube finished, ending on the newest day of
    the day report (so a clip's period money covers the same days as the dashboard's periods). A video YouTube left
    out of a successful report had no money and no views in those days: it is stored as 0. Never asked for a video
    posted after the window ends."""
    if not out.days or not video_ids:
        return
    through = max(str(d["date"]) for d in out.days)
    end = date.fromisoformat(through)
    ids = sorted(v for v in video_ids if video_ids[v] <= through)
    for n in WINDOW_DAYS:
        start = (end - timedelta(days=n - 1)).isoformat()
        videos: dict[str, dict[str, int]] = {}
        failed = False
        for i in range(0, len(ids), VIDEO_IDS_PER_REPORT):
            chunk = ids[i : i + VIDEO_IDS_PER_REPORT]
            ok, rows = _video_rows(http, token, chunk, start=start, end=through, out=out)
            if not ok:
                failed = True
                continue
            for video in chunk:
                amount, views = rows.get(video, (0, 0))
                videos[video] = {"amountMicros": amount, "views": views if views is not None else 0}
        if failed:
            out.windows_failed[str(n)] = YT_OTHER
        out.windows[str(n)] = {"from": start, "to": through, "videos": videos}


# --- Meta (Facebook Page, Instagram) ---------------------------------------------------------------------------


def _graph(version: str, path: str, params: dict[str, str]) -> str:
    return f"{GRAPH}/{version}/{path.lstrip('/')}?{urlencode(params, quote_via=quote, safe=',')}"


def _insight_sums(body: dict[str, Any]) -> dict[str, float]:
    sums: dict[str, float] = {}
    for row in body.get("data") or []:
        if not isinstance(row, dict) or not isinstance(row.get("name"), str):
            continue
        total = 0.0
        seen = False
        for v in row.get("values") or []:
            number = to_number(obj(v).get("value"))
            if number is not None:
                total += float(number)
                seen = True
        if seen:
            sums[row["name"]] = total
    return sums


def _graph_error(resp: HttpResponse) -> str | None:
    error = _body(resp).get("error")
    if resp.status >= 400 or isinstance(error, dict):
        return str(obj(error).get("code") or resp.status)
    return None


def read_facebook(
    http: HttpClient, token: str, *, page_id: str, now: datetime, graph_version: str, money_verified: bool
) -> Reading:
    out = Reading()
    if not page_id:
        out.error = "Connect Facebook again in Settings › Posting › Set up posting."
        return out
    page = quote(page_id, safe="")
    resp = _get(http, _graph(graph_version, page, {"fields": "followers_count"}), token)
    out.requests += 1
    followers = to_int(_body(resp).get("followers_count")) if _graph_error(resp) is None else None
    if followers is not None:
        out.numbers["followers"] = followers
        out.snapshot["followers"] = followers
    else:
        out.missing["followers"] = NOT_SHARED.format(name="Facebook")
    end = last_processed_day(now)
    since = (end - timedelta(days=59)).isoformat()
    window = {"period": "day", "since": since, "until": (end + timedelta(days=1)).isoformat()}
    metrics = ["page_video_view_time", "creator_monetization_qualified_views"]
    insights = _get(http, _graph(graph_version, f"{page}/insights", {"metric": ",".join(metrics), **window}), token)
    out.requests += 1
    if _graph_error(insights) == "100":  # one metric is unknown to this Page: ask for the minutes alone
        metrics = metrics[:1]
        insights = _get(http, _graph(graph_version, f"{page}/insights", {"metric": metrics[0], **window}), token)
        out.requests += 1
    sums = _insight_sums(_body(insights)) if _graph_error(insights) is None else {}
    if "page_video_view_time" in sums:
        out.numbers["minutes60"] = int(sums["page_video_view_time"] // 60_000)  # milliseconds
    else:
        out.missing["minutes60"] = NOT_SHARED.format(name="Meta")
    if "creator_monetization_qualified_views" in sums:
        out.numbers["qualifiedViews60"] = int(sums["creator_monetization_qualified_views"])
    else:
        out.missing["qualifiedViews60"] = NOT_SHARED.format(name="Meta")
    out.snapshot.update({k: out.numbers[k] for k in ("minutes60", "qualifiedViews60") if k in out.numbers})
    _facebook_money(http, token, page, version=graph_version, end=end, out=out, verified=money_verified)
    return out


def _meta_amount(value: Any) -> tuple[int, str, str] | None:
    """``(micros, currency, unit)`` only when Meta says both the amount's unit and its currency. A bare number has no
    unit we can trust (§25.8), so it is never shown."""
    node = obj(value)
    currency = node.get("currency")
    if not isinstance(currency, str) or not currency:
        return None
    for key, unit in (("micro_amount", "micro_amount"), ("microAmount", "micro_amount")):
        amount = to_int(node.get(key))
        if amount is not None:
            return amount, currency.upper(), unit
    return None


def _facebook_money(
    http: HttpClient, token: str, page: str, *, version: str, end: date, out: Reading, verified: bool
) -> None:
    start = month_start(end, 2)
    raw: dict[str, Any] = {}
    for metric, source in (
        ("content_monetization_earnings", "facebook.content_monetization_earnings"),
        ("monetization_approximate_earnings", "facebook.monetization_approximate_earnings"),
    ):
        windows = []
        cursor = start
        while cursor <= end:  # Meta answers at most 90 days a call
            stop = min(end, cursor + timedelta(days=89))
            windows.append((cursor, stop))
            cursor = stop + timedelta(days=1)
        values: list[Any] = []
        failed = False
        for since, until in windows:
            params = {"metric": metric, "period": "day", "since": since.isoformat()}
            params["until"] = (until + timedelta(days=1)).isoformat()
            resp = _get(http, _graph(version, f"{page}/insights", params), token)
            out.requests += 1
            if _graph_error(resp) is not None:
                failed = True
                raw[metric] = {"error": strip_raw(_body(resp).get("error"))}
                break
            body = _body(resp)
            raw.setdefault(metric, []).append(strip_raw(body))
            for row in body.get("data") or []:
                values.extend(v for v in obj(row).get("values") or [] if isinstance(v, dict))
        if failed or not verified:
            continue  # an erroring metric is "not available": no fallback to the other one
        if metric == "content_monetization_earnings":
            for v in values:
                parsed = _meta_amount(v.get("value"))
                day = str(v.get("end_time") or "")[:10]
                if parsed is None or len(day) != 10:
                    continue
                amount, currency, unit = parsed
                out.days.append(
                    {
                        "date": day,
                        "amountMicros": amount,
                        "currency": currency,
                        "unit": unit,
                        "source": source,
                        "breakdown": {},
                    }
                )
        else:
            month = end.strftime("%Y-%m")
            totals: dict[str, int] = {}
            for v in values:
                parsed = _meta_amount(v.get("value"))
                if parsed is not None and str(v.get("end_time") or "").startswith(month):
                    totals[parsed[1]] = totals.get(parsed[1], 0) + parsed[0]
            if len(totals) == 1:
                currency, amount = next(iter(totals.items()))
                out.approx_month = {"month": month, "amountMicros": amount, "currency": currency, "source": source}
    if not verified:
        out.raw = strip_raw(raw)


def read_instagram(http: HttpClient, token: str, *, user_id: str, graph_version: str) -> Reading:
    out = Reading()
    if not user_id:
        out.error = "Connect Instagram again in Settings › Posting › Set up posting."
        return out
    resp = _get(http, _graph(graph_version, quote(user_id, safe=""), {"fields": "followers_count"}), token)
    out.requests += 1
    followers = to_int(_body(resp).get("followers_count")) if _graph_error(resp) is None else None
    if followers is None:
        out.missing["followers"] = NOT_SHARED.format(name="Instagram")
    else:
        out.numbers["followers"] = followers
        out.snapshot["followers"] = followers
    return out


# --- TikTok --------------------------------------------------------------------------------------------------------


def read_tiktok(
    http: HttpClient, token: str, *, scopes: list[str], allowed: Callable[[int], bool] = lambda _n: True
) -> Reading:
    out = Reading()
    if TIKTOK_STATS_SCOPE in scopes:
        if allowed(1):
            resp = _get(http, f"{TIKTOK_API}/v2/user/info/?fields=follower_count,video_count", token)
            out.requests += 1
            user = obj(obj(_body(resp).get("data")).get("user"))
            followers = to_int(user.get("follower_count")) if resp.status == 200 else None
            if followers is not None:
                out.numbers["followers"] = followers
                out.snapshot["followers"] = followers
            else:
                out.missing["followers"] = NOT_SHARED.format(name="TikTok")
        else:
            out.missing["followers"] = "TikTok asked us to slow down. Clip Factory checks again tomorrow."
    else:
        out.missing["followers"] = "Press Allow follower reading once TikTok approves it."
    total = 0
    cursor: int | None = None
    newest: list[dict[str, Any]] = []
    complete = False
    for _ in range(MAX_TIKTOK_PAGES):
        if not allowed(1):
            break
        payload: dict[str, Any] = {"max_count": 20}
        if cursor is not None:
            payload["cursor"] = cursor
        resp = http(
            HttpRequest(
                "POST",
                f"{TIKTOK_API}/v2/video/list/?fields=id,view_count,duration,create_time",
                {"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json.dumps(payload, separators=(",", ":")).encode(),
            )
        )
        out.requests += 1
        data = obj(_body(resp).get("data"))
        if resp.status != 200:
            break
        videos = [obj(v) for v in data.get("videos") or []]
        for v in videos:
            total += max(0, to_int(v.get("view_count")) or 0)
        if len(newest) < NEWEST_FOR_LONG:
            newest.extend(videos[: NEWEST_FOR_LONG - len(newest)])
        if not data.get("has_more"):
            complete = True
            break
        cursor = to_int(data.get("cursor"))
        if cursor is None:
            break
    if complete:
        out.snapshot["viewsTotal"] = total
        out.long_videos = sum(1 for v in newest if (to_number(v.get("duration")) or 0) >= LONG_VIDEO_SECONDS)
        out.snapshot["longVideos"] = out.long_videos
    else:
        out.missing["views30"] = NOT_SHARED.format(name="TikTok")
    return out


# --- X ---------------------------------------------------------------------------------------------------------


def read_x(http: HttpClient, token: str) -> tuple[Reading, HttpResponse | None]:
    """One owned ``users/me`` read. ``verified_followers_count`` is not verified live as a user field (§25.8): if X
    refuses the field, the read is repeated without it and that bar says X didn't share it."""
    out = Reading()
    fields = "public_metrics,subscription_type,verified_followers_count"
    resp = _get(http, f"{X_ME}?user.fields={fields}", token)
    out.requests += 1
    if resp.status == 400:
        resp = _get(http, f"{X_ME}?user.fields=public_metrics,subscription_type", token)
        out.requests += 1
    if resp.status != 200:
        out.error = "X didn't answer. Clip Factory checks again tomorrow."
        return out, resp
    user = obj(_body(resp).get("data"))
    kind = user.get("subscription_type")
    if kind in PREMIUM_TYPES:
        out.numbers["premium"] = True
    elif kind in NOT_PREMIUM_TYPES:
        out.numbers["premium"] = False
    else:
        out.missing["premium"] = NOT_SHARED.format(name="X")
    verified = to_int(user.get("verified_followers_count"))
    if verified is None:
        verified = to_int(obj(user.get("public_metrics")).get("verified_followers_count"))
    if verified is None:
        out.missing["verifiedFollowers"] = NOT_SHARED.format(name="X")
    else:
        out.numbers["verifiedFollowers"] = verified
        out.snapshot["verifiedFollowers"] = verified
    followers = to_int(obj(user.get("public_metrics")).get("followers_count"))
    if followers is not None:
        out.snapshot["followers"] = followers
    if isinstance(kind, str):
        out.snapshot["subscriptionType"] = kind
    return out, resp


def network_text(platform: str) -> str:
    return f"{label(platform)} didn't answer. Clip Factory checks again tomorrow."


__all__ = [
    "MONETARY_SCOPE",
    "TIKTOK_STATS_SCOPE",
    "NetworkError",
    "Reading",
    "micros",
    "read_facebook",
    "read_instagram",
    "read_tiktok",
    "read_x",
    "read_youtube",
    "strip_raw",
]
