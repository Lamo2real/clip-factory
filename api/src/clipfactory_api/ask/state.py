"""The owner's live state for Ask (docs/CONTRACTS.md §27.2): ``APP STATE`` and the ``read_my_clip_factory`` tool.

Everything is read with the verified user id, through the same service functions the routes use (not over HTTP), and
only read: nothing here writes. The reads for APP STATE run in parallel under one shared 1.5 s deadline; a read that
fails or is not back by then becomes "unknown" and is not waited for. ``scrub`` drops anything secret-shaped (tokens,
keys, secret names, ARNs, emails, OAuth state, links) before a value is shown to the model.

APP STATE goes to the model as a system message, so it holds only enums, numbers, ids, booleans and Clip Factory's
own words (setup step titles from the knowledge pack). Free text written by others or by a model (clip hooks, raw
error text, account names) is never in it; ``read_my_clip_factory`` returns those as tool results (data).
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timedelta
from typing import Any

from .. import db, s3
from ..clock import iso
from ..log import log
from .redact import redact

STATE_CHARS = 6_000
TOOL_CHARS = 12_000
READ_TIMEOUT_S = 1.5  # one shared deadline for every APP STATE read
_SECRETISH = re.compile(
    r"token|secret|password|cookie|email|state$|nonce|verifier|pkce|arn|hint|key$|keys$|url$|urls$|avatar|"
    r"sessionid|session_id|^pk$|^sk$|gsi|ttl|userid|signature",
    re.IGNORECASE,
)
UNKNOWN = "unknown"


def scrub(value: Any, depth: int = 0) -> Any:
    """A copy safe to show the model: secret-named keys dropped, strings redacted and cut to 400 characters."""
    if depth > 8:
        return None
    if isinstance(value, Mapping):
        return {str(k): scrub(v, depth + 1) for k, v in value.items() if not _SECRETISH.search(str(k))}
    if isinstance(value, list | tuple | set):
        return [scrub(v, depth + 1) for v in list(value)[:50]]
    if isinstance(value, str):
        return redact(value[:400])[0]
    if isinstance(value, bool | int | float) or value is None:
        return value
    try:
        return float(value)  # Decimal from DynamoDB
    except (TypeError, ValueError):
        return str(value)[:100]


def _dumps(value: Any, limit: int) -> str:
    text = json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=str)
    if len(text) <= limit:
        return text
    return text[: limit - 20] + '..."(cut short)"'


class Reader:
    """The owner's own data, read only."""

    def __init__(
        self,
        store: db.Store,
        media: s3.Media | None,
        user_id: str,
        now: datetime,
        steps: Mapping[str, list[dict[str, Any]]] | None = None,
    ) -> None:
        self.store = store
        self.media = media
        self.user_id = user_id
        self.now = now
        self.pk = db.user_pk(user_id)
        self.steps = steps or {}  # the setup guides' steps per platform, from the knowledge pack

    # --- the pieces ---------------------------------------------------------------------------------------------

    def counts(self) -> dict[str, int]:
        jobs = self.store.query_all(self.pk, "JOB#")
        clips = self.store.query_all(self.pk, "CLIP#")
        return {
            "review": sum(1 for c in clips if c.get("status") == "review"),
            "running": sum(1 for j in jobs if j.get("status") in {"queued", "running"}),
            "posted": sum(1 for c in clips if c.get("status") == "posted"),
        }

    def jobs(self, limit: int = 3, *, words: bool = False) -> list[dict[str, Any]]:
        """The newest jobs. ``words`` adds the raw error text (only for the tool result, never APP STATE)."""
        page = self.store.query_page(self.pk, "JOB#", newest_first=True, limit=limit, start_key=None)
        out = []
        for j in page.items:
            raw = j.get("source")
            source: Mapping[str, Any] = raw if isinstance(raw, Mapping) else {}
            row = {
                "jobId": j.get("jobId"),
                "status": j.get("status"),
                "progress": round(float(j.get("progress") or 0) * 100),
                "source": source.get("platform") or source.get("type"),
                "clipCount": j.get("clipCount"),
                "errorCode": _code(j.get("errorCode")) or ("failed" if j.get("error") else None),
                "createdAt": j.get("createdAt"),
            }
            if words and j.get("error"):
                row["errorText"] = str(j.get("error"))[:120]
            out.append(row)
        return out

    def setup(self, *, words: bool = False) -> list[dict[str, Any]]:
        """Each platform's setup: state, steps done of the total, the next step (id and its title from the guide),
        the gates and whether an account is connected. ``words`` adds the connected account's name (tool only)."""
        from ..oauth import setup

        skipped = set(self._skipped())
        out = []
        for s in setup.all_setups(self.store, self.user_id, self.now):
            platform = str(s.get("platform") or "")
            account = s.get("account") or {}
            gates = s.get("gates") or []
            done_ids = set(s.get("stepsDone") or [])
            counted = [st for st in self.steps.get(platform, []) if not st.get("optional")]
            done = [st for st in counted if _step_done(st, s, done_ids)]
            nxt = next((st for st in counted if not _step_done(st, s, done_ids)), None)
            connected = account.get("status") == "connected"
            if s.get("ready"):
                state = "ready"
            elif platform in skipped:
                state = "skipped"
            elif done_ids or (s.get("keys") or {}).get("saved") or account.get("status") not in {None, "not_connected"}:
                state = "in progress"
            else:
                state = "not started"
            row: dict[str, Any] = {
                "platform": platform,
                "state": state,
                "stepsDone": len(done),
                "stepsTotal": len(counted),
                "next": {
                    "id": nxt.get("id"),
                    "number": nxt.get("n"),
                    "part": nxt.get("partTitle"),
                    "title": nxt.get("title"),
                }
                if nxt and not s.get("ready")
                else None,
                "account": account.get("status"),
                "connected": connected,
                "keysSaved": bool((s.get("keys") or {}).get("saved")),
                "gates": [{"gate": g.get("key"), "state": g.get("state")} for g in gates],
            }
            if words:
                row["accountName"] = account.get("displayName") or account.get("name")
            out.append(row)
        return out

    def _skipped(self) -> list[str]:
        from .. import settings

        try:
            raw = settings.load(self.store, self.user_id).get("setupSkipped")
        except Exception:
            return []
        return [str(p) for p in raw] if isinstance(raw, list) else []

    def settings(self) -> dict[str, Any]:
        from .. import settings

        values = settings.load(self.store, self.user_id)
        return {
            "clipModel": values.get("clipModel"),
            "clipMin": values.get("clipMin"),
            "clipMax": values.get("clipMax"),
            "soundEnabled": values.get("soundEnabled"),
            "reduceMotion": values.get("reduceMotion"),
            "backgroundMode": values.get("backgroundMode"),
            "platforms": values.get("platforms"),
            "youtubePrivacy": values.get("youtubePrivacy"),
            "setupSkipped": values.get("setupSkipped"),
        }

    def skills(self) -> list[str]:
        from ..skill_prompt import owner_items

        return [str(i.get("name")) for i in owner_items(self.store.query_all(self.pk, "SKILL#"))]

    def follows(self) -> dict[str, Any]:
        from ..follow import all_follows, public_follow

        rows = [public_follow(f) for f in all_follows(self.store, self.user_id)]
        return {"count": len(rows), "liveNow": sum(1 for r in rows if r.get("live") or r.get("isLive"))}

    def money(self) -> list[dict[str, Any]]:
        from ..money import view

        cards = view.money_view(self.store, self.user_id, self.now).get("platforms") or []
        out = []
        for c in cards:
            revenue = c.get("revenue") or {}
            out.append(
                {
                    "platform": c.get("platform"),
                    "state": c.get("state"),
                    "progress": c.get("progress") or c.get("goals"),
                    "thisMonth": revenue.get("thisMonthMicros"),
                    "currency": revenue.get("currency"),
                    "lastRefresh": c.get("checkedAt") or c.get("lastRefreshAt"),
                }
            )
        return out

    def week(self) -> dict[str, Any]:
        from .. import weeks

        start = (self.now - timedelta(days=self.now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=7) - timedelta(seconds=1)
        entries = weeks.week_entries(self.store, self.user_id, start, end)
        best: tuple[int, str] = (-1, "")
        total = 0
        for clip, posts, _ in entries:
            views = sum(int((p.get("metrics") or {}).get("views") or 0) for p in posts if isinstance(p, Mapping))
            total += views
            if views > best[0]:
                best = (views, str(clip.get("hook") or ""))
        return {"clips": len(entries), "views": total, "bestHook": best[1] or None, "bestViews": max(best[0], 0)}

    def week_numbers(self) -> dict[str, Any]:
        """This week for APP STATE: numbers only (the best hook is the clip model's words about someone else's video,
        so it reaches the model only through ``read_my_clip_factory``)."""
        week = self.week()
        return {"clips": week["clips"], "views": week["views"], "bestViews": week["bestViews"]}

    # --- APP STATE ------------------------------------------------------------------------------------------------

    def app_state(self, *, context: Mapping[str, Any] | None, ask: Mapping[str, Any]) -> str:
        pieces: dict[str, Callable[[], Any]] = {
            "counts": self.counts,
            "jobs": self.jobs,
            "setup": self.setup,
            "settings": self.settings,
            "skills": self.skills,
            "follows": self.follows,
            "week": self.week_numbers,
            "money": self.money,
        }
        values: dict[str, Any] = {}
        pool = ThreadPoolExecutor(max_workers=len(pieces), thread_name_prefix="ask-state")
        try:
            futures = {name: pool.submit(fn) for name, fn in pieces.items()}
            wait(futures.values(), timeout=READ_TIMEOUT_S)  # one shared deadline, not 1.5 s each
            for name, future in futures.items():
                if not future.done():
                    values[name] = UNKNOWN
                    continue
                error = future.exception()
                if error is not None:
                    log("warning", "ask.state_read_failed", part=name, error=type(error).__name__)
                    values[name] = UNKNOWN
                else:
                    values[name] = future.result()
        finally:
            pool.shutdown(wait=False, cancel_futures=True)  # a slow read is left behind, never waited for
        skills = values.pop("skills")
        state = {
            "now": iso(self.now)[:10],
            "device": dict(context or {}),
            **values,
            "posting": (values.get("settings") or {}).get("platforms")
            if isinstance(values.get("settings"), dict)
            else UNKNOWN,
            "skills": {"count": len(skills), "names": skills[:20]} if isinstance(skills, list) else UNKNOWN,
            "ask": dict(ask),
        }
        return "APP STATE (his own live data, read just now):\n" + _dumps(scrub(state), STATE_CHARS)

    # --- read_my_clip_factory -------------------------------------------------------------------------------------

    def section(self, section: str, item_id: str | None) -> str:
        """The tool's text, or raises ``LookupError`` with a plain reason."""
        from .. import clips, jobs, lessons

        value: Any
        if section == "jobs":
            value = self.jobs(limit=10, words=True)
        elif section == "job":
            job = self.store.get(self.pk, db.job_sk(item_id or "")) if item_id else None
            if not job:
                raise LookupError("no job with that id")
            found = clips.clips_for_job(self.store, self.user_id, str(job["jobId"]))
            value = {"job": jobs.public_job(job), "clips": [_clip_line(c) for c in found]}
        elif section in {"review", "library"}:
            wanted = {"review"} if section == "review" else {"confirmed", "publishing", "posted", "failed"}
            value = [_clip_line(c) for c in clips.all_clips(self.store, self.user_id) if c.get("status") in wanted][:40]
        elif section == "clip":
            clip = self.store.get(self.pk, db.clip_sk(item_id or "")) if item_id else None
            if not clip:
                raise LookupError("no clip with that id")
            value = {k: v for k, v in clip.items() if k not in {"pk", "sk"}}
        elif section == "week":
            value = self.week()
        elif section == "setup":
            value = self.setup(words=True)
        elif section == "money":
            value = self.money()
        elif section == "money_days":
            from ..money import MONEY_ORDER, view

            if item_id not in MONEY_ORDER:
                raise LookupError("pick a platform like youtube")
            today = self.now.date()
            value = view.day_rows(self.store, self.user_id, str(item_id), today - timedelta(days=30), today)
        elif section == "follows":
            from ..follow import all_follows, public_follow

            value = [public_follow(f) for f in all_follows(self.store, self.user_id)]
        elif section == "settings":
            value = self.settings()
        elif section == "lessons":
            value = [lessons.public_lesson(i, self.now) for i in lessons.all_lessons(self.store, self.user_id)][:40]
        elif section == "skills":
            value = self.skills()
        else:
            raise LookupError("unknown section")
        return _dumps(scrub(value), TOOL_CHARS)


_CODE = re.compile(r"^[a-z0-9_]{1,40}$")


def _code(value: Any) -> str | None:
    """An error code (``snake_case``) or None: never free text."""
    return value if isinstance(value, str) and _CODE.match(value) else None


def _step_done(step: Mapping[str, Any], setup: Mapping[str, Any], done_ids: set[str]) -> bool:
    """The same rule as web/src/lib/setupProgress.ts ``stepDone``: auto steps tick from what the server knows."""
    keys = setup.get("keys") or {}
    auto = step.get("auto")
    if auto == "keys":
        return bool(keys.get("saved"))
    if auto == "connected":
        return (setup.get("account") or {}).get("status") == "connected"
    if auto == "checked":
        return bool((keys.get("check") or {}).get("ok") is True)
    if auto == "files":
        return bool(setup.get("files"))
    return str(step.get("id")) in done_ids


def _clip_line(c: Mapping[str, Any]) -> dict[str, Any]:
    return {
        k: c.get(k)
        for k in ("clipId", "jobId", "status", "hook", "momentType", "durationSec", "score", "rank", "createdAt")
        if c.get(k) is not None
    }
