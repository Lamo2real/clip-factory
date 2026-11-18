"""Amazon Transcribe (batch) with word timestamps, automatic language and speaker labels, parsed into words.json
and speakers.json."""

from __future__ import annotations

import asyncio
import contextlib
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any

from .util import TransientError, UserFacingError, log

Word = tuple[float, float, str]
PART_SECONDS = 3 * 3600 + 50 * 60  # Transcribe takes at most 4 hours per file
_TERMINAL = {"COMPLETED", "FAILED"}
SPEAKER_SETTINGS = {"ShowSpeakerLabels": True, "MaxSpeakerLabels": 10}
_REFUSED = {"BadRequestException", "ValidationException"}
Turn = tuple[float, float, str]


def parse_items(transcript: dict[str, Any], offset: float = 0.0) -> list[Word]:
    """Transcribe's ``results.items`` as ``[start, end, word]``; punctuation is glued to the word before it."""
    words: list[list[Any]] = []
    for item in (transcript.get("results") or {}).get("items") or []:
        alts = item.get("alternatives") or []
        content = str(alts[0].get("content", "")).strip() if alts else ""
        if not content:
            continue
        if item.get("type") == "punctuation":
            if words:
                words[-1][2] += content
            continue
        try:
            start = float(item["start_time"]) + offset
            end = float(item["end_time"]) + offset
        except (KeyError, TypeError, ValueError):
            continue
        words.append([round(start, 2), round(end, 2), content])
    return [(w[0], w[1], w[2]) for w in words]


def parse_speakers(transcript: dict[str, Any], offset: float = 0.0) -> list[Turn]:
    """Transcribe's ``results.speaker_labels.segments`` as ``[start, end, "S1"]`` turns (``spk_0`` is ``S1``).
    Turns of the same speaker that touch are joined. Labels are per Transcribe job: on a source split in parts,
    ``S1`` of one part is not ``S1`` of the next, so they only ever prefix transcript lines."""
    out: list[list[Any]] = []
    labels = (transcript.get("results") or {}).get("speaker_labels") or {}
    for seg in labels.get("segments") or []:
        try:
            start = round(float(seg["start_time"]) + offset, 2)
            end = round(float(seg["end_time"]) + offset, 2)
            n = int(str(seg["speaker_label"]).rsplit("_", 1)[-1])
        except (KeyError, TypeError, ValueError):
            continue
        name = f"S{n + 1}"
        if out and out[-1][2] == name and start - out[-1][1] <= 1.0:
            out[-1][1] = max(out[-1][1], end)
        else:
            out.append([start, end, name])
    return [(t[0], t[1], t[2]) for t in out]


def _refused(e: BaseException) -> bool:
    """Transcribe refused the request itself (a setting it does not take here), as opposed to being busy."""
    response = getattr(e, "response", None)
    code = str((response.get("Error") or {}).get("Code") or "") if isinstance(response, dict) else ""
    return (code or type(e).__name__) in _REFUSED


def job_name(job_id: str, part: int, attempt: str) -> str:
    """Unique per run (a retried job starts new Transcribe jobs) and within Transcribe's name rules."""
    return re.sub(r"[^0-9a-zA-Z._-]", "-", f"cf-{job_id}-{part}-{attempt}")[:200]


def plain_name(name: str) -> str:
    """The name of the same job started again without speaker labels."""
    return name[:198] + "-p"


class Transcriber:
    def __init__(self, client: Any, bucket: str) -> None:
        self.client = client
        self.bucket = bucket

    async def _start(self, name: str, media_key: str, output_key: str, *, speakers: bool = True) -> bool:
        """Starts the job with speaker labels (unless ``speakers`` is False). If Transcribe refuses that request, it
        is sent once more exactly as it was before speaker labels existed, so the words are never lost to an extra.
        Returns whether the job that started has speaker labels."""
        base: dict[str, Any] = {
            "TranscriptionJobName": name,
            "Media": {"MediaFileUri": f"s3://{self.bucket}/{media_key}"},
            "MediaFormat": "m4a",
            "IdentifyLanguage": True,
            "OutputBucketName": self.bucket,
            "OutputKey": output_key,
        }
        if speakers:
            try:
                await asyncio.to_thread(self.client.start_transcription_job, **base, Settings=dict(SPEAKER_SETTINGS))
                return True
            except Exception as e:
                if not _refused(e):
                    raise
                log("warn", "transcribe.speaker_labels_refused", job=name, error=type(e).__name__, detail=str(e)[:300])
        await asyncio.to_thread(self.client.start_transcription_job, **base)
        return False

    async def run(
        self,
        name: str,
        media_key: str,
        output_key: str,
        *,
        expected_seconds: float,
        check_cancel: Callable[[], Awaitable[None]],
        on_progress: Callable[[float], None],
        poll: float = 15.0,
        speakers: bool = True,
    ) -> dict[str, Any]:
        """Starts one job and waits for it; returns ``TranscriptionJob``. Progress is estimated from elapsed time
        (Transcribe reports none): batch jobs usually finish in well under the audio's own length."""
        labelled = await self._start(name, media_key, output_key, speakers=speakers)
        started = time.monotonic()
        budget = max(1800.0, expected_seconds * 1.5)
        while True:
            await check_cancel()
            r = await asyncio.to_thread(self.client.get_transcription_job, TranscriptionJobName=name)
            job: dict[str, Any] = r["TranscriptionJob"]
            status = job.get("TranscriptionJobStatus")
            if status == "COMPLETED":
                return job
            if status == "FAILED":
                reason = str(job.get("FailureReason") or "")
                if "throttl" in reason.lower() or "internal" in reason.lower():
                    raise TransientError(reason)
                # Transcribe's own reason goes to the log, never to the owner.
                log("warn", "transcribe.failed", job=name, reason=reason[:500], speakerLabels=labelled)
                if labelled:
                    # Speaker labels are an extra: the job is started once more exactly as before they existed.
                    name, labelled = plain_name(name), False
                    await self._start(name, media_key, output_key, speakers=False)
                    started = time.monotonic()
                    continue
                raise UserFacingError("We couldn't hear the words in this video. Tap Try again, or try another video.")
            elapsed = time.monotonic() - started
            if elapsed > budget:
                raise TransientError("Transcription is taking far longer than usual.")
            on_progress(min(0.95, elapsed / max(60.0, expected_seconds * 0.35)))
            await asyncio.sleep(poll)

    async def stop(self, name: str) -> None:
        """Best effort: a canceled job should not keep Transcribe busy (and billing). Also the job started again
        without speaker labels, if there is one."""
        for n in (name, plain_name(name)):
            with contextlib.suppress(Exception):
                await asyncio.to_thread(self.client.delete_transcription_job, TranscriptionJobName=n)


def language_of(jobs: list[dict[str, Any]]) -> str | None:
    for j in jobs:
        if j.get("LanguageCode"):
            return str(j["LanguageCode"])
    return None
