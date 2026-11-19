"""/v1/money: paid-programme progress and platform-reported money (docs/CONTRACTS.md §25.5).

Reading only: the platforms are read by ``cf-prod-money`` (daily, and on Check now through an async Invoke limited
to once an hour by one conditional write). Nothing here accepts a money amount.
"""

from __future__ import annotations

from datetime import date, timedelta

from .. import db, money, validate
from ..app import App
from ..async_invoke import InvokeError
from ..clock import iso
from ..errors import ApiError, bad_request, not_found
from ..http import Request, Response, ok
from ..log import log
from ..money import rules, view

REFRESH_EVERY = timedelta(hours=1)


def _view(app: App, req: Request) -> dict[str, object]:
    now = app.clock()
    money.register_owner(app.store, req.user_id, now)
    return view.money_view(app.store, req.user_id, now)


def get_money(app: App, req: Request) -> Response:
    return ok(_view(app, req))


def get_days(app: App, req: Request) -> Response:
    platform = req.params["platform"]
    if platform not in money.MONEY_ORDER:
        raise not_found("We do not support that platform.")
    today = app.clock().date()
    try:
        start = date.fromisoformat(req.query.get("from") or (today - timedelta(days=30)).isoformat())
        end = date.fromisoformat(req.query.get("to") or today.isoformat())
    except ValueError as e:
        raise bad_request("from and to must be dates like 2026-11-18.") from e
    if end < start or (end - start).days > view.MAX_DAYS_RANGE:
        raise bad_request(f"Ask for at most {view.MAX_DAYS_RANGE} days, with from before to.")
    return ok({"days": view.day_rows(app.store, req.user_id, platform, start, end)})


def refresh(app: App, req: Request) -> Response:
    """Check now: one conditional write claims the hour, then ``cf-prod-money`` reads every platform."""
    now = app.clock()
    money.register_owner(app.store, req.user_id, now)
    pk = db.user_pk(req.user_id)
    try:
        app.store.update_expr(
            pk,
            money.PREFS_SK,
            "SET #t = :type, #m = :now",
            condition="attribute_not_exists(#m) OR #m <= :ago",
            names={"#t": "type", "#m": "lastManualAt"},
            values={":type": "moneyprefs", ":now": iso(now), ":ago": iso(now - REFRESH_EVERY)},
        )
    except db.ConditionFailed:
        prefs = money.get_prefs(app.store, req.user_id)
        return ok({"started": False, "nextAllowedAt": _next(prefs.get("lastManualAt"), now)})
    if app.invoker is None:
        raise ApiError(503, "unavailable", "Checking money is not switched on for this app yet.")
    try:
        app.invoker.refresh_money(req.user_id)
    except InvokeError as e:
        log("error", "money.refresh_invoke_failed", error=str(e))
        # Give the hour back so the owner can try again at once.
        app.store.update_expr(pk, money.PREFS_SK, "REMOVE #m", names={"#m": "lastManualAt"})
        raise ApiError(503, "unavailable", "Could not start the check. Try again in a minute.") from e
    return ok({"started": True, "nextAllowedAt": iso(now + REFRESH_EVERY)}, status=202)


def _next(last: object, now: object) -> str | None:
    from ..clock import parse

    moment = parse(last) if isinstance(last, str) else None
    return iso(moment + REFRESH_EVERY) if moment is not None else None


def seen(app: App, req: Request) -> Response:
    """The owner saw a celebration: only a key that is pending moves to ``celebrated`` (it never plays again)."""
    body = req.json()
    validate.only_keys(body, {"key"})
    key = validate.required_string(body, "key", max_len=120)
    platform = key.split(":", 1)[0]
    if platform not in money.MONEY_ORDER:
        raise not_found("That celebration is not waiting.")
    pk = db.user_pk(req.user_id)
    item = app.store.get(pk, money.state_sk(platform)) or {}
    celebrated = item.get("celebrated") or {}
    pending = [c for c in item.get("pendingCelebrations") or [] if isinstance(c, dict)]
    if key in celebrated or not any(c.get("key") == key for c in pending):
        raise not_found("That celebration is not waiting.")
    # Only ``celebrated.<key>`` is written, never the pending list: the collector may be appending to that
    # list right now, and the view hides any pending key that is already celebrated (the collector prunes it).
    when = iso(app.clock())
    for _ in range(2):
        try:
            app.store.update_expr(
                pk,
                money.state_sk(platform),
                "SET #c.#k = :t",
                condition="attribute_exists(#c)",
                names={"#c": "celebrated", "#k": key},
                values={":t": when},
            )
            break
        except db.ConditionFailed:
            try:
                app.store.update_expr(
                    pk,
                    money.state_sk(platform),
                    "SET #c = :m",
                    condition="attribute_not_exists(#c)",
                    names={"#c": "celebrated"},
                    values={":m": {key: when}},
                )
                break
            except db.ConditionFailed:
                continue  # someone else made the map a moment ago: set the key inside it
    return ok(_view(app, req))


def put_country(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, {"country"})
    country = validate.required_string(body, "country", max_len=8)
    if country not in rules.load().country_codes():
        raise bad_request("Pick your country from the list.", "country")
    app.store.update_expr(
        db.user_pk(req.user_id),
        money.PREFS_SK,
        "SET #t = :type, #c = :c, #u = :u",
        names={"#t": "type", "#c": "country", "#u": "countryAt"},
        values={":type": "moneyprefs", ":c": country, ":u": iso(app.clock())},
    )
    return ok(_view(app, req))
