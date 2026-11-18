"""One owner's money run (docs/CONTRACTS.md §25.1, §25.3, §25.6).

Per platform, on its own (one failing never stops the others, and nothing here can block posting):

1. Get the token through the shared ``SecretsTokenProvider`` (its lease keeps X and TikTok rotations single).
2. Read the platform (``sources``), within the shared rate budgets.
3. Write today's ``ACCTSTAT#`` snapshot, the reported money days (``REVENUE#``, ``revisedAt`` when a later read
   changed one), YouTube's per-clip money on each Post (``SET revenue`` only), and the ``MONEYSTATE#`` item.
4. States never go down by themselves: ``in_program`` and ``earning`` stay; a bad day only sets ``lastError``.
   ``detectedAt``, ``earningSince`` and ``firstPositiveAt`` are written once (conditional).
5. Celebrations are queued once per key (``pendingCelebrations``) and acknowledged by the owner (``POST
   /v1/money/seen``). First money waits until it survived a later re-read at least 3 days on.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any

from .. import db, posts
from ..clock import Clock, iso, parse, utcnow
from ..log import log
from ..platforms.base import (
    HttpClient,
    NetworkError,
    NotConnectedError,
    ReconnectNeededError,
    ResponseMeta,
    RetryablePublishError,
    to_int,
)
from ..stats import budget
from ..stats import config as stats_config
from . import (
    ACCTSTAT_TTL_DAYS,
    MONEY_ORDER,
    acctstat_prefix,
    acctstat_sk,
    label,
    revenue_prefix,
    revenue_sk,
    sources,
    state_sk,
)
from . import rules as money_rules

FIRST_MONEY_WAIT = timedelta(days=3)
VIEWS_WINDOW_DAYS = 30
X_IMPRESSIONS_DAYS = 90
RANK = {"earning": 2, "in_program": 1}
CHECK_FAILED = "Couldn't check today. Clip Factory tries again tomorrow."


@dataclass
class MoneyDeps:
    store: db.Store
    tokens: Any  # oauth.tokens.SecretsTokenProvider, or None (no secrets configured: nothing is read)
    http: HttpClient
    clock: Clock = utcnow
    rules: money_rules.Monetization | None = None
    platforms: stats_config.PlatformsConfig | None = None
    graph_version: str = "v27.0"
    time_budget_seconds: float = 240.0
    monotonic: Callable[[], float] = time.monotonic

    def cfg(self) -> money_rules.Monetization:
        return self.rules or money_rules.load()

    def stats_cfg(self) -> stats_config.PlatformsConfig:
        return self.platforms or stats_config.load()


@dataclass
class Outcome:
    platform: str
    state: str | None = None
    error: str | None = None
    rows: int = 0
    celebrations: list[str] = field(default_factory=list)


# --- reading -------------------------------------------------------------------------------------------------------


def _youtube_videos(store: db.Store, user_id: str) -> dict[str, str]:
    found = {}
    for p in store.query_all(db.user_pk(user_id), "POST#"):
        if p.get("type") == "post" and p.get("platform") == "youtube" and p.get("status") == "posted":
            vid = p.get("statsId") or p.get("platformPostId")
            if isinstance(vid, str) and vid and p.get("postedAt"):
                found[vid] = str(p["postedAt"])[:10]
    return found


def _x_impressions(store: db.Store, user_id: str, now: datetime) -> int | None:
    """An upper guess from Clip Factory's own posts (original posts, never replies), from the stats already read."""
    oldest = now - timedelta(days=X_IMPRESSIONS_DAYS)
    total = 0
    seen = False
    for p in store.query_all(db.user_pk(user_id), "POST#"):
        if p.get("type") != "post" or p.get("platform") != "x" or p.get("status") != "posted":
            continue
        posted = parse(p.get("postedAt"))
        extra = (p.get("metrics") or {}).get("extra") if isinstance(p.get("metrics"), dict) else None
        value = extra.get("impressions") if isinstance(extra, dict) else None
        if posted is not None and posted >= oldest and isinstance(value, int | float) and not isinstance(value, bool):
            total += int(value)
            seen = True
    return total if seen else None


def _read(deps: MoneyDeps, user_id: str, platform: str, account: dict[str, Any], now: datetime) -> sources.Reading:
    creds = deps.tokens.credentials(platform, account)
    token = creds.access_token
    scopes = [str(s) for s in account.get("scopes") or []]
    cfg = deps.stats_cfg()

    def allowed(units: int) -> bool:
        got = budget.reserve(deps.store, platform, units, now, cfg=cfg)
        return isinstance(got, budget.Reserved)

    if platform == "youtube":
        return sources.read_youtube(
            deps.http,
            token,
            scopes=scopes,
            now=now,
            video_ids=_youtube_videos(deps.store, user_id),
            data_api_allowed=allowed,
        )
    if platform == "facebook":
        return sources.read_facebook(
            deps.http,
            token,
            page_id=str(account.get("accountId") or ""),
            now=now,
            graph_version=deps.graph_version,
            money_verified=deps.cfg().platform("facebook").money_verified,
        )
    if platform == "instagram":
        user = str(account.get("platformUserId") or account.get("accountId") or "")
        return sources.read_instagram(deps.http, token, user_id=user, graph_version=deps.graph_version)
    if platform == "tiktok":
        return sources.read_tiktok(deps.http, token, scopes=scopes, allowed=allowed)
    # X: one owned read a day, booked against the shared $10 a month (deduplicated per day).
    got = budget.reserve(deps.store, "x", 1, now, ids=("users/me",), cfg=cfg)
    if not isinstance(got, budget.Reserved):
        return sources.Reading(error="Clip Factory stopped X at your monthly limit. It checks again next month.")
    reading, resp = sources.read_x(deps.http, token)
    if resp is not None:
        meta = ResponseMeta(status=resp.status, headers=dict(resp.headers))
        meta.retry_after = to_int(resp.headers.get("x-rate-limit-reset"))
        if resp.status == 429:
            meta.error_code = "429"
        budget.record(deps.store, "x", meta, now, cfg=cfg)
    return reading


# --- writing -------------------------------------------------------------------------------------------------------


def _snapshot(deps: MoneyDeps, user_id: str, platform: str, reading: sources.Reading, now: datetime) -> None:
    if not reading.snapshot:
        return
    day = now.date().isoformat()
    deps.store.put(
        {
            "pk": db.user_pk(user_id),
            "sk": acctstat_sk(platform, day),
            "type": "acctstat",
            "platform": platform,
            "day": day,
            **reading.snapshot,
            "readAt": iso(now),
            "source": f"{platform}.api",
            "ttl": int((now + timedelta(days=ACCTSTAT_TTL_DAYS)).timestamp()),
        }
    )


def _views30(deps: MoneyDeps, user_id: str, today_total: int | None, now: datetime) -> tuple[int | None, int]:
    """TikTok's views in the last 30 days from daily snapshots of the summed public view counts, clamped at 0 (a
    deleted or private video lowers the sum). ``(views, days still to count)``."""
    snaps = deps.store.query_all(db.user_pk(user_id), acctstat_prefix("tiktok"))
    totals = {str(s.get("day")): int(s["viewsTotal"]) for s in snaps if isinstance(s.get("viewsTotal"), int)}
    if today_total is None or not totals:
        return None, VIEWS_WINDOW_DAYS
    today = now.date()
    oldest = min(date.fromisoformat(d) for d in totals)
    have = (today - oldest).days
    if have < VIEWS_WINDOW_DAYS:
        return None, VIEWS_WINDOW_DAYS - have
    target = (today - timedelta(days=VIEWS_WINDOW_DAYS)).isoformat()
    before = [d for d in totals if d <= target]
    base = totals[max(before)] if before else totals[min(totals)]
    return max(0, today_total - base), 0


def _write_days(deps: MoneyDeps, user_id: str, platform: str, days: list[dict[str, Any]], now: datetime) -> int:
    """Upserts each reported day; a changed amount keeps the first ``firstFetchedAt`` and sets ``revisedAt``."""
    pk = db.user_pk(user_id)
    existing = {str(i.get("date")): i for i in deps.store.query_all(pk, revenue_prefix(platform))}
    written = 0
    for day in days:
        old = existing.get(day["date"])
        item: dict[str, Any] = {
            "pk": pk,
            "sk": revenue_sk(platform, day["date"]),
            "type": "revenue",
            "platform": platform,
            "date": day["date"],
            "amountMicros": int(day["amountMicros"]),
            "currency": day["currency"],
            "unit": day["unit"],
            "source": day["source"],
            "breakdown": day.get("breakdown") or {},
            "estimate": True,
            "fetchedAt": iso(now),
            "firstFetchedAt": (old or {}).get("firstFetchedAt") or (old or {}).get("fetchedAt") or iso(now),
        }
        if old is not None:
            if old.get("amountMicros") != item["amountMicros"] or old.get("currency") != item["currency"]:
                item["revisedAt"] = iso(now)
                item["previousMicros"] = old.get("amountMicros")
            elif old.get("revisedAt"):
                item["revisedAt"] = old["revisedAt"]
        deps.store.put(item)
        written += 1
    return written


def _write_clip_money(deps: MoneyDeps, user_id: str, reading: sources.Reading, now: datetime) -> None:
    """YouTube's estimate per Clip Factory video, on its Post (``SET revenue`` only, never through the metrics)."""
    if not reading.videos:
        return
    pk = db.user_pk(user_id)
    for post in deps.store.query_all(pk, "POST#"):
        if post.get("type") != "post" or post.get("platform") != "youtube":
            continue
        vid = post.get("statsId") or post.get("platformPostId")
        if vid not in reading.videos:
            continue
        try:
            deps.store.update(
                pk,
                str(post["sk"]),
                {
                    "revenue": {
                        "amountMicros": reading.videos[str(vid)],
                        "currency": "USD",
                        "through": reading.videos_through,
                        "source": "youtube.estimatedRevenue",
                        "fetchedAt": iso(now),
                    }
                },
            )
        except db.ConditionFailed:
            continue


def _set_once(deps: MoneyDeps, user_id: str, platform: str, name: str, value: str) -> bool:
    try:
        deps.store.update_expr(
            db.user_pk(user_id),
            state_sk(platform),
            "SET #f = :v",
            condition="attribute_not_exists(#f)",
            names={"#f": name},
            values={":v": value},
        )
    except db.ConditionFailed:
        return False
    return True


# --- state ---------------------------------------------------------------------------------------------------------


def _base_state(platform: str, reading: sources.Reading, money_seen: bool, verified: bool) -> str:
    if platform == "youtube":
        if reading.monetary == "ok":
            return "earning" if money_seen else "in_program"
        if reading.monetary == "forbidden":
            return "not_yet"
        if reading.monetary == "missing_scope":
            return "needs_permission"
        return "error"
    if platform == "facebook":
        return "earning" if verified and money_seen else "unknown"
    if platform == "tiktok" and "followers" in reading.missing and "Allow follower" in reading.missing["followers"]:
        return "needs_permission"
    return "not_available"


def _celebrate(
    platform: str,
    rule: money_rules.Rule | str | None,
    numbers: dict[str, Any],
    state: str,
    previous: dict[str, Any],
    *,
    first_money_due: bool,
) -> list[dict[str, Any]]:
    done = set((previous.get("celebrated") or {}).keys()) | {
        c.get("key") for c in previous.get("pendingCelebrations") or []
    }
    out: list[dict[str, Any]] = []
    if isinstance(rule, money_rules.Rule):
        goals, _ = money_rules.progress(rule, numbers)
        for g in goals:
            if not g["reached"] or g["kind"] == "number":
                continue
            key = f"{platform}:goal:{g['key']}:{g['goal']}"
            if key in done:
                continue
            text = (
                f"You have {label(platform)} {g['label']}!"
                if g["kind"] == "tick"
                else f"You hit {int(g['goal']):,} {g['label']}!"
            )
            out.append({"key": key, "platform": platform, "kind": "goal", "text": text})
    if state in {"in_program", "earning"} and f"{platform}:in_program" not in done and platform == "youtube":
        out.append(
            {
                "key": f"{platform}:in_program",
                "platform": platform,
                "kind": "in_program",
                "text": "You're in YouTube's Partner Program!",
            }
        )
    if first_money_due and f"{platform}:first_money" not in done:
        out.append(
            {
                "key": f"{platform}:first_money",
                "platform": platform,
                "kind": "first_money",
                "text": f"Your first money from {label(platform)}!",
            }
        )
    return out


def _guarded_read(
    deps: MoneyDeps, user_id: str, platform: str, account: dict[str, Any], now: datetime
) -> sources.Reading:
    try:
        return _read(deps, user_id, platform, account, now)
    except ReconnectNeededError:
        return sources.Reading(error=f"Connect {label(platform)} again in Settings › Posting › Set up posting.")
    except (RetryablePublishError, NetworkError):
        return sources.Reading(error=sources.network_text(platform))


def _numbers(
    deps: MoneyDeps, user_id: str, platform: str, reading: sources.Reading, now: datetime
) -> tuple[dict[str, Any], dict[str, int]]:
    """What was read, plus what is worked out from Clip Factory's own snapshots and posts (never money)."""
    numbers: dict[str, Any] = dict(reading.numbers)
    counting: dict[str, int] = {}
    if platform == "tiktok":
        views, left = _views30(deps, user_id, reading.snapshot.get("viewsTotal"), now)
        if views is not None:
            numbers["views30"] = views
        elif "views30" not in reading.missing:
            counting["views30"] = left
    if platform == "x":
        impressions = _x_impressions(deps.store, user_id, now)
        if impressions is not None:
            numbers["impressions90"] = impressions
    return numbers, counting


def _decide(
    platform: str, reading: sources.Reading, previous: dict[str, Any], *, money_seen: bool, verified: bool
) -> tuple[str, str | None]:
    """``(state, lastError)``. States never go down by themselves (§25.1): a worse day only sets ``lastError``."""
    error = reading.error
    if reading.error:
        state = str(previous.get("state") or "error")
    else:
        state = _base_state(platform, reading, money_seen or previous.get("state") == "earning", verified)
    if state == "error" and reading.fix:
        error = reading.fix
    old = str(previous.get("state") or "")
    if RANK.get(old, 0) > RANK.get(state, 0):
        if state not in {"in_program", "earning"}:
            error = error or CHECK_FAILED
        state = old
    return state, error


def _state_fields(
    platform: str, reading: sources.Reading, state: str, numbers: dict[str, Any], counting: dict[str, int]
) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "type": "moneystate",
        "platform": platform,
        "state": state,
        "numbers": numbers,
        "missing": reading.missing,
        "counting": counting,
    }
    for name, value in (
        ("split", reading.split),
        ("rawEarnings", reading.raw),
        ("approxMonth", reading.approx_month),
        ("longVideos", reading.long_videos),
    ):
        if value is not None:
            fields[name] = value
    if platform == "youtube" and reading.monetary == "ok":
        fields["adsOn"] = any(int((d.get("breakdown") or {}).get("adsMicros") or 0) > 0 for d in reading.days)
    return fields


def _write_state(deps: MoneyDeps, user_id: str, platform: str, fields: dict[str, Any], error: str | None) -> None:
    if error:
        fields = {**fields, "lastError": error}
    names = {f"#f{i}": k for i, k in enumerate(fields)}
    values = {f":f{i}": v for i, v in enumerate(fields.values())}
    update = "SET " + ", ".join(f"#f{i} = :f{i}" for i in range(len(fields)))
    if not error:
        names["#r0"] = "lastError"
        update += " REMOVE #r0"
    deps.store.update_expr(db.user_pk(user_id), state_sk(platform), update, names=names, values=values)


def _mark_scopes(
    deps: MoneyDeps, user_id: str, platform: str, account: dict[str, Any], *, state: str, now: datetime
) -> None:
    """``moneyScopesMissing`` on the Account, set and removed with ``mark_account`` only (an UpdateItem)."""
    if platform not in {"youtube", "tiktok"}:
        return
    missing = state == "needs_permission"
    if missing == bool(account.get("moneyScopesMissing")):
        return
    from ..oauth import setup

    if missing:
        setup.mark_account(deps.store, user_id, platform, now, moneyScopesMissing=True)
    else:
        setup.mark_account(deps.store, user_id, platform, now, remove=["moneyScopesMissing"])


def run_platform(deps: MoneyDeps, user_id: str, platform: str, *, now: datetime, country: str | None) -> Outcome:
    out = Outcome(platform)
    account = posts.connected_account(deps.store, user_id, platform)
    if account is None:
        out.state = "not_connected"
        return out
    previous = deps.store.get(db.user_pk(user_id), state_sk(platform)) or {}
    cfg = deps.cfg()
    try:
        reading = _guarded_read(deps, user_id, platform, account, now)
    except NotConnectedError:
        out.state = "not_connected"
        return out
    _snapshot(deps, user_id, platform, reading, now)
    numbers, counting = _numbers(deps, user_id, platform, reading, now)
    verified = platform != "facebook" or cfg.platform("facebook").money_verified
    if reading.days and verified:
        out.rows = _write_days(deps, user_id, platform, reading.days, now)
    if platform == "youtube":
        _write_clip_money(deps, user_id, reading, now)
    money_seen = verified and any(int(d["amountMicros"]) > 0 for d in reading.days)
    state, error = _decide(platform, reading, previous, money_seen=money_seen, verified=verified)
    in_program = state in {"in_program", "earning"}
    now_iso = iso(now)
    if in_program and platform == "youtube":
        _set_once(deps, user_id, platform, "detectedAt", now_iso)
    if state == "earning":
        _set_once(deps, user_id, platform, "earningSince", now_iso)
    if money_seen:
        _set_once(deps, user_id, platform, "firstPositiveAt", now_iso)
    first_positive = parse(previous.get("firstPositiveAt"))
    rule = money_rules.pick(cfg, platform, today=now.date(), in_program=in_program, country=country)
    new = _celebrate(
        platform,
        rule,
        {**numbers, "missing": reading.missing},
        state,
        previous,
        first_money_due=bool(money_seen and first_positive is not None and now - first_positive >= FIRST_MONEY_WAIT),
    )
    fields = _state_fields(platform, reading, state, numbers, counting)
    fields["lastCheckedAt"] = now_iso
    fields["pendingCelebrations"] = [c for c in previous.get("pendingCelebrations") or [] if isinstance(c, dict)] + new
    _write_state(deps, user_id, platform, fields, error)
    _mark_scopes(deps, user_id, platform, account, state=state, now=now)
    out.state = state
    out.error = error
    out.celebrations = [c["key"] for c in new]
    return out


def run_user(deps: MoneyDeps, user_id: str, *, platforms: tuple[str, ...] = MONEY_ORDER) -> list[Outcome]:
    from . import get_prefs

    started = deps.monotonic()
    country = get_prefs(deps.store, user_id).get("country")
    outcomes = []
    for platform in platforms:
        if deps.monotonic() - started > deps.time_budget_seconds:
            log("warning", "money.time_budget", platform=platform)
            break
        now = deps.clock()
        try:
            outcomes.append(
                run_platform(deps, user_id, platform, now=now, country=country if isinstance(country, str) else None)
            )
        except Exception as e:  # one platform never stops the others
            log("error", "money.platform_failed", platform=platform, error=type(e).__name__)
            try:
                deps.store.update_expr(
                    db.user_pk(user_id),
                    state_sk(platform),
                    "SET #e = :e, #t = :t, #p = :p",
                    names={"#e": "lastError", "#t": "type", "#p": "platform"},
                    values={":e": CHECK_FAILED, ":t": "moneystate", ":p": platform},
                )
            except Exception as inner:
                log("error", "money.state_write_failed", platform=platform, error=type(inner).__name__)
            outcomes.append(Outcome(platform, error=CHECK_FAILED))
    log(
        "info",
        "money.run",
        platforms=len(outcomes),
        rows=sum(o.rows for o in outcomes),
        errors=sum(1 for o in outcomes if o.error),
    )
    return outcomes
