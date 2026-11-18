from __future__ import annotations

import asyncio
from typing import Any

import pytest

from clipfactory_agent.transcribe import (
    SPEAKER_SETTINGS,
    Transcriber,
    job_name,
    language_of,
    parse_items,
    parse_speakers,
)
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
    assert fake.started["Settings"] == {"ShowSpeakerLabels": True, "MaxSpeakerLabels": 10} == SPEAKER_SETTINGS
    assert fake.started["Media"] == {"MediaFileUri": "s3://bucket/jobs/j/source/audio.m4a"}
    assert fake.started["OutputKey"] == "jobs/j/source/transcript.json"
    assert seen and 0 <= seen[0] < 1


async def test_transcriber_failure_is_plain() -> None:
    failed = {"TranscriptionJobStatus": "FAILED", "FailureReason": "Unsupported media"}
    fake = FakeTranscribe([failed, failed])  # with speaker labels, then once more without them

    async def no_cancel() -> None:
        return None

    with pytest.raises(UserFacingError, match="couldn't hear the words") as info:
        await Transcriber(fake, "b").run(
            "n", "k", "o", expected_seconds=1, check_cancel=no_cancel, on_progress=lambda f: None, poll=0
        )
    # Transcribe's own words stay in the log; the owner gets the next step.
    assert "Unsupported media" not in str(info.value) and "Tap Try again" in str(info.value)


async def test_transcriber_checks_cancel() -> None:
    fake = FakeTranscribe([{"TranscriptionJobStatus": "IN_PROGRESS"}] * 3)

    async def cancel() -> None:
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await Transcriber(fake, "b").run(
            "n", "k", "o", expected_seconds=1, check_cancel=cancel, on_progress=lambda f: None, poll=0
        )


# --- speaker labels (ADR-40) ------------------------------------------------------------------------------------


async def test_a_job_that_fails_with_speaker_labels_runs_once_more_without_them() -> None:
    names: list[str] = []
    settings: list[Any] = []

    class Fake(FakeTranscribe):
        def start_transcription_job(self, **kw: Any) -> None:
            names.append(kw["TranscriptionJobName"])
            settings.append(kw.get("Settings"))

        def get_transcription_job(self, TranscriptionJobName: str) -> dict[str, Any]:
            assert TranscriptionJobName == names[-1]
            return {"TranscriptionJob": self.statuses.pop(0)}

    fake = Fake(
        [
            {"TranscriptionJobStatus": "FAILED", "FailureReason": "speaker identification failed"},
            {"TranscriptionJobStatus": "COMPLETED", "LanguageCode": "en-US"},
        ]
    )

    async def no_cancel() -> None:
        return None

    job = await Transcriber(fake, "b").run(
        "cf-J-0-abc", "k", "o", expected_seconds=1, check_cancel=no_cancel, on_progress=lambda f: None, poll=0
    )
    assert job["LanguageCode"] == "en-US"
    assert names == ["cf-J-0-abc", "cf-J-0-abc-p"] and settings == [SPEAKER_SETTINGS, None]


async def test_stop_also_removes_the_plain_job() -> None:
    deleted: list[str] = []

    class Fake:
        def delete_transcription_job(self, TranscriptionJobName: str) -> None:
            deleted.append(TranscriptionJobName)

    await Transcriber(Fake(), "b").stop("cf-J-0-abc")
    assert deleted == ["cf-J-0-abc", "cf-J-0-abc-p"]


class Refusing(FakeTranscribe):
    """Transcribe refusing the request with speaker labels, as a boto3 ClientError would."""

    def __init__(self, code: str, always: bool = False) -> None:
        super().__init__([{"TranscriptionJobStatus": "COMPLETED"}])
        self.code, self.always = code, always
        self.calls: list[dict[str, Any]] = []

    def start_transcription_job(self, **kw: Any) -> None:
        self.calls.append(kw)
        if "Settings" in kw or self.always:
            e = RuntimeError(f"{self.code}: nope")
            e.response = {"Error": {"Code": self.code, "Message": "nope"}}  # type: ignore[attr-defined]
            raise e
        self.started = kw


async def start(fake: Any) -> dict[str, Any]:
    async def no_cancel() -> None:
        return None

    return await Transcriber(fake, "bucket").run(
        "n", "k.m4a", "o.json", expected_seconds=60, check_cancel=no_cancel, on_progress=lambda f: None, poll=0
    )


@pytest.mark.parametrize("code", ["BadRequestException", "ValidationException"])
async def test_refused_speaker_labels_start_the_job_again_exactly_as_before(code: str) -> None:
    fake = Refusing(code)
    await start(fake)
    assert len(fake.calls) == 2 and "Settings" in fake.calls[0]
    assert fake.calls[1] == {  # today's exact call
        "TranscriptionJobName": "n",
        "Media": {"MediaFileUri": "s3://bucket/k.m4a"},
        "MediaFormat": "m4a",
        "IdentifyLanguage": True,
        "OutputBucketName": "bucket",
        "OutputKey": "o.json",
    }


async def test_the_fallback_start_is_tried_once_and_other_errors_are_not_swallowed() -> None:
    fake = Refusing("BadRequestException", always=True)
    with pytest.raises(RuntimeError, match="BadRequestException"):
        await start(fake)
    assert len(fake.calls) == 2  # with labels, then without; never a loop
    busy = Refusing("ThrottlingException")
    with pytest.raises(RuntimeError, match="ThrottlingException"):
        await start(busy)
    assert len(busy.calls) == 1  # a busy service is the caller's retry, not a reason to drop the labels


def test_parse_speakers() -> None:
    doc = {
        "results": {
            "speaker_labels": {
                "speakers": 2,
                "segments": [
                    {"start_time": "1.0", "end_time": "4.0", "speaker_label": "spk_0", "items": []},
                    {"start_time": "4.2", "end_time": "6.0", "speaker_label": "spk_0"},
                    {"start_time": "6.1", "end_time": "9.0", "speaker_label": "spk_1"},
                    {"start_time": "30.0", "end_time": "31.0", "speaker_label": "spk_1"},
                    {"start_time": "x", "end_time": "9.0", "speaker_label": "spk_1"},
                    {"start_time": "40", "end_time": "41"},
                ],
            }
        }
    }
    assert parse_speakers(doc) == [(1.0, 6.0, "S1"), (6.1, 9.0, "S2"), (30.0, 31.0, "S2")]
    assert parse_speakers(doc, offset=13800)[0] == (13801.0, 13806.0, "S1")
    assert parse_speakers(TRANSCRIPT) == [] and parse_speakers({}) == []
