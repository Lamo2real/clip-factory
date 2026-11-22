"""The bank key, the app ID and the owner (docs/CONTRACTS.md §40.5.1, §40.5.4; builder BA).

* ``claim_owner`` / ``require_owner``: the first signed-in user who makes a bank key is written to ``BANKOWNER`` (a
  conditional put); anyone else gets 403 "Your bank is only for the owner of this Clip Factory." (Enable Banking's
  free use is for one private person: nobody else is ever offered it.)
* ``make_key`` ("Make my bank key"): an RSA-4096 pair (public exponent 65537), a self-signed X.509 certificate (CN
  "Clip Factory", 10 years, SHA-256) and, only the first time, a 32-byte ``hashKey``, straight into
  ``cf-prod/platforms/bank/app``. The private key and ``hashKey`` never leave Secrets Manager and the Lambdas'
  memory; ``BankView.key`` carries only the public key and the certificate.
* ``save_app`` ("Save"): the app ID (a UUID, stored lower-cased), or the .pem file of Enable Banking's default path
  (a PKCS#8 RSA key of 2048 bits or more, at most 8 KB), which replaces Clip Factory's key. The .pem is never logged,
  echoed or stored outside the secret.

While any bank link still has a session (its ``status`` isn't ``stopped``, or it has ``closePending``), a new key, a
new app ID or any .pem gets 409 "Stop reading every bank first.": sessions belong to the old app.
"""

from __future__ import annotations

import base64
import re
import secrets as random
from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any

from .. import db
from ..clock import iso
from ..errors import ApiError, bad_request, conflict
from ..log import log
from . import (
    APP_ID,
    APP_ID_BAD,
    APP_ID_TOO,
    CONN_SK,
    KEY_FIRST,
    LINK_PREFIX,
    NOT_OWNER,
    OWNER_PK,
    OWNER_SK,
    PEM_BAD,
    PEM_DELETED,
    PLATFORM,
    STOP_FIRST,
)
from .eb import BankEnv

Item = dict[str, Any]
KEY_BITS = 4096
MIN_FILE_BITS = 2048
CERT_DAYS = 3652  # 10 years
MAX_PEM_BYTES = 8 * 1024
PEM_FIRST_LINE = "-----BEGIN PRIVATE KEY-----"
FILE_NAME = re.compile(r"^([0-9a-fA-F-]{36})(?: \(\d+\))?\.pem$")


# --- the owner ----------------------------------------------------------------------------------------------------


def owner(store: db.Store) -> str | None:
    item = store.get(OWNER_PK, OWNER_SK) or {}
    found = item.get("userId")
    return found if isinstance(found, str) and found else None


def require_owner(store: db.Store, user_id: str) -> None:
    """403 for anyone but ``BANKOWNER`` (nobody is the owner before the first key)."""
    found = owner(store)
    if found is not None and found != user_id:
        raise ApiError(403, "forbidden", NOT_OWNER)


def claim_owner(store: db.Store, user_id: str, now: datetime) -> None:
    try:
        store.put(
            {"pk": OWNER_PK, "sk": OWNER_SK, "type": "bankowner", "userId": user_id, "claimedAt": iso(now)},
            if_absent=True,
        )
    except db.ConditionFailed:
        require_owner(store, user_id)
        return
    log("info", "bank.owner_claimed")


# --- sessions -----------------------------------------------------------------------------------------------------


def links(store: db.Store, user_id: str) -> list[Item]:
    return store.query_all(db.user_pk(user_id), LINK_PREFIX)


def has_session(link: Mapping[str, Any]) -> bool:
    return link.get("status") != "stopped" or bool(link.get("closePending"))


def any_session(store: db.Store, user_id: str) -> bool:
    return any(has_session(link) for link in links(store, user_id))


# --- key material -------------------------------------------------------------------------------------------------


def _generate() -> Any:
    from cryptography.hazmat.primitives.asymmetric import rsa

    return rsa.generate_private_key(public_exponent=65537, key_size=KEY_BITS)


def material(private_key: Any, now: datetime) -> Item:
    """``{privateKeyPem (PKCS#8), publicKeyPem (SPKI), certificatePem}`` for one RSA key."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.x509.oid import NameOID

    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Clip Factory")])
    start = now.replace(microsecond=0)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(start)
        .not_valid_after(start + timedelta(days=CERT_DAYS))
        .sign(private_key, hashes.SHA256())
    )
    return {
        "privateKeyPem": private_key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        ).decode(),
        "publicKeyPem": private_key.public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode(),
        "certificatePem": certificate.public_bytes(serialization.Encoding.PEM).decode(),
    }


def new_hash_key() -> str:
    return base64.b64encode(random.token_bytes(32)).decode()


def public_parts(secret: Mapping[str, Any] | None) -> Item | None:
    """What ``BankView.key`` may carry: the public key, the certificate and where the key came from. Never the
    private key, ``hashKey`` or the app ID."""
    if not secret or not isinstance(secret.get("publicKeyPem"), str):
        return None
    out: Item = {"publicKeyPem": secret["publicKeyPem"]}
    if isinstance(secret.get("certificatePem"), str):
        out["certificatePem"] = secret["certificatePem"]
    if secret.get("source") in {"clipfactory", "file"}:
        out["source"] = secret["source"]
    return out


def _set_app(
    store: db.Store, user_id: str, now: datetime, app: Mapping[str, Any], *, untick: frozenset[str] = frozenset()
) -> None:
    """One UpdateItem on ``BANKCONN``: the whole ``app`` map, and the ticks a new key makes stale."""
    names = {"#t": "type", "#a": "app", "#u": "updatedAt"}
    values: Item = {":t": "bankconn", ":a": dict(app), ":u": iso(now)}
    expression = "SET #t = :t, #a = :a, #u = :u"
    if untick:
        names["#s"] = "stepsDone"
        values[":p"] = set(untick)
        expression += " DELETE #s :p"
    store.update_expr(db.user_pk(user_id), CONN_SK, expression, names=names, values=values)


# A new pair belongs to no Enable Banking app yet: steps 3 and 4 (a new app with the new public key) start again.
NEW_KEY_UNTICKS = frozenset({"bank-app", "bank-details"})


def conn(store: db.Store, user_id: str) -> Item:
    return store.get(db.user_pk(user_id), CONN_SK) or {}


def make_key(env: BankEnv, store: db.Store, user_id: str, *, again: bool) -> bool:
    """ "Make my bank key". True when a key was made; with a key already there (and no ``again``) nothing changes."""
    now = env.clock()
    claim_owner(store, user_id, now)
    name = env.app_name()
    current = env.secrets.read(name, fresh=True) or {}
    if current.get("privateKeyPem") and not again:
        return False
    if current.get("privateKeyPem") and any_session(store, user_id):
        raise conflict(STOP_FIRST)
    hash_key = current.get("hashKey") if isinstance(current.get("hashKey"), str) else None
    made = material(_generate(), now)
    env.secrets.write(
        name,
        {
            **made,
            "hashKey": hash_key or new_hash_key(),  # kept on "again", so depositIds never change
            "appId": None,
            "source": "clipfactory",
            "keyMadeAt": iso(now),
        },
        platform=PLATFORM,
    )
    # A new pair belongs to no Enable Banking app yet: the app ID and its check go with the old one.
    _set_app(
        store,
        user_id,
        now,
        {"status": "key_made", "source": "clipfactory", "keyMadeAt": iso(now)},
        untick=NEW_KEY_UNTICKS if current.get("privateKeyPem") else frozenset(),
    )
    log("info", "bank.key_made", again=again)
    return True


def _app_id(raw: Any) -> str:
    if not isinstance(raw, str) or not APP_ID.match(raw.strip()):
        raise bad_request(APP_ID_BAD, "appId")
    return raw.strip().lower()


def _load_pem(pem: Any) -> Any:
    """The RSA key in a pasted or uploaded .pem; 400 with the friendly sentence for anything else."""
    if not isinstance(pem, str) or not pem.strip() or len(pem.encode()) > MAX_PEM_BYTES:
        raise bad_request(PEM_BAD, "pem")
    if pem.strip().splitlines()[0].strip() != PEM_FIRST_LINE:
        raise bad_request(PEM_BAD, "pem")
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    try:
        key = serialization.load_pem_private_key(pem.strip().encode(), password=None)
    except (ValueError, TypeError) as e:
        raise bad_request(PEM_BAD, "pem") from e
    if not isinstance(key, rsa.RSAPrivateKey) or key.key_size < MIN_FILE_BITS:
        raise bad_request(PEM_BAD, "pem")
    return key


def save_app(env: BankEnv, store: db.Store, user_id: str, body: Mapping[str, Any]) -> bool:
    """ "Save" (``PUT /v1/getpaid/bank/app``). True when the stored key or app ID changed (False: the same app ID,
    which only runs the check again). The caller runs the check either way."""
    now = env.clock()
    pem = body.get("pem")
    name = env.app_name()
    if pem is not None:
        claim_owner(store, user_id, now)
        if "appId" in body:
            app_id = _app_id(body.get("appId"))
        else:
            found = FILE_NAME.match(str(body.get("fileName") or ""))
            if found is None or not APP_ID.match(found.group(1)):
                raise bad_request(APP_ID_TOO, "appId")
            app_id = found.group(1).lower()
        key = _load_pem(pem)
        if any_session(store, user_id):
            raise conflict(STOP_FIRST)
        current = env.secrets.read(name, fresh=True) or {}
        hash_key = current.get("hashKey") if isinstance(current.get("hashKey"), str) else None
        env.secrets.write(
            name,
            {
                **material(key, now),
                "hashKey": hash_key or new_hash_key(),
                "appId": app_id,
                "source": "file",
                "keyMadeAt": iso(now),
            },
            platform=PLATFORM,
        )
        app = {
            "status": "saved",
            "source": "file",
            "keyMadeAt": iso(now),
            "savedAt": iso(now),
            "appIdHint": f"{app_id[:8]}…",
        }
        _set_app(store, user_id, now, app, untick=frozenset({PEM_DELETED}))
        log("info", "bank.pem_saved")
        return True
    require_owner(store, user_id)
    app_id = _app_id(body.get("appId"))
    current = env.secrets.read(name, fresh=True) or {}
    if not current.get("privateKeyPem"):
        raise conflict(KEY_FIRST)
    if current.get("appId") == app_id:
        return False
    if any_session(store, user_id):
        raise conflict(STOP_FIRST)
    env.secrets.write(name, {**current, "appId": app_id}, platform=PLATFORM)
    stored = conn(store, user_id).get("app")
    old: Mapping[str, Any] = stored if isinstance(stored, Mapping) else {}
    app = {
        "status": "saved",
        "source": old.get("source") or current.get("source") or "clipfactory",
        "keyMadeAt": old.get("keyMadeAt") or current.get("keyMadeAt") or iso(now),
        "savedAt": iso(now),
        "appIdHint": f"{app_id[:8]}…",  # a new app ID starts without a check: the old one was for another app
    }
    _set_app(store, user_id, now, app)
    log("info", "bank.app_id_saved")
    return True
