"""The owner's live state for Ask (docs/CONTRACTS.md §27.2): ``APP STATE`` and the ``read_my_clip_factory`` tool.

Everything is read with the verified user id, through the same service functions the routes use (not over HTTP), and
only read: nothing here writes. The reads for APP STATE run in parallel with 1.5 s each; a read that fails or is slow
becomes "unknown". ``scrub`` drops anything secret-shaped (tokens, keys, secret names, ARNs, emails, OAuth state, links)
before a value is shown to the model.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from datetime import datetime, timedelta
from typing import Any

from .. import db, s3
from ..clock import iso
from ..log import log
from .redact import redact

STATE_CHARS = 6_000
TOOL_CHARS = 12_000
READ_TIMEOUT_S = 1.5
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

    def __init__(self, store: db.Store, media: s3.Media | None, user_id: str, now: datetime) -> None:
        self.store = store
        self.media = media
        self.user_id = user_id
        self.now = now
        self.pk = db.user_pk(user_id)

    # --- the pieces ---------------------------------------------------------------------------------------------

    def counts(self) -> dict[str, int]:
        jobs = self.store.query_all(self.pk, "JOB#")
        clips = self.store.query_all(self.pk, "CLIP#")
        return {
            "review": sum(1 for c in clips if c.get("status") == "review"),
            "running": sum(1 for j in jobs if j.get("status") in {"queued", "running"}),
            "posted": sum(1 for c in clips if c.get("status") == "posted"),
        }

    def jobs(self, limit: int = 3) -> list[dict[str, Any]]:
        page = self.store.query_page(self.pk, "JOB#", newest_first=True, limit=limit, start_key=None)
        out = []
        for j in page.items:
            raw = j.get("source")
            source: Mapping[str, Any] = raw if isinstance(raw, Mapping) else {}
            out.append(
                {
                    "jobId": j.get("jobId"),
                    "status": j.get("status"),
                    "progress": round(float(j.get("progress") or 0) * 100),
                    "source": source.get("platform") or source.get("type"),
                    "clipCount": j.get("clipCount"),
                    "error": j.get("errorCode") or (str(j.get("error"))[:120] if j.get("error") else None),
                    "createdAt": j.get("createdAt"),
                }
            )
        return out

    def setup(self) -> list[dict[str, Any]]:
        from ..oauth import setup

        out = []
        for s in setup.all_setups(self.store, self.user_id, self.now):
            account = s.get("account") or {}
            gates = s.get("gates") or []
            action = next((g for g in gates if g.get("state") == "action"), None)
            out.append(
                {
                    "platform": s.get("platform"),
                    "state": "ready" if s.get("ready") else ("in progress" if s.get("stepsDone") else "not started"),
                    "stepsDone": s.get("stepsDone"),
                    "account": account.get("status"),
                    "accountName": account.get("displayName") or account.get("name"),
                    "keysSaved": bool((s.get("keys") or {}).get("saved")),
                    "next": {"gate": action.get("id"), "title": action.get("title")} if action else None,
                    "gates": [{"id": g.get("id"), "state": g.get("state")} for g in gates],
                }
            )
        return out

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

    # --- APP STATE ------------------------------------------------------------------------------------------------

    def app_state(self, *, context: Mapping[str, Any] | None, ask: Mapping[str, Any]) -> str:
        pieces: dict[str, Callable[[], Any]] = {
            "counts": self.counts,
            "jobs": self.jobs,
            "setup": self.setup,
            "settings": self.settings,
            "skills": self.skills,
            "follows": self.follows,
            "week": self.week,
            "money": self.money,
        }
        values: dict[str, Any] = {}
        with ThreadPoolExecutor(max_workers=len(pieces)) as pool:
            futures = {name: pool.submit(fn) for name, fn in pieces.items()}
            for name, future in futures.items():
                try:
                    values[name] = future.result(timeout=READ_TIMEOUT_S)
                except FutureTimeout:
                    values[name] = UNKNOWN
                except Exception as e:
                    log("warning", "ask.state_read_failed", part=name, error=type(e).__name__)
                    values[name] = UNKNOWN
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
            value = self.jobs(limit=10)
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
            value = self.setup()
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


def _clip_line(c: Mapping[str, Any]) -> dict[str, Any]:
    return {
        k: c.get(k)
        for k in ("clipId", "jobId", "status", "hook", "momentType", "durationSec", "score", "rank", "createdAt")
        if c.get(k) is not None
    }
