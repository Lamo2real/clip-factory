"""The public campaign JSON (docs/CONTRACTS.md §38.10 "Preview").

``GET https://contentrewards.com/api/campaign/campaigns/{uuid}``: public and undocumented, and robots.txt disallows
``/api/`` for crawlers, so it is read **only when the owner acts** (add, Check now, opening a card older than 10
minutes, a job's start), never on a schedule; at most 6 reads a minute per container; never used to submit.
``Accept: application/json``, ``User-Agent: ClipFactory/1``, 6 s, ≤ 512 KB, no cookies, redirects followed only to
``contentrewards.com``. When the JSON fails, the page's Open Graph line fills the name and pay.
"""

from __future__ import annotations

import html
import json
import re
import time
import urllib.parse
from collections import deque
from collections.abc import Callable, Mapping
from typing import Any

from ..platforms.base import HttpRequest, HttpResponse
from . import config
from .net import Net, NetworkError

Item = dict[str, Any]
TIMEOUT = 6.0
MAX_BYTES = 512 * 1024
MAX_REDIRECTS = 3
GROUP_MAX = 20
KEEP = (
    "id",
    "name",
    "organizationId",
    "status",
    "statusReason",
    "requiresApplication",
    "private",
    "type",
    "description",
    "briefCounts",
)
_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_reads: deque[float] = deque(maxlen=config.PUBLIC_PER_MINUTE)


class PublicGone(Exception):
    """CR answered 404 ``NOT_FOUND``: the campaign is removed (→ ``ended``)."""


class PublicDown(Exception):
    """The JSON could not be read (and neither could the page)."""


def _allowed(url: str) -> bool:
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or "").lower().removeprefix("www.")
    return parts.scheme == "https" and host == "contentrewards.com" and parts.port in (None, 443)


def _limited(monotonic: Callable[[], float]) -> bool:
    now = monotonic()
    if len(_reads) == _reads.maxlen and now - _reads[0] < 60:
        return True
    _reads.append(now)
    return False


def reset_limit() -> None:
    """Tests: a fresh container."""
    _reads.clear()


def _get(net: Net, url: str, accept: str) -> HttpResponse:
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        if not _allowed(current):
            raise PublicDown("redirect off contentrewards.com")
        request = HttpRequest("GET", current, {"Accept": accept, "User-Agent": config.USER_AGENT})
        try:
            response = net(request, TIMEOUT)
        except NetworkError as e:
            raise PublicDown("network") from e
        if response.status in {301, 302, 303, 307, 308}:
            current = urllib.parse.urljoin(current, response.headers.get("location", ""))
            continue
        if len(response.body) > MAX_BYTES:
            raise PublicDown("too big")
        return response
    raise PublicDown("too many redirects")


def strip(raw: Mapping[str, Any]) -> Item:
    """The fields Clip Factory uses, ≤ 16 KB (long texts are cut)."""
    out: Item = {k: raw[k] for k in KEEP if k in raw}
    org = raw.get("organization")
    if isinstance(org, Mapping):
        out["organization"] = {k: org.get(k) for k in ("name", "logoUrl") if isinstance(org.get(k), str)}
    metrics = raw.get("metrics")
    if isinstance(metrics, Mapping) and isinstance(metrics.get("budgetSpentCents"), int):
        out["metrics"] = {"budgetSpentCents": metrics["budgetSpentCents"]}
    cfg = raw.get("configuration")
    if isinstance(cfg, Mapping):
        kept: Item = {}
        for name in ("payoutModel", "geoRates", "budget", "minClipViews", "requirement", "rules"):
            if name in cfg:
                kept[name] = cfg[name]
        content = cfg.get("content")
        if isinstance(content, Mapping) and isinstance(content.get("guidelines"), str):
            kept["content"] = {"guidelines": content["guidelines"]}
        creator = cfg.get("creator")
        if isinstance(creator, Mapping) and isinstance(creator.get("description"), str):
            kept["creator"] = {"description": creator["description"]}
        out["configuration"] = kept
    for _ in range(4):
        if len(json.dumps(out)) <= config.MAX_PUBLIC:
            break
        for path in (
            ("description",),
            ("configuration", "content", "guidelines"),
            ("configuration", "creator", "description"),
        ):
            holder: Any = out
            for part in path[:-1]:
                holder = holder.get(part) if isinstance(holder, Mapping) else None
            if isinstance(holder, dict) and isinstance(holder.get(path[-1]), str):
                holder[path[-1]] = holder[path[-1]][: max(500, len(holder[path[-1]]) // 2)]
    return out


def read(net: Net, uuid: str, *, monotonic: Callable[[], float] = time.monotonic) -> Item:
    """The stripped public JSON; ``PublicGone`` on CR's 404; ``PublicDown`` when neither the JSON nor the page's
    Open Graph line could be read. An Open Graph answer is marked ``{"og": true}``."""
    if _limited(monotonic):
        raise PublicDown("limited")
    try:
        response = _get(net, config.PUBLIC_JSON.format(uuid=uuid), "application/json")
    except PublicDown:
        response = None
    if response is not None:
        body = response.json()
        if response.status == 404:
            error = body.get("error") if isinstance(body, Mapping) else None
            if isinstance(error, Mapping) and error.get("code") == "NOT_FOUND":
                raise PublicGone(uuid)
        if response.status == 200 and isinstance(body, Mapping):
            data = body.get("data") if isinstance(body.get("data"), Mapping) else body
            if isinstance(data, Mapping) and data.get("name"):
                return strip(data)
    found = _open_graph(net, uuid)
    if found is None:
        raise PublicDown("no json and no page")
    return found


_META = re.compile(r'<meta\s+[^>]*(?:property|name)="(og:[a-z]+)"[^>]*content="([^"]*)"', re.IGNORECASE)
_META_REV = re.compile(r'<meta\s+[^>]*content="([^"]*)"[^>]*(?:property|name)="(og:[a-z]+)"', re.IGNORECASE)
_MONEY = r"\$([0-9][0-9,]*(?:\.[0-9]{1,2})?)"


def cents(text: str) -> int:
    return round(float(text.replace(",", "")) * 100)


def parse_open_graph(page: str) -> Item | None:
    """ "Clip for … Earn $X per 1,000 views, up to $Y per clip, $Z budget left." → name and pay."""
    tags = {k.lower(): html.unescape(v) for k, v in _META.findall(page)}
    tags.update({k.lower(): html.unescape(v) for v, k in _META_REV.findall(page)})
    title = tags.get("og:title", "").strip()
    text = tags.get("og:description", "")
    if not title:
        return None
    out: Item = {"name": title[:200], "og": True}
    rate = re.search(_MONEY + r"\s+per\s+1,?000\s+views", text, re.IGNORECASE)
    most = re.search(r"up to\s+" + _MONEY + r"\s+per clip", text, re.IGNORECASE)
    left = re.search(_MONEY + r"\s+budget left", text, re.IGNORECASE)
    if rate:
        out["ogRateCents"] = cents(rate.group(1))
    if most:
        out["ogMaxCents"] = cents(most.group(1))
    if left:
        out["ogLeftCents"] = cents(left.group(1))
    return out


def _open_graph(net: Net, uuid: str) -> Item | None:
    try:
        response = _get(net, f"{config.SITE}/c/campaigns/{uuid}", "text/html")
    except PublicDown:
        return None
    if response.status != 200:
        return None
    return parse_open_graph(response.body.decode("utf-8", errors="replace"))


def read_group(net: Net, uuid: str, *, monotonic: Callable[[], float] = time.monotonic) -> Item:
    """A group link, read once: ``{name, choices: [{uuid, name, brand?, access?, pay?}]}`` (≤ 20). The group JSON
    first (a discover card's ``group``), else the group page's ``/c/campaigns/{uuid}`` links."""
    if _limited(monotonic):
        raise PublicDown("limited")
    try:
        response = _get(net, f"{config.SITE}/api/campaign/campaigns/discover/{uuid}", "application/json")
    except PublicDown:
        response = None
    if response is not None and response.status == 200:
        body = response.json()
        data = body.get("data") if isinstance(body, Mapping) and isinstance(body.get("data"), Mapping) else body
        group = data.get("group") if isinstance(data, Mapping) else None
        found = _group_from_json(group, data if isinstance(data, Mapping) else {})
        if found:
            return found
    try:
        page = _get(net, f"{config.SITE}/c/campaigns/{uuid}?group=1", "text/html")
    except PublicDown as e:
        raise PublicDown("group") from e
    if page.status != 200:
        raise PublicDown("group")
    return _group_from_page(page.body.decode("utf-8", errors="replace"))


def _group_from_json(group: Any, card: Mapping[str, Any]) -> Item | None:
    if not isinstance(group, Mapping):
        return None
    rows = group.get("campaigns") or group.get("members") or group.get("items")
    if not isinstance(rows, list):
        return None
    choices = []
    for row in rows[:GROUP_MAX]:
        if not isinstance(row, Mapping) or not re.fullmatch(_UUID, str(row.get("id") or "").lower()):
            continue
        choice: Item = {"uuid": str(row["id"]).lower(), "name": str(row.get("name") or "Campaign")[:200]}
        brand = row.get("organizationName") or card.get("organizationName")
        if isinstance(brand, str):
            choice["brand"] = brand[:200]
        if isinstance(row.get("requiresApplication"), bool):
            choice["access"] = "application" if row["requiresApplication"] else "open"
        if isinstance(row.get("payouts"), list):
            choice["payouts"] = row["payouts"]
        choices.append(choice)
    if not choices:
        return None
    return {"name": str(group.get("name") or card.get("name") or "Campaigns")[:200], "choices": choices}


def _group_from_page(page: str) -> Item:
    choices: list[Item] = []
    seen: set[str] = set()
    named = {
        m.group(1).lower(): m.group(2)
        for m in re.finditer(r'"id":"(' + _UUID + r')","name":"([^"\\]{1,200})"', page, re.IGNORECASE)
    }
    for found in re.finditer(r"/c/campaigns/(" + _UUID + r")", page, re.IGNORECASE):
        uid = found.group(1).lower()
        if uid in seen:
            continue
        seen.add(uid)
        choices.append({"uuid": uid, "name": html.unescape(named.get(uid, "Campaign"))[:200]})
        if len(choices) >= GROUP_MAX:
            break
    if not choices:
        raise PublicDown("group page had no campaigns")
    title = parse_open_graph(page) or {}
    return {"name": str(title.get("name") or "Campaigns"), "choices": choices}
