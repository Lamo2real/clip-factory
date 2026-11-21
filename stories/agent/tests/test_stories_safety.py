"""Step ``safety`` (docs/CONTRACTS.md §45.11.5): the three outcomes (ok, rewritten then ok, ``needs_check``), an
owner's text never rewritten, the no-topic block, only shown guidance reaching the writer, and a story of another kind
that starts teaching driving safety held for the owner. These jobs stop before the drawing, so no ffmpeg is needed."""

from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path
from typing import Any

from lamostories_agent import keys
from lamostories_agent.data import AssetPut, JobFence
from lamostories_agent.guidance import load
from lamostories_agent.pipeline import HELD_TOPIC, StoryJob
from ls_fakes import PK, REPO, USER, WS, needs_deno, needs_libass
from test_stories_pipeline import (
    OK,
    POST,
    PREFIX,
    STORY,
    answers,
    job_item,
    run_job,
    sample,
    story_item,
    workspace,
    world,
    writer_answer,
)

CHECK_RUN = ["storyboard", "safety"]


def problem(ref: str, text: str = "This shows a dangerous act as something to copy.") -> dict[str, Any]:
    return {"ok": False, "problems": [{"ref": ref, "problem": text}]}


@needs_deno
def test_ok_when_the_checker_finds_nothing(tmp_path: Path) -> None:
    svc, _store, table, fake = world(tmp_path, job=job_item("J1", "S1", run=CHECK_RUN))
    assert run_job(svc) == "ready"
    story = table.item(f"STORY#{STORY}")
    assert story is not None and story["status"] == "review"
    assert story["safety"] == {
        "topicId": None,
        "status": "ok",
        "problems": [],
        "checkedScriptVersion": 1,
        "citations": [],
        "checkStatus": "ok",  # internal: the fact check's own status, without the last look
        "lastLook": [],  # internal: the final review's problems (the API's StorySafety shape leaves both out)
    }
    check = fake.calls[2]
    assert check["task"] == "fact_check" and check["ctx"].agent_id == "quality_assurance"
    assert "fact checker" in check["messages"][0]["content"][0]["text"]
    body = json.loads(check["messages"][0]["content"][1]["text"].split("\n", 1)[1])
    assert body["guidance"] is None and "nothing dangerous" in body["note"]
    assert {i["ref"] for i in body["items"]} >= {"caption:cap1", "scene:s1", "post:youtubeTitle"}


@needs_deno
def test_the_writers_text_is_rewritten_once_then_checked_again(tmp_path: Path) -> None:
    replies = answers(
        captions=[dict(POST), {**POST, "x": "Lamo learns to slow down on ice."}],
        fact_check=[problem("post:x"), OK],
    )
    svc, _store, table, fake = world(tmp_path, replies, job=job_item("J1", "S1", run=CHECK_RUN))
    assert run_job(svc) == "ready"
    assert fake.tasks() == ["storyboard", "captions", "fact_check", "storyboard", "captions", "fact_check"]
    assert "The fact checker found problems" in fake.calls[3]["messages"][0]["content"][0]["text"]
    story = table.item(f"STORY#{STORY}")
    assert story is not None and story["status"] == "review" and story["scriptVersion"] == 2
    assert story["safety"]["status"] == "ok" and story["safety"]["checkedScriptVersion"] == 2
    assert story["postCaptions"]["x"] == "Lamo learns to slow down on ice."
    job = table.item("PJOB#J1")
    assert job is not None and job["steps"][1]["message"] == "Rewritten, then checked"


@needs_deno
def test_problems_left_after_the_rewrite_hold_the_story_in_needs_check(tmp_path: Path) -> None:
    replies = answers(fact_check=problem("post:x", "This post tells people to speed."))
    svc, _store, table, fake = world(tmp_path, replies, job=job_item("J1", "S1", run=CHECK_RUN))
    assert run_job(svc) == "needs_check"
    # the runaway guard: at most 3 writer and 2 checker answers (here 2 and 2)
    assert fake.tasks().count("storyboard") == 2 and fake.tasks().count("fact_check") == 2
    story, job = table.item(f"STORY#{STORY}"), table.item("PJOB#J1")
    assert story is not None and job is not None
    assert story["status"] == "needs_check" and job["status"] == "needs_check" and "currentJobId" not in story
    assert story["safety"]["status"] == "problems"
    assert story["safety"]["problems"] == ["Post caption (x): This post tells people to speed."]
    assert story["safety"]["checkedScriptVersion"] == story["scriptVersion"]


@needs_deno
def test_a_driving_safety_story_without_a_checked_topic_is_never_written(tmp_path: Path) -> None:
    svc, _store, table, fake = world(
        tmp_path,
        story=story_item(category="driving_safety", safetyTopicId=None),
        job=job_item("J1", "S1", run=CHECK_RUN),
    )
    assert run_job(svc) == "failed"
    assert fake.calls == []  # no model was asked
    job = table.item("PJOB#J1")
    assert job is not None and job["error"].startswith(keys.NO_TOPIC)
    assert "Checked topics: Recovering from a skid" in job["error"]
    story = table.item(f"STORY#{STORY}")
    assert story is not None and story["status"] == "failed" and story.get("scriptVersion") == 0


@needs_deno
def test_only_shown_guidance_reaches_the_writer_and_a_hidden_step_is_caught(tmp_path: Path) -> None:
    answer = writer_answer()
    answer["captions"] = [
        {"id": "cap1", "at": 0.5, "dur": 2, "text": "Ease off the accelerator", "guidanceRef": "skid-recovery.2"},
        {"id": "cap2", "at": 3.2, "dur": 2, "text": "Release the brake", "guidanceRef": "skid-recovery.3"},
    ]
    story = story_item(category="driving_safety", safetyTopicId="skid-recovery")
    replies = answers(storyboard=answer, captions={**POST, "youtubeDescription": "Skids. #shorts"})
    svc, store, table, fake = world(tmp_path, replies, story=story, job=job_item("J1", "S1", run=CHECK_RUN))
    assert run_job(svc) == "needs_check"
    request = json.loads(fake.calls[0]["messages"][0]["content"][1]["text"].split("\n", 1)[1])
    shown = {s["id"] for s in request["guidance"]["steps"]} | {d["id"] for d in request["guidance"]["donts"]}
    topic = load(REPO / "stories" / "config").topic("skid-recovery")
    assert topic is not None and shown == topic.shown_ids
    assert "skid-recovery.3" not in json.dumps(request) and "skid-recovery.7" not in json.dumps(request)
    captions = json.loads(fake.calls[1]["messages"][0]["content"][1]["text"].split("\n", 1)[1])
    assert captions["sources"] == [c["publisher"] for c in topic.citations]  # the descriptions name the sources
    checker = json.loads(fake.calls[2]["messages"][0]["content"][1]["text"].split("\n", 1)[1])
    assert {h["id"] for h in checker["guidance"]["notChecked"]} >= {"skid-recovery.3", "skid-recovery.7"}
    saved = table.item(f"STORY#{STORY}")
    assert saved is not None
    assert saved["safety"]["topicId"] == "skid-recovery" and saved["safety"]["citations"]
    assert saved["safety"]["problems"] == [
        "Caption “Release the brake”: This caption uses advice that is not on the checked list."
    ]
    script = json.loads(store.objects[saved["scriptKey"]][0])
    assert script["safety"]["topicId"] == "skid-recovery"
    assert {c["publisher"] for c in script["safety"]["citations"]} == {c["publisher"] for c in topic.citations}
    assert "Based on advice from" in saved["postCaptions"]["youtubeDescription"]


@needs_deno
def test_a_story_that_starts_teaching_driving_safety_is_held(tmp_path: Path) -> None:
    answer = writer_answer()
    answer.update({"teachesSafety": True, "safetyTopicId": "skid-recovery"})
    svc, _store, table, _fake = world(tmp_path, answers(storyboard=answer), job=job_item("J1", "S1", run=CHECK_RUN))
    assert run_job(svc) == "needs_check"
    story = table.item(f"STORY#{STORY}")
    assert story is not None and story["safetyTopicId"] == "skid-recovery" and story["status"] == "needs_check"
    assert story["safety"]["problems"] == [HELD_TOPIC]


@needs_deno
def test_an_owners_edited_text_is_never_rewritten(tmp_path: Path) -> None:
    """The writer wrote v1; the owner then edited cap1 (the API's v2, no writer snapshot). Both captions are flagged:
    the rewrite may change the writer's cap2 only, and cap1's problem is shown to the owner."""
    script = sample()
    script["captions"] = [
        {"id": "cap1", "at": 0.5, "dur": 2, "text": "Ease off the accelerator"},
        {"id": "cap2", "at": 3.2, "dur": 2, "text": "Floor it!"},
    ]
    owners = copy.deepcopy(script)
    owners["captions"][0]["text"] = "Speed up on the ice"
    job = job_item("J1", "S1", run=list(keys.STEP_ORDER))
    story = story_item(scriptVersion=2, scriptKey=PREFIX + "script/v2.json", postCaptions=POST)
    flagged = {
        "ok": False,
        "problems": [
            {"ref": "caption:cap1", "problem": "Speeding up on ice is dangerous."},
            {"ref": "caption:cap2", "problem": "Flooring it is dangerous."},
        ],
    }
    fix = writer_answer(script)
    fix["captions"] = [
        {"id": "cap1", "at": 0.5, "dur": 2, "text": "Something the writer prefers"},
        {"id": "cap2", "at": 3.2, "dur": 2, "text": "Ease off gently"},
    ]
    replies = answers(storyboard=fix, fact_check=[flagged, problem("caption:cap1", "Speeding up on ice is dangerous.")])
    svc, store, table, fake = world(tmp_path, replies, story=story, job=job)
    store.objects[PREFIX + "script/v1.json"] = (json.dumps(script).encode(), "application/json")
    snapshot = {"by": "writer", "texts": {"caption:cap1": "Ease off the accelerator", "caption:cap2": "Floor it!"}}
    store.objects[PREFIX + "script/v1.writer.json"] = (json.dumps(snapshot).encode(), "application/json")
    store.objects[PREFIX + "script/v2.json"] = (json.dumps(owners).encode(), "application/json")
    v1 = AssetPut(
        "storyboard", PREFIX + "script/v1.json", "application/json", 10, 1, story_id=STORY, meta={"by": "writer"}
    )
    table.seed(
        {**v1.item(JobFence(USER, WS, "J0", "S0"), "2026-11-21T17:00:00.000Z"), "meta": {"current": 1, "by": "writer"}}
    )

    async def go() -> None:
        j = StoryJob(svc, JobFence(USER, WS, "J1", "S1"), STORY)
        j.job = table.item("PJOB#J1") or {}
        j.steps = j.job["steps"]
        j.run_steps = list(keys.STEP_ORDER)
        j.story = table.item(f"STORY#{STORY}") or {}
        j.config = workspace()["configuration"]
        j.assets = await svc.data.assets(USER, WS, story_id=STORY)
        assert await j.check_facts() == "1 thing to check"

    asyncio.run(go())
    assert fake.tasks() == ["fact_check", "storyboard", "fact_check"]
    rewrite = json.loads(fake.calls[1]["messages"][0]["content"][1]["text"].split("\n", 1)[1])
    assert "caption:cap1" in rewrite["keep"] and "caption:cap2" not in rewrite["keep"]
    saved = table.item(f"STORY#{STORY}")
    assert saved is not None and saved["scriptVersion"] == 3
    new = json.loads(store.objects[saved["scriptKey"]][0])
    texts = {c["id"]: c["text"] for c in new["captions"]}
    assert texts == {
        "cap1": "Speed up on the ice",
        "cap2": "Ease off gently",
    }  # the owner's words stay as he wrote them
    assert saved["safety"]["status"] == "problems"
    assert saved["safety"]["problems"] == ["Caption “Speed up on the ice”: Speeding up on ice is dangerous."]
    assert table.item(f"STORY#{STORY}", PK) is not None


@needs_deno
def test_the_owners_edits_the_api_records_are_never_rewritten_even_without_a_snapshot(tmp_path: Path) -> None:
    """``ownerEdits`` (the API's record of the owner's own text) protects his caption with no writer snapshot."""
    script = sample()
    script["captions"] = [
        {"id": "cap1", "at": 0.5, "dur": 2, "text": "Speed up on the ice"},
        {"id": "cap2", "at": 3.2, "dur": 2, "text": "Floor it!"},
    ]
    story = story_item(scriptVersion=1, scriptKey=PREFIX + "script/v1.json", postCaptions=POST,
                       ownerEdits={"captions": ["cap1"], "sceneCaptions": [], "postCaptions": ["x"]})  # fmt: skip
    flagged = {"ok": False, "problems": [{"ref": "caption:cap1", "problem": "Speeding is dangerous."},
                                         {"ref": "caption:cap2", "problem": "Flooring it is dangerous."},
                                         {"ref": "post:x", "problem": "This post is unkind."}]}  # fmt: skip
    fix = writer_answer(script)
    fix["captions"] = [
        {"id": "cap1", "at": 0.5, "dur": 2, "text": "The writer's own words"},
        {"id": "cap2", "at": 3.2, "dur": 2, "text": "Ease off gently"},
    ]
    replies = answers(storyboard=fix, fact_check=[flagged, problem("caption:cap1", "Speeding is dangerous.")])
    svc, store, table, fake = world(tmp_path, replies, story=story, job=job_item("J1", "S1"))
    store.objects[PREFIX + "script/v1.json"] = (json.dumps(script).encode(), "application/json")

    async def go() -> None:  # the safety step of a whole remake (so captions may change), run on its own
        j = StoryJob(svc, JobFence(USER, WS, "J1", "S1"), STORY)
        j.job = table.item("PJOB#J1") or {}
        j.steps = j.job["steps"]
        j.run_steps = list(keys.STEP_ORDER)
        j.story = table.item(f"STORY#{STORY}") or {}
        j.config = workspace()["configuration"]
        j.assets = await svc.data.assets(USER, WS, story_id=STORY)
        assert await j.check_facts() == "1 thing to check"

    asyncio.run(go())
    rewrite = json.loads(fake.calls[1]["messages"][0]["content"][1]["text"].split("\n", 1)[1])
    assert {"caption:cap1", "post:x"} <= set(rewrite["keep"])
    saved = table.item(f"STORY#{STORY}")
    assert saved is not None
    new = json.loads(store.objects[saved["scriptKey"]][0])
    assert {c["id"]: c["text"] for c in new["captions"]} == {"cap1": "Speed up on the ice", "cap2": "Ease off gently"}
    assert saved["postCaptions"]["x"] == POST["x"]


@needs_deno
@needs_libass
def test_the_final_review_adds_its_problems_and_holds_the_story(tmp_path: Path) -> None:
    """The quality agent's last look (preview) finds a problem: it joins safety.problems and the story waits."""
    replies = answers(final_review={"ok": False, "problems": [{"ref": "", "problem": "The last caption is cut off."}]})
    svc, _store, table, fake = world(tmp_path, replies)
    assert run_job(svc) == "needs_check"
    story, job = table.item(f"STORY#{STORY}"), table.item("PJOB#J1")
    assert story is not None and job is not None
    assert story["status"] == "needs_check" and job["status"] == "needs_check"
    assert story["safety"]["status"] == "problems"
    assert story["safety"]["problems"] == ["Last look: The last caption is cut off."]
    assert job["steps"][-1]["message"] == "1 thing to check"
    assert fake.calls[-1]["task"] == "final_review" and fake.calls[-1]["ctx"].agent_id == "quality_assurance"


def quality_off(answer: Any) -> Any:
    """The quality agent switched off: its calls stop, except the ones that must run anyway (``allow_inactive``)."""
    from lamostories_agent.models import AgentOff

    def got(kw: dict[str, Any]) -> Any:
        if not kw.get("allow_inactive"):
            raise AgentOff("Quality check is switched off.")
        if isinstance(answer, list):  # used in turn, the last one kept
            return answer.pop(0) if len(answer) > 1 else answer[0]
        return answer

    return got


def produce(table: Any, job_id: str, session: str, run: list[str], **story: Any) -> None:
    table.seed({**table.items[(PK, f"STORY#{STORY}")], "status": "producing", "currentJobId": job_id, **story})
    table.seed(job_item(job_id, session, run=run))


@needs_deno
def test_a_story_the_writer_flags_is_always_checked_and_held_until_the_advice_is_checked_or_gone(
    tmp_path: Path,
) -> None:
    """A comedy story the writer flags teachesSafety with no topic it could pick, the quality agent off: the fact
    check still runs (never "skipped"), every piece of driving advice is a problem, and the story is held. A later
    job (no storyboard) still knows the flag from the writer's sidecar; once the advice is gone the hold ends."""
    from lamostories_agent.safety import UNCHECKED_NOTE

    answer = writer_answer()
    answer.update({"teachesSafety": True, "safetyTopicId": None})
    advice = problem("caption:cap1", "This gives driving advice that is not on the checked list.")
    replies = answers(storyboard=answer, fact_check=quality_off([advice, advice, OK]))
    svc, store, table, fake = world(tmp_path, replies, job=job_item("J1", "S1", run=CHECK_RUN))
    assert run_job(svc) == "needs_check"
    checks = [c for c in fake.calls if c["task"] == "fact_check"]
    assert checks and all(c.get("allow_inactive") is True for c in checks)
    body = json.loads(checks[0]["messages"][0]["content"][1]["text"].split("\n", 1)[1])
    assert body["guidance"] is None and body["note"] == UNCHECKED_NOTE
    story = table.item(f"STORY#{STORY}")
    assert story is not None and story["safety"]["status"] == "problems" and HELD_TOPIC in story["safety"]["problems"]
    sidecar = json.loads(store.objects[story["scriptKey"].removesuffix(".json") + ".writer.json"][0])
    assert sidecar["teachesSafety"] is True

    # the owner edits something; the next "Check again" runs only the fact check: still checked, still held
    fake.answers["fact_check"] = quality_off(advice)
    produce(table, "J2", "S2", ["safety"], stale=["safety"])
    assert run_job(svc, "J2", "S2") == "needs_check"
    assert fake.calls[-1]["allow_inactive"] is True
    held = table.item(f"STORY#{STORY}")
    assert held is not None and held["safety"]["status"] == "problems" and HELD_TOPIC in held["safety"]["problems"]

    # the advice taken out: the checker finds none, and the story may be approved
    fake.answers["fact_check"] = quality_off(OK)
    produce(table, "J3", "S3", ["safety"], stale=["safety"])
    assert run_job(svc, "J3", "S3") == "ready"
    done = table.item(f"STORY#{STORY}")
    assert done is not None and done["status"] == "review" and done["safety"]["status"] == "ok"


@needs_deno
def test_the_code_s_own_findings_count_when_the_quality_agent_is_off(tmp_path: Path) -> None:
    """A comedy story with the quality agent off is skipped, unless the code itself found a problem (a caption that
    names advice that is not on the checked list): then the problem is shown, never "skipped"."""
    script = sample()
    script["captions"][0]["guidanceRef"] = "made-up-step"
    svc, store, table, _fake = world(
        tmp_path, answers(fact_check=quality_off(OK)), job=job_item("J1", "S1", run=["safety"])
    )
    store.objects[PREFIX + "script/v1.json"] = (json.dumps(script).encode(), "application/json")
    table.seed(story_item(scriptVersion=1, scriptKey=PREFIX + "script/v1.json", postCaptions=POST))
    assert run_job(svc) == "needs_check"
    story = table.item(f"STORY#{STORY}")
    assert story is not None and story["safety"]["status"] == "problems"
    assert story["safety"]["problems"] == [
        "Caption “Ease off the accelerator”: This caption uses advice that is not on the checked list."
    ]


@needs_deno
@needs_libass
def test_the_last_look_s_problems_stand_until_a_new_look_and_are_never_added_twice(tmp_path: Path) -> None:
    cut = {"ok": False, "problems": [{"ref": "", "problem": "The last caption is cut off."}]}
    svc, _store, table, fake = world(tmp_path, answers(final_review=cut))
    assert run_job(svc) == "needs_check"
    first = table.item(f"STORY#{STORY}")
    assert first is not None and first["safety"]["problems"] == ["Last look: The last caption is cut off."]

    # a post caption edit runs the fact check alone: the video was not looked at again, so the last look stands
    produce(table, "J2", "S2", ["safety"], stale=["safety"])
    assert run_job(svc, "J2", "S2") == "needs_check"
    second = table.item(f"STORY#{STORY}")
    assert second is not None and second["safety"]["status"] == "problems"
    assert second["safety"]["problems"] == ["Last look: The last caption is cut off."]

    # the same finding again on a new look: shown once
    produce(table, "J3", "S3", ["preview"])
    assert run_job(svc, "J3", "S3") == "needs_check"
    third = table.item(f"STORY#{STORY}")
    assert third is not None and third["safety"]["problems"] == ["Last look: The last caption is cut off."]

    # an effects edit (sound, assemble, preview; the check carried over by the API): a clean look clears it
    fake.answers["final_review"] = OK
    produce(table, "J4", "S4", ["sound", "assemble", "preview"])
    assert run_job(svc, "J4", "S4") == "ready"
    fourth = table.item(f"STORY#{STORY}")
    assert fourth is not None and fourth["status"] == "review"
    assert fourth["safety"]["status"] == "ok" and fourth["safety"]["problems"] == []
    assert fourth["safety"]["checkedScriptVersion"] == fourth["scriptVersion"]
