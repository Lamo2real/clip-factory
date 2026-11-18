"""Learn from results (docs/CONTRACTS.md §16.12, ADR-41): day-7 numbers, winners, traits, lessons, the daily run,
the routes and forgetting a platform. Offline: fakes only, no AWS, no real platform numbers."""

from __future__ import annotations

import copy
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from clipfactory_api import daily, day7, db, lessons, s3, traits, weekly, winners
from clipfactory_api.clock import iso
from clipfactory_api.creators import ALL_CREATORS, creator_key, creator_keys
from clipfactory_api.ids import ulid
from clipfactory_api.learning_rules import MAD_FLOOR, MIN_BASELINE
from clipfactory_api.stats import config
from clipfactory_api.stats.handler import handle as stats_handle
from clipfactory_api.stats.refresh import StatsDeps, write_result
from conftest import USER, Call, seed_clip
from fakes import FakeS3, FakeTable, client_error

NOW = datetime(2026, 11, 18, 5, 0, tzinfo=UTC)
CREATOR = "youtube:id:UCaaaaaaaaaaaaaaaaaaaaaa"
OTHER_CREATOR = "youtube:id:UCbbbbbbbbbbbbbbbbbbbbbb"
SHORT_HOOK = "He lost it"
LONG_HOOK = "he really thought nobody would notice what he did right there"
MEDIA = s3.Media(FakeS3(), "cf-prod-media-123")


class ScriptedBedrock:
    """Converse answers in order: a JSON string (end_turn), a (stopReason, text) pair, or an exception."""

    def __init__(self, *replies: Any) -> None:
        self.replies = list(replies)
        self.calls: list[dict[str, Any]] = []

    def converse(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(kw)
        reply = self.replies.pop(0) if self.replies else json.dumps({"lessons": []})
        if isinstance(reply, BaseException):
            raise reply
        stop, text = reply if isinstance(reply, tuple) else ("end_turn", reply)
        return {"output": {"message": {"role": "assistant", "content": [{"text": text}]}}, "stopReason": stop}


def answer(*rows: dict[str, Any]) -> str:
    return json.dumps({"lessons": list(rows)})


# --- seeding ---------------------------------------------------------------------------------------------------


def seed_post(
    store: db.Store,
    clip: dict[str, Any],
    *,
    platform: str = "youtube",
    posted_at: datetime,
    views: int | None = None,
    read_at: datetime | None = None,
    frozen: int | None = None,
    window: bool = True,
) -> dict[str, Any]:
    """A posted post. ``views``: one STAT# snapshot read at ``read_at`` (default 7 days after posting).
    ``frozen``: the day-7 number already written."""
    post_id = ulid()
    item: dict[str, Any] = {
        "pk": db.user_pk(USER),
        "sk": db.post_sk(post_id),
        "gsi1pk": f"CLIP#{clip['clipId']}",
        "gsi1sk": f"POST#{platform}",
        "type": "post",
        "userId": USER,
        "postId": post_id,
        "clipId": clip["clipId"],
        "platform": platform,
        "status": "posted",
        "postedAt": iso(posted_at),
    }
    if window:
        item.update({"gsi2pk": "STATS", "gsi2sk": f"{iso(posted_at)}#{post_id}"})
    if frozen is not None:
        item.update({"day7State": "frozen", "day7": frozen, "day7At": iso(posted_at + timedelta(days=7))})
    if views is not None or frozen is not None:
        item["metrics"] = {"views": views if views is not None else frozen}  # what the poller stored
    store.put(item)
    if views is not None:
        at = read_at or posted_at + timedelta(days=7)
        stat(store, item, at, views, read_at=at)
    return item


def stat(
    store: db.Store, post: dict[str, Any], at: datetime, views: int | None, *, read_at: datetime | None
) -> dict[str, Any]:
    snap: dict[str, Any] = {
        "pk": db.user_pk(USER),
        "sk": db.stat_sk(post["postId"], iso(at)),
        "type": "stat",
        "postId": post["postId"],
        "platform": post["platform"],
        "at": iso(at),
    }
    if views is not None:
        snap["views"] = views
    if read_at is not None:
        snap["viewsReadAt"] = iso(read_at)
    store.put(snap)
    return snap


def creator_clip(store: db.Store, key: str = CREATOR, *, job: str, hook: str, **fields: Any) -> dict[str, Any]:
    clip = seed_clip(store, job_id=job, hook=hook, status="posted", **fields)
    store.update(
        clip["pk"], clip["sk"], {"creatorKey": key, "creatorName": "Streamer " + key[-1], "creatorKeys": [key]}
    )
    return {**clip, "creatorKey": key}


def seed_creator(
    store: db.Store,
    key: str = CREATOR,
    *,
    normals: int = 22,
    winners_: int = 4,
    win_views: int = 6000,
    posted_at: datetime | None = None,
) -> list[dict[str, Any]]:
    """``normals`` posts around 1,000 views with long hooks and ``winners_`` posts at ``win_views`` with short hooks,
    each winner from its own source video. Every post is 10 days old, so its day-7 window has closed."""
    posted = posted_at or NOW - timedelta(days=10)
    out = []
    jobs = [ulid() for _ in range(3)]
    for i in range(normals):
        clip = creator_clip(store, key, job=jobs[i % 3], hook=LONG_HOOK)
        out.append(seed_post(store, clip, posted_at=posted - timedelta(minutes=i), views=800 + (i * 37) % 400))
    for i in range(winners_):
        clip = creator_clip(store, key, job=ulid(), hook=SHORT_HOOK)
        out.append(seed_post(store, clip, posted_at=posted - timedelta(minutes=100 + i), views=win_views + i))
    return out


def deps(store: db.Store, bedrock: Any, *, now: datetime = NOW, budget: float = 720.0) -> daily.DailyDeps:
    return daily.DailyDeps(
        store=store,
        bedrock=bedrock,
        model_id="global.anthropic.claude-fable-5-1",
        media=MEDIA,
        clock=lambda: now,
        builtins=list,
        budget_seconds=budget,
    )


def lessons_of(store: db.Store) -> list[dict[str, Any]]:
    return lessons.all_lessons(store, USER)


def short_hook_lesson(store: db.Store) -> str:
    winner = next(
        c for c in store.query_all(db.user_pk(USER), "CLIP#") if c.get("hook") == SHORT_HOOK and c.get("creatorKey")
    )
    return answer(
        {
            "trait": "hook:short",
            "text": "Lean toward short hooks of 5 words or fewer that drop the viewer straight into the moment.",
            "clipIds": [winner["clipId"]],
        }
    )


# --- the creator key -------------------------------------------------------------------------------------------


def test_creator_key_prefers_the_channel_id_and_normalises_names() -> None:
    assert creator_key({"platform": "YouTube ", "channelId": "UC123", "channel": "Big Streamer"}) == "youtube:id:UC123"
    assert creator_keys({"platform": "twitch", "channelId": "42", "channel": "@Big  Streamer"}) == [
        "twitch:id:42",
        "twitch:name:big streamer",
    ]
    assert creator_key({"platform": "kick", "channel": "  @Loud  "}) == "kick:name:loud"
    assert creator_key({"platform": "upload", "channel": "me"}) is None
    assert creator_key({"platform": "youtube"}) is None
    assert creator_key(None) is None


def test_the_agent_has_the_same_creator_rules() -> None:
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    api = (root / "api/src/clipfactory_api/creators.py").read_text()
    agent = (root / "agent/src/clipfactory_agent/creators.py").read_text()
    assert api == agent, "agent/src/clipfactory_agent/creators.py must be a byte-for-byte copy"


# --- day 7 -----------------------------------------------------------------------------------------------------

POSTED = NOW - timedelta(days=10)


def _snap(views: int | None, days: float, *, read: bool = True) -> dict[str, Any]:
    at = POSTED + timedelta(days=days)
    out: dict[str, Any] = {"sk": f"STAT#P#{iso(at)}", "at": iso(at)}
    if views is not None:
        out["views"] = views
    if read:
        out["viewsReadAt"] = iso(at)
    return out


@pytest.mark.parametrize(
    ("days", "inside"),
    [(6.49, False), (6.5, True), (7.0, True), (8.5, True), (8.51, False)],
)
def test_day7_window_edges(days: float, inside: bool) -> None:
    chosen = day7.choose(POSTED, [_snap(500, days)])
    assert (chosen is not None) == inside
    if chosen:
        assert chosen.views == 500


def test_day7_takes_the_reading_closest_to_seven_days() -> None:
    chosen = day7.choose(POSTED, [_snap(100, 6.6), _snap(200, 7.2), _snap(300, 8.4), _snap(50, 3)])
    assert chosen is not None
    assert chosen.views == 200


def test_day7_never_guesses_from_outside_the_window() -> None:
    # Readings at day 3 and day 12 only: no interpolation, no latest value, no zero.
    assert day7.choose(POSTED, [_snap(100, 3), _snap(900, 12)]) is None


def test_zero_is_a_number_but_no_views_is_not_a_reading() -> None:
    zero = day7.choose(POSTED, [_snap(0, 7)])
    assert zero is not None
    assert zero.views == 0
    assert day7.choose(POSTED, [_snap(None, 7)]) is None


def test_old_snapshots_count_only_when_the_views_changed() -> None:
    same = [_snap(400, 5, read=False), _snap(400, 7, read=False)]
    assert day7.choose(POSTED, same) is None  # could be day-5 views stamped day 7
    moved = [_snap(400, 5, read=False), _snap(450, 7, read=False)]
    chosen = day7.choose(POSTED, moved)
    assert chosen is not None
    assert chosen.views == 450


def test_freeze_writes_once_and_missing_stays_missing(store: db.Store, table: FakeTable) -> None:
    clip = creator_clip(store, job=ulid(), hook=SHORT_HOOK)
    post = seed_post(store, clip, posted_at=POSTED, views=1234)
    lost = seed_post(store, clip, platform="tiktok", posted_at=POSTED)
    stat(store, lost, POSTED + timedelta(days=3), 50, read_at=POSTED + timedelta(days=3))
    assert day7.freeze(store, post, NOW) == "frozen"
    assert day7.freeze(store, lost, NOW) == "missing"
    frozen = store.get(post["pk"], post["sk"]) or {}
    assert frozen["day7"] == 1234
    assert frozen["day7State"] == "frozen"
    assert frozen["day7Source"]["viewsReadAt"] == iso(POSTED + timedelta(days=7))
    assert frozen["day7Source"]["statKey"].startswith(f"STAT#{post['postId']}#")
    missing = store.get(lost["pk"], lost["sk"]) or {}
    assert missing["day7State"] == "missing"
    assert "day7" not in missing
    # A later reading never changes either answer.
    stat(store, lost, POSTED + timedelta(days=7), 999, read_at=POSTED + timedelta(days=7))
    assert day7.freeze(store, missing, NOW + timedelta(days=1)) == "skipped"
    assert "day7" not in (store.get(lost["pk"], lost["sk"]) or {})
    assert day7.due(missing, NOW) is False


def test_a_post_is_frozen_only_after_its_window_closed() -> None:
    post = {"type": "post", "status": "posted", "postedAt": iso(NOW - timedelta(days=8))}
    assert day7.due(post, NOW) is False
    assert day7.due({**post, "postedAt": iso(NOW - timedelta(days=8.5))}, NOW) is True
    assert day7.due({**post, "status": "failed", "postedAt": iso(POSTED)}, NOW) is False


def test_an_insights_only_refresh_in_the_window_is_not_a_day7_reading(store: db.Store) -> None:
    """K1: the refresh writes a snapshot at day 7 that still holds day-3 views; it carries viewsReadAt = day 3."""
    clip = creator_clip(store, job=ulid(), hook=SHORT_HOOK)
    day3 = POSTED + timedelta(days=3)
    post = seed_post(store, clip, posted_at=POSTED)
    store.update(
        post["pk"],
        post["sk"],
        {
            "metrics": {"views": 300, "metricsUpdatedAt": iso(day3), "checkedAt": iso(day3)},
            "lastSnapshotAt": iso(day3),
            "lastSnapshotViews": 300,
        },
    )
    deps_ = StatsDeps(store=store, cfg=config.load(config.REPO_FILE))
    at7 = POSTED + timedelta(days=7)
    write_result(deps_, store.get(post["pk"], post["sk"]) or {}, None, {"shares": 4}, at7)
    (snap,) = store.query_all(db.user_pk(USER), db.stat_prefix(post["postId"]))
    assert snap["at"] == iso(at7)
    assert snap["views"] == 300
    assert "viewsReadAt" not in snap  # stored before viewsUpdatedAt existed: no proof of when views were read
    assert day7.freeze(store, store.get(post["pk"], post["sk"]) or {}, NOW) == "missing"


def test_a_counts_refresh_stamps_views_read_at(store: db.Store) -> None:
    clip = creator_clip(store, job=ulid(), hook=SHORT_HOOK)
    post = seed_post(store, clip, posted_at=POSTED)
    at7 = POSTED + timedelta(days=7)
    write_result(StatsDeps(store=store, cfg=config.load(config.REPO_FILE)), post, {"views": 777}, None, at7)
    (snap,) = store.query_all(db.user_pk(USER), db.stat_prefix(post["postId"]))
    assert snap["viewsReadAt"] == iso(at7)
    assert day7.freeze(store, store.get(post["pk"], post["sk"]) or {}, NOW) == "frozen"


# --- the winner test -------------------------------------------------------------------------------------------


def m(views: int, *, creator: str | None = CREATOR, platform: str = "youtube", source: str = "J") -> winners.Measured:
    pid = ulid()
    return winners.Measured(pid, "C" + pid, source, platform, creator, "", views, NOW - timedelta(days=10))


def test_equal_views_name_no_winners_thanks_to_the_mad_floor() -> None:
    assert MAD_FLOOR == 0.2
    baseline = [1000] * 25
    assert winners.is_winner(1999, baseline) is False  # under 2x: never
    assert winners.is_winner(2050, baseline) is False  # 2x, but z = 1.6 at the floor
    assert winners.is_winner(2200, baseline) is True
    rows = [m(1000) for _ in range(25)]
    assert not any(v.winner for v in winners.judge(rows).values())


def test_fewer_than_twenty_baseline_posts_fall_back_to_all_creators() -> None:
    mine = [m(1000 + i) for i in range(10)] + [m(9000)]
    others = [m(1000 + i, creator=OTHER_CREATOR) for i in range(15)]
    verdicts = winners.judge(mine + others)
    star = verdicts[mine[-1].post_id]
    assert star.scope == "all"
    assert star.winner
    assert star.baseline == 25


def test_too_few_posts_anywhere_name_no_winner() -> None:
    rows = [m(1000 + i) for i in range(MIN_BASELINE - 1)] + [m(50_000)]
    verdicts = winners.judge(rows)
    assert all(v.scope is None and not v.winner for v in verdicts.values())
    assert winners.needed(rows, CREATOR) == {"youtube": 1}


def test_platforms_are_never_mixed() -> None:
    youtube = [m(1000 + i) for i in range(25)]
    tiktok_star = m(9000, platform="tiktok")
    verdicts = winners.judge([*youtube, tiktok_star])
    assert verdicts[tiktok_star.post_id].scope is None  # no TikTok baseline at all


def test_the_clip_under_test_is_left_out_of_its_baseline() -> None:
    rows = [m(1000) for _ in range(20)]
    star = m(9000)
    assert winners.judge([*rows, star])[star.post_id].baseline == 20


# --- trait guards ----------------------------------------------------------------------------------------------


def _group(win_rows: list[winners.Measured], other_rows: list[winners.Measured]) -> winners.Group:
    return winners.Group(CREATOR, "S", "youtube", "creator", [*win_rows, *other_rows], win_rows)


def _with(views: int, hook: str, source: str) -> winners.Measured:
    row = m(views, source=source)
    return winners.Measured(**{**row.__dict__, "clip": {"hook": hook}})


def test_a_trait_needs_three_winners() -> None:
    wins = [_with(9000, SHORT_HOOK, s) for s in ("A", "B")]
    others = [_with(1000, LONG_HOOK, "C") for _ in range(20)]
    assert traits.candidates(_group(wins, others)) == []


def test_a_trait_needs_two_source_videos() -> None:
    wins = [_with(9000, SHORT_HOOK, "A") for _ in range(4)]
    others = [_with(1000, LONG_HOOK, "C") for _ in range(20)]
    assert traits.candidates(_group(wins, others)) == []


def test_a_trait_needs_a_lift_of_one_and_a_half() -> None:
    wins = [_with(9000, SHORT_HOOK, s) for s in ("A", "B", "C", "D")]
    common = [_with(1000, SHORT_HOOK, "E") for _ in range(16)] + [_with(1000, LONG_HOOK, "E") for _ in range(4)]
    assert traits.candidates(_group(wins, common)) == []  # 100 % vs 80 %: lift 1.25
    rare = [_with(1000, SHORT_HOOK, "E") for _ in range(5)] + [_with(1000, LONG_HOOK, "E") for _ in range(15)]
    (cand,) = traits.candidates(_group(wins, rare))
    assert (cand.trait, cand.winners_with, cand.others_with, cand.others_known, cand.sources) == (
        "hook:short",
        4,
        5,
        20,
        4,
    )


def test_a_missing_fact_counts_on_neither_side() -> None:
    row = m(1000)
    assert traits.facts(winners.Measured(**{**row.__dict__, "clip": {"hook": "x"}})).get("wordsPerSecond") is None
    paced = winners.Measured(**{**row.__dict__, "clip": {"durationSec": 20, "wordCount": 50, "firstWordSec": 0.2}})
    f = traits.facts(paced)
    assert f["wordsPerSecond"] == 2.5
    assert f["firstWordSec"] == 0.2
    assert {"pace:normal", "start:instant", "length:20-30"} <= set(traits.traits(f))


# --- the model's words are checked -----------------------------------------------------------------------------


def _one_group(store: db.Store) -> winners.Group:
    seed_creator(store)
    report = daily.Report()
    d = deps(store, ScriptedBedrock())
    posts = daily.freeze_due(d, USER, NOW, report, d.monotonic())
    measured = winners.recent(daily.measured_posts(store, USER, posts, NOW), NOW)
    (group,) = [g for g in winners.groups(measured, winners.judge(measured)) if g.creator_key == CREATOR]
    return group


def test_an_invented_number_is_rejected_then_retried(store: db.Store) -> None:
    group = _one_group(store)
    cands = traits.candidates(group)
    assert [c.trait for c in cands] == ["hook:short"]
    winner = group.winners[0].clip_id
    bad = answer({"trait": "hook:short", "text": "Short hooks got 37% more views.", "clipIds": [winner]})
    good = answer({"trait": "hook:short", "text": "Keep hooks to 5 words or fewer.", "clipIds": [winner]})
    bedrock = ScriptedBedrock(bad, good)
    written, problems = lessons.ask(bedrock, "m", group, cands, skills=_block())
    assert [w["text"] for w in written] == ["Keep hooks to 5 words or fewer."]
    assert problems == []
    assert len(bedrock.calls) == 2
    assert "37 is not in the evidence" in bedrock.calls[1]["messages"][0]["content"][0]["text"]


def test_a_lesson_still_wrong_after_one_retry_is_dropped(store: db.Store) -> None:
    group = _one_group(store)
    cands = traits.candidates(group)
    fake = answer({"trait": "hook:short", "text": "Keep hooks short.", "clipIds": ["NOT-A-WINNER"]})
    twice = answer({"trait": "hook:short", "text": "Hooks of fifty words win.", "clipIds": []})
    bedrock = ScriptedBedrock(fake, twice)
    written, problems = lessons.ask(bedrock, "m", group, cands, skills=_block())
    assert written == []
    assert len(problems) == 1
    assert "50 is not in the evidence" in problems[0]
    assert len(bedrock.calls) == 2


@pytest.mark.parametrize(
    ("text", "ok"),
    [
        ("Keep hooks to 5 words or fewer.", True),
        ("Use hooks of 5 words; the median clip got 1,000 views.", False),
        ("Twice as many views come from short hooks.", False),
        ("Lean toward short hooks. Open on the action. Then stop.", False),
        ("See clip 01JAAAAAAAAAAAAAAAAAAAAAAA for the hook.", False),
    ],
)
def test_lesson_text_rules(text: str, ok: bool) -> None:
    cand = traits.Candidate("youtube", "hook:short", "short hooks of 5 words or fewer", 4, 4, 0, 20, 4, ("P",), ("C",))
    allowed = lessons.evidence_numbers({"label": cand.label, "winners": 4, "measuredClips": 24})
    clean, _why = lessons.check_lesson(
        {"trait": "hook:short", "text": text, "clipIds": ["C"]}, {cand.trait: cand}, {"C"}, allowed
    )
    assert (clean is not None) == ok


def test_the_lesson_call_sends_the_skills_block_first(store: db.Store) -> None:
    group = _one_group(store)
    bedrock = ScriptedBedrock(answer())
    lessons.ask(bedrock, "m", group, traits.candidates(group), skills=_block())
    (request,) = bedrock.calls
    assert request["system"][0]["text"].startswith("<owner_skills")
    assert request["system"][-1] == {"text": lessons.SYSTEM_PROMPT}
    assert request["outputConfig"]["textFormat"]["type"] == "json_schema"
    payload = request["messages"][0]["content"][0]["text"]
    assert '"winnerClips"' in payload
    assert '"normalClips"' in payload
    assert "hook:short" in payload


def _block() -> Any:
    from clipfactory_api.skill_prompt import skills_block

    return skills_block([], where="test")


# --- the daily run ---------------------------------------------------------------------------------------------


def test_the_daily_run_freezes_finds_winners_and_writes_a_trial_lesson(store: db.Store) -> None:
    seed_creator(store)
    bedrock = ScriptedBedrock(short_hook_lesson(store))
    out = daily.run(deps(store, bedrock))
    assert out["owners"] == 1
    assert out["frozen"] == 26
    assert out["modelCalls"] == 1
    assert out["lessonsWritten"] == 1
    (lesson,) = lessons_of(store)
    assert lesson["status"] == "trial"
    assert lesson["kind"] == "creator"
    assert lesson["type"] == "learning"
    assert lesson["creatorKey"] == CREATOR
    assert lesson["scope"] == "creator"
    assert lesson["platform"] == "youtube"
    assert lesson["trait"] == "hook:short"
    assert lesson["expiresAt"] == iso(NOW + timedelta(days=90))
    ev = lesson["evidence"]
    assert (ev["winners"], ev["measured"], ev["baseline"]) == (4, 26, "creator")
    assert sorted(w["views"] for w in ev["winnerViews"]) == [6000, 6001, 6002, 6003]
    assert ev["trait"]["winnersWith"] == 4
    assert ev["trait"]["othersWith"] == 0
    state = store.get(db.user_pk(USER), db.LEARN_STATE_SK) or {}
    rows = {r["creatorKey"]: r for r in state["creators"]}
    assert rows[CREATOR]["platforms"]["youtube"] == {"measured": 26, "needed": 0, "winners": 4}


def test_a_second_run_the_same_day_changes_nothing(store: db.Store, table: FakeTable) -> None:
    seed_creator(store)
    bedrock = ScriptedBedrock(short_hook_lesson(store))
    daily.run(deps(store, bedrock))
    before = copy.deepcopy(table.items)
    again = daily.run(deps(store, bedrock))  # the automatic retry, or a second rule delivery
    assert table.items == before
    assert len(bedrock.calls) == 1
    assert again["modelCalls"] == 0
    assert again["frozen"] == 0
    assert again["lessonsWritten"] == 0


def test_a_quiet_day_calls_no_model(store: db.Store) -> None:
    seed_creator(store, winners_=0)
    bedrock = ScriptedBedrock()
    out = daily.run(deps(store, bedrock))
    assert out["modelCalls"] == 0
    assert bedrock.calls == []
    assert lessons_of(store) == []


def test_one_lucky_clip_never_makes_a_lesson(store: db.Store) -> None:
    seed_creator(store, winners_=1, win_views=50_000)
    bedrock = ScriptedBedrock()
    daily.run(deps(store, bedrock))
    assert bedrock.calls == []
    assert lessons_of(store) == []


def test_not_enough_clips_names_no_winner_and_says_how_many_more(store: db.Store) -> None:
    seed_creator(store, normals=8, winners_=4)
    bedrock = ScriptedBedrock()
    daily.run(deps(store, bedrock))
    assert bedrock.calls == []
    state = store.get(db.user_pk(USER), db.LEARN_STATE_SK) or {}
    rows = {r["creatorKey"]: r for r in state["creators"]}
    assert rows[CREATOR]["platforms"]["youtube"]["needed"] == 9
    assert rows[ALL_CREATORS]["platforms"]["youtube"] == {"measured": 12, "needed": 9, "winners": 0}


def test_a_failure_for_one_creator_never_stops_the_others(store: db.Store) -> None:
    seed_creator(store, CREATOR)
    seed_creator(store, OTHER_CREATOR)
    other_winner = next(
        c["clipId"]
        for c in store.query_all(db.user_pk(USER), "CLIP#")
        if c.get("creatorKey") == OTHER_CREATOR and c.get("hook") == SHORT_HOOK
    )
    ok = answer({"trait": "hook:short", "text": "Short hooks of 5 words or fewer work.", "clipIds": [other_winner]})
    bedrock = ScriptedBedrock(client_error("ThrottlingException", 429), ok)
    out = daily.run(deps(store, bedrock))
    assert out["failed"] == 1
    assert out["lessonsWritten"] == 1
    (lesson,) = lessons_of(store)
    assert lesson["creatorKey"] == OTHER_CREATOR
    # The failed creator's winners stay unseen, so tomorrow asks again.
    state = store.get(db.user_pk(USER), db.LEARN_STATE_SK) or {}
    assert f"{CREATOR}|youtube" not in state["seen"]


def test_the_time_budget_leaves_model_calls_for_tomorrow(store: db.Store) -> None:
    seed_creator(store)
    bedrock = ScriptedBedrock()
    out = daily.run(deps(store, bedrock, budget=10.0))
    assert out["deferred"] == 1
    assert bedrock.calls == []


def test_lesson_life_trial_confirm_expire(store: db.Store) -> None:
    seed_creator(store)
    daily.run(deps(store, ScriptedBedrock(short_hook_lesson(store))))
    # Too early: a run 3 days later never confirms, even with a new winner.
    _new_winner(store, NOW + timedelta(days=3))
    daily.run(deps(store, ScriptedBedrock(), now=NOW + timedelta(days=3)))
    assert lessons_of(store)[0]["status"] == "trial"
    # 8 days later, another new short-hook winner: confirmed and active.
    later = NOW + timedelta(days=8)
    _new_winner(store, later)
    bedrock = ScriptedBedrock()
    daily.run(deps(store, bedrock, now=later))
    (lesson,) = lessons_of(store)
    assert lesson["status"] == "active"
    assert lesson["confirmedAt"] == iso(later)
    assert lesson["expiresAt"] == iso(later + timedelta(days=90))
    assert bedrock.calls == []  # the trait is already a lesson: no model call for it
    # No new support for 90 days: expired, and never given to the picker.
    gone = later + timedelta(days=91)
    daily.run(deps(store, ScriptedBedrock(), now=gone))
    assert lessons_of(store)[0]["status"] == "expired"


def _new_winner(store: db.Store, now: datetime) -> None:
    clip = creator_clip(store, job=ulid(), hook=SHORT_HOOK)
    seed_post(store, clip, posted_at=now - timedelta(days=9), views=7000)


def test_at_most_five_active_lessons_per_creator(store: db.Store) -> None:
    for n in range(7):
        store.put(
            {
                "pk": db.user_pk(USER),
                "sk": db.lesson_sk(f"{n:024x}"),
                "type": "learning",
                "kind": "creator",
                "lessonId": f"{n:024x}",
                "creatorKey": CREATOR,
                "platform": "youtube",
                "trait": f"t{n}",
                "status": "active",
                "supportPostIds": [str(i) for i in range(n + 1)],
                "confirmedAt": iso(NOW),
                "expiresAt": iso(NOW + timedelta(days=30)),
            }
        )
    items = lessons_of(store)
    assert lessons.cap(store, items, NOW) == 2
    active = sorted(i["trait"] for i in lessons_of(store) if i["status"] == "active")
    assert active == ["t2", "t3", "t4", "t5", "t6"]  # the best supported stay


def test_off_on_and_a_deleted_lesson_is_not_written_again(store: db.Store) -> None:
    seed_creator(store)
    daily.run(deps(store, ScriptedBedrock(short_hook_lesson(store))))
    (lesson,) = lessons_of(store)
    lid = lesson["lessonId"]
    off = lessons.turn(store, USER, lid, "off", NOW)
    assert off is not None
    assert off["status"] == "off"
    assert off["statusBeforeOff"] == "trial"
    on = lessons.turn(store, USER, lid, "on", NOW)
    assert on is not None
    assert on["status"] == "trial"
    assert "statusBeforeOff" not in on
    assert lessons.delete(store, USER, lid, NOW) is True
    (tomb,) = lessons_of(store)
    assert tomb["status"] == "deleted"
    assert "text" not in tomb
    assert "evidence" not in tomb
    # New winners with the same trait: the tombstone keeps the lesson from coming back.
    _new_winner(store, NOW + timedelta(days=2))
    bedrock = ScriptedBedrock(short_hook_lesson(store))
    daily.run(deps(store, bedrock, now=NOW + timedelta(days=2)))
    assert bedrock.calls == []
    assert [i["status"] for i in lessons_of(store)] == ["deleted"]


def test_older_clips_get_their_creator_from_the_job(store: db.Store) -> None:
    job = ulid()
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.job_sk(job),
            "type": "job",
            "jobId": job,
            "source": {"type": "link", "platform": "youtube", "channel": "Old Name"},
        }
    )
    clip = seed_clip(store, job_id=job, status="posted")  # made before creatorKey was stored
    post = seed_post(store, clip, posted_at=POSTED, frozen=500)
    (row,) = daily.measured_posts(store, USER, [store.get(post["pk"], post["sk"]) or {}], NOW)
    assert row.creator_key == "youtube:name:old name"
    assert "creatorKey" not in (store.get(clip["pk"], clip["sk"]) or {})  # read only: nothing rewritten


def test_an_old_name_key_joins_the_channel_id_once_one_new_clip_has_both(store: db.Store) -> None:
    old_job = ulid()
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.job_sk(old_job),
            "type": "job",
            "jobId": old_job,
            "source": {"platform": "youtube", "channel": "Big One"},
        }
    )
    old = seed_post(store, seed_clip(store, job_id=old_job, status="posted"), posted_at=POSTED, frozen=1)
    new_clip = seed_clip(store, job_id=ulid(), status="posted")
    store.update(
        new_clip["pk"],
        new_clip["sk"],
        {"creatorKey": "youtube:id:UC9", "creatorKeys": ["youtube:id:UC9", "youtube:name:big one"]},
    )
    new = seed_post(store, new_clip, posted_at=POSTED, frozen=2)
    rows = daily.measured_posts(store, USER, [store.get(p["pk"], p["sk"]) or {} for p in (old, new)], NOW)
    assert {r.creator_key for r in rows} == {"youtube:id:UC9"}


def test_owners_are_found_through_the_poll_index_without_a_scan(store: db.Store, table: FakeTable) -> None:
    seed_creator(store, normals=2, winners_=0)
    assert daily.owners(store) == [USER]
    assert all(name in {"query", "put_item", "update_item"} for name, _ in table.calls)
    assert any(kw.get("IndexName") == "gsi2" for name, kw in table.calls if name == "query")


def test_the_learn_lambda_runs_the_daily_mode_on_a_scheduled_event(store: db.Store) -> None:
    seed_creator(store, winners_=0)
    wdeps = weekly.WeeklyDeps(
        store=store, bedrock=ScriptedBedrock(), model_id="m", vectors=None, media=MEDIA, clock=lambda: NOW
    )
    event = {"source": "aws.events", "detail-type": "Scheduled Event", "detail": {}}
    out = weekly.handle(event, wdeps)
    assert out["action"] == "daily"
    assert out["owners"] == 1
    assert out["frozen"] == 22
    assert weekly.handle({"week": "2026-W46"}, wdeps)["outcome"] == "bad_event"


# --- forgetting a platform -------------------------------------------------------------------------------------


def test_forgetting_youtube_removes_every_day7_number_and_lesson(store: db.Store) -> None:
    seed_creator(store)
    daily.run(deps(store, ScriptedBedrock(short_hook_lesson(store))))
    assert lessons_of(store)
    stats_deps = StatsDeps(store=store, cfg=config.load(config.REPO_FILE))
    out = stats_handle({"action": "forget", "userId": USER, "platform": "youtube"}, stats_deps)
    assert out["lessons"] == 1
    assert lessons_of(store) == []
    for post in store.query_all(db.user_pk(USER), "POST#"):
        assert not {"day7", "day7At", "day7Source", "day7State", "metrics"} & set(post)
    state = store.get(db.user_pk(USER), db.LEARN_STATE_SK) or {}
    assert all(not k.endswith("|youtube") for k in state["seen"])
    assert all("youtube" not in r["platforms"] for r in state["creators"])


# --- the routes ------------------------------------------------------------------------------------------------


def _seed_lesson(store: db.Store, **fields: Any) -> dict[str, Any]:
    clip = creator_clip(store, job=ulid(), hook=SHORT_HOOK)
    lid = lessons.lesson_id(CREATOR, "youtube", "hook:short")
    item = {
        "pk": db.user_pk(USER),
        "sk": db.lesson_sk(lid),
        "type": "learning",
        "kind": "creator",
        "userId": USER,
        "lessonId": lid,
        "creatorKey": CREATOR,
        "creatorName": "Big One",
        "scope": "creator",
        "platform": "youtube",
        "trait": "hook:short",
        "traitLabel": "short hooks of 5 words or fewer",
        "text": "Keep hooks short.",
        "status": "active",
        "evidence": {"winners": 4, "measured": 31, "medianViews": 1000, "winnerViews": [], "trait": {}},
        "clipIds": [clip["clipId"]],
        "supportPostIds": ["P1"],
        "createdAt": "2026-11-01T05:00:00.000Z",
        "confirmedAt": "2026-11-10T05:00:00.000Z",
        "expiresAt": "2027-02-08T05:00:00.000Z",
        **fields,
    }
    store.put(item)
    return item


def test_get_lessons(call: Call, store: db.Store) -> None:
    item = _seed_lesson(store)
    store.put({"pk": db.user_pk(USER), "sk": db.LEARN_STATE_SK, "type": "learnstate", "creators": [], "seen": {}})
    status, body = call("GET", "/v1/lessons")
    assert status == 200
    (lesson,) = body["lessons"]
    assert lesson["lessonId"] == item["lessonId"]
    assert lesson["status"] == "active"
    assert lesson["clips"] == [{"clipId": item["clipIds"][0], "hook": SHORT_HOOK}]
    assert "supportPostIds" not in lesson
    assert "pk" not in lesson
    assert "userId" not in lesson
    assert body["creators"] == []


def test_get_lessons_shows_an_expired_lesson_as_expired(call: Call, store: db.Store) -> None:
    _seed_lesson(store, expiresAt="2026-11-01T00:00:00.000Z")
    _, body = call("GET", "/v1/lessons")
    assert body["lessons"][0]["status"] == "expired"


def test_patch_and_delete_lessons(call: Call, store: db.Store) -> None:
    item = _seed_lesson(store)
    path = f"/v1/lessons/{item['lessonId']}"
    status, body = call("PATCH", path, {"status": "off"})
    assert status == 200
    assert body["lesson"]["status"] == "off"
    status, body = call("PATCH", path, {"status": "on"})
    assert status == 200
    assert body["lesson"]["status"] == "active"
    assert call("PATCH", path, {"status": "active"})[0] == 400
    assert call("PATCH", path, {"status": "off", "text": "x"})[0] == 400
    assert call("PATCH", "/v1/lessons/not-an-id", {"status": "off"})[0] == 404
    assert call("PATCH", f"/v1/lessons/{'0' * 24}", {"status": "off"})[0] == 404
    assert call("DELETE", path)[0] == 204
    assert call("GET", "/v1/lessons")[1]["lessons"] == []
    assert call("PATCH", path, {"status": "on"})[0] == 404  # a tombstone cannot be turned back on
    assert call("DELETE", f"/v1/lessons/{'0' * 24}")[0] == 404


# --- review fixes ----------------------------------------------------------------------------------------------


def _ig_post(store: db.Store, day3: datetime) -> dict[str, Any]:
    clip = creator_clip(store, job=ulid(), hook=SHORT_HOOK)
    post = seed_post(store, clip, platform="instagram", posted_at=POSTED)
    metrics = {"views": 100, "likes": 5, "metricsUpdatedAt": iso(day3), "viewsUpdatedAt": iso(day3)}
    store.update(post["pk"], post["sk"], {"metrics": metrics, "lastSnapshotAt": iso(day3), "lastSnapshotViews": 100})
    return store.get(post["pk"], post["sk"]) or {}


def test_an_instagram_counts_only_refresh_does_not_stamp_old_views_as_day7(store: db.Store) -> None:
    """Instagram and Facebook read views only with the insights: likes alone are not a views reading."""
    day3 = POSTED + timedelta(days=3)
    post = _ig_post(store, day3)
    at7 = POSTED + timedelta(days=7)
    write_result(StatsDeps(store=store, cfg=config.load(config.REPO_FILE)), post, {"likes": 9}, {}, at7)
    (snap,) = store.query_all(db.user_pk(USER), db.stat_prefix(post["postId"]))
    assert snap["views"] == 100
    assert snap["viewsReadAt"] == iso(day3)  # the views are still the day-3 ones
    assert (store.get(post["pk"], post["sk"]) or {})["metrics"]["metricsUpdatedAt"] == iso(at7)
    assert day7.freeze(store, store.get(post["pk"], post["sk"]) or {}, NOW) == "missing"


def test_an_insights_refresh_with_views_stamps_views_read_at(store: db.Store) -> None:
    day3 = POSTED + timedelta(days=3)
    post = _ig_post(store, day3)
    at7 = POSTED + timedelta(days=7)
    write_result(StatsDeps(store=store, cfg=config.load(config.REPO_FILE)), post, None, {"views": 500}, at7)
    (snap,) = store.query_all(db.user_pk(USER), db.stat_prefix(post["postId"]))
    assert (snap["views"], snap["viewsReadAt"]) == (500, iso(at7))
    assert (store.get(post["pk"], post["sk"]) or {})["metrics"]["metricsUpdatedAt"] == iso(day3)
    assert day7.freeze(store, store.get(post["pk"], post["sk"]) or {}, NOW) == "frozen"
    assert (store.get(post["pk"], post["sk"]) or {})["day7"] == 500


def _paced(views: int, source: str, *, pace: bool) -> winners.Measured:
    clip: dict[str, Any] = {"durationSec": 20}
    if pace:
        clip.update({"wordCount": 80, "firstWordSec": 0.1})
    return winners.Measured(**{**m(views, source=source).__dict__, "clip": clip})


def test_a_trait_needs_other_clips_to_compare_with() -> None:
    """Older clips have no pacing facts: three fast-talking winners against nothing is not a lesson."""
    wins = [_paced(9000, s, pace=True) for s in ("A", "B", "C")]
    old = [_paced(1000, "D", pace=False) for _ in range(25)]
    assert not [c for c in traits.candidates(_group(wins, old)) if c.trait.startswith(("pace:", "start:"))]
    some = [_paced(1000, "D", pace=False) for _ in range(16)] + [
        winners.Measured(**{**m(1000, source="E").__dict__, "clip": {"durationSec": 20, "wordCount": 30}})
        for _ in range(9)
    ]
    assert not [c for c in traits.candidates(_group(wins, some)) if c.trait.startswith("pace:")]  # 9 < 10


def test_a_bigger_channel_is_not_a_winner_just_for_being_bigger() -> None:
    small = [m(1000 + i, creator=CREATOR) for i in range(15)]
    big = [m(5000 + i, creator=OTHER_CREATOR) for i in range(10)]
    verdicts = winners.judge(small + big)
    assert {verdicts[r.post_id].scope for r in small + big} == {"all"}
    assert not any(v.winner for v in verdicts.values())
    star = m(9000, creator=OTHER_CREATOR)  # 1.8 x its own channel: still normal
    assert not winners.judge([*small, *big, star])[star.post_id].winner
    real = m(30_000, creator=OTHER_CREATOR)  # 6 x its own channel
    assert winners.judge([*small, *big, real])[real.post_id].winner


def test_an_all_creators_trait_needs_winners_from_two_creators() -> None:
    def row(views: int, creator: str, hook: str, source: str) -> winners.Measured:
        return winners.Measured(**{**m(views, creator=creator, source=source).__dict__, "clip": {"hook": hook}})

    others = [row(1000, CREATOR, LONG_HOOK, "Z") for _ in range(20)]
    one = [row(9000, OTHER_CREATOR, SHORT_HOOK, s) for s in ("A", "B", "C")]
    group = winners.Group(ALL_CREATORS, "", "youtube", "all", [*one, *others], one)
    assert traits.candidates(group) == []
    two = [*one[:2], row(9000, CREATOR, SHORT_HOOK, "D")]
    group = winners.Group(ALL_CREATORS, "", "youtube", "all", [*two, *others], two)
    assert [c.trait for c in traits.candidates(group)] == ["hook:short"]


@pytest.mark.parametrize(
    "text",
    [
        "Keep clips under fifteen seconds.",
        "Aim for sixty seconds or less.",
        "Hooks that hit x2 harder win.",
        "Thirteen-word hooks lose.",
        "Fast talkers got about fifteen times more views; lean into rapid chatter.",
        "One in seven clips wins.",
        "Clips with x10 the energy win.",
        "Triple the energy in the first moment.",
        "Twenty-five words are plenty.",
        "A quarter of the clip should be the payoff.",
    ],
)
def test_invented_number_words_and_multipliers_are_rejected(text: str) -> None:
    cand = traits.Candidate("youtube", "hook:short", "short hooks of 5 words or fewer", 4, 4, 0, 20, 4, ("P",), ("C",))
    allowed = lessons.evidence_numbers({"label": cand.label, "winners": 4, "measuredClips": 24})
    clean, why = lessons.check_lesson(
        {"trait": "hook:short", "text": text, "clipIds": ["C"]}, {cand.trait: cand}, {"C"}, allowed
    )
    assert clean is None
    assert "not in the evidence" in why


def test_number_words_from_the_evidence_are_fine() -> None:
    assert lessons.text_numbers("twenty-five, one hundred and fifty and 1,200") == [1200.0, 25.0, 150.0]
    assert lessons.text_numbers("quadruple, a third, half, first reactions in a second") == [4.0, 3.0, 0.5]
    cand = traits.Candidate("youtube", "hook:short", "short hooks of 5 words or fewer", 4, 4, 0, 20, 4, ("P",), ("C",))
    allowed = lessons.evidence_numbers({"label": cand.label, "winners": 4, "measuredClips": 24})
    clean, _ = lessons.check_lesson(
        {"trait": "hook:short", "text": "Keep hooks to five words; four winners did.", "clipIds": ["C"]},
        {cand.trait: cand},
        {"C"},
        allowed,
    )
    assert clean is not None


def test_a_baseline_of_zeros_names_no_winner() -> None:
    assert winners.is_winner(2, [0] * 20) is False
    assert winners.is_winner(3, [0] * 15 + [1] * 5) is False
    assert winners.is_winner(99, [5] * 20) is False  # under the views floor
    assert winners.is_winner(500, [0] * 20) is False  # a baseline median under the floor


def test_an_old_post_never_becomes_a_new_winner_when_the_baseline_moves(store: db.Store) -> None:
    """Judged once, against the baseline as it was when its day-7 number froze."""
    for i in range(25):
        clip = creator_clip(store, job=ulid(), hook=LONG_HOOK)
        seed_post(store, clip, posted_at=NOW - timedelta(days=86, minutes=i), views=2500 + i)
    for i in range(21):
        clip = creator_clip(store, job=ulid(), hook=LONG_HOOK)
        seed_post(store, clip, posted_at=NOW - timedelta(days=40, minutes=i), views=1000 + i)
    target = seed_post(
        store, creator_clip(store, job=ulid(), hook=SHORT_HOOK), posted_at=NOW - timedelta(days=9), views=3000
    )
    daily.run(deps(store, ScriptedBedrock()))
    verdict = (store.get(target["pk"], target["sk"]) or {})["day7Verdict"]
    assert verdict["winner"] is False
    assert verdict["scope"] == "creator"
    later = NOW + timedelta(days=8)  # the 86-day-old posts have left the 90-day window
    bedrock = ScriptedBedrock()
    out = daily.run(deps(store, bedrock, now=later))
    assert (store.get(target["pk"], target["sk"]) or {})["day7Verdict"] == verdict
    assert bedrock.calls == []
    assert out["modelCalls"] == 0
    state = store.get(db.user_pk(USER), db.LEARN_STATE_SK) or {}
    rows = {r["creatorKey"]: r for r in state["creators"]}
    assert rows[CREATOR]["platforms"]["youtube"]["winners"] == 0


def test_two_jobs_of_the_same_stream_are_one_source(store: db.Store) -> None:
    def job(url: str) -> str:
        jid = ulid()
        source = {"type": "link", "platform": "youtube", "url": url, "channel": "S"}
        store.put({"pk": db.user_pk(USER), "sk": db.job_sk(jid), "type": "job", "jobId": jid, "source": source})
        return jid

    a = job("https://www.youtube.com/watch?v=abc123")
    b = job("https://youtube.com/watch?v=abc123&t=30")
    c = job("https://youtu.be/xyz789")
    posts = [
        seed_post(store, seed_clip(store, job_id=j, status="posted"), posted_at=POSTED, frozen=10) for j in (a, b, c)
    ]
    rows = daily.measured_posts(store, USER, [store.get(p["pk"], p["sk"]) or {} for p in posts], NOW)
    assert sorted({r.source_id for r in rows}) == ["youtube:abc123", "youtube:xyz789"]
    assert daily.source_id({"source": {"type": "upload", "key": "u/1/v.mp4"}}) == "upload:u/1/v.mp4"
    assert daily.source_id(None) is None


def test_a_name_two_channels_share_joins_neither(store: db.Store) -> None:
    rows = [
        {"creatorKeys": ["youtube:id:UC1", "youtube:name:gamer"]},
        {"creatorKeys": ["youtube:id:UC2", "youtube:name:gamer"]},
        {"creatorKeys": ["youtube:id:UC3", "youtube:name:solo"]},
    ]
    assert daily._aliases(rows) == {"youtube:name:solo": "youtube:id:UC3"}


def test_measured_posts_reads_only_the_last_ninety_days(store: db.Store, table: FakeTable) -> None:
    old = seed_post(
        store, creator_clip(store, job=ulid(), hook=SHORT_HOOK), posted_at=NOW - timedelta(days=200), frozen=5
    )
    new = seed_post(
        store, creator_clip(store, job=ulid(), hook=SHORT_HOOK), posted_at=NOW - timedelta(days=20), frozen=6
    )
    table.calls.clear()
    rows = daily.measured_posts(store, USER, [old, new], NOW)
    assert [r.post_id for r in rows] == [new["postId"]]
    keys = [
        k["sk"] for name, kw in table.calls if name == "batch_get_item" for k in kw["RequestItems"][table.name]["Keys"]
    ]
    assert db.clip_sk(old["clipId"]) not in keys


def test_seen_only_keeps_posts_of_the_last_ninety_days(store: db.Store) -> None:
    seed_creator(store)
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.LEARN_STATE_SK,
            "type": "learnstate",
            "seen": {f"{CREATOR}|youtube": ["OLD-POST"]},
            "creators": [],
        }
    )
    daily.run(deps(store, ScriptedBedrock(short_hook_lesson(store))))
    state = store.get(db.user_pk(USER), db.LEARN_STATE_SK) or {}
    assert "OLD-POST" not in state["seen"][f"{CREATOR}|youtube"]
    assert len(state["seen"][f"{CREATOR}|youtube"]) == 4
    assert state["version"] == 1


def test_a_disconnect_during_the_freeze_keeps_the_number_out(store: db.Store) -> None:
    clip = creator_clip(store, job=ulid(), hook=SHORT_HOOK)
    post = seed_post(store, clip, posted_at=POSTED, views=1234)
    read = store.get(post["pk"], post["sk"]) or {}
    store.update(post["pk"], post["sk"], {}, remove=["metrics"])  # forget ran after the run read the post
    assert day7.freeze(store, read, NOW) == "skipped"
    assert "day7" not in (store.get(post["pk"], post["sk"]) or {})


def test_a_lesson_is_never_written_over_a_delete_or_a_disconnect(store: db.Store) -> None:
    seed_creator(store)
    daily.run(deps(store, ScriptedBedrock(short_hook_lesson(store))))
    (lesson,) = lessons_of(store)
    fresh = dict(lesson)
    # The owner deleted it while the run was working: the run's write is refused.
    lessons.delete(store, USER, lesson["lessonId"], NOW)
    assert daily.write_lesson(store, USER, fresh, NOW) is False
    assert lessons_of(store)[0]["status"] == "deleted"
    # A disconnect removed the numbers it rests on: the write is taken back out.
    store.delete(lesson["pk"], lesson["sk"])
    first = fresh["supportPostIds"][0]
    store.update(db.user_pk(USER), db.post_sk(first), {}, remove=["day7", "day7State", "metrics"])
    assert daily.write_lesson(store, USER, fresh, NOW) is False
    assert lessons_of(store) == []


def test_the_state_is_not_written_over_a_disconnect(store: db.Store) -> None:
    seed_creator(store)
    old = {
        "pk": db.user_pk(USER),
        "sk": db.LEARN_STATE_SK,
        "type": "learnstate",
        "seen": {},
        "creators": [],
        "version": 3,
    }
    store.put({**old, "version": 4})  # a forget bumped it after the run read version 3
    daily._save_state(store, USER, old, {"x|youtube": ["P"]}, [{"creatorKey": "x"}], now=NOW)
    assert (store.get(db.user_pk(USER), db.LEARN_STATE_SK) or {})["version"] == 4
    assert lessons.forget_platform(store, USER, "youtube") == 0
    assert (store.get(db.user_pk(USER), db.LEARN_STATE_SK) or {})["version"] == 5


def test_no_retry_is_sent_without_time_for_it(store: db.Store) -> None:
    group = _one_group(store)
    cands = traits.candidates(group)
    winner = group.winners[0].clip_id
    bad = answer({"trait": "hook:short", "text": "Short hooks got 37% more views.", "clipIds": [winner]})
    bedrock = ScriptedBedrock(bad, bad)
    written, problems = lessons.ask(bedrock, "m", group, cands, skills=_block(), time_left=lambda: 10.0)
    assert written == []
    assert len(bedrock.calls) == 1
    assert "no time left for a retry today" in problems


def test_freezing_stops_when_the_budget_is_spent(store: db.Store) -> None:
    seed_creator(store, normals=3, winners_=0)
    d = deps(store, ScriptedBedrock(), budget=0.0)
    report = daily.Report()
    daily.freeze_due(d, USER, NOW, report, d.monotonic())
    assert (report.frozen, report.deferred) == (0, 3)


def test_turning_a_lesson_back_on_only_works_on_an_off_lesson(store: db.Store) -> None:
    item = _seed_lesson(store, status="off", statusBeforeOff="active")
    store.put({**item, "status": "deleted"})  # deleted between the read and the write
    assert lessons.turn(store, USER, item["lessonId"], "on", NOW) is None
    expired = _seed_lesson(store, status="active", expiresAt="2026-11-01T00:00:00.000Z")
    same = lessons.turn(store, USER, expired["lessonId"], "off", NOW)
    assert same is not None
    assert same["status"] == "active"  # too old: nothing to turn off


def test_a_toggle_that_keeps_losing_the_race_is_a_409(call: Call, store: db.Store, monkeypatch: Any) -> None:
    item = _seed_lesson(store)

    def busy(*_a: Any, **_k: Any) -> Any:
        raise db.ConditionFailed("changed")

    monkeypatch.setattr(lessons, "turn", busy)
    status, body = call("PATCH", f"/v1/lessons/{item['lessonId']}", {"status": "off"})
    assert status == 409
    assert "Try again" in json.dumps(body)
