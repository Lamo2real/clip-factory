"""The Lamo Stories dashboard (docs/CONTRACTS.md §45.16.3): counts, Needs you, what is being made, the accounts,
the numbers and recent activity, all from this workspace's partition.

``SOCIAL#`` and ``PUBJOB#`` items are builder B's and are only read here. The accounts are the public ones the Social
accounts page shows (``social.accounts_shown``, settled the same way, §45.35 D11), so a key change or Clip Factory
connecting the same account later shows here too. A post that stopped on an account problem (its sentence sends the
owner to Social accounts) has its Fix it open that platform's page on Social accounts while the problem is there;
once that account is connected again, nothing is left to fix there, so the line says to tap Try again on the post and
Fix it opens the video's Review page, where that Try again is. A TikTok post the owner's Mac stopped (§47.10:
``publishingStatus`` ``mac``, ``macState`` ``stopped``) is in Needs you too, with its stored reason,
``publishingStatus: "mac"`` and its ``mac`` (so the web's Try again asks the Mac again). A platform the owner skipped
(``SocialAccount.skipped``, ``skips``) is left out of the accounts and of Needs you (its own line and a stopped post
there, the Mac's too): it shows only on Social accounts and in the setup.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import timedelta
from typing import Any, Final

from ..clock import iso, parse
from . import activity, sentences, shapes, skips
from . import types as ws
from .publish import MAC_STATUS, public_mac

PLATFORM_NAMES: Final = {
    "youtube": "YouTube",
    "tiktok": "TikTok",
    "instagram": "Instagram",
    "facebook": "Facebook",
    "x": "X",
}
METRICS: Final = ("views", "likes", "comments", "shares")
NUMBERS_FOR = timedelta(days=7)
ACTIVITY_SHOWN = 10
CHECK_FACTS = "Check the facts in this video before you approve it."
MAC_STOPPED = "Your Mac stopped posting it to TikTok. Open the story and tap Try again."
SOCIAL_ACCOUNTS: Final = skips.SOCIAL_ACCOUNTS  # Clips Funded › Social accounts


def _post_href(job: Mapping[str, Any], story_id: str, account_fixed: bool = False) -> str:
    """Fix it: the platform's page on Social accounts when the post stopped on an account problem (needs connecting
    again, not connected, keys changed, Clip Factory's own account: its sentence names that page) that is still there,
    else the video's Review page (its Try again; also once that account is connected again)."""
    if sentences.CONNECTIONS in str(job.get("error") or "") and not account_fixed:
        return skips.social_href(str(job.get("platform") or "") or None)
    return f"/stories/review/{story_id}" if story_id else "/stories"


def _skipped(socials: Sequence[Mapping[str, Any]]) -> frozenset[str]:
    return frozenset(str(a.get("platform")) for a in socials if a.get("skipped") is True)


def _post_sentence(job: Mapping[str, Any], title: str = "", account_fixed: bool = False) -> str:
    error = str(job.get("error") or "").strip()
    if error and account_fixed and sentences.CONNECTIONS in error:
        name = PLATFORM_NAMES.get(str(job.get("platform")), "The account")
        on = f"“{title}”" if title else "the video"
        return f"{name} is connected now. Tap Try again on {on}."
    if error:
        return error
    name = PLATFORM_NAMES.get(str(job.get("platform")), "the platform")
    return f"Posting to {name} stopped. Open the story and tap Try again."


def _mac_sentence(job: Mapping[str, Any]) -> str:
    """Why the Mac stopped (its stored reason, the row's "Didn't work: …"), else a plain Try again."""
    reason = str(job.get("macReason") or "").strip()
    return reason or MAC_STOPPED


def _account_sentence(account: Mapping[str, Any]) -> str | None:
    name = PLATFORM_NAMES.get(str(account.get("platform")), "an account")
    if account.get("connectionStatus") == "needs_reconnect":
        if str(account.get("accountName") or "").strip():  # "this {Platform} account ({name})" (round 5 E13)
            who = sentences.this_account(str(account.get("platform")), str(account["accountName"]), start=True)
            return f"{who} needs connecting again. Open Social accounts and tap Connect again."
        return f"Clips Funded's {name} needs connecting again. Open Social accounts and tap Connect again."
    warning = account.get("warning")
    if account.get("reason") == "clips_unknown":
        return None  # nothing to do now: the first post shows the account to check (§45.34)
    if isinstance(warning, str) and warning.strip():
        return warning.strip()
    return None


def needs_you(
    stories: Sequence[Mapping[str, Any]], pubjobs: Sequence[Mapping[str, Any]], socials: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    titles = {str(s.get("storyId")): str(s.get("title") or "") for s in stories}
    skipped = _skipped(socials)
    connected = {str(a.get("platform")) for a in socials if a.get("connectionStatus") == "connected"}
    out: list[dict[str, Any]] = []
    latest_posted: dict[tuple[str, str], str] = {}
    for job in pubjobs:
        if job.get("publishingStatus") == "posted":
            key = (str(job.get("contentId")), str(job.get("platform")))
            latest_posted[key] = max(latest_posted.get(key, ""), str(job.get("createdAt") or ""))
    for job in sorted(pubjobs, key=lambda j: str(j.get("createdAt") or ""), reverse=True):
        mac = job.get("publishingStatus") == MAC_STATUS and job.get("macState") == "stopped"
        if job.get("publishingStatus") not in {"needs_attention", "failed"} and not mac:
            continue
        if str(job.get("platform")) in skipped:
            continue  # a skipped platform shows only on Social accounts and in the setup
        key = (str(job.get("contentId")), str(job.get("platform")))
        if latest_posted.get(key, "") > str(job.get("createdAt") or ""):
            continue
        story_id = str(job.get("contentId") or "")
        fixed = str(job.get("platform")) in connected
        item: dict[str, Any] = {
            "publishingJobId": str(job.get("publishingJobId") or "") or None,
            "storyId": story_id or None,
            "title": titles.get(story_id, ""),
            "platform": job.get("platform") if job.get("platform") in ws.PLATFORMS else None,
            "sentence": _mac_sentence(job) if mac else _post_sentence(job, titles.get(story_id, ""), fixed),
            "href": f"/stories/review/{story_id}" if mac and story_id else _post_href(job, story_id, fixed),
        }
        if mac:
            item["publishingStatus"] = MAC_STATUS
            item["mac"] = public_mac(job)
        out.append(item)
    for account in sorted(
        socials, key=lambda a: ws.PLATFORMS.index(a["platform"]) if a.get("platform") in ws.PLATFORMS else 9
    ):
        if str(account.get("platform")) in skipped:
            continue
        sentence = _account_sentence(account)
        if sentence:
            out.append(
                {
                    "publishingJobId": None,
                    "storyId": None,
                    "title": str(account.get("accountName") or PLATFORM_NAMES.get(str(account.get("platform")), "")),
                    "platform": account.get("platform") if account.get("platform") in ws.PLATFORMS else None,
                    "sentence": sentence,
                    "href": skips.social_href(str(account.get("platform") or "") or None),
                }
            )
    for story in stories:
        if story.get("status") == "needs_check":
            out.append(
                {
                    "publishingJobId": None,
                    "storyId": str(story["storyId"]),
                    "title": str(story.get("title") or ""),
                    "platform": None,
                    "sentence": CHECK_FACTS,
                    "href": f"/stories/review/{story['storyId']}",
                }
            )
    return out


def _producing(stories: Sequence[Mapping[str, Any]], jobs: Mapping[str, Mapping[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for story in stories:
        if story.get("status") != "producing":
            continue
        job = jobs.get(str(story.get("currentJobId") or "")) or {}
        steps = [s for s in job.get("steps") or [] if isinstance(s, Mapping)]
        running = next((s for s in steps if s.get("status") == "running"), None)
        pending = next((s for s in steps if s.get("status") == "pending"), None)
        step = (running or pending or {}).get("key") or "storyboard"
        out.append(
            {
                "storyId": str(story["storyId"]),
                "title": str(story.get("title") or ""),
                "step": step if step in shapes.STEP_ORDER else "storyboard",
                "progress": shapes.progress(steps),
            }
        )
    return out


def _accounts(socials: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Every platform's account, in order, except the ones the owner skipped (the tile counts "N of M" over these)."""
    by_platform = {str(a.get("platform")): a for a in socials}
    skipped = _skipped(socials)
    out = []
    for platform in ws.PLATFORMS:
        if platform in skipped:
            continue
        account = by_platform.get(platform) or {}
        out.append(
            {
                "platform": platform,
                "status": str(account.get("connectionStatus") or "not_connected"),
                "accountName": account.get("accountName") or None,
            }
        )
    return out


def _count(value: Any) -> int:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) and value > 0 else 0


def _performance(pubjobs: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    totals = dict.fromkeys(METRICS, 0)
    posts = 0
    checked: list[str] = []
    posted_at: list[str] = []
    for job in pubjobs:
        if job.get("publishingStatus") == "posted":
            posts += 1
            if isinstance(job.get("postedAt"), str):
                posted_at.append(job["postedAt"])
        metrics = job.get("metrics")
        if isinstance(metrics, Mapping):
            for key in METRICS:
                totals[key] += _count(metrics.get(key))
            if isinstance(metrics.get("checkedAt"), str):
                checked.append(metrics["checkedAt"])
    last = parse(max(posted_at)) if posted_at else None
    return {
        **totals,
        "posts": posts,
        "checkedAt": max(checked) if checked else None,
        "lastAt": iso(last + NUMBERS_FOR) if last else None,
    }


def build(
    stories: Sequence[Mapping[str, Any]],
    jobs: Mapping[str, Mapping[str, Any]],
    pubjobs: Sequence[Mapping[str, Any]],
    socials: Sequence[Mapping[str, Any]],
    activity_items: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    you = needs_you(stories, pubjobs, socials)
    counts = {
        "made": sum(1 for s in stories if s.get("videoKey")),
        "review": sum(1 for s in stories if s.get("status") == "review"),
        "published": sum(1 for s in stories if s.get("status") == "published"),
        "producing": sum(1 for s in stories if s.get("status") == "producing"),
        "needsCheck": sum(1 for s in stories if s.get("status") == "needs_check"),
        "needsYou": len(you),
    }
    return {
        "counts": counts,
        "needsYou": you,
        "producing": _producing(stories, jobs),
        "accounts": _accounts(socials),
        "performance": _performance(pubjobs),
        "activity": [activity.public(a) for a in activity_items[:ACTIVITY_SHOWN]],
    }
