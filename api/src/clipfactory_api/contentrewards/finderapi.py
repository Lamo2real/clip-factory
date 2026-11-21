"""The campaign finder, api side (docs/CONTRACTS.md §41.5): the owner's ``CRFIND`` item, the ``Finder`` view, the
want checks and their defaults, the one-tap add, adopting a campaign he joined on Content Rewards, "Ask Content
Rewards" and the tick check.

Nothing here reads Content Rewards' pages. The look (``cf-prod-campaigns`` ``find``, §41.2) reads them, keeps the
shared cache under pk ``CRPUBLIC`` and writes its own attributes of ``CRFIND``; this module reads those by their
literal shapes and never imports the reader. The only calls to Content Rewards made here are the owner's own: §38.8's
add (one public read, on his tap), ``list_my_campaigns`` (signed in) and one ``send_feedback`` on his tap.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from .. import db
from ..clock import iso, parse
from ..errors import ApiError, bad_request, conflict, not_found
from ..log import log
from ..oauth import setup as oauth_setup
from ..stats import STATS_ORDER
from . import campaigns, config, connection, gates, ids, links
from .deps import CrDeps
from .mcp import CrError

Item = dict[str, Any]

SK = "CRFIND"
PUBLIC_PK = "CRPUBLIC"
STATE_SK = "STATE"
UNAVAILABLE = "Coming soon."

# §41.3: the defaults, chosen for him (the same literal as the reader's ``finder/config.py``; both are tested).
DEFAULT_WANT: dict[str, Any] = {
    "on": True,
    "minPer1kCents": 100,
    "places": None,
    "categories": [],
    "minLeftPct": 25,
    "access": "open",
    "otherPay": False,
    "languages": [],
    "tellMe": True,
}
MIN_PER_1K = (50, 100, 200, 300)
MIN_LEFT = (0, 25, 50, 75)
ACCESS = ("open", "any")
LANGUAGES = ("en", "es", "pt", "fr", "de", "it")
CATEGORY = re.compile(r"^[a-z0-9-]{1,40}$")
MAX_CATEGORIES = 12
SOURCE_STATES = ("down", "blocked", "not_allowed", "unreadable")
WHY = ("schedule", "start", "check_now", "want")

LOOKING_FOR = timedelta(minutes=10)
CHECK_EVERY = timedelta(minutes=30)
CHECKS_PER_DAY = 4
JOINED_EVERY = timedelta(seconds=30)
ADOPT_OPENED_FOR = timedelta(hours=48)
ADOPT_MAX = 5
PUB_FRESH = timedelta(hours=24)
ASK_EVERY = timedelta(days=30)
OPENED_MAX = 50
ADDED_MAX = 100
HIDDEN_MAX = 500
MATCHES_MAX = 20

PICK = "Pick one of the choices shown."
NOT_A_MATCH = "That campaign isn't in your matches any more. Tap Look again now."
START_FIRST = "Tap Find campaigns for me first."
STOPPED = "Tap Find campaigns again first."
CONNECT_FIRST = "Connect Content Rewards first."

# §41.5: one fixed feature request, no personal data, URL or token (shown under Show more "What it says", §38.1).
ASK_MESSAGE = (
    "Feature request from Clip Factory: creators ask for MCP tools to search Discover campaigns (filters for pay per "
    "1,000 views, platforms, category, budget left, open or application, language) and to join an open campaign, or "
    "start an application, with the creator's consent. Today Clip Factory reads only public campaign pages a few times "
    "a day, and the creator taps Join Campaign on Content Rewards."
)


def ask_args() -> Item:
    """``send_feedback``'s own fields (CR's ``mcp-tools.json``)."""
    return {
        "message": ASK_MESSAGE,
        "kind": "idea",
        "about_tool": "list_my_campaigns",
        "agent_name": config.AGENT_NAME,
        "agent_version": config.AGENT_VERSION,
    }


def enabled(env: Mapping[str, str] | None = None) -> bool:
    """``CR_FINDER=on`` (an unset value is off, §41.6)."""
    source = os.environ if env is None else env
    return str(source.get("CR_FINDER", "")).strip().lower() == "on"


def require() -> None:
    if not enabled():
        raise ApiError(503, "unavailable", UNAVAILABLE)


def key(user_id: str) -> tuple[str, str]:
    return db.user_pk(user_id), SK


def load(store: db.Store, user_id: str) -> Item | None:
    return store.get(*key(user_id))


def started(item: Mapping[str, Any] | None) -> bool:
    """His finder was started (the first ``want``). A ``CRFIND`` made only by "Ask Content Rewards" is not."""
    return item is not None and isinstance(item.get("want"), Mapping)


def _map(value: Any) -> dict[str, str]:
    return {str(k): str(v) for k, v in value.items() if isinstance(v, str)} if isinstance(value, Mapping) else {}


def _strings(value: Any) -> list[str]:
    return [str(v) for v in value if isinstance(v, str)] if isinstance(value, list | set | frozenset | tuple) else []


def _when(value: Any) -> datetime | None:
    """An ISO time, or epoch seconds (the reader's ``STATE`` times)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float | Decimal):
        return datetime.fromtimestamp(float(value), UTC)
    return parse(value)


# --- what he wants ---------------------------------------------------------------------------------------------------


def _norm(name: str, value: Any) -> Any:
    """The checked value of one ``FinderWant`` key; ``ValueError`` when it isn't one of the choices."""
    if name in ("on", "otherPay", "tellMe"):
        if not isinstance(value, bool):
            raise ValueError(name)
        return value
    if name in ("minPer1kCents", "minLeftPct"):
        choices = MIN_PER_1K if name == "minPer1kCents" else MIN_LEFT
        if isinstance(value, bool) or not isinstance(value, int) or value not in choices:
            raise ValueError(name)
        return value
    if name == "access":
        if value not in ACCESS:
            raise ValueError(name)
        return value
    if name == "places":
        if value is None:
            return None
        if not isinstance(value, list) or len(set(map(str, value))) != len(value):
            raise ValueError(name)
        if not all(isinstance(p, str) and p in STATS_ORDER for p in value):
            raise ValueError(name)
        return [p for p in STATS_ORDER if p in value]
    if name == "categories":
        if not isinstance(value, list) or len(value) > MAX_CATEGORIES or len(set(map(str, value))) != len(value):
            raise ValueError(name)
        if not all(isinstance(c, str) and CATEGORY.match(c) for c in value):
            raise ValueError(name)
        return list(value)
    if name == "languages":
        if not isinstance(value, list) or len(set(map(str, value))) != len(value):
            raise ValueError(name)
        if not all(isinstance(c, str) and c in LANGUAGES for c in value):
            raise ValueError(name)
        return list(value)
    raise ValueError(name)


def check_want(value: Any) -> Item:
    """A ``Partial<FinderWant>``, checked: only the nine keys, each one of the choices shown (400 with ``field``)."""
    if not isinstance(value, dict):
        raise bad_request(PICK, "want")
    out: Item = {}
    for name, found in value.items():
        if name not in DEFAULT_WANT:
            raise bad_request(PICK, str(name))
        try:
            out[name] = _norm(name, found)
        except ValueError as e:
            raise bad_request(PICK, name) from e
    return out


def full_want(stored: Any) -> Item:
    """The stored want with the defaults filled in (a value that is no longer a choice falls back to its default).
    DynamoDB drops a ``None`` inside a map, so a stored want without ``places`` means "the places you set up"."""
    out = json.loads(json.dumps(DEFAULT_WANT))
    if isinstance(stored, Mapping):
        for name in DEFAULT_WANT:
            if name in stored:
                try:
                    out[name] = _norm(name, stored[name])
                except ValueError:
                    continue
    return out  # type: ignore[no-any-return]


def want_places(want: Mapping[str, Any]) -> list[str]:
    places = want.get("places")
    return list(places) if isinstance(places, list) else list(STATS_ORDER)


def resolved_places(want: Mapping[str, Any], setups: Iterable[Mapping[str, Any]]) -> list[str]:
    """The places matching uses: his picks (or every place) that are ``ready`` on Set up posting, TikTok only once
    its posting audit passed, in STATS_ORDER (A's ``gates.upload_places``, so the chips and the matches agree)."""
    return gates.upload_places(want_places(want), list(setups), {})


def matched_want(want: Mapping[str, Any], places: list[str]) -> str:
    """The first 16 hex characters of SHA-256 over the canonical JSON (sorted keys, no spaces, UTF-8) of
    ``{"places": resolvedPlaces, "want": want with the defaults filled in}`` (the reader writes it, §41.5)."""
    text = json.dumps(
        {"places": list(places), "want": full_want(want)}, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


# --- the view ---------------------------------------------------------------------------------------------------------


def state_of(item: Mapping[str, Any] | None, reader: Mapping[str, Any], now: datetime) -> str:
    """``Finder.state``: ``new`` before the first want, ``off`` when he stopped it, ``looking`` while a look or a
    change is worked on (≤ 10 minutes), else the reader's ``sourceState`` (``down``, ``blocked``, ``not_allowed``,
    ``unreadable``) or ``ok``."""
    if item is None or not started(item):
        return "new"
    if not full_want(item.get("want"))["on"]:
        return "off"
    since, matched = parse(item.get("lookingSince")), parse(item.get("matchedAt"))
    if since is not None and now - since <= LOOKING_FOR and (matched is None or since > matched):
        return "looking"
    for source in (reader.get("sourceState"), item.get("sourceState")):
        if isinstance(source, str) and source:
            return source if source in SOURCE_STATES else "ok"
    return "ok"


def _is_new(shown_at: str | None, seen_at: datetime | None) -> bool:
    if seen_at is None:
        return True
    shown = parse(shown_at)
    return shown is not None and shown > seen_at


def shown_matches(item: Mapping[str, Any], own: Iterable[str]) -> list[Item]:
    """The stored matches minus the ones now hidden, added or already his, each with ``isNew`` and ``opened``."""
    if not started(item) or not full_want(item.get("want"))["on"]:
        return []
    drop = {*_strings(item.get("hidden")), *_map(item.get("added")), *(str(u).lower() for u in own)}
    opened, shown = _map(item.get("opened")), _map(item.get("shown"))
    seen_at = parse(item.get("seenAt"))
    out: list[Item] = []
    for found in item.get("matches") or []:
        uuid = str(found.get("campaignId") or "").lower() if isinstance(found, Mapping) else ""
        if not links.UUID.match(uuid) or uuid in drop:
            continue
        match = {k: v for k, v in found.items() if k not in ("isNew", "opened")}
        match["campaignId"] = uuid
        match["url"] = links.campaign_url(uuid)  # only a link Clip Factory made
        match["isNew"] = _is_new(shown.get(uuid), seen_at)
        if opened.get(uuid):
            match["opened"] = opened[uuid]
        out.append(match)
    return out[:MATCHES_MAX]


def next_allowed(check: Any, now: datetime) -> datetime | None:
    """When "Look again now" may run again (30 minutes apart, 4 a UTC day), or None when it may now."""
    check = check if isinstance(check, Mapping) else {}
    times: list[datetime] = []
    at = parse(check.get("at"))
    if at is not None:
        times.append(at + CHECK_EVERY)
    count = check.get("n") if isinstance(check.get("n"), int) else 0
    if check.get("day") == now.date().isoformat() and count >= CHECKS_PER_DAY:
        times.append(datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), UTC))
    found = max(times) if times else None
    return found if found is not None and found > now else None


def _looked(value: Any) -> Item:
    if isinstance(value, Mapping):
        campaigns_n, pending = value.get("campaigns"), value.get("pending")
        return {
            "campaigns": campaigns_n if isinstance(campaigns_n, int) else 0,
            "pending": pending if isinstance(pending, int) else 0,
        }
    return {"campaigns": value if isinstance(value, int) and not isinstance(value, bool) else 0, "pending": 0}


def _rows(value: Any, keys: tuple[str, ...], limit: int) -> list[Item]:
    if not isinstance(value, list):
        return []
    return [dict(r) for r in value if isinstance(r, Mapping) and all(k in r for k in keys)][:limit]


class Context:
    """What one finder answer reads: ``CRFIND``, ``CRPUBLIC/STATE``, the setups, ``CRCONN`` and his campaigns' uuids
    (items only, never Content Rewards)."""

    def __init__(self, deps: CrDeps, user_id: str, now: datetime) -> None:
        self.deps = deps
        self.user_id = user_id
        self.now = now
        self.item = load(deps.store, user_id)
        self.reader = deps.store.get(PUBLIC_PK, STATE_SK) or {}
        self.setups = oauth_setup.all_setups(deps.store, user_id, now)
        self.conn = connection.load(deps.store, user_id)
        self.own = {str(c.get("campaignId")) for c in campaigns.all_for(deps.store, user_id)}

    def reload(self) -> None:
        self.item = load(self.deps.store, self.user_id)

    @property
    def want(self) -> Item:
        return full_want((self.item or {}).get("want"))

    @property
    def places(self) -> list[str]:
        return resolved_places(self.want, self.setups)

    def view(self) -> Item:
        """``Finder`` (§41.5)."""
        item, now, want = self.item, self.now, self.want
        out: Item = {
            "state": state_of(item, self.reader, now),
            "want": want,
            "resolvedPlaces": self.places,
            "tiktokWaits": gates.tiktok_waits(want_places(want), self.setups),
            "matches": [],
            "newCount": 0,
            "hiddenCount": 0,
            "skipped": [],
            "looked": {"campaigns": 0, "pending": 0},
            "categories": [],
            "signedIn": gates.looking(self.conn),
        }
        if item is None:
            return out
        if item.get("askedAt"):
            out["askedAt"] = str(item["askedAt"])
        if not started(item):
            return out
        matches = shown_matches(item, self.own)
        out["matches"] = matches
        out["newCount"] = sum(1 for m in matches if m["isNew"])
        out["hiddenCount"] = len(_strings(item.get("hidden")))
        out["skipped"] = _rows(item.get("skipped"), ("code", "count", "text"), 20)
        out["looked"] = _looked(item.get("looked"))
        out["categories"] = _rows(item.get("categories"), ("id", "name"), MAX_CATEGORIES)
        if item.get("matchedAt"):
            looked_at = _when(self.reader.get("lastLookAt")) or parse(item.get("matchedAt"))
            if looked_at is not None:
                out["lastLookAt"] = iso(looked_at)
            out["asOf"] = str(item["matchedAt"])
        allowed = next_allowed(item.get("checkNow"), now)
        if allowed is not None:
            out["nextAllowedAt"] = iso(allowed)
        return out

    def stale(self) -> bool:
        """A place set up or TikTok's audit passed since the last match (``matchedWant`` differs) and no look is
        being worked on: GET starts a match-only look."""
        item = self.item
        if item is None or not started(item) or not self.want["on"]:
            return False
        if item.get("matchedWant") == matched_want(self.want, self.places):
            return False
        since = parse(item.get("lookingSince"))
        return since is None or self.now - since > LOOKING_FOR


def overview(store: db.Store, user_id: str, own: Iterable[str]) -> Item:
    """``CrOverview.finder`` (§41.5): what Home's chips and the entry card need, from ``CRFIND`` only."""
    item = load(store, user_id)
    if item is None or not started(item):
        return {"on": True, "started": False, "newCount": 0, "matches": 0}
    matches = shown_matches(item, own)
    return {
        "on": bool(full_want(item.get("want"))["on"]),
        "started": True,
        "newCount": sum(1 for m in matches if m["isNew"]),
        "matches": len(matches),
    }


# --- writes ----------------------------------------------------------------------------------------------------------


def start_look(deps: CrDeps, user_id: str, why: str, now: datetime, *, idle_only: bool = False) -> bool:
    """Sets ``lookingSince`` and invokes ``cf-prod-campaigns`` ``find`` for this owner (async). ``idle_only``: only
    when no look was started in the last 10 minutes. A failed invoke takes its ``lookingSince`` back."""
    pk, sk = key(user_id)
    condition = "attribute_exists(pk)"
    values: Item = {":now": iso(now)}
    if idle_only:
        condition += " AND (attribute_not_exists(#l) OR #l < :cutoff)"
        values[":cutoff"] = iso(now - LOOKING_FOR)
    try:
        deps.store.update_expr(
            pk, sk, "SET #l = :now", condition=condition, names={"#l": "lookingSince"}, values=values
        )
    except db.ConditionFailed:
        return False
    try:
        if deps.invoker is None:
            raise RuntimeError("no invoker")
        deps.invoker.find(user_id, why)
    except Exception as e:
        log("warning", "cr.finder_invoke_failed", why=why, error=type(e).__name__)
        with contextlib.suppress(db.ConditionFailed):
            deps.store.update(pk, sk, {}, remove=["lookingSince"], expect_in={"lookingSince": [iso(now)]})
        return False
    log("info", "cr.finder_look", why=why)
    return True


def _create(store: db.Store, user_id: str, want: Item, now: datetime) -> bool:
    """The first want: ``CRFIND`` with the full defaults merged (it may exist already, made by "Ask")."""
    pk, sk = key(user_id)
    try:
        store.update_expr(
            pk,
            sk,
            "SET #w = :want, #t = :type, #uid = :user, #c = if_not_exists(#c, :now), #u = :now",
            condition="attribute_not_exists(#w)",
            names={"#w": "want", "#t": "type", "#uid": "userId", "#c": "createdAt", "#u": "updatedAt"},
            values={":want": want, ":type": "crfind", ":user": user_id, ":now": iso(now)},
        )
    except db.ConditionFailed:
        return False
    return True


def _set_in_map(store: db.Store, user_id: str, name: str, uuid: str, now: datetime, *, cap: int) -> None:
    """``CRFIND.{name}[uuid] = now`` (a map of uuid → ISO), at most ``cap`` entries (the oldest dropped). One map key
    is set at a time, so two taps a moment apart never undo each other."""
    pk, sk = key(user_id)
    value = iso(now)
    for _ in range(3):
        item = store.get(pk, sk) or {}
        current = item.get(name) if isinstance(item.get(name), Mapping) else None
        try:
            if current is not None and uuid not in current and len(current) >= cap:
                kept = dict(sorted(_map(current).items(), key=lambda kv: kv[1])[-(cap - 1) :])
                kept[uuid] = value
                store.update(pk, sk, {name: kept, "updatedAt": iso(now)})
            elif current is None:
                store.update(pk, sk, {name: {uuid: value}, "updatedAt": iso(now)}, expect_absent=[name])
            else:
                store.update_expr(
                    pk,
                    sk,
                    "SET #m.#k = :v, #u = :now",
                    condition="attribute_exists(pk) AND attribute_exists(#m)",
                    names={"#m": name, "#k": uuid, "#u": "updatedAt"},
                    values={":v": value, ":now": iso(now)},
                )
            return
        except db.ConditionFailed:
            if not item:
                return  # no CRFIND: nothing to keep it on
            continue


def patch(deps: CrDeps, user_id: str, body: Mapping[str, Any], now: datetime) -> None:
    """``PATCH /v1/contentrewards/finder``: ``want`` (the first one creates ``CRFIND`` and starts the first look),
    ``seenAll`` and ``unhideAll``."""
    if not body:
        raise bad_request("Send want, seenAll or unhideAll.")
    for name in ("seenAll", "unhideAll"):
        if name in body and body[name] is not True:
            raise bad_request(f"{name} must be true.", name)
    part = check_want(body["want"]) if "want" in body else None
    store = deps.store
    pk, sk = key(user_id)
    item = load(store, user_id)
    why: str | None = None
    if part is not None:
        if not started(item) and _create(store, user_id, {**DEFAULT_WANT, **part}, now):
            campaigns.own(store, user_id, now)
            why = "start"
            log("info", "cr.finder_started")
        else:
            item = load(store, user_id) or {}
            old = full_want(item.get("want"))
            new = {**old, **part}
            if new != old:
                store.update(pk, sk, {"want": new, "updatedAt": iso(now)})
                why = "want" if new["on"] else None
        item = load(store, user_id)
    if item is None:
        return  # seenAll and unhideAll have nothing to change before the first want
    if body.get("seenAll") and any(m["isNew"] for m in shown_matches(item, ())):
        # Only when something was new: the page says seenAll again after each live refresh, and a write that
        # changes nothing would send it one more live event.
        store.update(pk, sk, {"seenAt": iso(now)})
    if body.get("unhideAll") and _strings(item.get("hidden")):
        store.update(pk, sk, {"updatedAt": iso(now)}, remove=["hidden"])
        if started(item) and full_want(item.get("want"))["on"]:
            why = why or "want"
    if why is not None:
        start_look(deps, user_id, why, now)


def check_now(deps: CrDeps, user_id: str, now: datetime) -> tuple[int, Item]:
    """ "Look again now": at most once per 30 minutes and 4 times a UTC day per owner (``CRFIND.checkNow``)."""
    item = load(deps.store, user_id)
    if item is None or not started(item):
        raise conflict(START_FIRST)
    if not full_want(item.get("want"))["on"]:
        raise conflict(STOPPED)
    limited = next_allowed(item.get("checkNow"), now)
    if limited is not None:
        return 200, {"started": False, "nextAllowedAt": iso(limited)}
    if not start_look(deps, user_id, "check_now", now):
        raise campaigns.platform_down()
    found = item.get("checkNow")
    old: Mapping[str, Any] = found if isinstance(found, Mapping) else {}
    today = now.date().isoformat()
    count = int(old.get("n") or 0) + 1 if old.get("day") == today else 1
    check = {"at": iso(now), "day": today, "n": count}
    deps.store.update(*key(user_id), {"checkNow": check})
    after = next_allowed(check, now) or now + CHECK_EVERY
    return 202, {"started": True, "nextAllowedAt": iso(after)}


def _uuid(value: str) -> str:
    uuid = (value or "").lower()
    if not links.UUID.match(uuid):
        raise not_found(NOT_A_MATCH)
    return uuid


def _known(item: Mapping[str, Any] | None, uuid: str) -> bool:
    """A stored match, one he opened, or one he hid."""
    if item is None:
        return False
    stored = {str(m.get("campaignId") or "").lower() for m in item.get("matches") or [] if isinstance(m, Mapping)}
    return uuid in stored or uuid in _map(item.get("opened")) or uuid in _strings(item.get("hidden"))


def said(deps: CrDeps, user_id: str, campaign_id: str, value: Any, now: datetime) -> None:
    """``PATCH …/matches/{id}``: ``opened`` (the Open tap), ``not_for_me`` (hide it) or ``null`` (the toast's Undo)."""
    if value not in ("opened", "not_for_me", None):
        raise bad_request('said must be "opened", "not_for_me" or null.', "said")
    uuid = _uuid(campaign_id)
    store = deps.store
    item = load(store, user_id)
    if item is None or not _known(item, uuid):
        raise not_found(NOT_A_MATCH)
    pk, sk = key(user_id)
    hidden = _strings(item.get("hidden"))
    if value == "opened":
        _set_in_map(store, user_id, "opened", uuid, now, cap=OPENED_MAX)
    elif value == "not_for_me" and uuid not in hidden:
        if len(hidden) >= HIDDEN_MAX:
            drop = set(sorted(hidden)[: len(hidden) - HIDDEN_MAX + 1])
            store.update(pk, sk, {"hidden": {*(h for h in hidden if h not in drop), uuid}, "updatedAt": iso(now)})
        else:
            store.update_expr(
                pk,
                sk,
                "ADD #h :one SET #u = :now",
                condition="attribute_exists(pk)",
                names={"#h": "hidden", "#u": "updatedAt"},
                values={":one": {uuid}, ":now": iso(now)},
            )
    elif value is None and uuid in hidden:
        store.update_expr(  # DynamoDB removes a set that becomes empty
            pk,
            sk,
            "DELETE #h :one SET #u = :now",
            condition="attribute_exists(pk)",
            names={"#h": "hidden", "#u": "updatedAt"},
            values={":one": {uuid}, ":now": iso(now)},
        )


# --- adding a match ----------------------------------------------------------------------------------------------------


def _base(user_id: str, uuid: str, now: datetime) -> Item:
    """The same base fields as §38.8's ``campaigns.add``, plus ``addedBy: "finder"``."""
    return {
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
        "addedBy": "finder",
    }


def _copy(store: db.Store, uuid: str) -> Item | None:
    """``CRPUBLIC/PUB#{uuid}``: the §38.10 stripped copy the look kept, or None."""
    found = store.get(PUBLIC_PK, f"PUB#{uuid}")
    if found is None or not isinstance(found.get("public"), Mapping) or parse(found.get("readAt")) is None:
        return None
    return found


def _from_copy(user_id: str, uuid: str, pub: Mapping[str, Any], now: datetime) -> Item:
    """A new ``CAMPAIGN#`` item from the look's copy: Content Rewards' numbers say when they were read
    (``publicAt`` and ``budget.asOf`` are the copy's ``readAt``, never now)."""
    item = _base(user_id, uuid, now)
    read_at = parse(pub.get("readAt")) or now
    campaigns.apply_public(item, dict(pub["public"]), read_at)
    return {k: v for k, v in item.items() if v is not None}


def _add_from_copy(deps: CrDeps, user_id: str, uuid: str, now: datetime, error: ApiError) -> None:
    """The public read failed: the item is made from a ``PUB#`` copy at most 24 hours old, else the error stands."""
    pub = _copy(deps.store, uuid)
    read_at = parse((pub or {}).get("readAt"))
    if pub is None or read_at is None or now - read_at > PUB_FRESH:
        raise error
    try:
        deps.store.put(_from_copy(user_id, uuid, pub, now), if_absent=True)
    except db.ConditionFailed:
        return  # added meanwhile (a double tap): the answer below reads it
    item = campaigns.get(deps.store, user_id, uuid)
    if item is None:
        raise error
    campaigns.check_membership(deps, user_id, item, connection.load(deps.store, user_id), now)
    if item.get("rulesState") not in ("reading", "ready", "failed"):
        item["rulesState"] = campaigns.initial_rules_state(item)
    from . import rules

    waiting = item.get("rulesState") == "waiting_for_join"
    if item.get("access") == "application" and waiting and rules.brief_text(item).strip():
        campaigns.start_read(deps, user_id, item, now)
    campaigns.save(deps, user_id, item)
    campaigns.own(deps.store, user_id, now)
    log("info", "cr.campaign_added_from_copy")


def add(deps: CrDeps, user_id: str, campaign_id: str, now: datetime) -> tuple[int, Item]:
    """``POST …/matches/{id}/add`` ("I joined: add it" / "I applied: add it"): §38.8's add with the link it already
    has, the brand picture as ``add_campaign`` does, then his answer (``routes/contentrewards.apply_said``)."""
    from ..routes import contentrewards as cr_routes

    uuid = _uuid(campaign_id)
    store = deps.store
    if not _known(load(store, user_id), uuid):
        raise not_found(NOT_A_MATCH)
    existed = campaigns.get(store, user_id, uuid) is not None
    try:
        campaigns.add(deps, user_id, links.campaign_url(uuid), now)
    except ApiError as e:
        if e.code != "platform_down" or existed:
            raise
        _add_from_copy(deps, user_id, uuid, now, e)
    item = campaigns.get(store, user_id, uuid)
    if item is None:
        raise not_found(campaigns.UNKNOWN)
    if not existed:
        item["addedBy"] = "finder"
        conn = connection.load(store, user_id)
        if item.get("access") == "application":
            cr_routes.apply_said(item, conn, "applied", now)
        elif item.get("membership") != "in" and not gates.looking(conn):
            cr_routes.apply_said(item, conn, "joined_by_hand", now)
        elif item.get("membership") == "not_joined":
            item["canSayInBy"] = item.get("addedAt") or iso(now)  # "I joined, but it still says not joined" at once
        if campaigns.needs_read(item):
            campaigns.start_read(deps, user_id, item, now)
        item = campaigns.save(deps, user_id, item)
    _set_in_map(store, user_id, "added", uuid, now, cap=ADDED_MAX)
    cr_routes._brand_picture(deps, user_id, item)
    log("info", "cr.finder_added", membership=item.get("membership"))
    return (200 if existed else 201), campaigns.View(deps, user_id, now).full(item)


# --- adopting what he joined --------------------------------------------------------------------------------------------


def candidates(
    deps: CrDeps, user_id: str, now: datetime, item: Mapping[str, Any] | None = None
) -> list[tuple[str, Item]]:
    """``(uuid, PUB# copy)`` of the campaigns he opened from the finder in the last 48 hours, not added before
    (a campaign he added and removed is never brought back), with no ``CAMPAIGN#`` item and with a ``PUB#`` copy;
    newest open first. Never a stored match he didn't open."""
    item = item if item is not None else load(deps.store, user_id)
    if item is None:
        return []
    added = _map(item.get("added"))
    recent: list[tuple[str, datetime]] = []
    for uuid, at in _map(item.get("opened")).items():
        when = parse(at)
        if links.UUID.match(uuid) and uuid not in added and when is not None and now - when <= ADOPT_OPENED_FOR:
            recent.append((uuid.lower(), when))
    if not recent:
        return []
    recent.sort(key=lambda r: r[1], reverse=True)
    pk = db.user_pk(user_id)
    wanted = [(pk, db.campaign_sk(u)) for u, _ in recent] + [(PUBLIC_PK, f"PUB#{u}") for u, _ in recent]
    found = deps.store.batch_get(wanted)
    have = {
        str(f["sk"]).removeprefix(db.CAMPAIGN_PREFIX)
        for f in found
        if f.get("pk") == pk and str(f.get("sk")).startswith(db.CAMPAIGN_PREFIX)
    }
    copies = {
        str(f["sk"]).removeprefix("PUB#"): f
        for f in found
        if f.get("pk") == PUBLIC_PK and isinstance(f.get("public"), Mapping) and parse(f.get("readAt")) is not None
    }
    return [(u, copies[u]) for u, _ in recent if u not in have and u in copies]


def adopt(
    deps: CrDeps,
    user_id: str,
    listed: Sequence[Mapping[str, Any]],
    now: datetime,
    *,
    found: list[tuple[str, Item]] | None = None,
) -> list[Item]:
    """Adds each candidate Content Rewards now lists for him (``list_my_campaigns``, just read; signed in only): a
    ``PutItem`` of the new ``CAMPAIGN#`` as ``unknown``, then a read back and §38.4's membership check with that list
    and a save, so the change to ``in`` is a ``MODIFY`` (the "You're in!" notification and the card's confetti happen
    as for any campaign). At most 5 adds per call. Returns their ``CampaignSummary``."""
    conn = connection.load(deps.store, user_id)
    if not gates.looking(conn):
        return []
    found = candidates(deps, user_id, now) if found is None else found
    out: list[Item] = []
    view: campaigns.View | None = None
    for uuid, pub in found:
        if len(out) >= ADOPT_MAX:
            break
        _row, how = ids.match_campaign(
            listed,
            uuid,
            pub["public"],
            use_typeid=conn.get("typeidVerified") is not False,
            org_matches=conn.get("orgMatched") is not False,
        )
        if how not in ("typeid", "name"):
            continue  # never an ambiguous one
        try:
            deps.store.put(_from_copy(user_id, uuid, pub, now), if_absent=True)
        except db.ConditionFailed:
            continue
        _set_in_map(deps.store, user_id, "added", uuid, now, cap=ADDED_MAX)
        item = campaigns.get(deps.store, user_id, uuid)
        if item is None:
            continue
        campaigns.check_membership(deps, user_id, item, conn, now, fresh=False)
        saved = campaigns.save(deps, user_id, item)
        view = view or campaigns.View(deps, user_id, now)
        out.append(view.summary(saved))
        log("info", "cr.finder_adopted", how=how, membership=saved.get("membership"))
    return out


def joined(deps: CrDeps, user_id: str, now: datetime) -> list[Item]:
    """``POST …/finder/joined`` (the page came back into view): signed in only, at most every 30 seconds per owner,
    one ``list_my_campaigns`` (cached 2 minutes per container), then ``adopt``."""
    if not gates.looking(connection.load(deps.store, user_id)):
        return []
    item = load(deps.store, user_id)
    if item is None:
        return []
    last = parse(item.get("joinedAt"))
    if last is not None and now - last < JOINED_EVERY:
        return []
    found = candidates(deps, user_id, now, item)
    if not found:
        return []
    deps.store.update(*key(user_id), {"joinedAt": iso(now)})
    try:
        listed, _complete = campaigns.list_campaigns(deps, user_id)
    except CrError as e:
        log("info", "cr.finder_list_failed", code=e.code)
        return []
    return adopt(deps, user_id, listed, now, found=found)


# --- asking Content Rewards ---------------------------------------------------------------------------------------------


def ask(deps: CrDeps, user_id: str, now: datetime) -> str:
    """One MCP ``send_feedback`` with ``ASK_MESSAGE`` on his tap, once per 30 days (inside them the stored
    ``askedAt`` answers and nothing is sent)."""
    if not gates.looking(connection.load(deps.store, user_id)):
        raise conflict(CONNECT_FIRST)
    item = load(deps.store, user_id) or {}
    asked = parse(item.get("askedAt"))
    if asked is not None and now - asked < ASK_EVERY:
        return str(item["askedAt"])
    try:
        deps.mcp(user_id).call("send_feedback", ask_args())
    except CrError as e:
        log("warning", "cr.finder_ask_failed", code=e.code)
        raise campaigns.platform_down() from e
    pk, sk = key(user_id)
    deps.store.update_expr(
        pk,
        sk,
        "SET #a = :now, #u = :now, #t = :type, #uid = :user, #c = if_not_exists(#c, :now)",
        names={"#a": "askedAt", "#u": "updatedAt", "#t": "type", "#uid": "userId", "#c": "createdAt"},
        values={":now": iso(now), ":type": "crfind", ":user": user_id},
    )
    log("info", "cr.finder_asked")
    return iso(now)


# --- the tick ------------------------------------------------------------------------------------------------------------


def tick(deps: CrDeps, now: datetime) -> bool:
    """``cf-prod-stats``' 15-minute tick (§41.5): when switched on and ``CRPUBLIC/STATE`` says a look is due
    (``nextRunAt`` absent or past) and none is running (``runningUntil`` absent or past), invoke
    ``cf-prod-campaigns`` ``{"action": "find", "why": "schedule"}`` (async)."""
    if not enabled() or deps.invoker is None:
        return False
    reader = deps.store.get(PUBLIC_PK, STATE_SK) or {}
    next_run, running = _when(reader.get("nextRunAt")), _when(reader.get("runningUntil"))
    if (next_run is not None and next_run > now) or (running is not None and running > now):
        return False
    try:
        deps.invoker.find(None, "schedule")
    except Exception as e:
        log("warning", "cr.finder_tick_invoke_failed", error=type(e).__name__)
        return False
    log("info", "cr.finder_tick")
    return True
