"""One look of the campaign finder: ``cf-prod-campaigns`` action ``find`` (docs/CONTRACTS.md §41.2, §41.4, §41.5).

``run(deps, user_id, why, now)``: (1) ``why == "want"``: match that owner from the cache, nothing read; a scheduled
look with no owner whose ``CRFIND.want.on`` is true reads nothing at all ("Stop finding campaigns" stops the looks
too, §41.4) and only moves ``nextRunAt`` 6 hours on; (2) else decide whether this look reads (no backoff, the last
read at least 30 minutes old, fewer than 6 reading looks this UTC day) and take the lease in **one** conditional
UpdateItem that also writes, before any request, ``lastReadAt`` and ``readsToday`` (a reading look) and ``nextRunAt``
(``why: "schedule"``); a look that can't take it only matches its own owner; (3) read (``source.read``); (4) match
the owners (``userId``, or every ``CROWNERS`` owner whose ``CRFIND.want.on`` is true) and write only the look's
attributes of ``CRFIND`` (UpdateItem, never a create), with the notice on a scheduled look; (5) ``STATE``, the lease
cleared. It never raises.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from ... import db
from ...clock import iso, parse
from ...log import log
from ...oauth import setup as oauth_setup
from ...stats import STATS_ORDER
from .. import fetch, gates
from ..util import obj
from . import config, match, sitemap, source
from .sitemap import Entry
from .source import PK, STATE_SK

Item = dict[str, Any]
CRFIND_SK = "CRFIND"


def _day(now: datetime) -> str:
    return now.astimezone(UTC).strftime("%Y-%m-%d")


def _reads_today(state: Mapping[str, Any], now: datetime) -> int:
    reads = state.get("readsToday")
    if isinstance(reads, Mapping) and reads.get("day") == _day(now):
        return int(reads.get("n") or 0)
    return 0


def _robots_due(state: Mapping[str, Any], now: datetime) -> bool:
    last = source.robots_last(state)
    return last is None or now - last >= config.ROBOTS_EVERY


def may_read(state: Mapping[str, Any], now: datetime) -> bool:
    """A look may read when no backoff runs, the last read is at least 30 minutes old and fewer than 6 reading looks
    ran this UTC day (and, while robots.txt forbids the pages, only when its daily read is due)."""
    backoff = parse(state.get("backoffUntil"))
    last = parse(state.get("lastReadAt"))
    if backoff is not None and backoff > now:
        return False
    if last is not None and now - last < config.READ_GAP:
        return False
    if _reads_today(state, now) >= config.READS_PER_DAY:
        return False
    return not (state.get("sourceState") == "not_allowed" and not _robots_due(state, now))


def next_try(state: Mapping[str, Any], now: datetime) -> datetime:
    """When a scheduled look that could not read should run again: the first moment the reading rules allow, no
    sooner than the next tick."""
    times = [now + config.NEXT_TRY_MIN]
    backoff = parse(state.get("backoffUntil"))
    last = parse(state.get("lastReadAt"))
    if backoff is not None:
        times.append(backoff)
    if last is not None:
        times.append(last + config.READ_GAP)
    if _reads_today(state, now) >= config.READS_PER_DAY:
        midnight = datetime(now.year, now.month, now.day, tzinfo=UTC) + timedelta(days=1)
        times.append(midnight)
    if state.get("sourceState") == "not_allowed":
        last_robots = source.robots_last(state)
        if last_robots is not None:
            times.append(last_robots + config.ROBOTS_EVERY)
    return max(times)


def take_lease(store: db.Store, state: Mapping[str, Any], now: datetime, why: str, reading: bool) -> bool:
    """The one conditional UpdateItem before any request: ``runningUntil`` (+ ``lastReadAt``, ``readsToday`` for a
    reading look, ``nextRunAt`` for a scheduled one). False when another look holds it (or read meanwhile)."""
    names = {"#ru": "runningUntil"}
    values: Item = {":until": iso(now + config.LEASE), ":now": iso(now)}
    sets = ["#ru = :until"]
    condition = "(attribute_not_exists(#ru) OR #ru < :now)"
    if reading:
        names.update({"#lr": "lastReadAt", "#rt": "readsToday"})
        values[":reads"] = {"day": _day(now), "n": _reads_today(state, now) + 1}
        sets += ["#lr = :now", "#rt = :reads"]
        if isinstance(state.get("lastReadAt"), str):
            values[":seen"] = state["lastReadAt"]
            condition += " AND #lr = :seen"
        else:
            condition += " AND attribute_not_exists(#lr)"
    if why == "schedule":
        names["#nr"] = "nextRunAt"
        values[":next"] = iso(now + config.RUN_EVERY if reading else next_try(state, now))
        sets.append("#nr = :next")
    names["#ty"] = "type"
    values[":type"] = "crpublicstate"
    sets.append("#ty = :type")
    try:
        store.update_expr(PK, STATE_SK, "SET " + ", ".join(sets), condition=condition, names=names, values=values)
    except db.ConditionFailed:
        return False
    return True


def _clear_lease(store: db.Store, now: datetime) -> None:
    try:
        store.update_expr(
            PK,
            STATE_SK,
            "REMOVE #ru",
            condition="#ru = :mine",
            names={"#ru": "runningUntil"},
            values={":mine": iso(now + config.LEASE)},
        )
    except db.ConditionFailed:
        return


# --- the cache and the owners --------------------------------------------------------------------------------------


def cache_items(store: db.Store) -> dict[str, Item]:
    """Every ``CAMP#`` item (one Query), by uuid."""
    rows = store.query_all(PK, source.CAMP_PREFIX)
    return {str(r.get("uuid") or r["sk"][len(source.CAMP_PREFIX) :]): r for r in rows if r.get("type") == "crpublic"}


def counted(
    cache: Mapping[str, Mapping[str, Any]], entries: list[Entry] | None, sitemap_at: datetime | None, now: datetime
) -> list[Item]:
    """The ``ok`` cards that count for matching: in the latest sitemap (or read after it), or a group sibling the
    sitemap misses whose read is under 14 days old. With no sitemap known yet, every ``ok`` card counts. Each card
    carries its item's ``readAt`` (the "as of" of Content Rewards' numbers)."""
    listed = None if entries is None else {u for u, _ in entries}
    siblings = {str(g) for item in cache.values() for g in (item.get("card") or {}).get("groupIds") or []}
    out = []
    for uuid, item in cache.items():
        card = item.get("card")
        if item.get("state") != "ok" or not isinstance(card, Mapping):
            continue
        read_at = parse(item.get("readAt"))
        ok = (
            listed is None
            or uuid in listed
            or (sitemap_at is not None and read_at is not None and read_at > sitemap_at)
            or (uuid in siblings and read_at is not None and now - read_at < config.GROUP_KEEP)
        )
        if ok:
            out.append({**card, "readAt": item.get("readAt")})
    out.sort(key=lambda c: str(c.get("uuid")))
    return out


def chip_categories(cards: Iterable[Mapping[str, Any]]) -> list[Item]:
    """Up to 12 of Content Rewards' categories seen in the cache, most common first (``Finder.categories``)."""
    counts: dict[str, int] = {}
    names: dict[str, str] = {}
    for card in cards:
        if not card.get("onDiscover"):
            continue
        for c in card.get("categories") or []:
            if isinstance(c, Mapping) and isinstance(c.get("id"), str):
                counts[c["id"]] = counts.get(c["id"], 0) + 1
                names.setdefault(c["id"], str(c.get("name") or c["id"]))
    ranked = sorted(counts, key=lambda cid: (-counts[cid], names[cid].lower(), cid))
    return [{"id": cid, "name": names[cid], "count": counts[cid]} for cid in ranked[: config.MAX_CHIP_CATEGORIES]]


def owner_ids(store: db.Store, user_id: str | None) -> list[str]:
    if user_id:
        return [user_id]
    rows = store.query_all(db.CROWNERS_PK, "USER#")
    return [str(r.get("userId") or str(r["sk"]).removeprefix("USER#")) for r in rows]


def _finder(store: db.Store, user_id: str) -> Item | None:
    return store.get(db.user_pk(user_id), CRFIND_SK)


def _shown(previous: Any, matches: list[Item], at: str) -> dict[str, str]:
    """When each match was first shown. Past 300 entries the current matches always keep theirs (a dropped one would
    come back as "new"), then the newest of the rest."""
    shown = {str(k): str(v) for k, v in (previous or {}).items()} if isinstance(previous, Mapping) else {}
    for m in matches:
        shown.setdefault(m["campaignId"], at)
    if len(shown) > config.SHOWN_MAX:
        current = {m["campaignId"] for m in matches}
        keep = {k: v for k, v in shown.items() if k in current}
        rest = sorted((kv for kv in shown.items() if kv[0] not in current), key=lambda kv: kv[1], reverse=True)
        keep.update(rest[: max(0, config.SHOWN_MAX - len(keep))])
        shown = keep
    return shown


def notice(finder: Mapping[str, Any], matches: list[Item], shown: Mapping[str, str], now: datetime) -> Item | None:
    """§41.4 "When" (a scheduled look only): on and ``tellMe``, not the first look, the last notice at least 24 hours
    old, and at least one current match first shown after both the last notice and his last visit."""
    want = match.with_defaults(finder.get("want"))
    if not want["on"] or not want["tellMe"] or finder.get("matchedAt") is None:
        return None
    last_at = parse(obj(finder.get("notice")).get("at"))
    if last_at is not None and now - last_at < config.NOTICE_EVERY:
        return None
    floors = [t for t in (last_at, parse(finder.get("seenAt"))) if t is not None]
    floor = max(floors) if floors else None
    new = [
        m
        for m in matches
        if (first := parse(shown.get(m["campaignId"]))) is not None and (floor is None or first > floor)
    ]
    if not new:
        return None
    return {"key": f"{now.astimezone(UTC):%Y%m%d%H}:{len(new)}", "count": len(new), "at": iso(now)}


def match_owner(
    store: db.Store,
    user_id: str,
    finder: Mapping[str, Any],
    cards: list[Item],
    now: datetime,
    *,
    scheduled: bool,
    source_state: str,
    pending: int,
) -> bool:
    """Match one owner and write the look's attributes of his ``CRFIND`` (only if it exists). True when written."""
    want = match.with_defaults(finder.get("want"))
    if not want["on"]:
        return False
    setups = oauth_setup.all_setups(store, user_id, now)
    asked = list(STATS_ORDER) if want["places"] is None else [str(p) for p in want["places"]]
    places = gates.upload_places(asked, setups, {})
    own = [
        str(i.get("campaignId") or "").lower()
        for i in store.query_all(db.user_pk(user_id), db.CAMPAIGN_PREFIX)
        if i.get("type") == "campaign"
    ]
    hidden = [str(h) for h in finder.get("hidden") or []]
    result = match.find(
        cards,
        want,
        places=places,
        own=own,
        hidden=hidden,
        now=now,
        tiktok_waits=gates.tiktok_waits(["tiktok"], setups),
    )
    at = iso(now)
    shown = _shown(finder.get("shown"), result["matches"], at)
    sets: Item = {
        "matches": result["matches"],
        "matchedAt": at,
        "matchedWant": match.matched_want(want, places),
        "shown": shown,
        "skipped": result["skipped"],
        "looked": {"campaigns": result["looked"], "pending": pending},
        "categories": chip_categories(cards),
        "sourceState": source_state,
    }
    if scheduled:
        found = notice(finder, result["matches"], shown, now)
        if found is not None:
            sets["notice"] = found
    try:
        store.update(db.user_pk(user_id), CRFIND_SK, sets)
    except db.ConditionFailed:
        return False
    log("info", "finder.matched", matches=len(result["matches"]), looked=result["looked"], notice="notice" in sets)
    return True


def _match_all(
    store: db.Store,
    ids: list[str],
    cards: list[Item],
    now: datetime,
    *,
    scheduled: bool,
    source_state: str,
    pending: int,
) -> int:
    """Each owner's ``CRFIND`` is read right before his match (a change he made during the read wins)."""
    done = 0
    for uid in ids:
        try:
            finder = _finder(store, uid)
            if finder is None:
                continue
            if match_owner(
                store, uid, finder, cards, now, scheduled=scheduled, source_state=source_state, pending=pending
            ):
                done += 1
        except Exception as e:  # one owner's failure never stops the others
            log("error", "finder.owner_failed", error=type(e).__name__)
    return done


# --- the look -----------------------------------------------------------------------------------------------------


def source_state(prev: Any, look: source.Look | None, sitemap_at: datetime | None, now: datetime) -> str:
    """``CRPUBLIC/STATE.sourceState`` after a look (§41.2 Backoff)."""
    before = prev if prev in ("ok", "down", "blocked", "not_allowed", "unreadable") else "ok"
    stale = sitemap_at is not None and now - sitemap_at > config.DOWN_AFTER
    if look is None:
        return "down" if before == "ok" and stale else before
    if look.state is not None:
        return look.state
    if look.entries is not None:
        if before in ("blocked", "unreadable") and look.good == 0:
            return before
        return "ok"
    if sitemap_at is None or stale:
        return "down"
    return before if before != "not_allowed" else "ok"


def _pending(entries: list[Entry] | None, cache: Mapping[str, Mapping[str, Any]]) -> int:
    if entries is None:
        return 0
    return sum(1 for u, _ in entries if source.never_read(cache.get(u)))


def _anyone_on(store: db.Store, ids: list[str]) -> bool:
    """At least one of these owners has a ``CRFIND`` with ``want.on`` true."""
    for uid in ids:
        finder = _finder(store, uid)
        if finder is not None and match.with_defaults(finder.get("want"))["on"]:
            return True
    return False


def _idle(store: db.Store, now: datetime) -> bool:
    """Nobody is finding campaigns: no request, only ``nextRunAt = now + 6 h`` so the tick doesn't start it again
    every 15 minutes (one conditional UpdateItem; False when a look is running)."""
    try:
        store.update_expr(
            PK,
            STATE_SK,
            "SET #nr = :next, #ty = :type",
            condition="(attribute_not_exists(#ru) OR #ru < :now)",
            names={"#nr": "nextRunAt", "#ty": "type", "#ru": "runningUntil"},
            values={":next": iso(now + config.RUN_EVERY), ":type": "crpublicstate", ":now": iso(now)},
        )
    except db.ConditionFailed:
        return False
    return True


def _write_entries(store: db.Store, entries: list[Entry]) -> None:
    """``entriesGz`` (Binary). ``Store.update`` stores no bytes, so the one UpdateItem goes through ``transact``,
    which takes the request as built (an Update inside a transaction needs only ``dynamodb:UpdateItem``)."""
    request = db.update_request(PK, STATE_SK, {"type": "crpublicstate"})
    request["UpdateExpression"] += ", #gz = :gz"
    request["ExpressionAttributeNames"]["#gz"] = "entriesGz"
    request.setdefault("ExpressionAttributeValues", {})[":gz"] = sitemap.entries_gz(entries)
    store.transact(updates=[request])


def run(
    deps: Any,
    user_id: str | None,
    why: str,
    now: datetime,
    *,
    opener: fetch.Opener = fetch.https_open,
    resolver: fetch.Resolver | None = None,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> Item:
    """One look; ``deps`` is ``CampaignsDeps`` (its ``store`` and ``get``, nothing else). Never raises."""
    store: db.Store = deps.store
    try:
        state = store.get(PK, STATE_SK) or {}
        stored_entries = sitemap.entries_from_gz(state.get("entriesGz")) if state.get("entriesGz") else None
        sitemap_at = parse(state.get("sitemapAt"))
        if why == "want":
            cache = cache_items(store)
            cards = counted(cache, stored_entries, sitemap_at, now)
            done = _match_all(
                store,
                [user_id] if user_id else [],
                cards,
                now,
                scheduled=False,
                source_state=source_state(state.get("sourceState"), None, sitemap_at, now),
                pending=_pending(stored_entries, cache),
            )
            return {"action": "find", "outcome": "matched", "owners": done}
        if why == "schedule" and not _anyone_on(store, owner_ids(store, user_id)):
            outcome = "idle" if _idle(store, now) else "busy"
            log("info", f"finder.{outcome}")
            return {"action": "find", "outcome": outcome, "owners": 0}
        reading = may_read(state, now)
        leased = (reading or why == "schedule") and take_lease(store, state, now, why, reading)
        if not leased:
            reading = False
            if why == "schedule" and not user_id:
                log("info", "finder.busy")
                return {"action": "find", "outcome": "busy", "owners": 0}
        look: source.Look | None = None
        ids = owner_ids(store, user_id)
        if reading:
            finders = [_finder(store, uid) for uid in dict.fromkeys([*ids, *owner_ids(store, None)])]
            matched = [
                str(m.get("campaignId"))
                for f in finders
                if f is not None
                for m in f.get("matches") or []
                if isinstance(m, Mapping)
            ]
            look = source.read(
                store,
                state,
                cache_items(store),
                matched,
                now,
                get=deps.get,
                opener=opener,
                resolver=resolver,
                monotonic=monotonic,
                sleep=sleep,
            )
        entries = look.entries if look is not None and look.entries is not None else stored_entries
        if look is not None and look.entries is not None:
            sitemap_at = now
        cache = cache_items(store)
        after = store.get(PK, STATE_SK) or {}
        final = source_state(after.get("sourceState", state.get("sourceState")), look, sitemap_at, now)
        cards = counted(cache, entries, sitemap_at, now)
        done = _match_all(
            store,
            ids,
            cards,
            now,
            scheduled=why == "schedule",
            source_state=final,
            pending=_pending(entries, cache),
        )
        if leased:
            _finish(store, look, now, final, len(cache))
        outcome = "read" if look is not None else "matched"
        return {"action": "find", "outcome": outcome, "owners": done, "pages": look.pages if look else 0}
    except Exception as e:
        log("error", "finder.run_failed", error=type(e).__name__)
        return {"action": "find", "outcome": "failed"}


def _finish(store: db.Store, look: source.Look | None, now: datetime, final: str, cached: int) -> None:
    """(5) ``STATE``: what the look learned, then the lease cleared."""
    sets: Item = {"type": "crpublicstate", "sourceState": final, "cached": cached}
    if look is not None:
        sets["lastLookAt"] = iso(now)
        if look.robots_kept is not None:
            sets["robots"] = look.robots_kept
        elif look.robots_tried is not None:
            sets["robots"] = look.robots_tried
        if look.entries is not None:
            sets["sitemapAt"] = iso(now)
            if not look.throttled:
                sets["backoffLooks"] = 0
        if look.good > 0 and not look.blocked:
            sets["blockedLooks"] = 0
    names = {f"#f{i}": k for i, k in enumerate(sets)}
    values = {f":f{i}": v for i, v in enumerate(sets.values())}
    store.update_expr(
        PK, STATE_SK, "SET " + ", ".join(f"#f{i} = :f{i}" for i in range(len(sets))), names=names, values=values
    )
    if look is not None and look.entries is not None:
        try:
            _write_entries(store, look.entries)
        except Exception as e:
            log("error", "finder.entries_failed", error=type(e).__name__)
    _clear_lease(store, now)
