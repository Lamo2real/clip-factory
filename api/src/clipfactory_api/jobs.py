"""Job items: source checks, the initial step list and starting a run (the durable ``cf-prod-job-flow``)."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit, urlunsplit

from . import db
from .agent_client import new_session_id
from .errors import bad_request
from .flow_client import FlowClient, FlowStartError
from .log import log

Item = dict[str, Any]

# The ten steps and their owner-facing labels (words an 8-year-old can follow). The same list, in the same order, as
# agent/src/clipfactory_agent/jobs.py and web/src/api/mock/fixtures.ts (docs/CONTRACTS.md §5, §8); the agent's tests
# compare the three. "watch" is the deep analysis of the picture (docs/DECISIONS.md ADR-40). A job saved before it
# existed keeps its nine steps and still serialises.
STEPS: tuple[tuple[str, str], ...] = (
    ("resolve", "Find the video"),
    ("download", "Get the video"),
    ("transcribe", "Write down the words"),
    ("analyze", "Listen for big moments"),
    ("watch", "Watch the video"),
    ("select", "Pick the best moments"),
    ("render", "Cut the clips"),
    ("checklist", "Check each clip"),
    ("captions", "Write the captions"),
    ("finalize", "Finish up"),
)
ACTIVE = ("queued", "running")
RESTARTABLE = ("failed", "canceled")
INTERNAL_FIELDS = ("sessionId", "heartbeatAt", "flowRun", "flowExecutionArn")

START_FAILED = "Could not start. Press Try again."

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


def start(store: db.Store, flows: FlowClient, job: Item, now: str) -> Item:
    """Starts the job's durable flow for a job already saved as ``queued`` (docs/CONTRACTS.md §14.4).

    The flow invokes the agent and waits for its callback. A failed start marks this run failed; the route still
    answers 201/200 with the job, so the owner sees "Try again".
    """
    try:
        started = flows.start_job_flow(job["jobId"], job["userId"], job["sessionId"], int(job.get("flowRun") or 1))
    except (FlowStartError, ValueError) as e:
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
            return store.get(job["pk"], job["sk"]) or job
    log("info", "job.started", jobId=job["jobId"], flow=started.name, existed=started.execution_arn is None)
    if not started.execution_arn:
        return job
    try:
        return store.update(
            job["pk"],
            job["sk"],
            {"flowExecutionArn": started.execution_arn},
            expect_in={"sessionId": [job["sessionId"]]},
        )
    except db.ConditionFailed:
        return store.get(job["pk"], job["sk"]) or job


def restart_fields(job_id: str, now: str, previous_run: int) -> Item:
    return {
        "status": "queued",
        "flowRun": previous_run + 1,
        "steps": new_steps(),
        "progress": 0,
        "clipCount": 0,
        "sessionId": new_session_id(job_id),
        "heartbeatAt": now,
        "updatedAt": now,
    }
