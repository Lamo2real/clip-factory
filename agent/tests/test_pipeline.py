from __future__ import annotations

from pathlib import Path

from clipfactory_agent.captions import FIELDS
from clipfactory_agent.checklist import Candidate, Item
from clipfactory_agent.pipeline import JobState, clip_item
from clipfactory_agent.render import RenderResult

from .conftest import make_moment


def state(**job: object) -> JobState:
    st = JobState(job_id="01JOB", user_id="user-1", workdir=Path("/tmp/x"))
    st.job = {"notes": "Clips 15-30 seconds #GTA6", **job}
    st.settings = {"clipMin": 4, "clipMax": 8}
    return st


def test_job_state_targets() -> None:
    assert state(clipTarget={"min": 5, "max": 10}).clip_target == (5, 10)
    assert state(clipTarget={"min": 12, "max": 3}).clip_target == (10, 10)
    assert state().clip_target == (4, 8)  # settings when the job has none
    assert state().length == (15, 30)
    assert state().key("words.json") == "jobs/01JOB/source/words.json"


def test_clip_item_matches_the_contract() -> None:
    st = state()
    st.captions = {"01CLIP": dict.fromkeys(FIELDS, "x")}
    r = RenderResult(Path("clip.mp4"), Path("cover.jpg"), 27.4, [(100, 127.4)], [], "facecam_top", True)
    c = Candidate(make_moment(score=7.6), r, [Item("hear", "What do they hear?", True, "Loud.")], ["Moved the start."])
    item = clip_item(st, c, "01CLIP", 2, "jobs/01JOB/clips/01CLIP/", "youtube", "https://www.youtube.com/watch?v=abc")
    assert item["pk"] == "USER#user-1" and item["sk"] == "CLIP#01CLIP"
    assert item["gsi1pk"] == "JOB#01JOB" and item["gsi1sk"] == "CLIP#002"
    assert item["type"] == "clip" and item["status"] == "review" and item["rank"] == 2
    assert item["score"] == 8 and item["layout"] == "facecam_top" and item["momentType"] == "rage"
    assert item["sourceUrlAt"] == "https://www.youtube.com/watch?v=abc&t=100s"
    assert item["videoKey"] == "jobs/01JOB/clips/01CLIP/clip.mp4" and item["coverKey"].endswith("cover.jpg")
    assert item["checklist"] == {
        "items": [{"key": "hear", "label": "What do they hear?", "pass": True, "note": "Loud."}],
        "fixes": ["Moved the start."],
    }
    assert "videoUrl" not in item and "coverUrl" not in item  # the API adds presigned URLs
    upload = clip_item(st, c, "01CLIP", 1, "p/", "upload", "")
    assert "sourceUrlAt" not in upload
