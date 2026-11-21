"""Job items: source checks, the initial step list and starting a run (the durable ``cf-prod-job-flow``)."""

from __future__ import annotations

import hashlib
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
INTERNAL_FIELDS = (
    "sessionId",
    "heartbeatAt",
    "flowRun",
    "flowExecutionArn",
    "pickUp",
    "resumes",
    "runStartedAt",
    "macCallbackId",  # the job flow's mac-done callback (§35); macFetch itself goes out through macfetch.public
    "deletingAt",  # §34: a delete fenced the job and is still removing its clips and files
    "campaign",  # §38.5: the internal JobCampaign (the rules this job follows); campaignId and campaignNote are public
)

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


def run_tag(session_id: Any) -> str | None:
    """A short tag of the run that owns the job (a hash of its ``sessionId``, which itself never leaves the server).
    The web keeps a live status line only when its ``run`` matches the job's (docs/CONTRACTS.md §31)."""
    if not isinstance(session_id, str) or not session_id:
        return None
    return hashlib.sha256(session_id.encode()).hexdigest()[:10]


def public_job(item: Item, live: Item | None = None) -> Item:
    out = db.strip_keys(item, INTERNAL_FIELDS)
    if "macFetch" in out:
        from . import macfetch

        mac = macfetch.public(out.pop("macFetch"))
        if mac:
            out["macFetch"] = mac
    run = run_tag(item.get("sessionId"))
    if run:
        out["run"] = run
    if live is not None and item.get("status") in ACTIVE:
        shown = public_live(live)
        if shown.get("run") == run:
            out["live"] = shown
    return out


# The live status line (§31): only these fields of a JOBLIVE# item ever leave the server.
LIVE_FIELDS = ("jobId", "step", "text", "detail", "tech", "since", "i", "n", "pct", "at", "lastChange")


def live_sk(job_id: str) -> str:
    return f"JOBLIVE#{job_id}"


def public_live(item: Item) -> Item:
    """The public shape of a ``JOBLIVE#`` item: the allowed fields, plus ``run`` in place of its ``sessionId``."""
    out = {k: item[k] for k in LIVE_FIELDS if item.get(k) not in (None, "")}
    run = run_tag(item.get("sessionId"))
    if run:
        out["run"] = run
    return out


def live_lines(store: db.Store, user_id: str, jobs: list[Item]) -> dict[str, Item]:
    """The live lines of the jobs still working, by jobId, from one query (none when no job is working)."""
    if not any(j.get("status") in ACTIVE for j in jobs):
        return {}
    rows = store.query_all(db.user_pk(user_id), "JOBLIVE#")
    return {str(r.get("jobId")): r for r in rows if r.get("jobId")}


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


RESUME_NOTE = "Picking up where it stopped…"
WORKING_CAP = 0.99  # the most progress a job not finished yet shows (the agent's cap too)


def picked_up_steps(steps: Any) -> list[Item]:
    """The step list a pick-up starts from: done and skipped steps stay as they are, the step that stopped (failed or
    running) and every later one go back to pending. Anything unreadable: a fresh list."""
    old = {s.get("key"): s for s in steps or [] if isinstance(s, dict)}
    out: list[Item] = []
    for fresh in new_steps():
        prev = old.get(fresh["key"])
        if prev and prev.get("status") in ("done", "skipped"):
            out.append({**fresh, **{k: prev[k] for k in ("status", "message", "startedAt", "finishedAt") if k in prev}})
        else:
            out.append(fresh)
    return out


# Steps that run after every clip is cut and checked: a failure there is never the video's fault.
LATE_STEPS = ("captions", "finalize")


def picks_up(job: Item) -> bool:
    """Whether Try again picks up where the last run stopped (docs/CONTRACTS.md §30.6) instead of starting over: the
    run stopped partway (``pickUp`` on a failed job); it failed while writing the captions or finishing up, after the
    clips were cut (owner report 2026-11-20: Finish up failed after 30 minutes of checking, and starting over would
    cut and check every clip again); or the owner stopped it after the clips were cut."""
    status = job.get("status")
    if status == "failed" and job.get("pickUp"):
        return True
    steps = {s.get("key"): s.get("status") for s in job.get("steps") or [] if isinstance(s, dict)}
    if steps.get("render") != "done":
        return False
    if status == "failed":
        return any(steps.get(k) == "failed" for k in LATE_STEPS)
    return status == "canceled"


def restart_fields(
    job_id: str,
    now: str,
    previous_run: int,
    *,
    pick_up: bool = False,
    steps: Any = None,
    progress: Any = 0,
) -> Item:
    """A new run of the same job (Try again): same job id, so the same saved files. ``pick_up`` (the last run
    stopped partway rather than failing on its own, ``pickUp`` on the job, docs/CONTRACTS.md §30.6) keeps the moments
    and clips it saved, its done steps (``steps``) and its ``progress``, and says so; otherwise the run starts over, as
    Try again always did. ``runStartedAt`` starts this run's 8 h budget (the kept steps carry older times)."""
    fields: Item = {
        "status": "queued",
        "flowRun": previous_run + 1,
        "steps": new_steps(),
        "progress": 0,
        "clipCount": 0,
        "resumes": 0,
        "sessionId": new_session_id(job_id),
        "heartbeatAt": now,
        "runStartedAt": now,
        "updatedAt": now,
    }
    if pick_up:
        try:
            # Never 100% with steps left: only a finished job shows that (an older run could carry 1.0 over).
            done = max(0.0, min(WORKING_CAP, float(progress or 0)))
        except (TypeError, ValueError):
            done = 0.0
        fields.update(pickUp=True, note=RESUME_NOTE, steps=picked_up_steps(steps), progress=done)
    return fields
