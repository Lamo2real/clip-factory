"""Post and Account items (docs/CONTRACTS.md §5, §6): one Post per platform when a clip is confirmed."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta
from typing import Any

from . import db
from .clock import iso, parse, utcnow
from .ids import ulid
from .settings import PLATFORMS

Item = dict[str, Any]
POST_FIELDS = (
    "postId",
    "clipId",
    "platform",
    "status",
    "url",
    "postedAt",
    "perfCheckAt",
    "privacy",
    "nextRefreshAt",
    "error",
)
COMMON_METRICS = ("views", "likes", "comments", "shares")
REFRESH_CLAIM = timedelta(minutes=5)  # a manual refresh counts as running for this long (§16.2)
PERF_CHECK_DELAY = timedelta(hours=48)


def public_metrics(raw: Any) -> Item | None:
    """``PostMetrics`` (§16.3) as the web reads it: the common four always present (``null`` = the platform does
    not say), ``metricsUpdatedAt`` filled in for metrics stored before §16 (only ``checkedAt``), ``extra`` always an
    object."""
    if not isinstance(raw, Mapping):
        return None
    out: Item = {k: raw.get(k) for k in COMMON_METRICS}
    checked = raw.get("metricsUpdatedAt") or raw.get("checkedAt")
    if checked:
        out["checkedAt"] = raw.get("checkedAt") or checked
        out["metricsUpdatedAt"] = checked
    if raw.get("insightsUpdatedAt"):
        out["insightsUpdatedAt"] = raw["insightsUpdatedAt"]
    if raw.get("final"):
        out["final"] = True
    extra = raw.get("extra")
    out["extra"] = dict(extra) if isinstance(extra, Mapping) else {}
    return out


def is_refreshing(item: Mapping[str, Any], now: datetime | None = None) -> bool:
    started = parse(item.get("refreshStartedAt"))
    return started is not None and (now or utcnow()) - started < REFRESH_CLAIM


def public_post(item: Item, now: datetime | None = None) -> Item:
    """The Post shape of §5/§16.3. Internal fields (``platformPostId``, ``statsId``, ``statsDueAt``, ``gsi2*``,
    ``refreshStartedAt``, ``lastSnapshotAt``, ``insightsDueAt``, ``statsError``) never leave."""
    out = {k: item[k] for k in POST_FIELDS if k in item}
    metrics = public_metrics(item.get("metrics"))
    if metrics is not None:
        out["metrics"] = metrics
    out["refreshing"] = is_refreshing(item, now)
    return out


def mark_posted(store: db.Store, post: Mapping[str, Any], published: Any, now: datetime) -> Item:
    """Writes a queued post as ``posted`` with the stats fields of §16.3 (conditional on ``status = queued``).

    ``published`` is a ``platforms.Published``. A post with a ``statsId`` joins the poller's sparse ``gsi2`` with its
    first poll ``minIntervalMinutes`` after posting; a private TikTok post (no ``statsId``) never does.
    Raises ``db.ConditionFailed`` when the post is no longer queued."""
    from .stats import config

    posted_at = parse(published.posted_at) or now
    fields: Item = {
        "status": "posted",
        "url": published.url,
        "postedAt": iso(posted_at),
        "perfCheckAt": iso(posted_at + PERF_CHECK_DELAY),
        "privacy": published.privacy if published.privacy in {"public", "private"} else "public",
    }
    if published.platform_post_id:
        fields["platformPostId"] = published.platform_post_id
    if published.stats_id and fields["privacy"] == "public":
        cfg = config.load()
        due = iso(posted_at + timedelta(minutes=cfg.platform(str(post["platform"])).min_interval))
        fields.update(
            {
                "statsId": published.stats_id,
                "statsDueAt": due,
                "gsi2pk": db.STATS_GSI_PK,
                "gsi2sk": f"{due}#{post['postId']}",
            }
        )
    return store.update(str(post["pk"]), str(post["sk"]), fields, remove=["error"], expect_in={"status": ["queued"]})


ACCOUNT_FIELDS = ("handle", "name", "avatarUrl", "connectedAt", "missing", "reason", "reconnectBy")
ACCOUNT_STATUSES = ("connected", "needs_reconnect", "choose_account")


def account_items(store: db.Store, user_id: str) -> list[Item]:
    return store.query_all(db.user_pk(user_id), "ACCOUNT#")


def connected_account(store: db.Store, user_id: str, platform: str) -> Item | None:
    """The platform's connected Account item (internal fields included: ``accountId`` for the adapters)."""
    for item in account_items(store, user_id):
        if item.get("platform") == platform and item.get("status") == "connected":
            return item
    return None


def public_account(item: Mapping[str, Any]) -> Item:
    """The Account shape of §17.4: never ``accountId``, ``scopes``, ``refreshLeaseUntil`` or keys."""
    platform = str(item.get("platform") or "")
    status = item.get("status")
    if status not in ACCOUNT_STATUSES:
        out: Item = {"platform": platform, "status": "not_connected"}
        if item.get("reason") == "keys_changed":
            out["reason"] = "keys_changed"
        return out
    account: Item = {"platform": platform, "status": status}
    for key in ACCOUNT_FIELDS:
        value = item.get(key)
        if value not in (None, "", []):
            account[key] = list(value) if isinstance(value, list | tuple | set) else value
    return account


def accounts(store: db.Store, user_id: str) -> list[Item]:
    """One Account per platform (in ``PLATFORMS`` order); a connected one wins over a stale one."""
    rank = {"connected": 0, "needs_reconnect": 1, "choose_account": 2}
    best: dict[str, Item] = {}
    for item in account_items(store, user_id):
        platform = item.get("platform")
        if platform not in PLATFORMS:
            continue
        current = best.get(platform)
        if current is None or rank.get(item.get("status", ""), 9) < rank.get(current.get("status", ""), 9):
            best[platform] = item
    return [public_account(best.get(p) or {"platform": p, "status": "not_connected"}) for p in PLATFORMS]


def set_stats_id(store: db.Store, post: Mapping[str, Any], stats_id: str, now: datetime) -> Item:
    """A public TikTok post's id arrived after posting (§17.6): it joins the poller's ``gsi2``. Conditional on the
    post being ``posted`` without a ``statsId`` yet, so a replay changes nothing."""
    from .stats import config

    cfg = config.load()
    due = iso(now + timedelta(minutes=cfg.platform(str(post["platform"])).min_interval))
    fields: Item = {
        "statsId": stats_id,
        "statsDueAt": due,
        "gsi2pk": db.STATS_GSI_PK,
        "gsi2sk": f"{due}#{post['postId']}",
    }
    return store.update(
        str(post["pk"]), str(post["sk"]), fields, expect_in={"status": ["posted"]}, expect_absent=["statsId"]
    )


def create_for_clip(
    store: db.Store,
    user_id: str,
    clip: Mapping[str, Any],
    settings: Mapping[str, Any],
    now: str,
    *,
    clip_fields: Mapping[str, Any] | None = None,
    expect_status: Iterable[str] | None = None,
    post_options: Mapping[str, Mapping[str, Any]] | None = None,
) -> list[Item]:
    """Creates the clip's Posts, one per enabled platform, and returns all its posts (public shape).

    One transaction writes the missing posts together with ``postsCreated: true`` (plus ``clip_fields``) on the
    clip, conditional on the flag not being set yet (and on the clip's status being in ``expect_status``), so the
    posts are created exactly once even when Confirm and the clip-flow's ``ensure-posts`` step race or repeat.
    When the flag is already set nothing is written. Raises ``db.ConditionFailed`` if the condition fails.
    ``post_options`` (per platform) are stored on that platform's post as the internal ``postOptions`` (§17.8).
    """
    clip_id = str(clip["clipId"])
    if clip.get("postsCreated"):
        return [public_post(p) for p in posts_for_clip(store, user_id, clip_id, consistent=True)]
    # Clips confirmed before the flag existed may already have some posts: never create a second one per platform.
    existing = [public_post(p) for p in posts_for_clip(store, user_id, clip_id, consistent=True)]
    have = {p["platform"] for p in existing}
    connected = {a["platform"] for a in accounts(store, user_id) if a["status"] == "connected"}
    created: list[Item] = []
    items: list[Item] = []
    for platform in settings.get("platforms", PLATFORMS):
        if platform in have or platform not in PLATFORMS:
            continue
        post_id = ulid()
        post = {
            "postId": post_id,
            "clipId": clip_id,
            "platform": platform,
            "status": "queued" if platform in connected else "pending_integration",
        }
        created.append(post)
        items.append(
            {
                "pk": db.user_pk(user_id),
                "sk": db.post_sk(post_id),
                "gsi1pk": f"CLIP#{clip_id}",
                "gsi1sk": f"POST#{platform}",
                "type": "post",
                "userId": user_id,
                "createdAt": now,
                **post,
                **({"postOptions": dict(post_options[platform])} if post_options and platform in post_options else {}),
            }
        )
    update = db.update_request(
        db.user_pk(user_id),
        db.clip_sk(clip_id),
        {"postsCreated": True, **(clip_fields or {})},
        expect_in={"status": list(expect_status)} if expect_status is not None else None,
        expect_absent=["postsCreated"],
    )
    store.transact(puts=items, updates=[update])
    return existing + created


def posts_for_clip(store: db.Store, user_id: str, clip_id: str, *, consistent: bool = False) -> list[Item]:
    """A clip's posts. ``consistent`` reads the owner's partition with a strongly consistent query instead of the
    eventually consistent gsi1, for callers (Confirm, the clip-flow) that must see posts written moments earlier."""
    if consistent:
        items = store.query_all(db.user_pk(user_id), "POST#", consistent=True)
        return [i for i in items if i.get("clipId") == clip_id and i.get("type") == "post"]
    # gsi1 is not partitioned by owner, so every result is checked against the caller.
    items = store.query_all(f"CLIP#{clip_id}", "POST#", index="gsi1")
    return [i for i in items if i.get("userId") == user_id and i.get("type") == "post"]


def all_posts(store: db.Store, user_id: str) -> list[Item]:
    return store.query_all(db.user_pk(user_id), "POST#", newest_first=True)
