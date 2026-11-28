"""Reference videos, "Edit like these" (docs/CONTRACTS.md §57): merging the measured styles, the skills-block
section, and what the renderer copies (with no style, the clip is exactly what it was)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from clipfactory_agent import editstyle, loudness, proc
from clipfactory_agent import pipeline as pipeline_mod
from clipfactory_agent import render as R
from clipfactory_agent.bedrock import Facecam, FrameLayout
from clipfactory_agent.editstyle import DEFAULT, RenderStyle
from clipfactory_agent.skills import SkillsBlock, with_section

from .conftest import make_moment

HOOK = "he thought he got away with it"


def row(ref_id: str, created: str, style: dict[str, Any], **kw: Any) -> dict[str, Any]:
    return {
        "refId": ref_id,
        "name": f"clip {ref_id}.mp4",
        "createdAt": created,
        "status": "ready",
        "style": style,
        **kw,
    }


def caps() -> list[R.Phrase]:
    return R.phrases([R.TimedWord(0.5, 0.8, "no"), R.TimedWord(0.8, 1.1, "way")])


def style_line(ass: str, name: str) -> str:
    return next(line for line in ass.splitlines() if line.startswith(f"Style: {name},"))


# --- reading and merging ---------------------------------------------------------------------------------------------


def test_only_ready_rows_with_a_style_are_used_newest_first() -> None:
    rows: list[Any] = [
        row("a", "2026-11-01T00:00:00Z", {}),
        row("b", "2026-11-03T00:00:00Z", {"captions": {"size": "large"}}),
        {**row("c", "2026-11-05T00:00:00Z", {}), "status": "analyzing"},
        {**row("d", "2026-11-06T00:00:00Z", {}), "style": "broken"},
        "not a row",
        {"status": "ready"},
    ]
    refs = editstyle.ready_refs(rows)
    assert [r.ref_id for r in refs] == ["b", "a"]
    assert editstyle.build([]) == (None, "")
    assert editstyle.build([{"status": "failed", "style": {}}]) == (None, "")


def test_most_common_wins_ties_go_to_the_newest_and_numbers_use_the_median() -> None:
    refs = editstyle.ready_refs(
        [
            row(
                "old", "2026-11-01", {"captions": {"size": "small", "casing": "lower"}, "pacing": {"lengthSeconds": 20}}
            ),
            row(
                "mid", "2026-11-02", {"captions": {"size": "small", "casing": "title"}, "pacing": {"lengthSeconds": 40}}
            ),
            row(
                "new", "2026-11-03", {"captions": {"size": "large", "casing": "upper"}, "pacing": {"lengthSeconds": 33}}
            ),
        ]
    )
    m = editstyle.merge(refs)
    assert m["captions.size"] == "small"  # two of three
    assert m["captions.casing"] == "upper"  # a three-way tie: the newest
    assert m["pacing.lengthSeconds"] == 33.0  # the median
    two = editstyle.merge(refs[:2])  # new and mid
    assert two["captions.size"] == "large" and two["pacing.lengthSeconds"] == pytest.approx(36.5)


def test_bad_fields_are_ignored_and_missing_ones_keep_todays_default() -> None:
    bad = {
        "format": "full_frame",
        "hook": {"textPosition": "sideways"},
        "captions": {
            "present": "no",
            "wordsPerLine": True,
            "size": 5,
            "color": "red",
            "highlightColor": None,
            "casing": "UPPER ",
        },
        "pacing": {"jumpCuts": 0, "zooms": None, "lengthSeconds": float("nan")},
    }
    s = editstyle.render_style(editstyle.ready_refs([row("x", "2026-11-01", bad)]))
    assert s == RenderStyle(casing="upper") == DEFAULT
    assert editstyle.render_style([]) is DEFAULT


def test_the_render_style_follows_the_support_table() -> None:
    style = {
        "format": {"layout": "full_frame", "aspect": "1:1"},
        "hook": {"textPosition": "none"},
        "captions": {
            "present": True,
            "wordsPerLine": 6,
            "size": "large",
            "weight": "regular",
            "casing": "title",
            "color": "#ff0000",
            "highlightColor": "#00FF00",
            "highlightMode": "word",
            "box": True,
            "position": "middle",
        },
        "pacing": {"jumpCuts": False, "zooms": "none"},
    }
    s = editstyle.render_style(editstyle.ready_refs([row("x", "2026-11-01", style)]))
    assert s == RenderStyle(
        fill=True,
        hook=False,
        captions=True,
        words_per_line=4,  # 5 and 6 are clamped to 4
        caption_size=100,
        caption_bold=False,
        caption_color="#FF0000",
        highlight_color="#00FF00",
        casing="title",
        box=True,
        caption_middle=True,
        cut_silences=False,
        punch_in=False,
    )
    none = editstyle.render_style(
        editstyle.ready_refs([row("y", "2026-11-01", {"captions": {"highlightMode": "none"}})])
    )
    assert none.highlight_color is None
    top = editstyle.render_style(
        editstyle.ready_refs(
            [row("z", "2026-11-01", {"captions": {"position": "top"}, "hook": {"textPosition": "middle"}})]
        )
    )
    assert top == DEFAULT  # captions at the top and hook text in the middle are not supported: kept as today


def test_unsupported_lines() -> None:
    lines = editstyle.unsupported(
        {
            "format": {"layout": "split_facecam_bottom", "aspect": "16:9"},
            "captions": {"emoji": True, "position": "top"},
            "pacing": {"zooms": "many", "speedRamps": True},
            "placement": {"logo": "top_left"},
            "audio": {"music": True, "soundEffects": True},
        }
    )
    assert lines == [
        "Facecam at the bottom",
        "Square or wide videos",
        "Captions at the top",
        "Emoji in captions",
        "Many zooms",
        "Speed ramps",
        "A logo on every clip",
        "Added music",
        "Sound effects",
    ]
    assert editstyle.unsupported({}) == []


# --- the section in the skills block ---------------------------------------------------------------------------------


TWO = [
    row(
        "a",
        "2026-11-01",
        {
            "format": {"layout": "split_facecam_top"},
            "hook": {
                "seconds": 1,
                "textPosition": "top",
                "pattern": "starts on the payoff, then rewinds",
                "onScreenText": "HE HAD NO IDEA",
            },
            "captions": {"wordsPerLine": 2, "size": "large", "casing": "upper"},
            "pacing": {"lengthSeconds": 25, "jumpCuts": True},
            "ending": {"type": "loop"},
        },
    ),
    row(
        "b",
        "2026-11-02",
        {
            "format": {"layout": "full_frame"},
            "hook": {
                "seconds": 3,
                "textPosition": "none",
                "pattern": "a <b>question</b> first",
                "spoken": "wait for it",
            },
            "captions": {"wordsPerLine": 1, "size": "medium", "casing": "lower"},
            "pacing": {"lengthSeconds": 45, "jumpCuts": True},
            "ending": {"type": "punchline"},
        },
    ),
]


def test_the_section_lists_the_merged_style_and_each_hook() -> None:
    _, text = editstyle.build(TWO)
    lines = text.splitlines()
    assert lines[0] == '<reference_videos count="2">' and lines[1] == editstyle.SECTION_TITLE
    assert lines[-2] == editstyle.LIMIT_WINS and lines[-1] == "</reference_videos>"
    assert "- Format: the whole frame, no split." in lines  # a tie: the newest (b)
    assert "- Length: about 35 s." in lines  # the median
    assert '1. "clip b.mp4": a &lt;b&gt;question&lt;/b&gt; first; said: "wait for it".' in lines
    assert '2. "clip a.mp4": starts on the payoff, then rewinds; on screen: "HE HAD NO IDEA".' in lines
    assert all(len(line) <= 300 for line in lines)
    assert editstyle.section_text([]) == ""


def test_the_section_goes_after_every_skill_and_the_skills_stay_as_they_are() -> None:
    block = SkillsBlock('<owner_skills count="1">\nintro\n<skill name="x">t</skill>\n</owner_skills>', {"chars": 10})
    assert with_section(block, "") is block
    _, text = editstyle.build(TWO)
    out = with_section(block, text, name="refs")
    assert out.text.startswith(block.text) and out.text.index("</owner_skills>") < out.text.index(
        editstyle.SECTION_TITLE
    )
    assert out.counts["refs_chars"] == len(text) and out.counts["chars"] == len(out.text)


# --- the renderer ----------------------------------------------------------------------------------------------------


def test_no_style_and_the_default_style_change_nothing() -> None:
    plain = R.build_ass(HOOK, caps(), 20.0)
    assert R.build_ass(HOOK, caps(), 20.0, style=None) == plain
    assert R.build_ass(HOOK, caps(), 20.0, style=RenderStyle()) == plain
    assert R.caption_style() in plain
    assert "\\c&H0000D4FF&}NO{\\c&H00FFFFFF&}" in plain
    take = R.TakeShown("my take on it", 0.4, 4.4)
    assert R.build_ass(HOOK, caps(), 20.0, take=take, style=DEFAULT) == R.build_ass(HOOK, caps(), 20.0, take=take)


def test_caption_colours_size_weight_box_and_position() -> None:
    s = RenderStyle(
        caption_size=64,
        caption_bold=False,
        caption_color="#112233",
        highlight_color="#AABBCC",
        box=True,
        caption_middle=True,
    )
    ass = R.build_ass(HOOK, caps(), 20.0, style=s)
    line = style_line(ass, "Caption").split(",")
    assert line[2] == "64" and line[3] == line[4] == "&H00332211"  # &HAABBGGRR
    assert line[5] == R.CAPTION_BOX and line[7] == "0" and line[15] == "3"  # the box, regular weight
    assert int(line[-2]) == R.H - R.CAP_MIDDLE == 740 and R.SAFE[1] < R.CAP_MIDDLE < R.SAFE[3]
    assert "{\\c&H00CCBBAA&}NO{\\c&H00332211&} WAY" in ass
    big = style_line(R.build_ass(HOOK, caps(), 20.0, style=RenderStyle(caption_size=100)), "Caption").split(",")
    assert big[2] == "100" and big[-2] == str(R.H - R.CAP_BOTTOM)


def test_casing() -> None:
    ph = R.phrases([R.TimedWord(0.5, 0.8, "No"), R.TimedWord(0.8, 1.1, "way!")])
    for casing, want in (("upper", "NO WAY"), ("lower", "no way"), ("title", "No Way"), ("sentence", "No way")):
        ass = R.build_ass(HOOK, ph, 20.0, style=RenderStyle(casing=casing, highlight_color=None))
        assert f",Caption,,0,0,0,,{want}" in ass, casing


def test_no_highlight_shows_each_phrase_once() -> None:
    ass = R.build_ass(HOOK, caps(), 20.0, style=RenderStyle(highlight_color=None))
    events = [e for e in ass.splitlines() if ",Caption," in e and e.startswith("Dialogue")]
    assert events == ["Dialogue: 0,0:00:00.50,0:00:01.10,Caption,,0,0,0,,NO WAY"]


def test_no_hook_and_no_captions() -> None:
    ass = R.build_ass(HOOK, caps(), 20.0, style=RenderStyle(hook=False, captions=False))
    assert ",Hook,," not in ass and ",Caption,," not in ass
    assert "Style: Hook," in ass  # the styles stay; only the events go


def test_the_take_stands_where_the_captions_were_when_they_move_to_the_middle() -> None:
    take = R.TakeShown("my take on it", 0.4, 4.4)
    ass = R.build_ass(HOOK, caps(), 20.0, take=take, style=RenderStyle(caption_middle=True))
    assert int(style_line(ass, "Take").split(",")[-2]) == R.H - R.CAP_BOTTOM + R.TAKE_PAD


def test_words_per_line() -> None:
    ws = [R.TimedWord(i * 0.2, i * 0.2 + 0.2, w) for i, w in enumerate(["one", "two", "three", "four", "five"])]
    assert [p.text for p in R.phrases(ws, max_words=1)] == ["ONE", "TWO", "THREE", "FOUR", "FIVE"]
    assert [p.text for p in R.phrases(ws, max_words=4)] == ["ONE TWO THREE FOUR", "FIVE"]


class FakeRender:
    """render_clip with ffmpeg faked: every command is kept, the section has sound and lasts 40 s."""

    def __init__(self, tmp: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.tmp = tmp
        self.runs: list[list[str]] = []

        async def probe(src: str) -> proc.MediaInfo:
            return proc.MediaInfo(40.0, 1280, 720, True, True, 30.0)

        async def run(args: list[str], **kw: object) -> proc.Result:
            self.runs.append(list(args))
            out = Path(args[-1])
            if out.suffix in (".mp4", ".jpg"):
                out.write_bytes(b"x")
            return proc.Result(b"", "[silencedetect @ 0x1] silence_start: 12\n[silencedetect @ 0x1] silence_end: 15\n")

        async def normalize(video: Path, tmp: Path) -> None:
            return None

        monkeypatch.setattr(proc, "probe", probe)
        monkeypatch.setattr(proc, "run", run)
        monkeypatch.setattr(loudness, "normalize", normalize)

    async def fetch(self, start: float, end: float, dest: Path) -> Path:
        dest.write_bytes(b"section")
        return dest

    async def cut(self, name: str, style: RenderStyle | None, **kw: Any) -> R.RenderResult:
        self.runs.clear()
        return await R.render_clip(
            make_moment(start=5, end=30, payoff_at=29, peak_at=20),
            words=[[6.0, 6.4, "no"], [6.4, 6.8, "way"], [7.0, 7.3, "that"], [7.3, 7.6, "is"]],
            workdir=self.tmp / name,
            fetch_section=self.fetch,
            detect_layout=None,
            known_layout=kw.pop("layout", FrameLayout(Facecam(0.7, 0.05, 0.25, 0.3), "gameplay")),
            style=style,
            **kw,
        )

    def graph(self) -> str:
        cut = next(a for a in self.runs if "-filter_complex" in a)
        return cut[cut.index("-filter_complex") + 1]

    def silences_detected(self) -> bool:
        return any(any("silencedetect" in x for x in a) for a in self.runs)


async def test_render_clip_without_a_style_is_unchanged(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    f = FakeRender(tmp_path, monkeypatch)
    plain = await f.cut("plain", None)
    graph, ass = f.graph(), (tmp_path / "plain" / "captions.ass").read_text()
    default = await f.cut("default", RenderStyle())
    assert (
        f.graph().replace("/default/", "/plain/") == graph
        and (tmp_path / "default" / "captions.ass").read_text() == ass
    )
    assert plain.layout == default.layout == "facecam_top" and plain.segments == default.segments
    assert "zoompan" in graph and f.silences_detected() and len(plain.segments) == 2


async def test_render_clip_keeps_pauses_and_skips_the_punch_in(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    f = FakeRender(tmp_path, monkeypatch)
    r = await f.cut("calm", RenderStyle(cut_silences=False, punch_in=False))
    assert not f.silences_detected() and r.segments == [(5.0, 30.0)]
    assert "zoompan" not in f.graph() and r.layout == "facecam_top"


async def test_render_clip_full_frame_forces_the_blur_fill(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    f = FakeRender(tmp_path, monkeypatch)
    layout = FrameLayout(Facecam(0.7, 0.05, 0.25, 0.3), "gameplay")
    r = await f.cut("fill", RenderStyle(fill=True), layout=layout)
    assert r.layout == "blur_fill" and r.frame_layout == layout  # a re-cut or copy still knows the facecam
    graph = f.graph()
    assert f"overlay=(W-w)/2:{R.BAND}[lay]" in graph and "[cams]" not in graph
    ass = (tmp_path / "fill" / "captions.ass").read_text()
    assert ",Hook,," in ass


async def test_render_clip_words_per_line_and_no_captions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    f = FakeRender(tmp_path, monkeypatch)
    one = await f.cut("one", RenderStyle(words_per_line=1))
    assert [c["text"] for c in one.captions] == ["NO", "WAY", "THAT", "IS"]
    off = await f.cut("off", RenderStyle(captions=False, hook=False))
    ass = (tmp_path / "off" / "captions.ass").read_text()
    assert ",Caption,," not in ass and ",Hook,," not in ass
    assert off.captions  # what is said is still known (the checks and the post captions read it)


async def test_a_campaign_clip_keeps_its_layout_hook_and_mark_row(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    f = FakeRender(tmp_path, monkeypatch)
    marks = R.Marks(disclosure="Paid partnership")
    plain = await f.cut("cr-plain", None, marks=marks)
    plain_ass = (tmp_path / "cr-plain" / "captions.ass").read_text()
    styled = await f.cut("cr", RenderStyle(fill=True, hook=False, caption_size=100, punch_in=False), marks=marks)
    ass = (tmp_path / "cr" / "captions.ass").read_text()
    assert styled.layout == plain.layout == "facecam_top" and styled.disclosure
    assert f"overlay=0:{R.CAMPAIGN_BAND}[l1]" in f.graph()
    assert ",Hook,," in ass and f",{R.CAMPAIGN_HOOK_TOP},1\n" in ass
    assert style_line(ass, "Disclosure") == style_line(plain_ass, "Disclosure")
    assert next(e for e in ass.splitlines() if ",Disclosure,," in e) == next(
        e for e in plain_ass.splitlines() if ",Disclosure,," in e
    )
    assert style_line(ass, "Caption").split(",")[2] == "100"  # the captions follow the style


# --- the pipeline ----------------------------------------------------------------------------------------------------


async def test_ready_refs_reach_the_skills_block_and_every_cut(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from .test_pipeline import World, assert_ready

    world = World(tmp_path, monkeypatch)
    world.store.refs = TWO
    styles: list[Any] = []
    fake = pipeline_mod.render_clip

    async def render(m: Any, **kw: Any) -> R.RenderResult:
        styles.append(kw.get("style"))
        return await fake(m, **kw)

    monkeypatch.setattr(pipeline_mod, "render_clip", render)
    status, st, steps = await world.run()
    assert_ready(status, steps)
    assert st.render_style is not None and st.render_style.fill and not st.render_style.hook
    text = st.block.text
    assert text.index("</owner_skills>") < text.index(editstyle.SECTION_TITLE) and editstyle.LIMIT_WINS in text
    assert styles and all(s == st.render_style for s in styles)


async def test_refs_that_cannot_be_read_never_fail_the_job(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from .test_pipeline import World, assert_ready

    world = World(tmp_path, monkeypatch)

    async def broken(user_id: str) -> list[dict[str, Any]]:
        raise RuntimeError("table is down")

    world.store.ref_rows = broken  # type: ignore[method-assign]
    styles: list[Any] = []
    fake = pipeline_mod.render_clip

    async def render(m: Any, **kw: Any) -> R.RenderResult:
        styles.append(kw.get("style"))
        return await fake(m, **kw)

    monkeypatch.setattr(pipeline_mod, "render_clip", render)
    status, st, steps = await world.run()
    assert_ready(status, steps)
    assert st.render_style is None and editstyle.SECTION_TITLE not in st.block.text
    assert styles and all(s is None for s in styles)
