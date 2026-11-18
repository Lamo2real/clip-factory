"""The daily "learn from results" run of ``cf-prod-learn`` (docs/CONTRACTS.md §16.12, ADR-41).

An EventBridge rule invokes ``cf-prod-learn`` once a day at 05:00 UTC (``source == "aws.events"``). For each owner:

1. **Freeze day 7.** Every posted post whose window (6.5 to 8.5 days after posting) has closed gets its day-7 number,
   or ``missing`` for good (``day7.py``).
2. **Find the winners.** Per platform, each measured post of the last 90 days is judged against its creator's
   baseline (or every creator's, ``winners.py``).
3. **Second look.** For each creator (and "all creators") with winners it has not looked at yet, the shared traits are
   computed (``traits.py``); when at least one passes every guard and is not already a lesson, ONE Claude call writes
   the lessons (``lessons.ask``, the owner's skills block first). No new winners → no model call.
4. **Lesson life.** Lessons are confirmed, expired and capped (``lessons.py``).
5. The per-creator status ("needs 12 more posted clips") is saved for Settings › What it learned.

Idempotent: a second run the same day (the automatic retry included) finds every post frozen, every winner seen and
every lesson already confirmed, so it writes nothing and calls no model. One creator's failure is logged and the
others go on. The run stops starting new work after ``DAILY_BUDGET_SECONDS``; what is left waits for tomorrow.

Owners are found through the poll index (``gsi2``, the posts inside their 30-day window), never a Scan: a post
reaches the end of its day-7 window (8.5 days) long before it leaves that index.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

from . import day7, db, lessons, s3, skill_prompt
from .clock import Clock, iso, parse, utcnow
from .creators import ALL_CREATORS, creator_keys, creator_name
from .learning_rules import (
    BASELINE_DAYS,
    DAILY_BUDGET_SECONDS,
    MAX_OWNER_POSTS,
    MIN_BASELINE,
    MODEL_CALL_SECONDS,
)
from .log import log
from .skills import BuiltinSkill, load_builtins
from .traits import candidates
from .winners import Group, Measured, groups, judge, needed, recent, settle, verdict_item

Item = dict[str, Any]
PLATFORMS = ("youtube", "tiktok", "instagram", "facebook", "x")


@dataclass
class DailyDeps:
    store: db.Store
    bedrock: Any
    model_id: str
    media: s3.Media
    clock: Clock = field(default=utcnow)
    monotonic: Callable[[], float] = field(default=time.monotonic)
    sleep: Callable[[float], None] = field(default=time.sleep)
    builtins: Callable[[], Sequence[BuiltinSkill]] = field(default=load_builtins)
    budget_seconds: float = DAILY_BUDGET_SECONDS


@dataclass
class Report:
    owners: int = 0
    frozen: int = 0
    missing: int = 0
    calls: int = 0
    written: int = 0
    confirmed: int = 0
    expired: int = 0
    capped: int = 0
    failed: list[str] = field(default_factory=list)
    deferred: int = 0

    def out(self) -> dict[str, Any]:
        return {
            "action": "daily",
            "owners": self.owners,
            "frozen": self.frozen,
            "missing": self.missing,
            "modelCalls": self.calls,
            "lessonsWritten": self.written,
            "confirmed": self.confirmed,
            "expired": self.expired,
            "capped": self.capped,
            "failed": len(self.failed),
            "deferred": self.deferred,
        }


def owners(store: db.Store) -> list[str]:
    """Every owner with a post inside its 30-day poll window (gsi2 ``STATS``), without a Scan."""
    rows = store.query_stats_due("~", cap=MAX_OWNER_POSTS)
    return sorted({str(r["userId"]) for r in rows if r.get("type") == "post" and r.get("userId")})


def run(deps: DailyDeps) -> dict[str, Any]:
    started = deps.monotonic()
    report = Report()
    for user_id in owners(deps.store):
        report.owners += 1
        try:
            run_owner(deps, user_id, report, started)
        except Exception as e:  # one owner never stops the others
            report.failed.append(user_id)
            log("error", "learn.owner_failed", error=type(e).__name__, detail=str(e)[:300])
    log("info", "learn.daily", **report.out())
    return report.out()


def _left(deps: DailyDeps, started: float) -> float:
    return deps.budget_seconds - (deps.monotonic() - started)


# --- joining posts with their clips and creators ---------------------------------------------------------------


def measured_posts(store: db.Store, user_id: str, posts: Sequence[Item], now: datetime) -> list[Measured]:
    """Posts of the last ``BASELINE_DAYS`` with a frozen day-7 number, joined with their clip, job and creator (older
    posts are never read past the post itself, so the reads follow the 90-day window, not the whole history). A clip
    made before ``creatorKey`` was stored gets it from its job's source (read only; nothing is rewritten)."""
    since = now - timedelta(days=BASELINE_DAYS)
    frozen = [
        p
        for p in posts
        if day7.day7_views(p) is not None
        and p.get("platform") in PLATFORMS
        and (parse(p.get("postedAt")) or since) >= since
    ]
    if not frozen:
        return []
    pk = db.user_pk(user_id)
    clips = {c.get("clipId"): c for c in store.batch_get((pk, db.clip_sk(str(p["clipId"]))) for p in frozen)}
    job_ids = {str(c.get("jobId")) for c in clips.values() if c.get("jobId")}
    jobs = {j.get("jobId"): j for j in store.batch_get((pk, db.job_sk(j)) for j in sorted(job_ids))}
    aliases = _aliases([*clips.values(), *jobs.values()])
    out: list[Measured] = []
    for p in frozen:
        clip = clips.get(p.get("clipId"))
        posted_at = parse(p.get("postedAt"))
        views = day7.day7_views(p)
        if clip is None or posted_at is None or views is None:
            continue
        job = jobs.get(clip.get("jobId"))
        key, name = _creator(clip, job)
        out.append(
            Measured(
                post_id=str(p["postId"]),
                clip_id=str(clip["clipId"]),
                source_id=source_id(job) or str(clip.get("jobId") or clip["clipId"]),
                platform=str(p["platform"]),
                creator_key=aliases.get(key, key) if key else None,
                creator_name=name,
                views=views,
                posted_at=posted_at,
                clip=clip,
                post=p,
            )
        )
    return out


def source_id(job: Mapping[str, Any] | None) -> str | None:
    """The source video itself, so two jobs of the same stream count as ONE source for the "2 different source
    videos" guard: the upload's key, or the link without its host (www/m) and, for YouTube, reduced to the video id."""
    source = (job or {}).get("source")
    if not isinstance(source, Mapping):
        return None
    if source.get("type") == "upload" and source.get("key"):
        return f"upload:{source['key']}"
    url = str(source.get("url") or "").strip()
    if not url:
        return None
    parts = urlsplit(url if "://" in url else "https://" + url)
    host = (parts.hostname or "").lower().removeprefix("www.").removeprefix("m.")
    path = parts.path.rstrip("/")
    if host in {"youtube.com", "youtu.be"}:
        video = (parse_qs(parts.query).get("v") or [""])[0]
        if not video and host == "youtu.be":
            video = path.strip("/")
        if not video and path.split("/")[1:2] in (["live"], ["shorts"]):
            video = path.split("/")[2] if len(path.split("/")) > 2 else ""
        if video:
            return f"youtube:{video}"
    platform = str(source.get("platform") or host)
    return f"{platform}:{path.lower()}" + (f"?{parts.query}" if parts.query else "")


def _creator(clip: Mapping[str, Any], job: Mapping[str, Any] | None) -> tuple[str | None, str]:
    if clip.get("creatorKey"):
        return str(clip["creatorKey"]), str(clip.get("creatorName") or "")
    source = (job or {}).get("source")
    keys = creator_keys(source if isinstance(source, Mapping) else None)
    return (keys[0] if keys else None), creator_name(source if isinstance(source, Mapping) else None)


def _aliases(rows: Sequence[Mapping[str, Any]]) -> dict[str, str]:
    """name key → id key, from every source that has both (so older clips join the same creator). A name that two
    different channel ids share (two channels both called "Gamer") is ambiguous: it gets no alias, and older clips
    that only have that name stay under the name key."""
    found: dict[str, set[str]] = {}
    for row in rows:
        source = row.get("source") if isinstance(row.get("source"), Mapping) else None
        keys = creator_keys(source) if source else [str(k) for k in row.get("creatorKeys") or []]
        if len(keys) > 1:
            for alias in keys[1:]:
                found.setdefault(alias, set()).add(keys[0])
    return {alias: next(iter(ids)) for alias, ids in found.items() if len(ids) == 1}


# --- one owner -------------------------------------------------------------------------------------------------


@dataclass
class OwnerRun:
    """What one owner's run carries from group to group."""

    deps: DailyDeps
    user_id: str
    now: datetime
    started: float
    report: Report
    items: list[Item]
    seen: dict[str, list[str]]
    block: skill_prompt.SkillsBlock | None = None

    @property
    def by_id(self) -> dict[str, Item]:
        return {str(i.get("lessonId")): i for i in self.items}


def freeze_due(deps: DailyDeps, user_id: str, now: datetime, report: Report, started: float) -> list[Item]:
    """Freezes every post whose day-7 window has closed (while the time budget lasts; the rest wait for tomorrow);
    returns the owner's posts as they are now."""
    store = deps.store
    pk = db.user_pk(user_id)
    posts = [p for p in store.query_all(pk, "POST#") if p.get("type") == "post"]
    changed = False
    for post in posts:
        if day7.due(post, now):
            if _left(deps, started) <= 0:
                report.deferred += 1
                continue
            outcome = day7.freeze(store, post, now)
            report.frozen += outcome == "frozen"
            report.missing += outcome == "missing"
            changed = changed or outcome in {"frozen", "missing"}
    if changed:
        posts = [p for p in store.query_all(pk, "POST#") if p.get("type") == "post"]
    return posts


def store_verdicts(store: db.Store, measured: Sequence[Measured], new: Mapping[str, Any], now: datetime) -> int:
    """Writes each new verdict on its post once (``day7Verdict``), only while the post still has its day-7 number."""
    n = 0
    for m in measured:
        v = new.get(m.post_id)
        if v is None:
            continue
        try:
            store.update(
                str(m.post["pk"]),
                str(m.post["sk"]),
                {"day7Verdict": verdict_item(v, now)},
                expect_in={"day7State": ["frozen"]},
                expect_absent=["day7Verdict"],
            )
            n += 1
        except db.ConditionFailed:
            continue  # judged by an earlier run (the retry), or the platform was just forgotten
    return n


def run_owner(deps: DailyDeps, user_id: str, report: Report, started: float) -> None:
    store, now = deps.store, deps.clock()
    posts = freeze_due(deps, user_id, now, report, started)
    measured = recent(measured_posts(store, user_id, posts, now), now)
    verdicts, new = settle(measured, judge(measured), now)
    store_verdicts(store, measured, new, now)
    all_groups = groups(measured, verdicts)
    state = store.get(db.user_pk(user_id), db.LEARN_STATE_SK) or {}
    run_ = OwnerRun(
        deps=deps,
        user_id=user_id,
        now=now,
        started=started,
        report=report,
        items=lessons.all_lessons(store, user_id),
        seen={str(k): list(v) for k, v in (state.get("seen") or {}).items()},
    )
    report.expired += lessons.expire(store, run_.items, now)
    for group in all_groups:
        try:
            learn_group(run_, group)
        except Exception as e:  # one creator never stops the others; its winners stay unseen for tomorrow
            report.failed.append(f"{group.creator_key}|{group.platform}")
            log(
                "error",
                "learn.group_failed",
                creator=group.creator_key,
                platform=group.platform,
                error=type(e).__name__,
            )
    report.capped += lessons.cap(store, run_.items, now)
    live = {m.post_id for m in measured}
    seen = {k: [p for p in v if p in live] for k, v in run_.seen.items()}
    _save_state(
        store, user_id, state, {k: v for k, v in seen.items() if v}, _status_rows(measured, all_groups), now=now
    )


def _still_measured(store: db.Store, user_id: str, post_ids: Sequence[str]) -> bool:
    """True while every one of these posts still has its day-7 number (a disconnect removes it)."""
    pk = db.user_pk(user_id)
    found = store.batch_get((pk, db.post_sk(p)) for p in post_ids)
    return len(found) == len(set(post_ids)) and all(day7.day7_views(p) is not None for p in found)


def write_lesson(store: db.Store, user_id: str, item: Item, now: datetime) -> bool:
    """Writes a new lesson only when no lesson with this id exists or the one there is expired, so a lesson the owner
    deleted (tombstone) or turned off while the run was working stays as the owner left it. Then it checks that the
    clips it rests on still have their numbers: a disconnect that ran meanwhile removes them, and the lesson is taken
    back out (the disconnect deletes lessons only after it removed the numbers, so one of the two always wins)."""
    try:
        store.put_when(
            item,
            "attribute_not_exists(pk) OR #s = :expired OR (#s IN (:trial, :active) AND #e <= :now)",
            names={"#s": "status", "#e": "expiresAt"},
            values={":expired": "expired", ":trial": "trial", ":active": "active", ":now": iso(now)},
        )
    except db.ConditionFailed:
        return False
    if not _still_measured(store, user_id, [str(p) for p in item.get("supportPostIds") or []]):
        store.delete(str(item["pk"]), str(item["sk"]))
        return False
    return True


def learn_group(run_: OwnerRun, group: Group) -> None:
    """Confirms this group's lessons, then, only when it has winners not looked at yet, asks for new ones."""
    store, now, key = run_.deps.store, run_.now, f"{group.creator_key}|{group.platform}"
    cands = candidates(group)
    by_trait = {c.trait: c for c in cands}
    for item in run_.items:
        mine = item.get("creatorKey") == group.creator_key and item.get("platform") == group.platform
        if mine and lessons.confirm(store, item, group, by_trait.get(str(item.get("trait"))), now):
            run_.report.confirmed += 1
    if not {w.post_id for w in group.winners} - set(run_.seen.get(key, [])):
        return  # no new evidence: no model call
    by_id = run_.by_id
    fresh = [
        c
        for c in cands
        if not lessons.blocked(by_id.get(lessons.lesson_id(group.creator_key, group.platform, c.trait)), now)
    ]
    if fresh:
        if _left(run_.deps, run_.started) < MODEL_CALL_SECONDS:
            run_.report.deferred += 1  # tomorrow: the winners stay unseen
            return
        if run_.block is None:
            run_.block = skill_prompt.load_block(
                store,
                run_.deps.media,
                run_.user_id,
                where="api.lessons",
                builtins=run_.deps.builtins,
                sleep=run_.deps.sleep,
            )
        run_.report.calls += 1
        written, _dropped = lessons.ask(
            run_.deps.bedrock,
            run_.deps.model_id,
            group,
            fresh,
            skills=run_.block,
            time_left=lambda: _left(run_.deps, run_.started),
        )
        for lesson in written:
            cand = by_trait[lesson["trait"]]
            lid = lessons.lesson_id(group.creator_key, group.platform, cand.trait)
            item = lessons.new_item(run_.user_id, group, cand, lesson, now, old=by_id.get(lid))
            if not write_lesson(store, run_.user_id, item, now):
                log("info", "learn.lesson_skipped", lessonId=lid)
                continue
            run_.items = [i for i in run_.items if i.get("lessonId") != lid] + [item]
            run_.report.written += 1
    run_.seen[key] = sorted(set(run_.seen.get(key, [])) | {w.post_id for w in group.winners})


def _status_rows(measured: Sequence[Measured], all_groups: Sequence[Group]) -> list[Item]:
    """Per creator and platform: measured clips, winners and how many more are needed for its own baseline."""
    names: dict[str, str] = {}
    keys: set[str] = set()
    for m in measured:
        if m.creator_key:
            keys.add(m.creator_key)
            names[m.creator_key] = names.get(m.creator_key) or m.creator_name
    winners = {(g.creator_key, g.platform): len(g.winners) for g in all_groups}
    rows: list[Item] = []
    for key in sorted(keys):
        mine = [m for m in measured if m.creator_key == key]
        platforms: dict[str, Item] = {}
        for platform, more in sorted(needed(mine, key).items()):
            platforms[platform] = {
                "measured": sum(1 for m in mine if m.platform == platform),
                "needed": more,
                "winners": winners.get((key, platform), 0),
            }
        rows.append({"creatorKey": key, "creatorName": names.get(key, ""), "platforms": platforms})
    everyone: dict[str, Item] = {}
    for platform in sorted({m.platform for m in measured}):
        count = sum(1 for m in measured if m.platform == platform)
        everyone[platform] = {
            "measured": count,
            "needed": max(0, MIN_BASELINE + 1 - count),
            "winners": winners.get((ALL_CREATORS, platform), 0),
        }
    rows.append({"creatorKey": ALL_CREATORS, "creatorName": "", "platforms": everyone})
    return rows


def _save_state(
    store: db.Store,
    user_id: str,
    old: Mapping[str, Any],
    seen: Mapping[str, list[str]],
    rows: list[Item],
    *,
    now: datetime,
) -> None:
    """Writes the owner's learn state only when something changed (a second run the same day writes nothing).

    The write is conditional on the ``version`` read at the start of the run: when something else changed the state
    meanwhile (a disconnect removed a platform from it), this run's copy is stale and is not written; tomorrow's run
    builds it again from the data as it is then."""
    if old and old.get("seen") == dict(seen) and old.get("creators") == rows:
        return
    raw = old.get("version")
    version = raw if isinstance(raw, int) else 0
    item = {
        "pk": db.user_pk(user_id),
        "sk": db.LEARN_STATE_SK,
        "type": "learnstate",
        "userId": user_id,
        "seen": dict(seen),
        "creators": rows,
        "checkedAt": iso(now),
        "version": version + 1,
    }
    try:
        if old:
            condition = "#v = :v" if isinstance(raw, int) else "attribute_not_exists(#v)"
            values = {":v": version} if isinstance(raw, int) else None
            store.put_when(item, f"attribute_exists(pk) AND {condition}", names={"#v": "version"}, values=values)
        else:
            store.put(item, if_absent=True)
    except db.ConditionFailed:
        log("warning", "learn.state_changed", userId=user_id)
