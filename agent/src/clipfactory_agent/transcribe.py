"""Amazon Transcribe (batch) with word timestamps and automatic language, parsed into words.json."""

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


def job_name(job_id: str, part: int, attempt: str) -> str:
    """Unique per run (a retried job starts new Transcribe jobs) and within Transcribe's name rules."""
    return re.sub(r"[^0-9a-zA-Z._-]", "-", f"cf-{job_id}-{part}-{attempt}")[:200]


class Transcriber:
    def __init__(self, client: Any, bucket: str) -> None:
        self.client = client
        self.bucket = bucket

    async def _start(self, name: str, media_key: str, output_key: str) -> None:
        await asyncio.to_thread(
            self.client.start_transcription_job,
            TranscriptionJobName=name,
            Media={"MediaFileUri": f"s3://{self.bucket}/{media_key}"},
            MediaFormat="m4a",
            IdentifyLanguage=True,
            OutputBucketName=self.bucket,
            OutputKey=output_key,
        )

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
    ) -> dict[str, Any]:
        """Starts one job and waits for it; returns ``TranscriptionJob``. Progress is estimated from elapsed time
        (Transcribe reports none): batch jobs usually finish in well under the audio's own length."""
        await self._start(name, media_key, output_key)
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
                log("warn", "transcribe.failed", job=name, reason=reason[:500])
                raise UserFacingError("We couldn't hear the words in this video. Tap Try again, or try another video.")
            elapsed = time.monotonic() - started
            if elapsed > budget:
                raise TransientError("Transcription is taking far longer than usual.")
            on_progress(min(0.95, elapsed / max(60.0, expected_seconds * 0.35)))
            await asyncio.sleep(poll)

    async def stop(self, name: str) -> None:
        """Best effort: a canceled job should not keep Transcribe busy (and billing)."""
        with contextlib.suppress(Exception):
            await asyncio.to_thread(self.client.delete_transcription_job, TranscriptionJobName=name)


def language_of(jobs: list[dict[str, Any]]) -> str | None:
    for j in jobs:
        if j.get("LanguageCode"):
            return str(j["LanguageCode"])
    return None
