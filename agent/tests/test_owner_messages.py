"""Owner-facing failure text: names the real button, never carries raw tool output, never leaks a presigned URL."""

from __future__ import annotations

import json
from typing import Any

import pytest

from clipfactory_agent import callback, jobs, sources
from clipfactory_agent.bedrock import model_failure
from clipfactory_agent.proc import CommandError, run
from clipfactory_agent.retry import is_transient
from clipfactory_agent.util import TransientError, UserFacingError, log, redact_urls

PRESIGNED = (
    "https://cf-media.s3.eu-north-1.amazonaws.com/jobs/u/j/video.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256"
    "&X-Amz-Credential=ASIAFAKE%2F20261116%2Feu-north-1%2Fs3%2Faws4_request&X-Amz-Date=20261116T000000Z"
    "&X-Amz-Expires=21600&X-Amz-SignedHeaders=host&X-Amz-Security-Token=FAKESESSIONTOKEN123%2B%2F"
    "&X-Amz-Signature=abc123"
)
SECRETS = ("ASIAFAKE", "FAKESESSIONTOKEN123", "abc123")


def test_failure_messages_name_the_try_again_button() -> None:
    """F047: the job page's only button reads "Try again"; no message says "Retry" or "the agent"."""
    texts = [
        callback.GENERIC_FAILURE,
        jobs.failure_message("render", TransientError("x")),
        jobs.failure_message("render", RuntimeError("x")),
        str(model_failure(RuntimeError("boom"))),
    ]
    assert is_transient(TransientError("x"))
    for t in texts:
        assert "Try again" in t, t
        assert "Retry" not in t and "the agent" not in t.lower(), t


def test_download_failure_is_plain_and_names_the_brand(capsys: pytest.CaptureFixture[str]) -> None:
    """F048: yt-dlp's raw stderr goes to the log, the owner gets plain words and a next step."""
    raw = "ERROR: [youtube] abc: Some weird extractor KeyError('streamingData')"
    e = sources.explain(CommandError("yt-dlp", 1, raw), "youtube", False)
    assert isinstance(e, UserFacingError)
    msg = str(e)
    assert "YouTube" in msg and "Youtube" not in msg
    assert "KeyError" not in msg and "streamingData" not in msg
    assert "Try again" in msg and "upload the video file" in msg
    assert "streamingData" in capsys.readouterr().out  # still in the log for us
    gone = sources.explain(CommandError("yt-dlp", 1, "ERROR: Video unavailable"), "twitch", False)
    assert "Twitch" in str(gone)
    assert sources.platform_name("tiktok") == "TikTok"


def test_failed_job_shows_no_raw_error_text() -> None:
    """F048: failure_message passes a UserFacingError through as is, so the plain sentence is what job.error shows."""
    e = sources.explain(CommandError("yt-dlp", 1, "ERROR: something odd"), "kick", False)
    assert jobs.failure_message("fetch", e) == str(e)
    assert "something odd" not in str(e)


def test_redact_urls_blanks_presigned_parameters() -> None:
    """F071."""
    out = redact_urls(f"{PRESIGNED}: Server returned 403 Forbidden (access denied)")
    for s in SECRETS:
        assert s not in out
    assert "X-Amz-Security-Token=<redacted>" in out and "403 Forbidden" in out
    assert redact_urls("https://www.youtube.com/watch?v=abc") == "https://www.youtube.com/watch?v=abc"


def test_command_error_never_carries_a_presigned_url() -> None:
    """F071: ffprobe/ffmpeg print the input URL; the tail, the message and the log line must not keep its secrets."""
    e = CommandError("ffprobe", 1, f"{PRESIGNED}: Server returned 403 Forbidden (access denied)")
    for s in SECRETS:
        assert s not in str(e) and s not in e.tail


async def test_run_redacts_the_url_in_a_real_failure() -> None:
    """F071: end to end through proc.run, as jobs.py and pipeline.py then log str(e)."""
    script = f"import sys; print({PRESIGNED + ': Server returned 403 Forbidden'!r}, file=sys.stderr); sys.exit(1)"
    with pytest.raises(CommandError) as info:
        await run(["python3", "-c", script])
    for s in SECRETS:
        assert s not in str(info.value)


def test_log_redacts_string_fields(capsys: pytest.CaptureFixture[str]) -> None:
    """F071: a URL that reaches a log line by another route is still redacted."""
    log("error", "job.failed", detail=f"boom {PRESIGNED}", count=3)
    line = json.loads(capsys.readouterr().out)
    for s in SECRETS:
        assert s not in line["detail"]
    assert line["count"] == 3


def test_the_new_step_messages_are_plain() -> None:
    """ADR-40: what the watch step says is for the owner: short, no service or tool names, no jargon."""
    from clipfactory_agent import pipeline

    texts = [
        pipeline.NOT_WATCHED,
        pipeline.MOTION_ONLY,
        "Watched all 2:03:10. Saw 41 big things.",
        "Got 2:03:10 of sound.",
    ]
    texts += ["Watched most of the video (44 of 48 parts).", "Used what it saw last time."]
    banned = ("bedrock", "nova", "fable", "claude", "ffmpeg", "yt-dlp", "frame", "chunk", "model", "signal", "proxy")
    for t in texts:
        assert len(t) <= 80 and len(t.split()) <= 15, t
        assert not any(b in t.lower() for b in banned), t
    assert pipeline.NOT_WATCHED == "Could not watch the video this time. Picking from the words and the sound."
    assert pipeline.MOTION_ONLY == "Saw where the picture moves fast. Picking with that, the words and the sound."
    assert pipeline.ALMOST_NO_SPEECH.startswith("Almost no speech was found in this video")


BANNED_IN_STEPS = ("transcri", "audio", "(s)", "skill(s)", "learning(s)", "spare", "render", "bedrock", "nova", "fable")


async def test_every_step_message_is_plain(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Every message under a step label, on a first run and on a Try again: short, no tool words, no "clip(s)"."""
    from .test_pipeline import World

    world = World(tmp_path, monkeypatch)
    seen: list[str] = []
    for _ in range(2):
        _status, _st, steps = await world.run()
        seen += [str(s.get("message") or "") for s in steps.values()]
    assert any(m.startswith("Wrote down ") for m in seen) and "Used the words from last time." in seen
    assert "Used the sound from last time." in seen and any(m.startswith("Picked ") for m in seen)
    for m in seen:
        assert len(m) <= 100, m
        assert not any(b in m.lower() for b in BANNED_IN_STEPS), m


def test_counts_read_naturally() -> None:
    from clipfactory_agent.pipeline import count

    assert (count(1, "clip"), count(2, "clip"), count(4812, "word")) == ("1 clip", "2 clips", "4,812 words")


def test_picked_for_words_are_plain_and_short() -> None:
    from clipfactory_agent import signals

    words = {
        *signals.KIND_WORDS.values(),
        signals.LOUD_LAUGH,
        signals.LOUD,
        signals.FAST,
        signals.REWATCH,
        signals.TALK,
    }
    for w in words:
        assert len(w.split()) <= 3 and w[0].isupper() and w.isascii(), w
