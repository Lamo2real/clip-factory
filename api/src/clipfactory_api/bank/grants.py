"""The bank list, Connect, the BankID callback, closing old sessions, Stop and Forget (docs/CONTRACTS.md §40.5.5).

Connect: ``POST /auth`` with ``psu_type: "personal"``, ``balances: false`` and a capped ``valid_until``; it never
sends ``credentials`` or ``auth_method``, so BankID happens on Enable Banking's and the bank's own pages. The state is
§17.4's (``OAUTH#{nonce}`` / ``STATE``, ``platform: "bank"``, single use).

The callback (``save_bank_grant``, run by ``cf-prod-hooks``) keeps, in memory only, the ``uid`` and
``identification_hash`` of each account that isn't a business account (``usage: "ORGA"``) and drops everything else
of Enable Banking's answer at once (holder name, IBAN, address, product). It writes the session secret
``cf-prod/platforms/bank/token_{linkId}``, one UpdateItem on ``BANKLINK#{linkId}`` and ``BANKCONN.lastConnect``, and
always answers with a result code for ``/bank-done``. It never closes an old session itself (the next
``GET /v1/getpaid/bank`` does, at most 5 s), so a slow Enable Banking can't push it past its deadline.

Never logged: the code, the state, a session id, a uid, a hash, the query, a name, an IBAN.
"""

from __future__ import annotations

import secrets as random
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from .. import db
from ..clock import iso, parse
from ..errors import ApiError, bad_request, conflict
from ..log import log
from ..money import PREFS_SK, rules
from ..oauth import STATE_SECONDS, setup, state
from . import (
    BANK_GONE,
    CHECK_TEXT,
    CONN_SK,
    COUNTRY_NOT_LINKED,
    DEPOSIT_PREFIX,
    LINK_PREFIX,
    MAX_BANK_NAME,
    MAX_BANKS,
    MAX_CLOSE_LATER,
    NO_COUNTRY,
    PAYERS_SK,
    PICK_BANK,
    PLATFORM,
    READING_NOW,
    STEPS_FIRST,
    TOO_MANY_BANKS,
    link_sk,
    token_secret,
)
from .eb import (
    KEY_ERRORS,
    SESSION_SECONDS,
    AppKey,
    BankEnv,
    Check,
    Deadline,
    EbError,
    app_key,
    call,
    delete_session,
    error_code,
    known_countries,
    ok_json,
    read_app,
    run_check,
    store_check,
)

Item = dict[str, Any]
LIST_SECONDS = 3600
DAY_SECONDS = 86400
MAX_DAYS = 180
DEFAULT_DAYS = 90  # a bank that doesn't say how long a link may last
HISTORY_AFTER_DAYS = 80
MAX_CODE_CHARS = 2048
MAX_ACCOUNTS = 20
MAX_HEADERS = 10
DENIED = "access_denied"
EXPIRED = frozenset({"EXPIRED_AUTHORIZATION_CODE", "WRONG_AUTHORIZATION_CODE", "ALREADY_AUTHORIZED"})
LEASE_SECONDS = 300


# --- the bank list (GET /aspsps, one hour per country) -------------------------------------------------------------

_LISTS: dict[tuple[str, str], tuple[float, list[Item]]] = {}
_LISTS_LOCK = threading.Lock()


def forget_lists() -> None:
    with _LISTS_LOCK:
        _LISTS.clear()


def _days(seconds: Any) -> int:
    if isinstance(seconds, bool) or not isinstance(seconds, int | float):
        return 0
    return max(0, int(seconds // DAY_SECONDS))


def _bank(raw: Mapping[str, Any]) -> Item | None:
    """One bank of Enable Banking's list (only ``personal`` ones): its name, link length, beta and the PSU headers it
    wants (names only, lower-cased; internal)."""
    name = raw.get("name")
    psu_types = raw.get("psu_types")
    if not isinstance(name, str) or not name.strip() or len(name) > MAX_BANK_NAME:
        return None
    if not isinstance(psu_types, list) or "personal" not in psu_types:
        return None
    headers = raw.get("required_psu_headers")
    found = (
        [h.strip().lower() for h in headers if isinstance(h, str) and h.strip()] if isinstance(headers, list) else []
    )
    return {
        "name": name.strip(),
        "maxDays": _days(raw.get("maximum_consent_validity")),
        "beta": raw.get("beta") is True,
        "psuHeaders": sorted(set(found))[:MAX_HEADERS],
    }


def bank_list(env: BankEnv, key: AppKey, country: str, deadline: Deadline, *, fresh: bool = False) -> list[Item]:
    """The country's personal banks, A to Z, cached in this container for an hour. ``EbError`` when unreadable."""
    return bank_list_read(env, key, country, deadline, fresh=fresh)[0]


def bank_list_read(
    env: BankEnv, key: AppKey, country: str, deadline: Deadline, *, fresh: bool = False
) -> tuple[list[Item], bool]:
    """``(banks, True when just read from Enable Banking)``."""
    cache_key = (key.app_id or "", country)
    if not fresh:
        with _LISTS_LOCK:
            hit = _LISTS.get(cache_key)
        if hit and env.monotonic() - hit[0] < LIST_SECONDS:
            return [dict(b) for b in hit[1]], False
    resp = call(env, key, "GET", f"/aspsps?country={country}&psu_type=personal&service=AIS", deadline)
    found = ok_json(resp).get("aspsps")
    if not isinstance(found, list):
        raise EbError(resp.status, "UNREADABLE")
    banks = [b for b in (_bank(raw) for raw in found if isinstance(raw, Mapping)) if b is not None]
    banks.sort(key=lambda b: str(b["name"]).casefold())
    with _LISTS_LOCK:
        _LISTS[cache_key] = (env.monotonic(), banks)
    return [dict(b) for b in banks], True


def public_banks(banks: list[Item]) -> list[Item]:
    return [{"name": b["name"], "maxDays": b["maxDays"], "beta": b["beta"]} for b in banks]


def _country_name(code: str) -> str:
    try:
        cfg = rules.load()
    except Exception:
        return code
    return next((c["name"] for c in cfg.countries if c.get("code") == code), code)


def his_country(store: db.Store, user_id: str) -> str | None:
    prefs = store.get(db.user_pk(user_id), PREFS_SK) or {}
    found = prefs.get("country")
    # "other" (Somewhere else) is no country Enable Banking knows.
    return found if isinstance(found, str) and len(found) == 2 and found.isalpha() else None


def pick_country(mine: str | None, countries: tuple[str, ...]) -> str:
    """§40.5.5's order: his Money country (when the app's countries hold it, or are empty), else the app's one
    country, else 409 ``country_not_linked`` (with his country) or ``no_country``."""
    if mine and (not countries or mine in countries):
        return mine
    if len(countries) == 1:
        return countries[0]
    if mine:
        raise ApiError(409, "country_not_linked", COUNTRY_NOT_LINKED.format(country=_country_name(mine)))
    raise ApiError(409, "no_country", NO_COUNTRY)


def saved_key(env: BankEnv) -> AppKey:
    """The key with a saved app ID; 409 "Do the steps above first." otherwise."""
    found = app_key(read_app(env))
    if found is None or not found.app_id:
        raise conflict(STEPS_FIRST)
    return found


def countries_for(env: BankEnv, store: db.Store, user_id: str, key: AppKey, deadline: Deadline) -> tuple[str, ...]:
    """The app's countries from a check at most an hour old, else a new check (stored like any other)."""
    known = known_countries(env, key.app_id or "")
    if known is not None:
        return known
    found = run_check(env, key, deadline)
    store_check(store, user_id, found)
    if found.code == "down":
        raise ApiError(503, "unavailable", CHECK_TEXT["down"])
    return found.countries


def banks(env: BankEnv, store: db.Store, user_id: str, deadline: Deadline) -> Item:
    """``GET /v1/getpaid/bank/banks``: ``{country, banks: BankChoice[]}``."""
    key = saved_key(env)
    country = pick_country(his_country(store, user_id), countries_for(env, store, user_id, key, deadline))
    try:
        found = bank_list(env, key, country, deadline)
    except EbError as e:
        log("warning", "bank.list_down", code=e.code, status=e.status)
        raise ApiError(503, "unavailable", CHECK_TEXT["down"]) from e
    return {"country": country, "banks": public_banks(found)}


# --- Connect (POST /auth) -----------------------------------------------------------------------------------------


def _stored_check(store: db.Store, user_id: str) -> str | None:
    conn = store.get(db.user_pk(user_id), CONN_SK) or {}
    app = conn.get("app") if isinstance(conn.get("app"), Mapping) else {}
    found = app.get("check") if isinstance(app, Mapping) else None
    code = found.get("code") if isinstance(found, Mapping) else None
    return code if isinstance(code, str) else None


def _find(banks_found: list[Item], name: str) -> Item | None:
    return next((b for b in banks_found if b["name"] == name), None)


def _valid_until(now: datetime, max_days: int) -> datetime:
    days = min(max_days if max_days > 0 else DEFAULT_DAYS, MAX_DAYS)
    return (now + timedelta(days=days) - timedelta(minutes=10)).replace(microsecond=0)


def _wants_history(link: Mapping[str, Any] | None, now: datetime) -> bool:
    if link is None:
        return True
    read_through = parse(link.get("readThrough"))  # a day ("2026-11-20") or a time
    return read_through is None or now - read_through > timedelta(days=HISTORY_AFTER_DAYS)


def _target(
    env: BankEnv,
    store: db.Store,
    user_id: str,
    body: Mapping[str, Any],
    deadline: Deadline,
    *,
    key: AppKey,
    found_check: Check | None,
) -> tuple[Item | None, str, str, str]:
    """``(the link for a reconnect or None, its linkId, the bank's name, the country)``."""
    links = store.query_all(db.user_pk(user_id), LINK_PREFIX)
    link: Item | None = None
    if "linkId" in body:
        link_id = str(body.get("linkId") or "")
        link = next((i for i in links if i.get("linkId") == link_id and i.get("connectedAt")), None)
        if link is None:
            raise ApiError(404, "not_found", "We could not find that bank link.")
        bank_name, country = str(link.get("bank") or ""), str(link.get("country") or "")
    else:
        raw = body.get("bank")
        bank_name = raw.strip() if isinstance(raw, str) else ""
        if not bank_name or len(bank_name) > MAX_BANK_NAME:
            raise bad_request(PICK_BANK, "bank")
        countries = found_check.countries if found_check is not None else None
        if countries is None:
            countries = countries_for(env, store, user_id, key, deadline)
        country = pick_country(his_country(store, user_id), countries)
        link_id = random.token_hex(6)
    active = [i for i in links if i.get("status") != "stopped" and i.get("linkId") != link_id]
    if (link is None or link.get("status") == "stopped") and len(active) >= MAX_BANKS:
        raise conflict(TOO_MANY_BANKS)
    return link, link_id, bank_name, country


def _choice(env: BankEnv, key: AppKey, country: str, name: str, deadline: Deadline) -> Item | None:
    """The bank in a list at most an hour old; the list is read again (once) when the name isn't in a cached one."""
    try:
        listed, fresh = bank_list_read(env, key, country, deadline)
        choice = _find(listed, name)
        if choice is None and not fresh:
            choice = _find(bank_list(env, key, country, deadline, fresh=True), name)
    except EbError as e:
        log("warning", "bank.list_down", code=e.code, status=e.status)
        raise ApiError(503, "unavailable", CHECK_TEXT["down"]) from e
    return choice


def _auth_refused(store: db.Store, user_id: str, status: int, code: str, now: datetime) -> ApiError:
    log("warning", "bank.auth_refused", code=code or "HTTP", status=status)
    if code == "REDIRECT_URI_NOT_ALLOWED":
        store_check(store, user_id, Check("redirect_missing", iso(now)))
        return conflict(CHECK_TEXT["redirect_missing"])
    if code == "WRONG_ASPSP_PROVIDED":
        return bad_request(PICK_BANK, "bank")
    if code in KEY_ERRORS or status == 401:
        return conflict(CHECK_TEXT["key_wrong"])
    return ApiError(503, "unavailable", CHECK_TEXT["down"])


def connect(env: BankEnv, store: db.Store, user_id: str, body: Mapping[str, Any], deadline: Deadline) -> Item:
    """``POST /v1/getpaid/bank/connect`` with ``{bank}`` or ``{linkId}``: ``{authorizeUrl, expiresAt}``. At most three
    Enable Banking calls (the check when needed, the list when needed, ``POST /auth``)."""
    now = env.clock()
    key = saved_key(env)
    found_check: Check | None = None
    if _stored_check(store, user_id) != "ok":
        found_check = run_check(env, key, deadline)
        store_check(store, user_id, found_check)
        if found_check.code != "ok":
            raise conflict(CHECK_TEXT[found_check.code])
    link, link_id, bank_name, country = _target(env, store, user_id, body, deadline, key=key, found_check=found_check)
    choice = _choice(env, key, country, bank_name, deadline)
    if choice is None:
        if link is not None:
            raise conflict(BANK_GONE.format(bank=bank_name))
        raise bad_request(PICK_BANK, "bank")
    reconnect = link is not None
    history = _wants_history(link, now)
    exp = int(now.timestamp()) + STATE_SECONDS
    state_key = env.state_key()
    nonce = state.new_nonce()
    store.put(
        {
            "pk": setup.oauth_pk(nonce),
            "sk": setup.OAUTH_SK,
            "type": "oauth",
            "userId": user_id,
            "platform": PLATFORM,
            "redirectUri": env.redirect_uri,
            "linkId": link_id,
            "reconnect": reconnect,
            "bank": choice["name"],
            "country": country,
            "maxDays": choice["maxDays"],
            "psuHeaders": choice["psuHeaders"],
            "history": history,
            "createdAt": iso(now),
            "ttl": exp + 300,
        },
        if_absent=True,
    )
    request = {
        "access": {
            "valid_until": _valid_until(now, int(choice["maxDays"])).isoformat(),
            "balances": False,
            "transactions_extended_history": history,
        },
        "aspsp": {"name": choice["name"], "country": country},
        "state": state.sign(state_key, PLATFORM, nonce, exp),
        "redirect_url": env.redirect_uri,
        "psu_type": "personal",
    }
    try:
        resp = call(env, key, "POST", "/auth", deadline, body=request)
    except EbError as e:
        log("warning", "bank.auth_down", code=e.code)
        raise ApiError(503, "unavailable", CHECK_TEXT["down"]) from e
    if not 200 <= resp.status < 300:
        raise _auth_refused(store, user_id, resp.status, error_code(resp), now)
    found = resp.json()
    url = found.get("url") if isinstance(found, dict) else None
    if not isinstance(url, str) or not url.startswith("https://"):
        raise ApiError(503, "unavailable", CHECK_TEXT["down"])
    log("info", "bank.connect_started", reconnect=reconnect, history=history)
    return {"authorizeUrl": url, "expiresAt": iso(now + timedelta(seconds=STATE_SECONDS))}


# --- the callback (GET /oauth/bank/callback, cf-prod-hooks) -------------------------------------------------------


def _accounts(found: Mapping[str, Any]) -> tuple[list[Item], bool]:
    """In memory only: ``[{uid, idHash}]`` of each account that isn't ``ORGA``, and whether any was ``ORGA``. Every
    other field of the answer is dropped here."""
    kept: list[Item] = []
    business = False
    raw = found.get("accounts")
    for account in raw if isinstance(raw, list) else []:
        if not isinstance(account, Mapping):
            continue
        if str(account.get("usage") or "").upper() == "ORGA":
            business = True
            continue
        uid = account.get("uid")
        id_hash = account.get("identification_hash")
        if isinstance(uid, str) and uid and len(uid) <= 200:
            kept.append({"uid": uid, "idHash": id_hash if isinstance(id_hash, str) and len(id_hash) <= 200 else None})
    return kept[:MAX_ACCOUNTS], business


def _last_connect(store: db.Store, user_id: str, result: str, saved: Mapping[str, Any], at: datetime) -> None:
    """``BANKCONN.lastConnect``, written for every result once the state was read, so the waiting page learns it."""
    value = {
        "result": result,
        "linkId": str(saved.get("linkId") or ""),
        "bank": str(saved.get("bank") or "")[:MAX_BANK_NAME],
        "reconnect": saved.get("reconnect") is True,
        "at": iso(at),
    }
    try:
        store.update_expr(
            db.user_pk(user_id),
            CONN_SK,
            "SET #t = :t, #l = :l",
            names={"#t": "type", "#l": "lastConnect"},
            values={":t": "bankconn", ":l": value},
        )
    except Exception as e:  # the owner still lands on /bank-done with his result
        log("error", "bank.last_connect_failed", error=type(e).__name__)


def save_bank_grant(query: Mapping[str, str], store: db.Store, env: BankEnv, deadline: Deadline) -> str:
    """The callback's result code (one of ``RESULTS``), with one time ``at`` for the whole call."""
    at = env.clock()
    raw = str(query.get("state") or "")
    try:
        nonce = state.verify(env.state_key(), PLATFORM, raw, int(at.timestamp()))
    except state.StateError:
        return "bank_expired"
    saved = store.delete_once(setup.oauth_pk(nonce), setup.OAUTH_SK)
    if saved is None or saved.get("platform") != PLATFORM or not saved.get("userId") or saved.get("workspaceId"):
        return "bank_expired"
    user_id = str(saved["userId"])
    try:
        result = _grant(query, store, env, deadline, saved=saved, user_id=user_id, at=at)
    except Exception as e:  # a Secrets Manager or DynamoDB error: a plain sentence, never a stack
        log("error", "bank.callback_failed", error=type(e).__name__)
        result = "bank_error"
    _last_connect(store, user_id, result, saved, at)
    log("info", "bank.callback", result=result, reconnect=saved.get("reconnect") is True)
    return result


@dataclass(frozen=True)
class _Session:
    """What is kept of ``POST /sessions``'s answer, in memory only."""

    session_id: str
    accounts: list[Item]
    business: bool
    valid: datetime | None


def _open_session(env: BankEnv, key: AppKey, code: str, deadline: Deadline) -> _Session | str:
    """The session, or the result code when Enable Banking said no."""
    try:
        resp = call(env, key, "POST", "/sessions", deadline, cap=SESSION_SECONDS, body={"code": code})
    except EbError as e:
        log("warning", "bank.session_down", code=e.code)
        return "bank_error"
    err = error_code(resp)
    if not 200 <= resp.status < 300:
        log("warning", "bank.session_refused", code=err or "HTTP", status=resp.status)
        if err in EXPIRED:
            return "bank_expired"
        if err in KEY_ERRORS or resp.status == 401:
            return "bank_key_wrong"
        return "bank_no_accounts" if err == "NO_ACCOUNTS_ADDED" else "bank_error"
    found = resp.json()
    if not isinstance(found, dict) or not isinstance(found.get("session_id"), str) or not found["session_id"]:
        return "bank_error"
    accounts, business = _accounts(found)
    access = found.get("access")
    valid = parse(access.get("valid_until")) if isinstance(access, Mapping) else None
    return _Session(str(found["session_id"]), accounts, business, valid)  # nothing else of the answer goes on


def _close_later(env: BankEnv, name: str, session_id: str) -> list[str]:
    """A reconnect: the old secret's session (when it differs) and its own ``closeLater``, at most 3 ids."""
    old = env.secrets.read(name, fresh=True) or {}
    earlier = old.get("closeLater")
    ids = [str(s) for s in earlier if isinstance(s, str) and s] if isinstance(earlier, list) else []
    old_id = old.get("sessionId")
    if isinstance(old_id, str) and old_id and old_id != session_id:
        ids.append(old_id)
    return [s for s in dict.fromkeys(ids) if s != session_id][-MAX_CLOSE_LATER:]


def _write_link(
    store: db.Store,
    user_id: str,
    saved: Mapping[str, Any],
    *,
    link_id: str,
    at: datetime,
    valid_until: str,
    accounts: int,
    close_later: bool,
) -> None:
    """One UpdateItem on ``BANKLINK#{linkId}`` (§40.5.5 step 6): the same ``at`` as the secret's ``connectedAt``."""
    headers = saved.get("psuHeaders")
    sets: Item = {
        "type": "banklink",
        "linkId": link_id,
        "bank": str(saved.get("bank") or "")[:MAX_BANK_NAME],
        "country": str(saved.get("country") or ""),
        "status": "connected",
        "consentUntil": valid_until,
        "connectedAt": iso(at),
        "accountCount": accounts,
        "psuHeaders": [str(h).lower() for h in headers if isinstance(h, str)] if isinstance(headers, list) else [],
        "historyWanted": saved.get("history") is True,
        "updatedAt": iso(at),
    }
    removes = list(LINK_CLEARED)
    if close_later:
        sets["closePending"] = True
    else:
        removes.append("closePending")
    names: dict[str, str] = {}
    values: Item = {}
    parts = []
    for i, (field, value) in enumerate(sets.items()):
        names[f"#s{i}"], values[f":s{i}"] = field, value
        parts.append(f"#s{i} = :s{i}")
    for i, (field, value) in enumerate((("firstConnectedAt", iso(at)), ("firstReadDone", False))):
        names[f"#f{i}"], values[f":f{i}"] = field, value
        parts.append(f"#f{i} = if_not_exists(#f{i}, :f{i})")
    for i, field in enumerate(removes):
        names[f"#r{i}"] = field
    expression = "SET " + ", ".join(parts) + " REMOVE " + ", ".join(f"#r{i}" for i in range(len(removes)))
    store.update_expr(db.user_pk(user_id), link_sk(link_id), expression, names=names, values=values)


LINK_CLEARED = (
    "reason",
    "lastError",
    "endedAt",
    "stoppedAt",
    "warnedFor",
    "limitUntil",
    "resume",
    "firstReadStartedAt",
    "failingSince",
)


def _grant(
    query: Mapping[str, str],
    store: db.Store,
    env: BankEnv,
    deadline: Deadline,
    *,
    saved: Mapping[str, Any],
    user_id: str,
    at: datetime,
) -> str:
    error = str(query.get("error") or "")
    if error:
        return "bank_denied" if error == DENIED else "bank_error"
    code = str(query.get("code") or "")
    link_id = str(saved.get("linkId") or "")
    if not code or len(code) > MAX_CODE_CHARS or not link_id:
        return "bank_error"
    key = app_key(read_app(env))
    if key is None or not key.app_id:
        return "bank_key_wrong"
    session = _open_session(env, key, code, deadline)
    if isinstance(session, str):
        return session
    if not session.accounts:
        delete_session(env, key, session.session_id, deadline)
        return "bank_business_only" if session.business else "bank_no_accounts"
    max_days = saved.get("maxDays") if isinstance(saved.get("maxDays"), int) else 0
    valid_until = iso(session.valid) if session.valid is not None else iso(_valid_until(at, int(max_days or 0)))
    name = token_secret(env.secrets.prefix, link_id)
    close_later = _close_later(env, name, session.session_id) if saved.get("reconnect") is True else []
    env.secrets.write(
        name,
        {
            "sessionId": session.session_id,
            "accounts": session.accounts,
            "validUntil": valid_until,
            "bank": str(saved.get("bank") or "")[:MAX_BANK_NAME],
            "country": str(saved.get("country") or ""),
            "connectedAt": iso(at),
            "closeLater": close_later,
        },
        platform=PLATFORM,
    )
    _write_link(
        store,
        user_id,
        saved,
        link_id=link_id,
        at=at,
        valid_until=valid_until,
        accounts=len(session.accounts),
        close_later=bool(close_later),
    )
    return "bank_connected"


# --- closing old sessions, Stop and Forget ------------------------------------------------------------------------


def _remove(store: db.Store, user_id: str, link_id: str, fields: list[str]) -> None:
    names = {f"#r{i}": f for i, f in enumerate(fields)}
    store.update_expr(
        db.user_pk(user_id),
        link_sk(link_id),
        "REMOVE " + ", ".join(names),
        condition="attribute_exists(pk)",
        names=names,
    )


def _close(
    env: BankEnv, store: db.Store, user_id: str, link: Mapping[str, Any], *, key: AppKey | None, deadline: Deadline
) -> bool:
    """Closes a link's old sessions (and, for a stopped link, its own). True when every one worked; then the secret
    is put back without ``closeLater`` (a connected link) or deleted (a stopped link), and ``closePending`` goes."""
    link_id = str(link.get("linkId") or "")
    name = token_secret(env.secrets.prefix, link_id)
    secret = env.secrets.read(name, fresh=True)
    stopped = link.get("status") == "stopped"
    ids: list[str] = []
    if secret:
        earlier = secret.get("closeLater")
        ids = [str(s) for s in earlier if isinstance(s, str) and s] if isinstance(earlier, list) else []
        if stopped and isinstance(secret.get("sessionId"), str) and secret["sessionId"]:
            ids.insert(0, str(secret["sessionId"]))
    if ids and key is None:
        return False
    closed = [delete_session(env, key, sid, deadline) for sid in ids] if key is not None else []
    worked = all(closed)  # every one is tried, even after a failure
    if not worked:
        return False
    if secret and stopped:
        env.secrets.delete(name)
    elif secret and secret.get("closeLater"):
        env.secrets.write(name, {**secret, "closeLater": []}, platform=PLATFORM)
    if stopped and not link.get("firstConnectedAt"):
        store.delete(db.user_pk(user_id), link_sk(link_id))  # a link Forget kept bare until its close worked
    elif link.get("closePending"):
        _remove(store, user_id, link_id, ["closePending"])
    return True


def close_pending(env: BankEnv, store: db.Store, user_id: str, deadline: Deadline) -> None:
    """``GET /v1/getpaid/bank`` first: at most 5 s on ``DELETE /sessions`` for links with ``closePending``. A failure
    changes nothing, and the view is answered anyway."""
    pending = [i for i in store.query_all(db.user_pk(user_id), LINK_PREFIX) if i.get("closePending")]
    if not pending:
        return
    try:
        key = app_key(read_app(env))
        for link in pending:
            _close(env, store, user_id, link, key=key, deadline=deadline)
    except Exception as e:
        log("warning", "bank.close_pending_failed", error=type(e).__name__)


def stop_link(
    env: BankEnv, store: db.Store, user_id: str, link: Mapping[str, Any], *, deadline: Deadline, key: AppKey | None
) -> bool:
    """ "Stop reading Swedbank": ``status "stopped"`` at once (no read touches it again), then Enable Banking closes
    the session and every ``closeLater`` id (best effort). When they worked the secret is deleted; else it stays with
    ``closePending``, so a later GET, Stop or Forget closes it. Every ``DEPOSIT#`` stays."""
    now = env.clock()
    link_id = str(link["linkId"])
    if link.get("status") != "stopped":
        store.update_expr(
            db.user_pk(user_id),
            link_sk(link_id),
            "SET #s = :s, #st = :at, #p = :p, #u = :at",
            condition="attribute_exists(pk)",
            names={"#s": "status", "#st": "stoppedAt", "#p": "closePending", "#u": "updatedAt"},
            values={":s": "stopped", ":at": iso(now), ":p": True},
        )
    else:
        store.update_expr(
            db.user_pk(user_id),
            link_sk(link_id),
            "SET #p = :p",
            condition="attribute_exists(pk)",
            names={"#p": "closePending"},
            values={":p": True},
        )
    fresh = store.get(db.user_pk(user_id), link_sk(link_id)) or {**link, "status": "stopped", "closePending": True}
    closed = _close(env, store, user_id, fresh, key=key, deadline=deadline)
    log("info", "bank.stopped", closed=closed)
    return closed


def stop(env: BankEnv, store: db.Store, user_id: str, link_id: str, deadline: Deadline) -> None:
    link = store.get(db.user_pk(user_id), link_sk(link_id))
    if link is None or link.get("type") != "banklink":
        raise ApiError(404, "not_found", "We could not find that bank link.")
    stop_link(env, store, user_id, link, deadline=deadline, key=app_key(read_app(env)))


def _lease_until(conn: Mapping[str, Any]) -> datetime | None:
    lease = conn.get("readLease")
    until = lease.get("until") if isinstance(lease, Mapping) else None
    if isinstance(until, int | float) and not isinstance(until, bool):
        from datetime import UTC

        return datetime.fromtimestamp(until, UTC)
    return parse(until)


def claim_lease(store: db.Store, user_id: str, now: datetime) -> Item:
    """``BANKCONN.readLease`` (shared with BR's reads): absent or expired → ours for 300 s; held → 409."""
    pk = db.user_pk(user_id)
    conn = store.get(pk, CONN_SK) or {}
    until = _lease_until(conn)
    if until is not None and until > now:
        raise conflict(READING_NOW)
    mine = {"until": iso(now + timedelta(seconds=LEASE_SECONDS))}
    names = {"#l": "readLease", "#t": "type"}
    values: Item = {":m": mine, ":t": "bankconn"}
    if "readLease" in conn:
        condition = "#l = :old"
        values[":old"] = conn["readLease"]
    else:
        condition = "attribute_not_exists(#l)"
    try:
        store.update_expr(pk, CONN_SK, "SET #l = :m, #t = :t", condition=condition, names=names, values=values)
    except db.ConditionFailed as e:
        raise conflict(READING_NOW) from e
    return mine


def release_lease(store: db.Store, user_id: str, mine: Mapping[str, Any]) -> None:
    try:
        store.update_expr(
            db.user_pk(user_id),
            CONN_SK,
            "REMOVE #l",
            condition="#l = :m",
            names={"#l": "readLease"},
            values={":m": dict(mine)},
        )
    except db.ConditionFailed:
        log("warning", "bank.lease_lost")


BARE = frozenset({"pk", "sk", "type", "linkId", "bank", "status", "stoppedAt", "closePending"})


def forget(env: BankEnv, store: db.Store, user_id: str, deadline: Deadline) -> int:
    """ "Forget my bank": stops every link, deletes every ``DEPOSIT#``, ``BANKPAYERS`` and every ``BANKLINK#`` without
    ``closePending`` (one with it keeps only its id, bank, ``stopped`` and ``closePending`` until its close works),
    sets ``BANKCONN.forgottenAt``. The app key, the app ID and ``BANKCONN.app`` stay."""
    now = env.clock()
    pk = db.user_pk(user_id)
    mine = claim_lease(store, user_id, now)
    gone = 0
    try:
        key = app_key(read_app(env))
        for link in store.query_all(pk, LINK_PREFIX):
            if link.get("status") != "stopped" or link.get("closePending"):
                stop_link(env, store, user_id, link, deadline=deadline, key=key)
        for item in store.query_all(pk, DEPOSIT_PREFIX):
            store.delete(pk, str(item["sk"]))
            gone += 1
        store.delete(pk, PAYERS_SK)
        for link in store.query_all(pk, LINK_PREFIX):
            if link.get("closePending"):
                extra = [k for k in link if k not in BARE]
                if extra:
                    _remove(store, user_id, str(link["linkId"]), extra)
            else:
                store.delete(pk, str(link["sk"]))
            gone += 1
        store.update_expr(
            pk,
            CONN_SK,
            "SET #f = :f, #u = :f REMOVE #lc",
            names={"#f": "forgottenAt", "#u": "updatedAt", "#lc": "lastConnect"},
            values={":f": iso(now)},
        )
    finally:
        release_lease(store, user_id, mine)
    log("info", "bank.forgotten", items=gone)
    return gone
