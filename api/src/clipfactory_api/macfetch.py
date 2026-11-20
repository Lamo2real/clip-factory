"""Mac fetches it (docs/CONTRACTS.md §35, ADR-59): when YouTube blocks the cloud, the owner's Mac or Windows app gets
the video on its own connection and sends it to the job, which then goes on as an upload (the PR #48 path).

The job item carries a ``macFetch`` map. Every YouTube link job made since §35 has one, which is how the agent knows
it may wait for the Mac instead of failing:

* ``state``: ``cloud`` (the cloud tries first), ``waiting`` (blocked or started on the desktop: waiting for a Mac),
  ``getting`` / ``sending`` (a Mac claimed it and reports progress), ``done`` (the video arrived), ``failed``.
* ``up``: started from the desktop app, so the cloud never tries YouTube (§35.1, up front).
* ``since`` (when the wait began), ``nudgedAt`` (the 2-minute notification went out), ``pct``, ``at``.
* Internal, never sent to the web: ``deviceId`` (the Mac that claimed it), ``uploadId``, ``key``, ``size``.

``macCallbackId`` (top level, internal) is the job flow's ``mac-done`` callback the API completes.
"""

from __future__ import annotations

import math
import re
from typing import Any

from . import db

Item = dict[str, Any]

PART_SIZE = 64 * 1024 * 1024  # the desktop app checks the same number (desktop/src-tauri/src/mac_fetch/upload.rs)
MAX_SIZE = 64 * 1024 * 1024 * 1024  # 64 GB: a 1080p video many hours long; S3 allows 10,000 parts of 64 MB (640 GB)
PART_URL_SECONDS = 6 * 3600  # long enough to send 64 GB at 3 MB/s
WAIT_HOURS = 24
NUDGE_MINUTES = 2
CLAIM_STALE_SECONDS = 120  # a Mac that has said nothing for this long gives the job up to another Mac
PROGRESS_GAP_SECONDS = 3  # mac-progress: at most one write per job this often

WAITING = "Waiting for your Mac to get the video"
OPEN_THE_APP = "Open Clip Factory on your Mac to continue"
GETTING = "Your Mac is getting the video"
SENDING = "Your Mac is sending the video"
SENT_NOTE = "Your Mac sent the video."
TIMED_OUT = "Your Mac didn't get the video. Use a video file instead."

# What the Mac may report when it stops, and the words the owner reads (every one names a real next step).
FAILURE_WORDS = {
    "blocked": "YouTube stopped your Mac too. Tap Use a video file.",
    "gone": "This video is private or was removed, so it can't be downloaded.",
    "live": "This stream is still live or has not started. Try again once it has ended.",
    "tools": "Your Mac could not set up its video tools. Check its internet, then tap Try again.",
    "failed": "Your Mac could not get the video. Tap Try again, or tap Use a video file.",
    "send": "Your Mac could not send the video. Tap Try again, or tap Use a video file.",
}
FULL_CODE = "full"

STATES = ("cloud", "waiting", "getting", "sending", "done", "failed")
WAITING_STATES = ("waiting", "getting", "sending")
PUBLIC_KEYS = ("state", "up", "since", "nudgedAt", "pct", "at")
DEVICE_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def full_words(gb: int) -> str:
    return f"Your Mac is full. Free up {gb} GB."


def failure_words(code: str, gb: int | None = None) -> str | None:
    if code == FULL_CODE:
        return full_words(max(1, min(int(gb or 1), 9999)))
    return FAILURE_WORDS.get(code)


def new_map(*, up: bool) -> Item:
    """The map a new YouTube link job gets: the cloud tries first, or (from the desktop app) the Mac does."""
    return {"state": "waiting", "up": True} if up else {"state": "cloud"}


def public(value: Any) -> Item | None:
    """What the web sees of ``macFetch``: never the device, the upload id or the key."""
    if not isinstance(value, dict):
        return None
    out = {k: value[k] for k in PUBLIC_KEYS if value.get(k) not in (None, "")}
    return out or None


def waiting(job: Item) -> bool:
    m = job.get("macFetch")
    return isinstance(m, dict) and m.get("state") in WAITING_STATES and job.get("status") in ("queued", "running")


def upload_key(user_id: str, job_id: str) -> str:
    """Where the Mac's video goes: the uploads prefix (S3 lifecycle aborts a forgotten multipart upload)."""
    return f"uploads/{user_id}/mac-{job_id}/video.mp4"


def part_count(size: int) -> int:
    return max(1, math.ceil(size / PART_SIZE))


def clean_text(value: Any, max_len: int) -> str | None:
    """One line of plain text (a title, a channel name) as the Mac read it from YouTube."""
    if not isinstance(value, str):
        return None
    text = "".join(c for c in value if c.isprintable()).strip()[:max_len]
    return text or None


def live_item(user_id: str, job: Item, phase: str, pct: int, *, now: str, ttl: int) -> Item:
    """The job's live status line (§31) while the Mac works: fixed templates, numbers only."""
    text = GETTING if phase == "getting" else SENDING
    step = next(
        (str(s.get("key")) for s in job.get("steps") or [] if isinstance(s, dict) and s.get("status") == "running"),
        "download",
    )
    return {
        "pk": db.user_pk(user_id),
        "sk": f"JOBLIVE#{job['jobId']}",
        "type": "jobLive",
        "jobId": job["jobId"],
        **({"sessionId": job["sessionId"]} if job.get("sessionId") else {}),
        "step": step,
        "text": text,
        "detail": f"{pct}%",
        "tech": "Clip Factory on your Mac",
        "pct": pct,
        "at": now,
        "lastChange": now,
        "ttl": ttl,
    }
