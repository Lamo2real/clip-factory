"""``GET /v1/getpaid`` and ``GET /v1/getpaid/{place}`` from stored items only (docs/CONTRACTS.md §40.7).

``load`` reads one owner's ``GETPAID``, ``PAYCONN#``, ``PAYSTATE#`` and ``PAYOUT#`` items plus ``ACCOUNT#``,
``MONEYSTATE#``, ``MONEYPREFS`` and, while Content Rewards is on, ``CRCONN`` and ``CRMONEY``; it never calls a
platform, Google or Whop. No answer carries a token, a client secret, a raw platform answer, a trace code or an
AdSense publisher id beyond its last 4.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any

from .. import db, posts
from ..clock import iso, parse
from ..money import MONEY_ORDER, PREFS_SK, rules, state_sk
from . import ADSENSE, CR, GETPAID_SK, WHOP, payconn_sk, payout_prefix, paystate_sk, status
from .sent import payout_rows

Item = dict[str, Any]
CONNECTED = frozenset({"connected", "needs_reconnect"})
PAYCONN_STATUSES = ("not_connected", "keys_saved", "connected", "needs_reconnect")
REASONS = ("token_dead", "keys_changed")
GOALS_FOR = ("youtube", "instagram", "x")


def ticks(store: db.Store, user_id: str) -> list[str]:
    item = store.get(db.user_pk(user_id), GETPAID_SK) or {}
    return sorted(str(s) for s in item.get("stepsDone") or [] if isinstance(s, str))


def _last4(value: Any) -> str:
    digits = "".join(c for c in str(value or "") if c.isalnum())
    return digits[-4:]


def public_conn(source: str, item: Mapping[str, Any] | None, *, redirect_uri: str = "") -> Item:
    """``PayConn`` (§40.7): never a token, a publisher id beyond its last 4, a lease or a token version."""
    item = item or {}
    found = item.get("status")
    out: Item = {"source": source, "status": found if found in PAYCONN_STATUSES else "not_connected"}
    if source == ADSENSE:
        accounts = [a for a in item.get("accounts") or [] if isinstance(a, Mapping)]
        if accounts and out["status"] in CONNECTED:
            first = accounts[0]
            label = str(first.get("displayName") or "AdSense for YouTube").strip()[:60]
            out["accountName"] = f"{label} (…{_last4(first.get('name'))})"
    elif isinstance(item.get("accountName"), str) and item["accountName"] and out["status"] in CONNECTED:
        out["accountName"] = item["accountName"]
    if out["status"] in CONNECTED and isinstance(item.get("connectedAt"), str):
        out["connectedAt"] = item["connectedAt"]
    if item.get("reason") in REASONS:
        out["reason"] = item["reason"]
    if source == WHOP:
        if isinstance(item.get("keyHint"), str) and item["keyHint"]:
            out["keyHint"] = item["keyHint"]
        out["redirectUri"] = redirect_uri
    if isinstance(item.get("lastResult"), str) and item["lastResult"]:
        out["lastResult"] = item["lastResult"]
    return out


def _goals(
    cfg: rules.Monetization, platform: str, state: Mapping[str, Any], now: datetime, country: str | None
) -> list[Item]:
    in_program = str(state.get("state") or "") in {"in_program", "earning"}
    picked = rules.pick(cfg, platform, today=now.date(), in_program=in_program, country=country)
    if not isinstance(picked, rules.Rule):
        return []
    numbers: Item = {
        **(state.get("numbers") or {}),
        "missing": dict(state.get("missing") or {}),
        "counting": dict(state.get("counting") or {}),
    }
    goals, _more = rules.progress(picked, numbers)
    return goals


def inputs(
    store: db.Store,
    user_id: str,
    now: datetime,
    *,
    cr_on: bool,
    whop_on: bool,
    cfg: rules.Monetization | None = None,
) -> tuple[dict[str, Item], Item]:
    """``(inputs per place, the shared facts)``: what ``status.card`` reads for each place, in the places' order."""
    cfg = cfg or rules.load()
    pk = db.user_pk(user_id)
    accounts = {str(a.get("platform")): a for a in posts.accounts(store, user_id)}
    states = {str(i["sk"]).removeprefix("MONEYSTATE#"): i for i in store.query_all(pk, "MONEYSTATE#")}
    prefs = store.get(pk, PREFS_SK) or {}
    country = prefs.get("country") if isinstance(prefs.get("country"), str) else None
    country_name = next((c["name"] for c in cfg.countries if c.get("code") == country), None)
    my_ticks = ticks(store, user_id)
    conns = {s: store.get(pk, payconn_sk(s)) or {} for s in (ADSENSE, WHOP)}
    out: dict[str, Item] = {}
    for p in MONEY_ORDER:
        state = states.get(p) or store.get(pk, state_sk(p)) or {}
        entry: Item = {
            "connected": (accounts.get(p) or {}).get("status") in CONNECTED,
            "ticks": [t for t in my_ticks if status.step(p, t) is not None],
            "moneyState": {k: state[k] for k in ("state", "numbers") if k in state},
            "country": country,
            "countryName": country_name,
        }
        if p in GOALS_FOR:
            entry["goals"] = _goals(cfg, p, state, now, country)
        if p == "tiktok":
            entry["notOpen"] = rules.pick(cfg, p, today=now.date(), in_program=False, country=country) == "not_open"
        if p == "youtube":
            entry["payconn"] = conns[ADSENSE]
            entry["paystate"] = store.get(pk, paystate_sk("youtube")) or {}
            entry["payouts"] = store.query_all(pk, payout_prefix("youtube"))
        out[p] = entry
    if cr_on:
        from ..contentrewards import connection

        crconn = store.get(pk, db.CRCONN_SK) or {}
        crmoney = store.get(pk, db.CRMONEY_SK) or {}
        effective, _ = connection.effective(crconn, now)
        out[CR] = {
            "connected": effective != "not_connected",
            "ticks": sorted(str(s) for s in crconn.get("stepsDone") or [] if isinstance(s, str)),
            "finance": crconn.get("finance") if isinstance(crconn.get("finance"), bool) else None,
            "crMoney": {
                k: crmoney[k]
                for k in ("paidTotalCents", "readyToMoveCents", "stillEarningCents", "onItsWayCents", "movedAt")
                if k in crmoney
            },
            "country": country,
            "whopOn": whop_on,
            "payconn": conns[WHOP],
            "paystate": store.get(pk, paystate_sk(CR)) or {},
            "payouts": store.query_all(pk, payout_prefix(CR)),
        }
    return out, {"country": country, "conns": conns, "ticks": my_ticks, "prefs": prefs}


def load(
    store: db.Store,
    user_id: str,
    now: datetime,
    *,
    cr_on: bool,
    whop_on: bool,
    whop_redirect: str = "",
    cfg: rules.Monetization | None = None,
) -> Item:
    """``GetPaid``: one card per place (YouTube, TikTok, Instagram, Facebook, X, then Content Rewards while on)."""
    found, shared = inputs(store, user_id, now, cr_on=cr_on, whop_on=whop_on, cfg=cfg)
    cards = [status.card(p, i, now) for p, i in found.items()]
    conns = shared["conns"]
    out: Item = {
        "places": cards,
        "summary": status.summary(cards),
        "country": shared["country"],
        "connections": {
            "adsense": public_conn(ADSENSE, conns[ADSENSE]),
            "whop": public_conn(WHOP, conns[WHOP], redirect_uri=whop_redirect) if whop_on else None,
        },
        "stepsDone": shared["ticks"],
    }
    last = shared["prefs"].get("lastManualAt")  # the same "Check now" claim as GET /v1/money (once an hour)
    if isinstance(last, str):
        moment = parse(last)
        if moment is not None and moment + timedelta(hours=1) > now:
            out["nextCheckAllowedAt"] = iso(moment + timedelta(hours=1))
    out["asOf"] = iso(now)
    return out


def place(
    store: db.Store,
    user_id: str,
    place_id: str,
    now: datetime,
    *,
    cr_on: bool,
    whop_on: bool,
    cfg: rules.Monetization | None = None,
) -> Item:
    """``{card, payouts}`` for one place (``GET /v1/getpaid/{place}``)."""
    found, _ = inputs(store, user_id, now, cr_on=cr_on, whop_on=whop_on, cfg=cfg)
    entry = found[place_id]
    return {"card": status.card(place_id, entry, now), "payouts": payout_rows(place_id, entry.get("payouts") or [])}
