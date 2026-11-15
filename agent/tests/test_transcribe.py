from __future__ import annotations

import asyncio
from typing import Any

import pytest

from clipfactory_agent.transcribe import Transcriber, job_name, language_of, parse_items
from clipfactory_agent.util import UserFacingError

TRANSCRIPT = {
    "jobName": "x",
    "results": {
        "transcripts": [{"transcript": "No way, he did it! Wow."}],
        "items": [
            {"type": "pronunciation", "start_time": "1.0", "end_time": "1.2", "alternatives": [{"content": "No"}]},
            {"type": "pronunciation", "start_time": "1.2", "end_time": "1.5", "alternatives": [{"content": "way"}]},
            {"type": "punctuation", "alternatives": [{"content": ","}]},
            {"type": "pronunciation", "start_time": "1.6", "end_time": "1.7", "alternatives": [{"content": "he"}]},
            {"type": "pronunciation", "start_time": "1.7", "end_time": "1.9", "alternatives": [{"content": "did"}]},
            {"type": "pronunciation", "start_time": "1.9", "end_time": "2.05", "alternatives": [{"content": "it"}]},
            {"type": "punctuation", "alternatives": [{"content": "!"}]},
            {"type": "pronunciation", "alternatives": [{"content": "broken"}]},
            {"type": "pronunciation", "start_time": "3", "end_time": "3.4", "alternatives": []},
            {"type": "pronunciation", "start_time": "4.0", "end_time": "4.4", "alternatives": [{"content": "Wow"}]},
            {"type": "punctuation", "alternatives": [{"content": "."}]},
        ],
    },
}


def test_parse_items_glues_punctuation_and_skips_broken_items() -> None:
    assert parse_items(TRANSCRIPT) == [
        (1.0, 1.2, "No"),
        (1.2, 1.5, "way,"),
        (1.6, 1.7, "he"),
        (1.7, 1.9, "did"),
        (1.9, 2.05, "it!"),
        (4.0, 4.4, "Wow."),
    ]


def test_parse_items_offsets_parts() -> None:
    words = parse_items(TRANSCRIPT, offset=13800)
    assert words[0] == (13801.0, 13801.2, "No")


def test_parse_items_handles_empty() -> None:
    assert parse_items({}) == []
    assert parse_items({"results": {"items": [{"type": "punctuation", "alternatives": [{"content": "."}]}]}}) == []


def test_job_name_is_safe() -> None:
    assert job_name("01ABC", 2, "x y/z") == "cf-01ABC-2-x-y-z"


def test_language_of() -> None:
    assert language_of([{}, {"LanguageCode": "en-US"}]) == "en-US"
    assert language_of([]) is None


class FakeTranscribe:
    def __init__(self, statuses: list[dict[str, Any]]) -> None:
        self.statuses = statuses
        self.started: dict[str, Any] = {}

    def start_transcription_job(self, **kw: Any) -> None:
        self.started = kw

    def get_transcription_job(self, TranscriptionJobName: str) -> dict[str, Any]:
        return {"TranscriptionJob": self.statuses.pop(0)}


async def test_transcriber_polls_until_complete() -> None:
    fake = FakeTranscribe(
        [{"TranscriptionJobStatus": "IN_PROGRESS"}, {"TranscriptionJobStatus": "COMPLETED", "LanguageCode": "en-GB"}]
    )
    seen: list[float] = []

    async def no_cancel() -> None:
        return None

    job = await Transcriber(fake, "bucket").run(
        "n",
        "jobs/j/source/audio.m4a",
        "jobs/j/source/transcript.json",
        expected_seconds=600,
        check_cancel=no_cancel,
        on_progress=seen.append,
        poll=0,
    )
    assert job["LanguageCode"] == "en-GB"
    assert fake.started["IdentifyLanguage"] is True
    assert fake.started["Media"] == {"MediaFileUri": "s3://bucket/jobs/j/source/audio.m4a"}
    assert fake.started["OutputKey"] == "jobs/j/source/transcript.json"
    assert seen and 0 <= seen[0] < 1


async def test_transcriber_failure_is_plain() -> None:
    fake = FakeTranscribe([{"TranscriptionJobStatus": "FAILED", "FailureReason": "Unsupported media"}])

    async def no_cancel() -> None:
        return None

    with pytest.raises(UserFacingError, match="could not read the audio"):
        await Transcriber(fake, "b").run(
            "n", "k", "o", expected_seconds=1, check_cancel=no_cancel, on_progress=lambda f: None, poll=0
        )


async def test_transcriber_checks_cancel() -> None:
    fake = FakeTranscribe([{"TranscriptionJobStatus": "IN_PROGRESS"}] * 3)

    async def cancel() -> None:
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await Transcriber(fake, "b").run(
            "n", "k", "o", expected_seconds=1, check_cancel=cancel, on_progress=lambda f: None, poll=0
        )
