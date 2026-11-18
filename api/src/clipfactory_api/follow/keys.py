"""The Twitch, Kick and YouTube read keys of Follow creators (docs/CONTRACTS.md §24.1, "Keys").

The keys go to Secrets Manager only, under the existing prefix (``cf-prod/platforms/twitch/app``,
``…/kick/app``, ``…/youtube/readkey``), created at runtime like the posting keys (§17.4): no Terraform resource holds
them, so a deploy can never replace or delete them. Saving the Twitch keys also makes the EventSub secret
(``…/twitch/eventsub``, 64 random hex characters) once; Twitch signs every webhook with it.

"Remove keys" never deletes a secret: it writes ``{"removed": true}`` as the new version, so the old version stays in
Secrets Manager's history. A response carries masked hints only; nothing here logs a key.
"""

from __future__ import annotations

import re
import secrets as random
from datetime import datetime
from typing import Any

from .. import db
from ..clock import iso
from ..errors import bad_request
from ..log import log
from ..oauth import formats
from . import KEY_PLATFORMS, LABELS, all_follows, keys_sk
from . import platforms as pf

Item = dict[str, Any]

FIELDS: dict[str, tuple[str, ...]] = {
    "twitch": ("clientId", "clientSecret"),
    "kick": ("clientId", "clientSecret"),
    "youtube-read": ("apiKey",),
}
FORMATS: dict[str, dict[str, tuple[re.Pattern[str], str]]] = {
    "twitch": {
        "clientId": (
            re.compile(r"^[a-z0-9]{20,40}$"),
            "The Twitch Client ID is about 30 small letters and numbers. Copy it again.",
        ),
        "clientSecret": (
            re.compile(r"^[a-z0-9]{20,40}$"),
            "The Twitch Client Secret is about 30 small letters and numbers. Press New Secret, then copy it.",
        ),
    },
    "kick": {
        "clientId": (
            re.compile(r"^[A-Za-z0-9_-]{8,128}$"),
            "The Kick Client ID is a long line of letters and numbers. Copy it again.",
        ),
        "clientSecret": (
            re.compile(r"^[A-Za-z0-9_-]{16,256}$"),
            "The Kick Client Secret is a long line of letters and numbers. Copy it again.",
        ),
    },
    "youtube-read": {
        "apiKey": (
            re.compile(r"^AIza[0-9A-Za-z_-]{35}$"),
            "A YouTube key starts with AIza and is 39 letters long. Copy it again.",
        ),
    },
}
CHECK_CHANNEL = "UC_x5XG1OV2P6uZZ5FSM9Ttw"  # Google for Developers: a channel that always exists


def item(store: db.Store, user_id: str, platform: str) -> Item:
    return store.get(db.user_pk(user_id), keys_sk(platform)) or {}


def overview(store: db.Store, env: pf.FollowEnv, user_id: str) -> list[Item]:
    """Each key slot: saved or not, masked hints, the last check, and whether a follow needs it."""
    follows = all_follows(store, user_id)
    used = {str(f.get("platform")) for f in follows}
    out = []
    for platform in KEY_PLATFORMS:
        found = item(store, user_id, platform)
        row: Item = {
            "platform": platform,
            "saved": bool(found.get("savedAt")),
            "needed": platform in used,
            "optional": platform == "youtube-read",
        }
        for name in ("savedAt", "hints", "check"):
            if found.get(name):
                row[name] = found[name]
        out.append(row)
    return out


def clean(platform: str, body: dict[str, Any]) -> dict[str, str]:
    wanted = FIELDS[platform]
    extra = sorted(set(body) - set(wanted))
    if extra:
        raise bad_request(f"Unknown field: {extra[0]}.")
    out = {}
    for name in wanted:
        pattern, message = FORMATS[platform][name]
        value = body.get(name)
        text = formats.clean(value) if isinstance(value, str) else ""
        if not text or len(text) > 400 or not pattern.match(text):
            raise bad_request(message, name)
        out[name] = text
    return out


def save(
    store: db.Store, env: pf.FollowEnv, user_id: str, platform: str, *, values: dict[str, str], now: datetime
) -> Item:
    if env.secrets is None:
        raise bad_request("Keys cannot be saved in this app yet.")
    secret: Item = {**values, "userId": user_id, "savedAt": iso(now)}
    secret_platform = "youtube" if platform == "youtube-read" else platform
    env.secrets.write(pf.secret_name(env.secrets, platform), secret, platform=secret_platform)
    if platform == "twitch" and not env.eventsub_secret():
        env.secrets.write(
            pf.secret_name(env.secrets, "twitch-eventsub"),
            {"secret": random.token_hex(32), "createdAt": iso(now)},
            platform="twitch",
        )
    env.forget_token(platform)
    hints = {
        name: formats.hint("clientId" if name == "clientId" else "clientSecret", value)
        for name, value in values.items()
    }
    store.put(
        {
            "pk": db.user_pk(user_id),
            "sk": keys_sk(platform),
            "type": "followkeys",
            "userId": user_id,
            "platform": platform,
            "savedAt": iso(now),
            "hints": hints,
        }
    )
    log("info", "follow.keys_saved", platform=platform)
    return item(store, user_id, platform)


def remove(store: db.Store, env: pf.FollowEnv, user_id: str, platform: str, now: datetime) -> None:
    """Writes ``{"removed": true}`` over the keys (the old version stays in the secret's history)."""
    if env.secrets is not None and env.keys(platform, fresh=True) is not None:
        secret_platform = "youtube" if platform == "youtube-read" else platform
        env.secrets.write(
            pf.secret_name(env.secrets, platform), {"removed": True, "removedAt": iso(now)}, platform=secret_platform
        )
    env.forget_token(platform)
    store.put(
        {
            "pk": db.user_pk(user_id),
            "sk": keys_sk(platform),
            "type": "followkeys",
            "userId": user_id,
            "platform": platform,
            "removedAt": iso(now),
        }
    )
    log("info", "follow.keys_removed", platform=platform)


def check(store: db.Store, env: pf.FollowEnv, user_id: str, platform: str, now: datetime) -> Item:
    """Asks the platform whether the keys work: an app token (Twitch, Kick) or one 1-unit read (YouTube)."""
    label = LABELS[platform]
    try:
        if env.keys(platform, fresh=True) is None:
            result: Item = {"ok": False, "code": "no_keys", "message": f"Paste the {label} keys first."}
        elif platform == "youtube-read":
            pf.youtube_channel(env, CHECK_CHANNEL)
            result = {"ok": True, "code": "ok", "message": "It works. Clip Factory can see who is live on YouTube."}
        else:
            env.forget_token(platform)
            env.token(platform)
            result = {"ok": True, "code": "ok", "message": f"It works. Clip Factory can see who is live on {label}."}
    except pf.KeysRejectedError:
        result = {"ok": False, "code": "keys_rejected", "message": f"{label} said no to these keys. Copy them again."}
    except pf.PlatformDownError:
        result = {"ok": False, "code": "platform_down", "message": f"{label} did not answer. Try again in a minute."}
    result["at"] = iso(now)
    found = item(store, user_id, platform)
    if found:
        store.update(db.user_pk(user_id), keys_sk(platform), {"check": result})
    return result
