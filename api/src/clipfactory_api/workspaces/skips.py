"""Clips Funded's platform skips (the owner, 24 Nov: "if i skip on a platform setup then i dont want to see it
anywhere except in settings or social accounts tab").

* **Storage**: the platform keys (``ws.PLATFORMS``) of the workspace's ``ONBOARD.skipped``, written by the setup's own
  ``PATCH …/onboarding {step, skipped}`` (``onboarding.patch``). Every other key there keeps its meaning ("later").
  Nothing new is stored, so a skip saved before this module existed counts at once.
* **Skipped** = in ``ONBOARD.skipped`` and not ``connected`` as Social accounts shows it (``SocialAccount.skipped``).
  A skipped platform is left out of the dashboard's accounts and Needs you, and of the setup's count
  (``Onboarding.total``); it shows only on Social accounts and in the setup.
* **Connected wins**: a read that works out the accounts (``mark``) drops the platforms connected now from
  ``ONBOARD.skipped``, so one that later needs the owner comes back to every list. The drop is one put of the whole
  item, conditional on the ``updatedAt`` read; a write that landed meanwhile wins and the next read tries again.
* **Separation**: only this workspace's ``ONBOARD`` item is read or written. Clip Factory's skips
  (``SETTINGS.setupSkipped``) are its own; nothing here reads or writes them, nor any account.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import datetime
from typing import Any, Final

from .. import db
from ..clock import iso
from ..log import log
from . import guard
from . import types as ws

Item = dict[str, Any]

CONNECTED: Final = "connected"
SOCIAL_ACCOUNTS: Final = "/stories/connections"  # Clips Funded › Social accounts


def stored(item: Mapping[str, Any] | None) -> list[str]:
    """The platform keys of ``ONBOARD.skipped``, in ``ws.PLATFORMS`` order."""
    raw = (item or {}).get("skipped")
    found = {str(s) for s in raw} if isinstance(raw, list | tuple | set) else set()
    return [p for p in ws.PLATFORMS if p in found]


def effective(stored: Iterable[str], statuses: Mapping[str, str]) -> frozenset[str]:
    """The stored skips minus the platforms that are connected now (connected wins)."""
    return frozenset(p for p in stored if p in ws.PLATFORMS and statuses.get(p) != CONNECTED)


def _read(store: db.Store, user_id: str, workspace_id: str) -> Item | None:
    item = store.get(ws.workspace_pk(user_id, workspace_id), ws.ONBOARD_SK)
    return item if guard.owned(item, user_id, workspace_id) else None


def _drop(store: db.Store, item: Mapping[str, Any], stale: frozenset[str], now: datetime) -> None:
    """Drops ``stale`` from ``ONBOARD.skipped``: one put of the whole item, only while it is still the one read."""
    kept = [s for s in item.get("skipped") or [] if str(s) not in stale]
    fresh = {**item, "skipped": kept, "updatedAt": iso(now)}
    before = item.get("updatedAt")
    if isinstance(before, str) and before:
        condition, values = "#u = :before", {":before": before}
    else:
        condition, values = "attribute_exists(pk) AND attribute_not_exists(#u)", None
    try:
        store.put_when(fresh, condition, names={"#u": "updatedAt"}, values=values)
    except db.ConditionFailed:
        log("info", "ws_skips.drop_raced", dropped=",".join(sorted(stale)))  # the next read tries again
        return
    except Exception as e:  # best effort: the answer is right either way
        log("warning", "ws_skips.drop_failed", error=type(e).__name__)
        return
    log("info", "ws_skips.dropped", dropped=",".join(sorted(stale)))


def mark(store: db.Store, user_id: str, workspace_id: str, accounts: list[Item], now: datetime) -> list[Item]:
    """Sets every account's ``skipped`` from one ``ONBOARD`` read, and drops the stale skips (the platforms among
    ``accounts`` that are connected now). ``accounts`` are public ``SocialAccount`` shapes; they are changed in place
    and returned."""
    item = _read(store, user_id, workspace_id)
    skipped = stored(item)
    statuses = {str(a.get("platform")): str(a.get("connectionStatus") or "not_connected") for a in accounts}
    live = effective(skipped, statuses)
    for account in accounts:
        account["skipped"] = str(account.get("platform")) in live
    stale = frozenset(p for p in skipped if statuses.get(p) == CONNECTED)
    if item is not None and stale:
        _drop(store, item, stale, now)
    return accounts


def social_href(platform: str | None) -> str:
    """A platform's own page under Social accounts; plain Social accounts when there is no platform."""
    return f"{SOCIAL_ACCOUNTS}/{platform}" if platform in ws.PLATFORMS else SOCIAL_ACCOUNTS
