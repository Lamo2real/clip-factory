"""/v1/getpaid/bank: Your bank, read through Enable Banking (docs/CONTRACTS.md §40.5.10; builder BA).

While ``BANK_READING`` is off, ``GET /v1/getpaid/bank`` answers ``{"on": false}`` and every other route 503
``unavailable`` "Coming soon.". Without §17.4's OAuth env they answer 503 "Posting setup is not switched on for this
app yet.". A user who isn't ``BANKOWNER`` gets 403. Only these reach outside stored items: key (makes a key, no
network), app and app/check (``GET /application``), banks (``GET /aspsps``, cached), connect (``POST /auth``), the two
deletes and a GET with ``closePending`` (``DELETE /sessions``) and check (the async invoke). No answer ever carries a
private key, ``hashKey``, a session id, a uid, an ``identification_hash``, a ``payerKey``, the bank's own text, an IP
address, a user agent or a JWT. Nothing here accepts an amount, an account number or a bank login.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from .. import db, money, validate
from ..app import App
from ..async_invoke import InvokeError
from ..bank import (
    CHECK_EVERY_MINUTES,
    CHECK_NOT_STARTED,
    CHECK_OFF,
    CLOSE_SECONDS,
    COMING_SOON,
    CONN_SK,
    CONNECT_FIRST,
    LINK_ID,
    LINK_PREFIX,
    MAX_STEPS_DONE,
    RATE_LIMITED,
    ROUTE_SECONDS,
    STEP_IDS,
    STEP_UNKNOWN,
    TICKABLE,
    TICKS_ITSELF,
    answers,
    eb,
    grants,
    keys,
    link_sk,
    view,
)
from ..bank.eb import BankEnv, Deadline
from ..clock import iso, parse
from ..errors import ApiError, bad_request, not_found
from ..http import Request, Response, no_content, ok
from ..log import log

MAX_UA = 512
MAX_LANG = 100
FIRST_READ_HOURS = 1  # a reconnect's own read counts as his first read within this long of BankID (§40.5.6)


def _on(app: App) -> None:
    if not getattr(app, "bank_reading", False):
        raise ApiError(503, "unavailable", COMING_SOON)


def _env(app: App) -> BankEnv:
    if app.oauth is None:
        raise ApiError(503, "unavailable", "Posting setup is not switched on for this app yet.")
    return eb.from_oauth(app.oauth, getattr(app, "bank_http", None), getattr(app, "bank_monotonic", None))


def _deadline(env: BankEnv, seconds: float = ROUTE_SECONDS) -> Deadline:
    return Deadline(seconds, env.monotonic)


def _ready(app: App, req: Request) -> BankEnv:
    """The guards every route but GET runs: the switch, the OAuth env, the owner."""
    _on(app)
    env = _env(app)
    keys.require_owner(app.store, req.user_id)
    return env


def _cr_on(app: App) -> bool:
    return getattr(app, "contentrewards", None) is not None


def _view(app: App, env: BankEnv, user_id: str) -> dict[str, Any]:
    def public_key() -> dict[str, Any] | None:
        try:
            return keys.public_parts(eb.read_app(env))
        except Exception as e:  # the view still answers; the Copy chip waits for the next read
            log("warning", "bank.key_read_failed", error=type(e).__name__)
            return None

    return view.load(
        app.store,
        user_id,
        app.clock(),
        cr_on=_cr_on(app),
        values=view.values(env.app_url, env.redirect_uri),
        public_key=public_key,
    )


# --- GET ----------------------------------------------------------------------------------------------------------


def get_bank(app: App, req: Request) -> Response:
    """``BankView``; registers the owner in ``MONEYOWNERS`` and first closes old sessions (at most 5 s)."""
    if not getattr(app, "bank_reading", False):
        return ok({"on": False})
    env = _env(app)
    keys.require_owner(app.store, req.user_id)
    money.register_owner(app.store, req.user_id, app.clock())
    grants.close_pending(env, app.store, req.user_id, _deadline(env).sub(CLOSE_SECONDS))
    return ok(_view(app, env, req.user_id))


# --- the key, the app ID and the check ----------------------------------------------------------------------------


def make_key(app: App, req: Request) -> Response:
    _on(app)
    env = _env(app)
    body = req.json()
    validate.only_keys(body, {"again"})
    again = validate.boolean(body["again"], "again") if "again" in body else False
    keys.make_key(env, app.store, req.user_id, again=again)
    return ok(_view(app, env, req.user_id))


def _check(app: App, env: BankEnv, user_id: str) -> dict[str, Any]:
    key = eb.app_key(eb.read_app(env))
    if key is None or not key.app_id:
        raise ApiError(409, "conflict", "Do the steps above first.")
    found = eb.run_check(env, key, _deadline(env))
    eb.store_check(app.store, user_id, found)
    return {"view": _view(app, env, user_id), "check": found.public()}


def put_app(app: App, req: Request) -> Response:
    _on(app)
    env = _env(app)
    body = req.json()
    validate.only_keys(body, {"appId", "pem", "fileName"})
    if "pem" not in body and "appId" not in body:
        raise bad_request("Your app ID has 36 letters and numbers with dashes.", "appId")
    keys.save_app(env, app.store, req.user_id, body)
    return ok(_check(app, env, req.user_id))


def check_app(app: App, req: Request) -> Response:
    env = _ready(app, req)
    return ok(_check(app, env, req.user_id))


def patch_steps(app: App, req: Request) -> Response:
    """``{step, done}``: his green answers ("I asked", "I'm in", "I did this") and "I deleted it" (``pem-deleted``)."""
    env = _ready(app, req)
    body = req.json()
    validate.only_keys(body, {"step", "done"})
    step_id = body.get("step")
    done = validate.boolean(body.get("done"), "done")
    if not isinstance(step_id, str) or (step_id not in STEP_IDS and step_id not in TICKABLE):
        raise bad_request(STEP_UNKNOWN, "step")
    if step_id not in TICKABLE:
        raise bad_request(TICKS_ITSELF, "step")
    now = app.clock()
    conn = app.store.get(db.user_pk(req.user_id), CONN_SK) or {}
    current = {str(s) for s in conn.get("stepsDone") or []}
    if done and step_id not in current and len(current) >= MAX_STEPS_DONE:
        raise bad_request("Too many steps are ticked.", "step")
    action = "ADD" if done else "DELETE"
    app.store.update_expr(
        db.user_pk(req.user_id),
        CONN_SK,
        f"SET #t = :t, #u = :u {action} #s :s",
        names={"#t": "type", "#u": "updatedAt", "#s": "stepsDone"},
        values={":t": "bankconn", ":u": iso(now), ":s": {step_id}},
    )
    log("info", "bank.step", step=step_id, done=done)
    return ok(_view(app, env, req.user_id))


# --- banks and connect --------------------------------------------------------------------------------------------


def get_banks(app: App, req: Request) -> Response:
    env = _ready(app, req)
    return ok(grants.banks(env, app.store, req.user_id, _deadline(env)))


def connect(app: App, req: Request) -> Response:
    env = _ready(app, req)
    body = req.json()
    validate.only_keys(body, {"bank", "linkId"})
    if ("bank" in body) == ("linkId" in body):
        raise bad_request("Pick a bank from the list.", "bank")
    if "linkId" in body and not (isinstance(body["linkId"], str) and LINK_ID.match(body["linkId"])):
        raise not_found("We could not find that bank link.")
    return ok(grants.connect(env, app.store, req.user_id, body, _deadline(env)))


# --- Check now ----------------------------------------------------------------------------------------------------


def _psu(req: Request) -> dict[str, str]:
    """His IP address, browser name and language, for that one read at Enable Banking (never stored or logged)."""
    return {
        "ip": req.source_ip,
        "ua": str(req.headers.get("user-agent") or "")[:MAX_UA],
        "lang": str(req.headers.get("accept-language") or "")[:MAX_LANG],
    }


def _wants_first(link: dict[str, Any], now: datetime) -> bool:
    """A connected link whose own read hasn't started: a new link (``firstReadDone`` false), or a reconnect within an
    hour of its ``connectedAt`` (the callback REMOVEd ``firstReadStartedAt``, and full history is often there only
    in that first hour after BankID)."""
    if link.get("status") != "connected" or link.get("firstReadStartedAt"):
        return False
    if link.get("firstReadDone") is not True:
        return True
    connected = parse(link.get("connectedAt"))
    return connected is not None and timedelta(0) <= now - connected < timedelta(hours=FIRST_READ_HOURS)


def _claim_first(app: App, user_id: str, links: list[dict[str, Any]], now: datetime) -> str | None:
    """The first read of a new or reconnected link: one per link (a conditional ``firstReadStartedAt``)."""
    for link in links:
        if not _wants_first(link, now):
            continue
        try:
            app.store.update_expr(
                db.user_pk(user_id),
                link_sk(str(link["linkId"])),
                "SET #f = :at",
                condition="attribute_exists(pk) AND #s = :c AND attribute_not_exists(#f)",
                names={"#f": "firstReadStartedAt", "#s": "status"},
                values={":at": iso(now), ":c": "connected"},
            )
        except db.ConditionFailed:
            continue
        return str(link["linkId"])
    return None


def _claim_manual(app: App, user_id: str, now: datetime) -> dict[str, Any]:
    """Once every 15 minutes and 12 times a UTC day (``BANKCONN.lastManualAt`` and ``manual {day, n}``). Returns the
    old values, to give the claim back when the invoke fails."""
    pk = db.user_pk(user_id)
    conn = app.store.get(pk, CONN_SK) or {}
    allowed = view.next_check_allowed(conn, now)
    if allowed is not None:
        raise ApiError(429, "rate_limited", RATE_LIMITED, extra={"retryAt": iso(allowed)})
    today = now.date().isoformat()
    raw = conn.get("manual")
    manual: dict[str, Any] = raw if isinstance(raw, dict) else {}
    n = int(manual.get("n") or 0) if manual.get("day") == today else 0
    names = {"#t": "type", "#l": "lastManualAt", "#m": "manual", "#u": "updatedAt"}
    values: dict[str, Any] = {":t": "bankconn", ":l": iso(now), ":m": {"day": today, "n": n + 1}, ":u": iso(now)}
    if "lastManualAt" in conn:
        condition = "#l = :old"
        values[":old"] = conn["lastManualAt"]
    else:
        condition = "attribute_not_exists(#l)"
    try:
        app.store.update_expr(
            pk, CONN_SK, "SET #t = :t, #l = :l, #m = :m, #u = :u", condition=condition, names=names, values=values
        )
    except db.ConditionFailed as e:
        retry = now + timedelta(minutes=CHECK_EVERY_MINUTES)
        raise ApiError(429, "rate_limited", RATE_LIMITED, extra={"retryAt": iso(retry)}) from e
    return {k: conn[k] for k in ("lastManualAt", "manual") if k in conn}


def _give_back(app: App, user_id: str, old: dict[str, Any]) -> None:
    """The invoke failed: the claim goes back, so he can try again at once."""
    names = {"#l": "lastManualAt", "#m": "manual"}
    values: dict[str, Any] = {}
    sets, removes = [], []
    for field, holder in (("lastManualAt", "#l"), ("manual", "#m")):
        if field in old:
            values[f":{field}"] = old[field]
            sets.append(f"{holder} = :{field}")
        else:
            removes.append(holder)
    expression = " ".join(
        p for p in ("SET " + ", ".join(sets) if sets else "", "REMOVE " + ", ".join(removes) if removes else "") if p
    )
    try:
        app.store.update_expr(db.user_pk(user_id), CONN_SK, expression, names=names, values=values or None)
    except Exception as e:
        log("warning", "bank.check_give_back_failed", error=type(e).__name__)


def check_now(app: App, req: Request) -> Response:
    """``POST /v1/getpaid/bank/check``: ``cf-prod-money`` reads every bank now (202 with the view)."""
    env = _ready(app, req)
    body = req.json()
    validate.only_keys(body, {"first"})
    first = validate.boolean(body["first"], "first") if "first" in body else False
    now = app.clock()
    links = app.store.query_all(db.user_pk(req.user_id), LINK_PREFIX)
    if not any(link.get("status") == "connected" for link in links):
        raise ApiError(409, "conflict", CONNECT_FIRST)
    if app.invoker is None:  # before any claim, so nothing is held back for a read that can't start
        raise ApiError(503, "unavailable", CHECK_OFF)
    claimed: str | None = None
    old: dict[str, Any] | None = None
    if first:
        claimed = _claim_first(app, req.user_id, links, now)
        if claimed is None:  # its first read started already: nothing more to start
            return ok(_view(app, env, req.user_id), status=202)
    else:
        old = _claim_manual(app, req.user_id, now)
    try:
        app.invoker.bank_check(req.user_id, first, _psu(req), iso(now))
    except InvokeError as e:
        log("error", "bank.check_invoke_failed", error=str(e))
        if old is not None:
            _give_back(app, req.user_id, old)
        if claimed is not None:
            app.store.update_expr(
                db.user_pk(req.user_id), link_sk(claimed), "REMOVE #f", names={"#f": "firstReadStartedAt"}
            )
        raise ApiError(503, "unavailable", CHECK_NOT_STARTED) from e
    log("info", "bank.check_started", first=first)
    return ok(_view(app, env, req.user_id), status=202)


# --- answers, Stop and Forget -------------------------------------------------------------------------------------


def patch_deposit(app: App, req: Request) -> Response:
    env = _ready(app, req)
    body = req.json()
    validate.only_keys(body, {"answer", "place"})
    found = answers.answer(app.store, req.user_id, req.params["depositId"], body, app.clock(), cr_on=_cr_on(app))
    log("info", "bank.answer", answer=found)
    return ok(_view(app, env, req.user_id))


def stop_link(app: App, req: Request) -> Response:
    env = _ready(app, req)
    link_id = req.params["linkId"]
    if not LINK_ID.match(link_id):
        raise not_found("We could not find that bank link.")
    grants.stop(env, app.store, req.user_id, link_id, _deadline(env))
    return no_content()


def forget(app: App, req: Request) -> Response:
    env = _ready(app, req)
    grants.forget(env, app.store, req.user_id, _deadline(env))
    return no_content()


__all__ = [
    "check_app",
    "check_now",
    "connect",
    "forget",
    "get_bank",
    "get_banks",
    "make_key",
    "patch_deposit",
    "patch_steps",
    "put_app",
    "stop_link",
]
