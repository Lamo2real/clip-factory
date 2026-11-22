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
    "campaignId",  # the Content Rewards campaign the post is for: set at creation, never changed (§38.11)
    "paidLabel",  # "not_set" when the platform refused the paid-partnership switch (§38.14)
    "by",  # "you": the owner posted it on TikTok himself (§42)
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


def is_private_test(item: Mapping[str, Any]) -> bool:
    """A post of auto-posting's Private test run (§46.8): only that run writes the internal ``postOptions.test``."""
    options = item.get("postOptions")
    return isinstance(options, Mapping) and options.get("test") == "private"


def public_post(item: Item, now: datetime | None = None) -> Item:
    """The Post shape of §5/§16.3. Internal fields (``platformPostId``, ``statsId``, ``statsDueAt``, ``gsi2*``,
    ``refreshStartedAt``, ``lastSnapshotAt``, ``insightsDueAt``, ``statsError``, ``postOptions``, ``autoRun``) never
    leave. An auto-posted post says ``auto: true``, a Private test run's ``test: "private"`` (§46.9)."""
    out = {k: item[k] for k in POST_FIELDS if k in item}
    if item.get("autoRun"):
        out["auto"] = True
    if is_private_test(item):
        out["test"] = "private"
    metrics = public_metrics(item.get("metrics"))
    if metrics is not None:
        out["metrics"] = metrics
    out["refreshing"] = is_refreshing(item, now)
    return out


def mark_posted(store: db.Store, post: Mapping[str, Any], published: Any, now: datetime) -> Item:
    """Writes a queued post as ``posted`` with the stats fields of §16.3 (conditional on ``status = queued``).

    ``published`` is a ``platforms.Published``. A public post with a ``statsId`` joins the poller's sparse ``gsi2`` with
    its first poll ``minIntervalMinutes`` after posting; a private post (a private TikTok post, a Private test run's
    post, §46.8) never does. A campaign
    post whose platform refused the paid-partnership switch (``published.paid_label``, §38.14) gets ``paidLabel``.
    Raises ``db.ConditionFailed`` when the post is no longer queued."""
    from .stats import config

    posted_at = parse(published.posted_at) or now
    fields: Item = {
        "status": "posted",
        "postedAt": iso(posted_at),
        "perfCheckAt": iso(posted_at + PERF_CHECK_DELAY),
        "privacy": published.privacy if published.privacy in {"public", "private"} else "public",
    }
    if published.url:  # a Private test run's Facebook draft and checked Instagram upload have no link (§46.8)
        fields["url"] = published.url
    if published.platform_post_id:
        fields["platformPostId"] = published.platform_post_id
    if getattr(published, "paid_label", None) == "not_set":
        fields["paidLabel"] = "not_set"
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


def account_items(store: db.Store, user_id: str, *, consistent: bool = False) -> list[Item]:
    return store.query_all(db.user_pk(user_id), "ACCOUNT#", consistent=consistent)


def connected_account(store: db.Store, user_id: str, platform: str, *, consistent: bool = False) -> Item | None:
    """The platform's connected Account item (internal fields included: ``accountId`` for the adapters).
    ``consistent`` is for callers that run moments after the Account was written (the release on connect, §17.6, and
    the clip flow it starts)."""
    for item in account_items(store, user_id, consistent=consistent):
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


# The order the owner sees the platforms in everywhere (STATS_ORDER in the web app).
UPLOAD_ORDER: tuple[str, ...] = ("youtube", "tiktok", "instagram", "facebook", "x")


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
    campaign_id: str | None = None,
    campaign_options: Mapping[str, Any] | None = None,
    post_fields: Mapping[str, Any] | None = None,
) -> list[Item]:
    """Creates the clip's Posts, one per chosen platform (the clip's ``uploadTo``, §33) or, when the clip has none,
    one per platform enabled in settings, and returns all its posts (public shape).

    One transaction writes the missing posts together with ``postsCreated: true`` (plus ``clip_fields``) on the
    clip, conditional on the flag not being set yet (and on the clip's status being in ``expect_status``), so the
    posts are created exactly once even when Confirm and the clip-flow's ``ensure-posts`` step race or repeat.
    When the flag is already set nothing is written. Raises ``db.ConditionFailed`` if the condition fails.
    ``post_options`` (per platform) are stored on that platform's post as the internal ``postOptions`` (§17.8).
    A campaign clip's posts (§38.14) get the public ``campaignId`` and, in every post's ``postOptions``, the internal
    ``campaign`` (``campaign_options``: paid partnership, disclosure, required items). ``post_fields`` are internal
    fields every new post gets (the auto-posting run that made it, ``autoRun``, §46.10).
    """
    clip_id = str(clip["clipId"])
    if clip.get("postsCreated"):
        return [public_post(p) for p in posts_for_clip(store, user_id, clip_id, consistent=True)]
    # Clips confirmed before the flag existed may already have some posts: never create a second one per platform.
    # Posts are only ever written together with the flag, so any found here are old and gsi1 already has them.
    existing = [public_post(p) for p in posts_for_clip(store, user_id, clip_id)]
    have = {p["platform"] for p in existing}
    connected = {a["platform"] for a in accounts(store, user_id) if a["status"] == "connected"}
    created: list[Item] = []
    items: list[Item] = []
    # The places the owner picked on this clip's Upload (§33), else Settings › Where clips go (older clients).
    chosen = (clip_fields or {}).get("uploadTo") or clip.get("uploadTo")
    # The flow run that sends these posts (§17.6): a later run started by Try again or a release leaves them alone.
    run = int((clip_fields or {}).get("flowRun") or clip.get("flowRun") or 1)
    targets = [p for p in UPLOAD_ORDER if p in chosen] if chosen else settings.get("platforms", PLATFORMS)
    for platform in targets:
        if platform in have or platform not in PLATFORMS:
            continue
        post_id = ulid()
        post = {
            "postId": post_id,
            "clipId": clip_id,
            "platform": platform,
            "status": "queued" if platform in connected else "pending_integration",
            **({"campaignId": campaign_id} if campaign_id else {}),
        }
        options = dict((post_options or {}).get(platform) or {})
        if campaign_options is not None:
            options["campaign"] = dict(campaign_options)
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
                "flowRun": run,
                **(post_fields or {}),
                **post,
                **({"postOptions": options} if options or (post_options and platform in post_options) else {}),
            }
        )
    update = db.update_request(
        db.user_pk(user_id),
        db.clip_sk(clip_id),
        {"postsCreated": True, "postIds": [p["postId"] for p in existing + created], **(clip_fields or {})},
        expect_in={"status": list(expect_status)} if expect_status is not None else None,
        expect_absent=["postsCreated"],
    )
    store.transact(puts=items, updates=[update])
    return existing + created


def posts_for_clip(store: db.Store, user_id: str, clip_id: str, *, consistent: bool = False) -> list[Item]:
    """A clip's posts. ``consistent`` is for callers (Confirm, the clip-flow) that must see posts written moments
    earlier: it reads the clip and then its posts by key (the internal ``postIds`` written in the same transaction as
    the posts), both strongly consistent, so the cost does not grow with the owner's post count. Clips created before
    ``postIds`` existed fall back to a strongly consistent read of the owner's whole partition (every page)."""
    if consistent:
        clip = store.get(db.user_pk(user_id), db.clip_sk(clip_id))
        ids = clip.get("postIds") if clip else None
        if isinstance(ids, list):
            found = store.batch_get((db.user_pk(user_id), db.post_sk(str(i))) for i in ids)
            order = {str(i): n for n, i in enumerate(ids)}
            found.sort(key=lambda i: order.get(str(i.get("postId")), len(order)))
        else:
            found = store.query_all(db.user_pk(user_id), "POST#", consistent=True)
        return [i for i in found if i.get("clipId") == clip_id and i.get("type") == "post"]
    # gsi1 is not partitioned by owner, so every result is checked against the caller.
    items = store.query_all(f"CLIP#{clip_id}", "POST#", index="gsi1")
    return [i for i in items if i.get("userId") == user_id and i.get("type") == "post"]


def all_posts(store: db.Store, user_id: str) -> list[Item]:
    return store.query_all(db.user_pk(user_id), "POST#", newest_first=True)
