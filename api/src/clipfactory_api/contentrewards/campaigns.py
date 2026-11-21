"""``CAMPAIGN#`` items: adding, reading, membership, the public ``Campaign`` (docs/CONTRACTS.md §38.4, §38.10).

The listed campaign from ``list_my_campaigns`` wins for status, pay, platforms and the brief; the public JSON is read
only on the owner's own actions (add, Check now, a stale card, a job's start). Membership is "in" when CR lists the
campaign for this owner; ``said`` is the owner's own answer, which changes only Clip Factory.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta
from typing import Any

from .. import db
from ..clock import iso, parse
from ..errors import ApiError, bad_request, not_found
from ..log import log
from ..oauth import setup as oauth_setup
from ..stats import STATS_ORDER
from . import config, connection, gates, ids, links, public, rules
from .deps import CrDeps
from .mcp import CrError
from .util import Loaded, changes, obj

Item = dict[str, Any]
PLATFORMS = frozenset(STATS_ORDER)
WAITING = ("not_joined", "apply_first", "waiting", "left")
STORED = (
    "campaignId",
    "url",
    "name",
    "brand",
    "access",
    "state",
    "membership",
    "inSince",
    "waitingSince",
    "said",
    "canSayInBy",
    "pay",
    "budget",
    "platformsPaid",
    "rulesState",
    "rules",
    "plainRules",
    "uncertain",
    "rulesAt",
    "logo",
    "sourceVideos",
    "anyway",
    "celebrate",
    "checkedAt",
    "nextCheckAt",
    "addedAt",
)
DOWN = "Content Rewards didn't answer. Try again in a minute."
GONE = "That campaign is gone from Content Rewards. Pick another one."
UNKNOWN = "Add the campaign again."
GROUP = "This link is a group of campaigns. Tap the one you want."


def platform_down(message: str = DOWN, retry_after: int | None = None) -> ApiError:
    extra = {"retryAfter": retry_after} if retry_after else None
    return ApiError(503, "platform_down", message, extra=extra)


def key(user_id: str, uuid: str) -> tuple[str, str]:
    return db.user_pk(user_id), db.campaign_sk(uuid)


def get(store: db.Store, user_id: str, uuid: str) -> Item | None:
    """The item as read (``Loaded``: ``save`` then writes only what this request changed)."""
    if not links.UUID.match(uuid or ""):
        return None
    found = store.get(*key(user_id, uuid.lower()))
    return Loaded(found) if found is not None else None


def get_or_404(store: db.Store, user_id: str, uuid: str) -> Item:
    found = get(store, user_id, uuid)
    if found is None:
        raise not_found(UNKNOWN)
    return found


def all_for(store: db.Store, user_id: str) -> list[Item]:
    rows = store.query_all(db.user_pk(user_id), db.CAMPAIGN_PREFIX, consistent=True)
    return [Loaded(r) for r in rows if r.get("type") == "campaign"]


# The campaign's ``type`` (cpm, per_post, pool, retainer, other) is stored as ``campaignType``: the table's own ``type``
# attribute names the item kind ("campaign"). It is served as ``Campaign.type`` (§38.8), unchanged.

# --- pay, budget and state from CR's own fields ------------------------------------------------------------------


def _cents(value: Any) -> int | None:
    if isinstance(value, Mapping):
        if str(value.get("currency") or "usd").lower() != "usd":
            log("warning", "cr.other_currency")
            return None
        value = value.get("value")
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def pay_from_listed(row: Mapping[str, Any]) -> tuple[list[Item], list[str]]:
    kind = str(row.get("type") or "")
    out: list[Item] = []
    for p in row.get("platforms") or []:
        if not isinstance(p, Mapping) or p.get("platform") not in PLATFORMS:
            continue
        rate = _cents(p.get("rate"))
        entry: Item = {
            "platform": p["platform"],
            "per1kCents": rate if kind == "cpm" else None,
            "perPostCents": rate if kind == "per_post" else None,
            "minPayoutCents": _cents(p.get("min_payout")),
            "maxPayoutCents": _cents(p.get("max_payout")),
            "minViews": p.get("min_views") if isinstance(p.get("min_views"), int) else None,
        }
        geo = p.get("country_rates")
        if isinstance(geo, Mapping):
            groups = []
            for g in geo.get("groups") or []:
                if isinstance(g, Mapping) and _cents(g.get("rate")) is not None:
                    groups.append(
                        {
                            "name": str(g.get("name") or "")[:60],
                            "per1kCents": _cents(g.get("rate")),
                            "countries": [str(c) for c in g.get("countries") or []][:60],
                        }
                    )
            entry["countryRates"] = groups
            entry["otherCountriesPer1kCents"] = _cents(geo.get("other_countries"))
            entry["unknownCountryPer1kCents"] = _cents(geo.get("unknown_country"))
        out.append(entry)
    out.sort(key=lambda e: STATS_ORDER.index(e["platform"]))
    return out, [e["platform"] for e in out]


def _geo_public(cfg: Mapping[str, Any], platform: str) -> Item | None:
    """``configuration.geoRates`` ``{tiers: [{label, countries, platform, rate}], restOfWorld: [{platform, rate}]}``
    for one platform, as ``CrPay``'s country fields (the public JSON names no unknown-country rate)."""
    geo = obj(cfg.get("geoRates"))
    tiers = [
        {
            "name": str(t.get("label") or "")[:60],
            "per1kCents": _cents(t.get("rate")),
            "countries": [str(c) for c in t.get("countries") or []][:60],
        }
        for t in geo.get("tiers") or []
        if isinstance(t, Mapping) and t.get("platform") == platform and _cents(t.get("rate")) is not None
    ]
    rest = next(
        (
            _cents(r.get("rate"))
            for r in geo.get("restOfWorld") or []
            if isinstance(r, Mapping) and r.get("platform") == platform
        ),
        None,
    )
    if not tiers and rest is None:
        return None
    return {"countryRates": tiers, "otherCountriesPer1kCents": rest, "unknownCountryPer1kCents": None}


def pay_from_public(pub: Mapping[str, Any]) -> tuple[list[Item], list[str]]:
    cfg = obj(pub.get("configuration"))
    kind = str(pub.get("type") or "")
    min_views = cfg.get("minClipViews") if isinstance(cfg.get("minClipViews"), int) else None
    out: list[Item] = []
    for p in cfg.get("payoutModel") or []:
        if not isinstance(p, Mapping) or p.get("platform") not in PLATFORMS:
            continue
        rate = _cents(p.get("rate"))
        entry: Item = {
            "platform": p["platform"],
            "per1kCents": rate if kind in {"cpm", ""} else None,
            "perPostCents": rate if kind == "per_post" else None,
            "minPayoutCents": _cents(p.get("minPayout")),
            "maxPayoutCents": _cents(p.get("maxPayout")),
            "minViews": min_views,
        }
        geo = _geo_public(cfg, str(p["platform"]))
        if geo is not None:
            entry.update(geo)
        out.append(entry)
    if not out and pub.get("og") and isinstance(pub.get("ogRateCents"), int):
        out.append(
            {
                "platform": "youtube",
                "per1kCents": pub["ogRateCents"],
                "perPostCents": None,
                "minPayoutCents": None,
                "maxPayoutCents": pub.get("ogMaxCents") if isinstance(pub.get("ogMaxCents"), int) else None,
                "minViews": None,
            }
        )
        return out, []  # the Open Graph line does not say which places pay
    out.sort(key=lambda e: STATS_ORDER.index(e["platform"]))
    return out, [e["platform"] for e in out]


def budget_from_public(pub: Mapping[str, Any], at: str) -> Item:
    cfg = obj(pub.get("configuration"))
    total = cfg.get("budget") if isinstance(cfg.get("budget"), int) else None
    metrics = obj(pub.get("metrics"))
    spent = metrics.get("budgetSpentCents") if isinstance(metrics.get("budgetSpentCents"), int) else None
    left = pub.get("ogLeftCents") if isinstance(pub.get("ogLeftCents"), int) else None
    if total is not None and spent is not None:
        left = max(0, total - spent)
    used = round(100 * spent / total, 1) if total and spent is not None else None
    return {"totalCents": total, "spentCents": spent, "leftCents": left, "usedPct": used, "asOf": at}


def state_from(status: Any) -> str:
    return {
        "active": "active",
        "paused": "paused",
        "archived": "ended",
        "ended": "ended",
        "completed": "ended",
        "draft": "scheduled",
        "scheduled": "scheduled",
    }.get(str(status or "").lower(), "unknown")


def campaign_type(value: Any) -> str:
    return value if value in {"cpm", "per_post", "pool", "retainer"} else "other"


def apply_public(item: Item, pub: Mapping[str, Any], now: datetime) -> Item:
    at = iso(now)
    stored = obj(item.get("public"))
    if pub.get("og") and stored and not stored.get("og"):
        # Only the page's Open Graph line answered: keep the full copy (CR's toggles, organization and access) and
        # fill only what is missing. ``publicAt`` stays, so the next owner action reads the JSON again.
        if not item.get("name"):
            item["name"] = str(pub.get("name") or "Campaign")[:200]
        if not item.get("pay"):
            item["pay"] = pay_from_public(pub)[0]
        budget = obj(item.get("budget"))
        if budget.get("leftCents") is None and isinstance(pub.get("ogLeftCents"), int):
            item["budget"] = {**budget, "leftCents": pub["ogLeftCents"], "asOf": at}
        return item
    org = obj(pub.get("organization"))
    item["public"] = dict(pub)
    item["publicAt"] = at
    item["name"] = str(pub.get("name") or item.get("name") or "Campaign")[:200]
    if org.get("name"):
        item["brand"] = str(org["name"])[:200]
    item.setdefault("brand", "")
    if not item.get("listed"):  # the listed campaign wins for status, pay and platforms
        if isinstance(pub.get("requiresApplication"), bool):
            item["access"] = "application" if pub["requiresApplication"] else "open"
        item["campaignType"] = campaign_type(pub.get("type") or ("cpm" if pub.get("og") else None))
        if pub.get("status") is not None:
            item["state"] = state_from(pub.get("status"))
        pay, paid = pay_from_public(pub)
        if pay:
            item["pay"] = pay
        if paid:
            item["platformsPaid"] = paid
    item["budget"] = budget_from_public(pub, at)
    reason = str(pub.get("statusReason") or "").lower()
    item["budgetGone"] = "budget" in reason and ("exhaust" in reason or "ran out" in reason or "depleted" in reason)
    item.setdefault("access", "open")
    item.setdefault("campaignType", "other")
    item.setdefault("state", "unknown")
    item.setdefault("pay", [])
    item.setdefault("platformsPaid", [])
    return item


def brief_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:32]


def apply_listed(item: Item, row: Mapping[str, Any], how: str) -> Item:
    item["listed"] = True
    item["crId"] = str(row.get("id") or "") if how != "ambiguous" else None
    if item["crId"] is None:
        item.pop("crId")
    item["idMatch"] = how
    item["name"] = str(row.get("name") or item.get("name") or "Campaign")[:200]
    if row.get("access") in {"open", "application"}:
        item["access"] = row["access"]
    item["campaignType"] = campaign_type(row.get("type"))
    item["state"] = state_from(row.get("status"))
    if isinstance(row.get("platforms"), list):  # null on a brand account's campaigns: unknown, the public copy stays
        item["pay"], item["platformsPaid"] = pay_from_listed(row)
    description = row.get("description")
    if isinstance(description, str) and description.strip():
        item["brief"] = description[: config.MAX_BRIEF]
    return item


# --- membership --------------------------------------------------------------------------------------------------


def cached_list(deps: CrDeps, user_id: str) -> tuple[list[Item], bool] | None:
    """The list read in the last 2 minutes by this container, else None."""
    cached = deps._lists.get(user_id)
    if cached and deps.monotonic() - cached[0] < config.LIST_CACHE.total_seconds():
        return list(cached[1]), cached[2]
    return None


def list_campaigns(deps: CrDeps, user_id: str, *, fresh: bool = False) -> tuple[list[Item], bool]:
    """``list_my_campaigns`` (active + paused) to the end (≤ 20 pages), cached 2 minutes per container."""
    cached = None if fresh else cached_list(deps, user_id)
    if cached is not None:
        return cached
    rows, complete = deps.mcp(user_id).list_all(
        "list_my_campaigns", {"status": ["active", "paused"]}, config.CAMPAIGN_PAGES
    )
    deps._lists[user_id] = (deps.monotonic(), rows, complete)
    return rows, complete


def _next_check(item: Mapping[str, Any], now: datetime) -> str | None:
    membership = item.get("membership")
    if membership in ("in", "manual"):
        return iso(now + config.SLOW_EVERY)
    if membership in WAITING or (membership == "unknown" and item.get("firstCheckFailedAt")):
        since = parse(item.get("waitingSince") if membership in WAITING else item.get("firstCheckFailedAt")) or now
        if now - since < config.FAST_FOR:
            return iso(now + config.TICK)
        if now - since < config.STOP_AFTER:
            return iso(now + config.SLOW_EVERY)
    return None


def settle_membership(  # noqa: PLR0915 (the membership table of §38.4, one place)
    item: Item, conn: Mapping[str, Any], listed: Iterable[Mapping[str, Any]] | None, complete: bool, now: datetime
) -> Item:
    """Sets ``membership`` (and ``inSince``, ``waitingSince``, ``celebrate``, ``nextCheckAt``) from CR's list (None
    when it could not be read) and the owner's ``said``."""
    before = item.get("membership")
    said = item.get("said")
    row: Mapping[str, Any] | None = None
    how = "none"
    if listed is not None:
        row, how = ids.match_campaign(
            listed,
            str(item["campaignId"]),
            item.get("public") if isinstance(item.get("public"), Mapping) else None,
            use_typeid=conn.get("typeidVerified") is not False,
            org_matches=conn.get("orgMatched") is not False,
        )
    if how == "ambiguous":
        if item.get("idMatch") != "ambiguous":
            log("warning", "cr.match_ambiguous")
        item["idMatch"] = "ambiguous"
        item.pop("crId", None)
    looking = connection.signed_in(conn) and not conn.get("blocked")
    if row is not None:
        apply_listed(item, row, how)
        item["lastListedAt"] = iso(now)
        new = "in"
    elif how == "ambiguous":
        new = "in"
    elif said == "not_eligible":
        new = "not_accepted"
    elif listed is None or not looking:
        if said == "joined_by_hand":
            new = "manual"
        elif before in ("in", "manual", "not_accepted"):
            new = str(before) if before != "in" else ("manual" if said == "joined_by_hand" else "in")
        elif looking and before in WAITING:
            new = str(before)  # connected, but CR didn't answer this time: what we knew stays, and so do its checks
        else:
            new = "unknown"
    elif said == "joined_by_hand":
        new = "manual"
    elif item.get("lastListedAt") and complete:
        new = "left"
    elif item.get("lastListedAt") and not complete:
        new = str(before or "unknown")  # a capped list makes nothing "left"
    elif item.get("access") == "application":
        new = "waiting" if said == "applied" else "apply_first"
    else:
        new = "not_joined"
    if new == "in" and before not in ("in",):
        item["inSince"] = iso(now)
        if before == "manual":
            item["autoSince"] = iso(now)
        else:
            item["celebrate"] = "in"
    if new in WAITING and before not in WAITING:
        item["waitingSince"] = iso(now)
    if new == "not_joined" and not item.get("canSayInBy") and listed is not None:
        added = parse(item.get("addedAt")) or now
        if now > added:
            item["canSayInBy"] = iso(max(now, added + config.SAY_NOT_JOINED_AFTER))
    item["membership"] = new
    item["checkedAt"] = iso(now)
    if listed is not None or not looking or new != "unknown":
        item.pop("firstCheckFailedAt", None)
    else:
        item.setdefault("firstCheckFailedAt", iso(now))  # connected but CR didn't answer: the next tick looks again
    found = _next_check(item, now)
    if found:
        item["nextCheckAt"] = found
    else:
        item.pop("nextCheckAt", None)
    return item


def verify_typeid(deps: CrDeps, user_id: str, conn: Mapping[str, Any], item: Mapping[str, Any], now: datetime) -> None:
    """The first match after Connect tells whether CR's ids are the TypeID of the page's UUID: logged once and kept
    as ``CRCONN.typeidVerified`` (after a mismatch only the name rules are used)."""
    if "typeidVerified" in conn or item.get("idMatch") not in ("typeid", "name"):
        return
    verified = item.get("idMatch") == "typeid"
    log("info", "cr.typeid_verified" if verified else "cr.typeid_mismatch")
    try:
        connection.update(deps.store, user_id, now, {"typeidVerified": verified})
    except db.ConditionFailed:
        return
    if isinstance(conn, dict):
        conn["typeidVerified"] = verified


def needs_read(item: Mapping[str, Any]) -> bool:
    """A rules read is due: the brief (or the pasted rules) changed since the last read."""
    if item.get("rulesState") == "reading":
        return False
    text = rules.read_input(item)
    if not text.strip():
        return False
    if item.get("membership") not in ("in", "manual") and item.get("access") == "open" and not item.get("pastedRules"):
        return False  # open campaigns hide their rules until you join
    return item.get("briefHash") != brief_hash(text)


def retry_read(item: Mapping[str, Any], now: datetime) -> bool:
    """A read that failed (or is stuck ``reading`` past 3 minutes) is tried again on the owner's Check now or a job
    start, when there is text to read and the rules are not hidden (an open campaign before joining)."""
    state = item.get("rulesState")
    started = parse(item.get("readStartedAt"))
    stuck = state == "reading" and (started is None or now - started > config.READ_STALE)
    if state != "failed" and not stuck:
        return False
    if not (rules.brief_text(item) + str(item.get("pastedRules") or "")).strip():
        return False
    hidden = item.get("membership") not in ("in", "manual") and item.get("access") == "open"
    return not hidden or bool(item.get("pastedRules"))


def start_read(deps: CrDeps, user_id: str, item: Item, now: datetime) -> Item:
    """Marks the item ``reading`` and starts ``cf-prod-campaigns`` ``read`` (async). The caller writes the item."""
    item["briefHash"] = brief_hash(rules.read_input(item))
    item["rulesState"] = "reading"
    item["readStartedAt"] = iso(now)
    item["readPending"] = True
    return item


def kick_read(deps: CrDeps, user_id: str, item: Mapping[str, Any]) -> None:
    """After the item is written: invoke the rules read (a failed invoke marks the read failed)."""
    if not item.get("readPending"):
        return
    try:
        if deps.invoker is None:
            raise RuntimeError("no invoker")
        deps.invoker.read_campaign(user_id, str(item["campaignId"]))
    except Exception as e:
        log("warning", "cr.read_invoke_failed", error=type(e).__name__)
        try:
            deps.store.update(*key(user_id, str(item["campaignId"])), {"rulesState": "failed"}, remove=["readPending"])
        except db.ConditionFailed:
            return
        return
    try:
        deps.store.update(*key(user_id, str(item["campaignId"])), {}, remove=["readPending"])
    except db.ConditionFailed:
        return


def initial_rules_state(item: Mapping[str, Any]) -> str:
    if item.get("rulesState") in ("ready", "failed", "reading"):
        return str(item["rulesState"])
    return "waiting_for_join"


def save(deps: CrDeps, user_id: str, item: Item) -> Item:
    """Writes the item and starts a pending rules read. An item read from the table (``Loaded``) is written as an
    UpdateItem of only what this caller changed, so a write made meanwhile (a rules read or logo by
    ``cf-prod-campaigns``, a cleared hold, a seen celebration, the owner's answer) is never undone; a removed
    campaign is not brought back. A new item is put whole."""
    before = getattr(item, "before", None)
    if before is None:
        item = {k: v for k, v in item.items() if v is not None}
        deps.store.put(item)
        kick_read(deps, user_id, item)
        return item
    sets, remove = changes(before, item)
    if not sets and not remove:
        return item
    try:
        saved: Item = Loaded(deps.store.update(str(item["pk"]), str(item["sk"]), sets, remove=remove))
    except db.ConditionFailed:
        log("info", "cr.campaign_gone_meanwhile")
        return item
    if saved.get("readPending") and ("readPending" in sets or "readStartedAt" in sets):
        kick_read(deps, user_id, saved)  # only a read this request started (a stale flag never blocks a new one)
    return saved


def check_membership(
    deps: CrDeps, user_id: str, item: Item, conn: Mapping[str, Any], now: datetime, *, fresh: bool = True
) -> Item:
    """Membership and status now (CR's list when signed in); a changed brief starts a rules read."""
    listed: list[Item] | None = None
    complete = False
    if connection.signed_in(conn) and not conn.get("blocked"):
        try:
            listed, complete = list_campaigns(deps, user_id, fresh=fresh)
        except CrError as e:
            log("info", "cr.list_failed", code=e.code)
            listed = None
    settle_membership(item, conn, listed, complete, now)
    if listed is not None:
        verify_typeid(deps, user_id, conn, item, now)
    if needs_read(item):
        start_read(deps, user_id, item, now)
    return item


# --- adding --------------------------------------------------------------------------------------------------------


def add(deps: CrDeps, user_id: str, url: str, now: datetime) -> tuple[int, Item]:
    parsed = links.parse_campaign_url(url)
    if parsed.kind == "refused":
        raise bad_request(str(parsed.text), "url")
    if parsed.kind == "none" or not parsed.uuid:
        raise bad_request(links.NOT_CAMPAIGN, "url")
    if parsed.kind == "group":
        try:
            group = public.read_group(deps.net, parsed.uuid, monotonic=deps.monotonic)
        except public.PublicDown as e:
            raise platform_down() from e
        choices = []
        for c in group["choices"]:
            pay = None
            if isinstance(c.get("payouts"), list):
                pay, _ = pay_from_public(
                    {
                        "configuration": {
                            "payoutModel": [
                                {
                                    "platform": p.get("platform"),
                                    "rate": p.get("rateCents"),
                                    "minPayout": p.get("minPayoutCents"),
                                    "maxPayout": p.get("maxPayoutCents"),
                                }
                                for p in c["payouts"]
                                if isinstance(p, Mapping)
                            ]
                        }
                    }
                )
            choices.append(
                {
                    "campaignId": c["uuid"],
                    "url": links.campaign_url(c["uuid"]),
                    "name": c["name"],
                    "brand": c.get("brand"),
                    "access": c.get("access"),
                    "pay": pay,
                }
            )
        return 200, {"group": {"name": group["name"], "choices": choices}}
    uuid = parsed.uuid
    existing = get(deps.store, user_id, uuid)
    conn = connection.load(deps.store, user_id)
    item: Item = existing or {
        "pk": db.user_pk(user_id),
        "sk": db.campaign_sk(uuid),
        "type": "campaign",
        "userId": user_id,
        "campaignId": uuid,
        "url": links.campaign_url(uuid),
        "addedAt": iso(now),
        "membership": "unknown",
        "rulesState": "waiting_for_join",
        "rules": None,
        "plainRules": [],
        "uncertain": [],
        "logo": {"needed": False, "state": "none"},
        "sourceVideos": [],
        "anyway": [],
    }
    try:
        pub = public.read(deps.net, uuid, monotonic=deps.monotonic)
        apply_public(item, pub, now)
    except public.PublicGone as e:
        if existing is None:
            raise ApiError(404, "not_found", GONE) from e
        item["state"] = "ended"
    except public.PublicDown as e:
        if existing is None:
            raise platform_down() from e
    check_membership(deps, user_id, item, conn, now)
    if item.get("rulesState") not in ("reading", "ready", "failed"):
        item["rulesState"] = initial_rules_state(item)
    waiting = item.get("rulesState") == "waiting_for_join"
    if existing is None and item.get("access") == "application" and waiting and rules.brief_text(item).strip():
        start_read(deps, user_id, item, now)  # an application campaign shows its requirements publicly
    saved = save(deps, user_id, item)
    _own(deps.store, user_id, now)
    log(
        "info", "cr.campaign_added" if existing is None else "cr.campaign_rechecked", membership=saved.get("membership")
    )
    return (201 if existing is None else 200), saved


def _own(store: db.Store, user_id: str, now: datetime) -> None:
    """``CROWNERS/USER#{id}``: the poller's list (on Connect and on the first campaign add)."""
    try:
        store.put(
            {"pk": db.CROWNERS_PK, "sk": db.user_pk(user_id), "type": "crowner", "userId": user_id, "since": iso(now)},
            if_absent=True,
        )
    except db.ConditionFailed:
        return


def own(store: db.Store, user_id: str, now: datetime) -> None:
    _own(store, user_id, now)


def refresh_public(deps: CrDeps, user_id: str, item: Item, now: datetime, *, max_age: timedelta) -> Item:
    """Re-reads the public preview when it is older than ``max_age`` (an owner action); CR down keeps the copy."""
    at = parse(item.get("publicAt"))
    if at is not None and now - at < max_age:
        return item
    try:
        apply_public(item, public.read(deps.net, str(item["campaignId"]), monotonic=deps.monotonic), now)
    except public.PublicGone:
        item["state"] = "ended"
    except public.PublicDown:
        return item
    return item


# --- the public shape ----------------------------------------------------------------------------------------------


def clip_counts(subs: Iterable[Mapping[str, Any]]) -> Item:
    counts = {"approved": 0, "waiting": 0, "notApproved": 0}
    for s in subs:
        state = s.get("state")
        if state == "approved":
            counts["approved"] += 1
        elif state == "rejected":
            counts["notApproved"] += 1
        elif state in ("sending", "sent", "sent_by_hand", "send_by_hand", "waiting_for_post"):
            counts["waiting"] += 1
    return counts


def subs_by_campaign(store: db.Store, user_id: str) -> dict[str, list[Item]]:
    out: dict[str, list[Item]] = {}
    for s in store.query_all(db.user_pk(user_id), db.CRSUB_PREFIX):
        if s.get("type") == "crsub":
            out.setdefault(str(s.get("campaignId")), []).append(s)
    return out


class View:
    """What serving campaigns needs once per request: CRCONN, the setups, the follows and the submissions."""

    def __init__(self, deps: CrDeps, user_id: str, now: datetime) -> None:
        self.deps = deps
        self.user_id = user_id
        self.now = now
        self.conn = connection.load(deps.store, user_id)
        self.setups = oauth_setup.all_setups(deps.store, user_id, now)
        self.follows = [f for f in deps.store.query_all(db.user_pk(user_id), "FOLLOW#") if f.get("type") == "follow"]
        self.subs = subs_by_campaign(deps.store, user_id)

    def places(self, item: Mapping[str, Any]) -> list[str]:
        return gates.upload_places(item.get("platformsPaid") or [], self.setups, connection.crlinked(self.conn))

    def full(self, item: Mapping[str, Any]) -> Item:
        return public_campaign(self, item)

    def summary(self, item: Mapping[str, Any]) -> Item:
        full = public_campaign(self, item)
        out: Item = {
            k: full[k]
            for k in (
                "campaignId",
                "name",
                "brand",
                "state",
                "membership",
                "uploadPlaces",
                "waitingClips",
                "clipCounts",
                "checkedAt",
            )
            if k in full
        }
        for k in ("brandPictureUrl", "celebrate"):
            if k in full:
                out[k] = full[k]
        out["chip"] = full["nextStep"]["chip"]
        out["nextStepText"] = full["nextStep"]["text"]
        out["hardStops"] = sum(1 for s in full["stops"] if s["hard"])
        return out


def _places_note(view: View, item: Mapping[str, Any], places: list[str]) -> str | None:
    paid = [str(p) for p in item.get("platformsPaid") or []]
    linked = connection.crlinked(view.conn)
    refused = [p for p in STATS_ORDER if p in paid and linked.get(p) is False]
    if refused:
        return f"Link {gates.LABELS.get(refused[0], refused[0])} inside Content Rewards first."
    if gates.tiktok_waits(paid, view.setups):
        return (
            "TikTok is left out for now. Until TikTok checks Clip Factory, TikTok posts are private, and private posts "
            "can't earn."
        )
    return None


def public_campaign(view: View, item: Mapping[str, Any]) -> Item:
    now = view.now
    places = view.places(item)
    stop_list = gates.stops(item, view.conn, places, now)
    rules_now = item.get("rules") if isinstance(item.get("rules"), Mapping) else None
    out: Item = {k: item[k] for k in STORED if k in item and item[k] is not None}
    out.setdefault("name", "Campaign")
    out.setdefault("brand", "")
    out.setdefault("access", "open")
    out["type"] = str(item.get("campaignType") or "other")
    out.setdefault("state", "unknown")
    out.setdefault("membership", "unknown")
    out.setdefault("pay", [])
    out.setdefault("platformsPaid", [])
    out.setdefault("rulesState", "waiting_for_join")
    out["rules"] = dict(rules_now) if rules_now else None
    out["plainRules"] = (
        rules.plain_rules(rules_now, str(item.get("brand") or ""), places or list(item.get("platformsPaid") or []))
        if rules_now
        else []
    )
    out["thingsYouDo"] = rules.things_you_do(rules_now)
    out["uncertain"] = list((rules_now or {}).get("uncertain") or item.get("uncertain") or [])
    budget = obj(item.get("budget"))
    out["budget"] = {
        "totalCents": budget.get("totalCents"),
        "spentCents": budget.get("spentCents"),
        "leftCents": budget.get("leftCents"),
        "usedPct": budget.get("usedPct"),
        **({"asOf": budget["asOf"]} if budget.get("asOf") else {}),
    }
    logo = obj(item.get("logo"))
    shown_logo: Item = {"needed": gates.logo_needed(item), "state": str(logo.get("state") or "none")}
    if logo.get("state") == "ready" and item.get("logoKey") and view.deps.media is not None:
        shown_logo["url"] = view.deps.media.presign_get(str(item["logoKey"]), 3600)
    if logo.get("error"):
        shown_logo["error"] = logo["error"]
    out["logo"] = shown_logo
    if item.get("brandKey") and view.deps.media is not None:
        out["brandPictureUrl"] = view.deps.media.presign_get(str(item["brandKey"]), 3600)
    source = list((rules_now or {}).get("sourceVideos") or [])
    out["sourceVideos"] = [
        {
            "url": v["url"],
            "kind": links.source_kind(v["url"]),
            "note": v.get("note"),
            "canMakeClips": links.source_kind(v["url"]) in links.CLIPPABLE,
        }
        for v in source
        if isinstance(v, Mapping) and isinstance(v.get("url"), str)
    ]
    channels = ((rules_now or {}).get("allowedSources") or {}).get("channels") or []
    out["channels"] = [
        {"name": str(c["name"]), "href": links.channel_href(str(c["name"]), c.get("url"), view.follows)}
        for c in channels
        if isinstance(c, Mapping) and c.get("name")
    ]
    out["uploadPlaces"] = places
    note = _places_note(view, item, places)
    if note:
        out["placesNote"] = note
    out["stops"] = stop_list
    out["anyway"] = [str(c) for c in item.get("anyway") or []]
    out["nextStep"] = gates.next_step(item, view.conn, stop_list, now)
    subs = view.subs.get(str(item.get("campaignId")), [])
    out["clipCounts"] = clip_counts(subs)
    pending = [s for s in subs if s.get("crStatus") == "pending" and not s.get("removed")]
    out["waitingClips"] = len(pending) if connection.signed_in(view.conn) else None
    out.setdefault("checkedAt", item.get("addedAt") or iso(now))
    out.setdefault("addedAt", iso(now))
    out["url"] = links.campaign_url(str(item.get("campaignId")))
    return out


def snapshot(item: Mapping[str, Any], places: list[str], now: datetime) -> Item:
    """``JobCampaign``: the rules a job follows (internal, never returned)."""
    rules_now = obj(item.get("rules")) or rules.empty()
    out: Item = {
        "campaignId": str(item["campaignId"]),
        "name": str(item.get("name") or "Campaign"),
        "brand": str(item.get("brand") or ""),
        "platformsPaid": [str(p) for p in item.get("platformsPaid") or []],
        "rules": json.loads(json.dumps(rules_now)),
        "plainRules": rules.plain_rules(rules_now, str(item.get("brand") or ""), places),
        "rulesVersion": int(item.get("rulesVersion") or 0),
        "at": iso(now),
    }
    if item.get("crId"):
        out["crId"] = str(item["crId"])
    return out
