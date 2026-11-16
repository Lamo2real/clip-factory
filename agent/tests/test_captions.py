from __future__ import annotations

from typing import Any

from clipfactory_agent.captions import (
    CAPTIONS_SCHEMA,
    FIELDS,
    ClipText,
    ensure,
    finish,
    fit,
    required_tags,
    template,
    title,
    write_captions,
)
from clipfactory_agent.schema import check
from clipfactory_agent.skills import skills_block

from .conftest import make_moment


def test_required_tags_from_notes_and_skills() -> None:
    notes = "Tag @RockstarGames and #GTA6, email me at a@b.com. Also #GTA6 again."
    skills = "Some text #example\nRequired hashtags: #ClipFactory #fyp\n"
    assert required_tags(notes, skills) == ["@RockstarGames", "#GTA6", "#ClipFactory", "#fyp"]
    assert required_tags("", "") == []


def test_ensure_appends_only_missing_tags() -> None:
    assert ensure("Wild one #gta6", ["#GTA6", "@me"]) == "Wild one #gta6\n\n@me"
    assert ensure("Fine", []) == "Fine"
    # A longer tag does not count as the shorter one.
    assert ensure("#GTA6Online", ["#GTA6"]).endswith("#GTA6")


def test_fit_keeps_tags_within_limit() -> None:
    text = "word " * 100
    out = fit(text, ["#GTA6", "@me"], 280)
    assert len(out) <= 280 and out.endswith("#GTA6 @me")
    assert fit("short", ["#a"], 280) == "short\n\n#a"


def test_title_strips_hashtags_and_limits() -> None:
    assert title("You won't believe #shorts this") == "You won't believe this"
    assert len(title("x" * 150)) == 100


def test_finish_adds_shorts_and_tags() -> None:
    out = finish({f: "Hello" for f in FIELDS}, ["#GTA6"])
    assert set(out) == set(FIELDS)
    assert "#shorts" in out["youtubeDescription"] and "#GTA6" in out["youtubeDescription"]
    assert "#GTA6" not in out["youtubeTitle"]
    assert all("#GTA6" in out[f] for f in ("instagram", "facebook", "tiktok", "x"))


def test_template() -> None:
    out = template(make_moment(), ["@me"])
    assert out["youtubeTitle"] == "He thought he got away with it"
    assert "@me" in out["x"]


class FakeBedrock:
    def __init__(self, answer: dict[str, Any] | Exception) -> None:
        self.answer = answer
        self.calls: list[dict[str, Any]] = []

    async def structured(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(kw)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


async def test_write_captions_uses_claude_and_template_for_missing() -> None:
    answer = {"clips": [{"id": "A", **{f: f"{f} text" for f in FIELDS}}]}
    assert check(CAPTIONS_SCHEMA, answer) == []
    fake = FakeBedrock(answer)
    clips = [
        ClipText("A", make_moment(), "no way"),
        ClipText("B", make_moment(hook="chat could not believe this one"), ""),
    ]
    block = skills_block([])
    out = await write_captions(fake, clips, notes="#GTA6", skills=block, skills_text="", system="s")  # type: ignore[arg-type]
    assert fake.calls[0]["skills"] is block
    assert out["A"]["instagram"].startswith("instagram text") and "#GTA6" in out["A"]["instagram"]
    assert out["B"]["youtubeTitle"] == "Chat could not believe this one"


async def test_write_captions_falls_back_on_model_error() -> None:
    from clipfactory_agent.bedrock import ModelError

    out = await write_captions(
        FakeBedrock(ModelError("no")),  # type: ignore[arg-type]
        [ClipText("A", make_moment(), "")],
        notes="",
        skills=skills_block([]),
        skills_text="",
        system="s",
    )
    assert out["A"]["tiktok"] == "He thought he got away with it"
