"""Job items: source checks, the initial step list and starting a run on the agent."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit, urlunsplit

from . import db
from .agent_client import AgentClient, AgentError, new_session_id
from .errors import bad_request
from .log import log

Item = dict[str, Any]

STEPS: tuple[tuple[str, str], ...] = (
    ("resolve", "Check the source"),
    ("download", "Download the source"),
    ("transcribe", "Transcribe the speech"),
    ("analyze", "Scan for big moments"),
    ("select", "Pick the best moments"),
    ("render", "Cut the clips"),
    ("checklist", "Check each clip"),
    ("captions", "Write the captions"),
    ("finalize", "Finish up"),
)
ACTIVE = ("queued", "running")
RESTARTABLE = ("failed", "canceled")
INTERNAL_FIELDS = ("sessionId", "heartbeatAt")

START_FAILED = "We could not start the clip agent. Press Retry to try again."

# Hosts after any "www." is removed. Keep in step with web/src/lib/links.ts, which accepts the same set.
_HOSTS = {
    "youtube.com": "youtube",
    "m.youtube.com": "youtube",
    "music.youtube.com": "youtube",
    "youtube-nocookie.com": "youtube",
    "youtu.be": "youtube",
    "twitch.tv": "twitch",
    "m.twitch.tv": "twitch",
    "clips.twitch.tv": "twitch",
    "kick.com": "kick",
    "m.kick.com": "kick",
}
MAX_URL = 2048


def link_platform(url: str) -> tuple[str, str]:
    """Returns (platform, normalised https URL) for a YouTube, Twitch or Kick link, or raises ``bad_request``."""
    if len(url) > MAX_URL:
        raise bad_request("That link is too long.")
    candidate = url.strip()
    if "://" not in candidate:
        candidate = "https://" + candidate
    try:
        parts = urlsplit(candidate)
        port = parts.port
    except ValueError as e:
        raise bad_request("That link is not a valid web address.") from e
    host = (parts.hostname or "").lower().rstrip(".")
    if parts.scheme not in {"http", "https"} or parts.username or parts.password or port not in {None, 80, 443}:
        raise bad_request("That link is not a valid web address.")
    bare = host.removeprefix("www.")
    platform = _HOSTS.get(bare)
    if platform is None:
        raise bad_request("Paste a YouTube, Twitch or Kick link.")
    if parts.path.strip("/") == "" and not parts.query:
        raise bad_request("That link does not point to a video or channel.")
    return platform, urlunsplit(("https", host, parts.path, parts.query, ""))


def new_steps() -> list[Item]:
    return [{"key": key, "label": label, "status": "pending"} for key, label in STEPS]


def public_job(item: Item) -> Item:
    return db.strip_keys(item, INTERNAL_FIELDS)


def start(store: db.Store, agent: AgentClient, job: Item, now: str) -> Item:
    """Invokes the agent for a job already saved as ``queued``; a failed start marks the job failed."""
    try:
        agent.start_job(job["jobId"], job["userId"], job["sessionId"])
    except AgentError as e:
        log("error", "job.start_failed", jobId=job["jobId"], error=str(e))
        try:
            return store.update(
                job["pk"],
                job["sk"],
                {"status": "failed", "error": START_FAILED, "updatedAt": now},
                # Only this run's own queued state: never a newer run's.
                expect_in={"status": ["queued"], "sessionId": [job["sessionId"]]},
            )
        except db.ConditionFailed:
            # The agent got far enough to change the job itself; its state is the truth.
            return store.get(job["pk"], job["sk"]) or job
    log("info", "job.started", jobId=job["jobId"])
    return job


def restart_fields(job_id: str, now: str) -> Item:
    return {
        "status": "queued",
        "steps": new_steps(),
        "progress": 0,
        "clipCount": 0,
        "sessionId": new_session_id(job_id),
        "heartbeatAt": now,
        "updatedAt": now,
    }
