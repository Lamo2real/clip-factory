"""The setup and account items, and their public shapes (docs/CONTRACTS.md §17.4).

* ``SETUP#{platform}`` (under ``USER#{userId}``): ``stepsDone`` (string set), ``keysSavedAt``, ``keyHints``,
  ``keysClientId`` (the public id only, to notice new keys), ``check``, ``gates`` (owner-picked or learned states),
  ``choices`` + ``choicesExpireAt`` (Meta pickers), ``files`` (TikTok verification files), ``lastResult``.
* ``ACCOUNT#{platform}``: one per platform (``posts.public_account`` is its public shape).

No key or token is ever stored here: those live in Secrets Manager only.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from datetime import datetime
from typing import Any

from .. import db, posts
from ..clock import iso, parse
from ..platforms.base import obj
from . import APP_NAME, SETUP_ORDER, OAuthEnv, host

Item = dict[str, Any]
STEP_ID = re.compile(r"^[a-z0-9-]{1,40}$")
MAX_STEPS = 60
GATE_STATES = ("ok", "limited", "waiting", "action", "unknown")
APP_REVIEW = {"draft": "limited", "not_approved": "limited", "in_review": "waiting", "live": "ok"}


def setup_sk(platform: str) -> str:
    return f"SETUP#{platform}"


def account_sk(platform: str) -> str:
    return f"ACCOUNT#{platform}"


def oauth_pk(nonce: str) -> str:
    return f"OAUTH#{nonce}"


OAUTH_SK = "STATE"


# --- values the web shows on Copy chips ---------------------------------------------------------------------------


def values(env: OAuthEnv, owner_email: str = "") -> Item:
    app = env.app_base
    privacy = f"{app}/legal/privacy.html"
    return {
        "appName": APP_NAME,
        "websiteUrl": f"{app}/about.html",
        "websitePrefix": f"{app}/",
        "privacyUrl": privacy,
        "termsUrl": f"{app}/legal/terms.html",
        "dataDeletionUrl": f"{privacy}#delete",
        "appDomain": host(app),
        "hooksDomain": host(env.hooks_url),
        "redirectUris": {p: env.redirect_uri(p) for p in SETUP_ORDER},
        "scopes": {p: list(env.scopes.get(p, ())) for p in SETUP_ORDER},
        "ownerEmail": owner_email,
    }


# --- reading -------------------------------------------------------------------------------------------------------


def items(store: db.Store, user_id: str) -> dict[str, Item]:
    found = store.query_all(db.user_pk(user_id), "SETUP#", consistent=True)
    return {str(i.get("platform")): i for i in found if i.get("platform") in SETUP_ORDER}


def item(store: db.Store, user_id: str, platform: str) -> Item:
    return store.get(db.user_pk(user_id), setup_sk(platform)) or {}


def account_item(store: db.Store, user_id: str, platform: str) -> Item | None:
    return store.get(db.user_pk(user_id), account_sk(platform))


def gates(platform: str, setup: Mapping[str, Any], account: Mapping[str, Any]) -> list[Item]:
    stored = obj(setup.get("gates"))
    steps = set(setup.get("stepsDone") or [])
    connected = account.get("status") == "connected"

    def gate(key: str, state: str) -> Item:
        out: Item = {"key": key, "state": state}
        at = obj(stored.get(key)).get("at")
        if at:
            out["at"] = at
        return out

    def stored_state(key: str) -> str | None:
        raw = stored.get(key)
        state = raw.get("state") if isinstance(raw, Mapping) else None
        return state if state in GATE_STATES else None

    if platform == "youtube":
        return [gate("published_app", "ok" if "key-publish" in steps else "action")]
    if platform == "tiktok":
        review = obj(stored.get("app_review")).get("value")
        audit = stored_state("posting_audit") if connected else None
        return [gate("app_review", APP_REVIEW.get(str(review), "limited")), gate("posting_audit", audit or "unknown")]
    if platform in {"instagram", "facebook"}:  # Development mode: only the owner sees the Reels until it is Live
        return [gate("app_live", "ok" if "public-live" in steps else "limited")]
    if platform == "x":
        return [gate("credits", stored_state("credits") or ("ok" if connected else "unknown"))]
    return []


def public_setup(
    setup: Mapping[str, Any] | None,
    account: Mapping[str, Any] | None,
    setup_values: Any = None,
    *,
    now: datetime | None = None,
) -> Item:
    """``PlatformSetup`` (§17.4). ``account`` is the public Account. ``setup_values`` (SetupValues) is accepted to
    match the contract name and is not needed here. Meta choices show until ``choicesExpireAt`` (checked when
    ``now`` is given)."""
    setup = setup or {}
    platform = str(setup.get("platform") or (account or {}).get("platform") or "")
    acct: Item = dict(account or {"platform": platform, "status": "not_connected"})
    choices = setup.get("choices")
    expires = parse(setup.get("choicesExpireAt"))
    fresh = expires is None or now is None or expires > now
    if acct.get("status") == "choose_account" and isinstance(choices, list) and choices and fresh:
        acct["choices"] = [{k: c.get(k) for k in ("id", "name", "avatarUrl") if c.get(k)} for c in choices]
    gate_list = gates(platform, setup, acct)
    keys: Item = {"saved": bool(setup.get("keysSavedAt"))}
    if keys["saved"]:
        if isinstance(setup.get("keyHints"), Mapping):
            keys["hints"] = dict(setup["keyHints"])
        keys["savedAt"] = setup["keysSavedAt"]
    if isinstance(setup.get("check"), Mapping):
        keys["check"] = dict(setup["check"])
    out: Item = {
        "platform": platform,
        "stepsDone": sorted(str(s) for s in setup.get("stepsDone") or []),
        "ready": acct.get("status") == "connected" and not any(g["state"] == "action" for g in gate_list),
        "keys": keys,
        "account": acct,
        "gates": gate_list,
    }
    if platform == "tiktok":
        out["files"] = sorted(str(f) for f in setup.get("files") or [])
    if setup.get("updatedAt"):
        out["updatedAt"] = setup["updatedAt"]
    return out


def all_setups(store: db.Store, user_id: str, now: datetime | None = None) -> list[Item]:
    found = items(store, user_id)
    accounts = {a["platform"]: a for a in posts.accounts(store, user_id)}
    return [
        public_setup(
            {"platform": p, **found.get(p, {})},
            accounts.get(p, {"platform": p, "status": "not_connected"}),
            now=now,
        )
        for p in SETUP_ORDER
    ]


def one_setup(store: db.Store, user_id: str, platform: str, now: datetime | None = None) -> Item:
    return next(s for s in all_setups(store, user_id, now) if s["platform"] == platform)


# --- writing -------------------------------------------------------------------------------------------------------


def record(
    store: db.Store,
    user_id: str,
    platform: str,
    now: datetime,
    fields: Mapping[str, Any] | None = None,
    *,
    remove: Iterable[str] = (),
    add_steps: Iterable[str] = (),
    drop_steps: Iterable[str] = (),
    add_files: Iterable[str] = (),
    drop_files: Iterable[str] = (),
) -> Item:
    """Upserts the SETUP item: sets ``fields``, removes ``remove`` and adds/drops step ids and file names (sets)."""
    sets: Item = {"type": "setup", "userId": user_id, "platform": platform, "updatedAt": iso(now), **(fields or {})}
    names: dict[str, str] = {}
    vals: Item = {}
    parts = []
    for i, (name, value) in enumerate(sets.items()):
        names[f"#s{i}"] = name
        vals[f":s{i}"] = value
        parts.append(f"#s{i} = :s{i}")
    expression = "SET " + ", ".join(parts)
    removes = [f"#r{i}" for i, _ in enumerate(remove)]
    for i, name in enumerate(remove):
        names[f"#r{i}"] = name
    if removes:
        expression += " REMOVE " + ", ".join(removes)
    adds: list[str] = []
    deletes: list[str] = []
    for field, extra, bucket, tag in (
        ("stepsDone", set(add_steps), adds, "as"),
        ("files", set(add_files), adds, "af"),
        ("stepsDone", set(drop_steps), deletes, "ds"),
        ("files", set(drop_files), deletes, "df"),
    ):
        if extra:
            names[f"#{tag}"] = field
            vals[f":{tag}"] = extra
            bucket.append(f"#{tag} :{tag}")
    if adds:
        expression += " ADD " + ", ".join(adds)
    if deletes:
        expression += " DELETE " + ", ".join(deletes)
    return store.update_expr(db.user_pk(user_id), setup_sk(platform), expression, names=names, values=vals)


def put_account(
    store: db.Store, user_id: str, platform: str, status: str, *, now: datetime, fields: Mapping[str, Any] | None = None
) -> Item:
    """Replaces the platform's Account item (one per platform, ``ACCOUNT#{platform}``)."""
    item: Item = {
        "pk": db.user_pk(user_id),
        "sk": account_sk(platform),
        "type": "account",
        "userId": user_id,
        "platform": platform,
        "status": status,
        "updatedAt": iso(now),
        **{k: v for k, v in (fields or {}).items() if v not in (None, "", [])},
    }
    store.put(item)  # PutItem only: cf-prod-hooks writes this too and has no Query or DeleteItem on accounts
    return item


def mark_account(
    store: db.Store, user_id: str, platform: str, now: datetime, *, remove: Iterable[str] = (), **fields: Any
) -> None:
    """Sets fields on an existing Account item (``needs_reconnect``, ``reason``...); a missing one stays missing."""
    try:
        store.update(db.user_pk(user_id), account_sk(platform), {**fields, "updatedAt": iso(now)}, remove=remove)
    except db.ConditionFailed:
        return


def set_gate(
    store: db.Store, user_id: str, platform: str, gate: str, *, state: str, now: datetime, **extra: Any
) -> None:
    current = item(store, user_id, platform).get("gates")
    gates_map: Item = dict(current) if isinstance(current, Mapping) else {}
    gates_map[gate] = {"state": state, "at": iso(now), **extra}
    record(store, user_id, platform, now, {"gates": gates_map})
