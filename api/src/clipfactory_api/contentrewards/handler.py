"""Lambda ``cf-prod-campaigns`` (docs/CONTRACTS.md §38.9, §38.10, §38.16).

Async only, ``{"action": "read" | "logo" | "brand_picture", "userId", "campaignId", …}``. It reads untrusted brand
text and fetches outside files, so it makes **no CR call and has no secret access at all**: the brief is already on
the item (the api and ``cf-prod-stats`` store it before they start a read). Every failure ends in a state the card
shows (``rulesState: failed``, ``logo.state: failed`` with the sentence); nothing raises to Lambda.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from .. import db, s3
from ..clock import Clock, iso, utcnow
from ..log import log
from . import config, fetch, links, logo, rules
from .util import obj

Item = dict[str, Any]


@dataclass
class CampaignsDeps:
    store: db.Store
    media: s3.Media
    bedrock: Any
    model_id: str
    get: Callable[..., fetch.Fetched] = fetch.get
    clock: Clock = field(default=utcnow)


def handle(event: Any, deps: CampaignsDeps) -> dict[str, Any]:
    if not isinstance(event, Mapping):
        log("warning", "campaigns.bad_event")
        return {"action": "bad_event"}
    action, user_id, uuid = event.get("action"), event.get("userId"), event.get("campaignId")
    if not (isinstance(user_id, str) and user_id and isinstance(uuid, str) and links.UUID.match(uuid)):
        log("warning", "campaigns.bad_event")
        return {"action": "bad_event"}
    item = deps.store.get(db.user_pk(user_id), db.campaign_sk(uuid.lower()))
    if item is None:
        return {"action": action, "outcome": "missing"}
    if action == "read":
        return {"action": "read", "outcome": read(deps, user_id, item)}
    if action == "logo" and isinstance(event.get("url"), str):
        return {"action": "logo", "outcome": fetch_logo(deps, user_id, item, str(event["url"]))}
    if action == "brand_picture":
        return {"action": "brand_picture", "outcome": brand_picture(deps, user_id, item)}
    log("warning", "campaigns.bad_event")
    return {"action": "bad_event"}


def read(deps: CampaignsDeps, user_id: str, item: Item) -> str:
    """The rules read: the item's own text only (brief, public, pasted rules) and up to 3 public Google Docs.

    Its answer (or its failure) is written only while the item's ``briefHash`` is still the one it read: a newer
    read started meanwhile (new pasted rules, a changed brief) wins, and this one ends ``superseded``."""
    pk, sk = item["pk"], item["sk"]
    now = deps.clock()
    mine = item.get("briefHash")
    same = {"briefHash": [mine]} if isinstance(mine, str) and mine else None
    try:
        texts = [rules.brief_text(item), str(item.get("pastedRules") or "")]
        docs, doc_doubts = rules.read_docs(texts, deps.get)
        parts = rules.blocks(item, docs)
        raw = rules.ask_claude(deps.bedrock, deps.model_id, parts)
        corpus = "\n".join(text for _label, text in parts)
        follows = [f for f in deps.store.query_all(pk, "FOLLOW#") if f.get("type") == "follow"]
        checked = rules.validate(raw, corpus, rules.toggles(item.get("public")), follows)
        checked["uncertain"] = (doc_doubts + checked["uncertain"])[: rules.MAX_LIST]
    except Exception as e:
        log("warning", "campaigns.read_failed", error=type(e).__name__)
        try:
            deps.store.update(pk, sk, {"rulesState": "failed"}, remove=["readPending"], expect_in=same)
        except db.ConditionFailed:
            return "superseded"
        return "failed"
    places = [str(p) for p in item.get("platformsPaid") or []]
    logo_state = dict(item.get("logo") or {"state": "none"})
    logo_state["needed"] = bool(checked["logo"]["required"])
    try:
        deps.store.update(
            pk,
            sk,
            {
                "rules": checked,
                "rulesState": "ready",
                "rulesVersion": int(item.get("rulesVersion") or 0) + 1,
                "rulesAt": iso(now),
                "plainRules": rules.plain_rules(checked, str(item.get("brand") or ""), places),
                "uncertain": checked["uncertain"],
                "logo": logo_state,
            },
            remove=["readPending"],
            expect_in=same,
        )
    except db.ConditionFailed:
        log("info", "campaigns.read_superseded")
        return "superseded"
    log("info", "campaigns.read", rules=len(checked["requiredHashtags"]) + len(checked["requiredTags"]))
    return "ready"


def fetch_logo(deps: CampaignsDeps, user_id: str, item: Item, url: str) -> str:
    pk, sk = item["pk"], item["sk"]
    uuid = str(item["campaignId"])
    try:
        body, ext = logo.fetch_link(url, deps.get)
    except logo.LogoError as e:
        current = dict(item.get("logo") or {})
        current.update({"state": "failed", "error": e.sentence})
        deps.store.update(pk, sk, {"logo": current})
        return "failed"
    rev = int(item.get("logoRev") or 0) + 1
    new_key = logo.upload_key(user_id, uuid, rev, ext)
    deps.media.put(new_key, body, logo.CONTENT_TYPES[ext])
    old = item.get("logoKey")
    current = dict(item.get("logo") or {})
    current.update({"state": "ready"})
    current.pop("error", None)
    deps.store.update(pk, sk, {"logo": current, "logoKey": new_key, "logoRev": rev})
    if isinstance(old, str) and old.startswith(logo.campaign_prefix(user_id, uuid)) and old != new_key:
        deps.media.delete(old)
    return "ready"


def brand_picture(deps: CampaignsDeps, user_id: str, item: Item) -> str:
    public = obj(item.get("public"))
    org = obj(public.get("organization"))
    url = logo.brand_url(org.get("logoUrl"))
    if url is None or item.get("brandKey"):
        return "skipped"
    try:
        got = deps.get(
            url,
            allow=lambda u: fetch.host_in(u, frozenset({logo.BRAND_HOST})),
            max_bytes=config.BRAND_MAX_BYTES,
            budget=6.0,
        )
    except fetch.FetchFail as e:
        log("info", "campaigns.brand_failed", reason=e.reason)
        return "failed"
    kind = logo.kind_of(got.body[:16])
    if kind is None:
        return "failed"
    key = logo.brand_key(user_id, str(item["campaignId"]), kind)
    deps.media.put(key, got.body, logo.CONTENT_TYPES[kind])
    deps.store.update(item["pk"], item["sk"], {"brandKey": key})
    return "ready"


_deps: CampaignsDeps | None = None


def _from_env() -> CampaignsDeps:
    import boto3
    from botocore.config import Config

    from ..app import region, table

    env = os.environ
    reg = region()
    bedrock = boto3.client(
        "bedrock-runtime",
        region_name=reg,
        config=Config(read_timeout=60, connect_timeout=5, retries={"mode": "standard", "max_attempts": 1}),
    )
    return CampaignsDeps(
        store=db.Store(table(env["TABLE_NAME"])),
        media=s3.Media(s3.make_client(reg), env["MEDIA_BUCKET"]),
        bedrock=bedrock,
        model_id=env.get("MODEL_ID", ""),
    )


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    global _deps
    if not config.enabled():
        log("info", "campaigns.off")
        return {"action": "off"}
    if _deps is None:
        _deps = _from_env()
    return handle(event, _deps)
