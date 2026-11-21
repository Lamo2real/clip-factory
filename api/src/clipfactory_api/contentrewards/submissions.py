"""``CRSUB#`` items and their public shape ``CrSubmission`` (docs/CONTRACTS.md §38.6, §38.8, §38.11)."""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta
from typing import Any

from .. import db
from ..clock import iso, parse
from . import config, links
from .util import obj

Item = dict[str, Any]
LABELS = {"youtube": "YouTube", "tiktok": "TikTok", "instagram": "Instagram", "facebook": "Facebook", "x": "X"}
FINAL = ("sent", "approved", "rejected", "sent_by_hand", "missed", "not_sent")
HAND = ("send_by_hand",)
APPEAL_DAYS = 10
PROOF_OPEN = {
    "youtube": ("Open YouTube Studio", "https://studio.youtube.com/"),
    "instagram": ("Open Instagram", "https://www.instagram.com/"),
    "x": ("Open X", "https://x.com/i/account_analytics"),
    "facebook": ("Open Facebook", "https://www.facebook.com/"),
    "tiktok": ("Open TikTok", "https://www.tiktok.com/"),
}
HINTS = (
    (("logo",), "Next time: keep the logo on screen the whole clip."),
    (("hashtag", "tag"), "Next time: every tag the campaign asks for goes in the caption."),
    (("length", "short", "long"), "Next time: check the campaign's clip length."),
    (("disclosure", "#ad", "sponsor", "paid partnership"), "Next time: #Ad first and 'Paid partnership' on the video."),
    (("music", "sound", "audio"), "Next time: use the sound the campaign asks for."),
)


def key(user_id: str, post_id: str) -> tuple[str, str]:
    return db.user_pk(user_id), db.crsub_sk(post_id)


def reason_text(
    code: str, platform: str = "youtube", *, detail: str = "", seconds: int | None = None, campaign_text: str = ""
) -> str:
    name = LABELS.get(platform, platform)
    quoted = f" “{detail[:200]}”" if detail else ""
    return {
        "private": "Private posts can't earn on Content Rewards.",
        "not_listed": "I couldn't find this campaign in your Content Rewards list, so send it yourself.",
        "not_linked": (
            f"Content Rewards doesn't know this {name} account. Open Content Rewards settings, tap **Accounts**, and "
            "connect it. Then tap I linked it."
        ),
        "not_on_application": (
            f"Your {name} account isn't on your application for this campaign. Open the campaign, tap **Add "
            "accounts**, and add it. The next clip will go."
        ),
        "relink": (
            f"This campaign needs {name} connected again on Content Rewards, with every box allowed. Open Content "
            "Rewards settings, then tap I linked it."
        ),
        "wrong_place": f"This campaign doesn't pay for {name}. Pick another campaign.",
        "too_short": (
            f"This clip is shorter than the campaign's {seconds or 30} seconds. The next clips will be longer."
        ),
        "held": "Content Rewards wants the brand to check your other clips first. I'll tell you when you can post again.",
        "account_refused": "Content Rewards won't take clips from this account on this campaign. Pick another campaign.",
        "sound_needed": campaign_text
        or "This campaign needs one of its own sounds. Clip Factory can't add it yet. Pick another campaign.",
        "drafts_first": campaign_text
        or "This campaign wants to see each clip before you post it. Clip Factory can't do that yet. Pick another campaign.",
        "campaign_closed": "The campaign isn't taking clips right now. I'll tell you when it opens again.",
        "campaign_refused": "Content Rewards won't take this clip on this campaign." + quoted,
        "refused": "Content Rewards didn't take this clip." + quoted,
        "banned": "Content Rewards says your account can't earn on this campaign. Pick another campaign.",
        "cap": "You reached the most you can earn on this campaign.",
        "not_sent_by_app": "Clip Factory couldn't send this one. Send it yourself now.",
        "not_visible_yet": "Content Rewards can't see this post yet. Send it yourself now.",
        "no_connection": "Clip Factory isn't connected to Content Rewards. Send it yourself now.",
        "read_only": "Content Rewards hasn't let Clip Factory send clips yet. Send it yourself now.",
        "manual": "You said you're in, so send it yourself now.",
        "ambiguous": "I can't tell which campaign this is on Content Rewards, so send it yourself.",
        "window_over": "Clip Factory tried for 25 minutes. Send it yourself now.",
    }.get(code, "Content Rewards didn't take this clip." + quoted)


def views_text(views: int) -> str:
    if views >= 1_000_000:
        return f"{math.floor(views / 100_000) / 10:g}M"
    if views >= 1000:
        return f"{math.floor(views / 100) / 10:g}K"
    return str(views)


def minutes_left(sub: Mapping[str, Any], now: datetime) -> int:
    by = parse(sub.get("sendBy"))
    if by is None:
        return 0
    return max(0, math.ceil((by - now).total_seconds() / 60))


def _money(cents: int) -> str:
    dollars, rest = divmod(int(cents), 100)
    return f"${dollars:,}.{rest:02d}"


def line(sub: Mapping[str, Any], now: datetime) -> str:
    state = sub.get("state")
    platform = str(sub.get("platform") or "")
    name = LABELS.get(platform, platform)
    if sub.get("removed"):
        return "Content Rewards took this clip off the campaign. It earns nothing more."
    if sub.get("postGone"):
        return f"The post is gone from {name}, so it stops earning."
    reason = obj(sub.get("reason"))
    if state == "waiting_for_post":
        return "Goes to Content Rewards after it posts."
    if state == "sending":
        return "Sending to Content Rewards…"
    if state == "sent":
        if sub.get("flagged"):
            return "On hold: Content Rewards is checking the views."
        if sub.get("appealedAt"):
            return "Back in review after you asked again."
        return "Sent ✓ · Waiting for the brand to check it"
    if state == "approved":
        text = "Approved ✓"
        if isinstance(sub.get("views"), int):
            text += f" · {views_text(int(sub['views']))} views on {name}"
        earned = obj(sub.get("earned"))
        total = int(earned.get("paidCents") or 0) + int(earned.get("pendingCents") or 0)
        if total > 0:
            text += f" · Earned on Content Rewards: {_money(total)} so far."
        return text
    if state == "rejected":
        asked = parse(sub.get("appealedAt"))
        if asked is not None:
            if now - asked >= timedelta(days=APPEAL_DAYS):
                return "The brand kept its answer. This one can't be asked again."
            return "Asked again ✓ · The answer takes 2 to 7 days."
        said = str(reason.get("brandSaid") or "")
        text = f"Not approved: “{said}”" if said else "Not approved: The brand gave no reason."
        hint = rejection_hint(said)
        return f"{text} {hint}" if hint else text
    if state == "send_by_hand":
        left = minutes_left(sub, now)
        code = reason.get("code")
        if code == "not_sent_by_app":
            return f"Clip Factory couldn't send this one. Send it yourself now ({left} min left)."
        if code == "not_visible_yet":
            return f"Content Rewards can't see this post yet. Send it yourself now ({left} min left)."
        return f"Send this to Content Rewards now ({left} min left)"
    if state == "sent_by_hand":
        return "You sent it ✓ · Looking for it on Content Rewards…"
    if state == "missed":
        return (
            "Too late to send this one. Content Rewards only takes clips in their first 30 minutes. Next time, send it "
            "as soon as I remind you."
        )
    if state == "not_sent":
        return f"Content Rewards didn't take it: {reason.get('text') or reason_text('refused')}"
    return "Goes to Content Rewards after it posts."


def rejection_hint(text: str) -> str | None:
    folded = text.lower()
    for words, hint in HINTS:
        if any(w in folded for w in words):
            return hint
    return None


def appeal_words(job_campaign: Mapping[str, Any] | None, checklist: Any) -> str:
    """A code-made, true-only text from the clip's passed checklist."""
    passed = set()
    for row in (checklist or {}).get("items") or [] if isinstance(checklist, Mapping) else []:
        if isinstance(row, Mapping) and row.get("pass") is True:
            passed.add(str(row.get("key")))
    rules_now = (job_campaign or {}).get("rules") if isinstance(job_campaign, Mapping) else None
    rules_now = obj(rules_now)
    disclosure = obj(rules_now.get("disclosure"))
    parts = []
    if "campaign_tags" in passed:
        parts.append(f"{disclosure.get('caption') or '#Ad'} is at the start of the caption")
    if "disclosure" in passed:
        parts.append(f"'{disclosure.get('onScreen') or 'Paid partnership'}' shows for the first 3 seconds")
    if "logo" in passed:
        parts.append("the logo is on screen the whole clip")
    tags = [*rules_now.get("requiredHashtags", []), *rules_now.get("requiredTags", [])]
    if "campaign_tags" in passed and tags:
        joined = tags[0] if len(tags) == 1 else ", ".join(tags[:-1]) + " and " + tags[-1]
        parts.append(f"it has {joined}")
    if not parts:
        return "This clip follows the brief."
    body = parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + ", and " + parts[-1]
    return f"This clip follows the brief: {body}."


def proof_for(
    sub: Mapping[str, Any], campaign: Mapping[str, Any] | None, post_views: int | None, now: datetime
) -> Item | None:
    stored = sub.get("proof") if isinstance(sub.get("proof"), Mapping) else None
    rules_now = obj((campaign or {}).get("rules"))
    rule = next(
        (
            r
            for r in rules_now.get("postSubmissionRules") or []
            if isinstance(r, Mapping) and (r.get("afterHours") or r.get("atViews"))
        ),
        None,
    )
    if stored is None and rule is None:
        return None
    text = str((stored or {}).get("text") or "To do: send the brand a screen recording of this clip's views.")
    where = (stored or {}).get("where") or (rule or {}).get("where")
    due_at = parse((stored or {}).get("dueAt"))
    posted = parse(sub.get("postedAt"))
    if due_at is None and rule is not None and rule.get("afterHours") and posted is not None:
        due_at = posted + timedelta(hours=int(rule["afterHours"]))
    due = bool(due_at and now >= due_at)
    if rule is not None and rule.get("atViews") and isinstance(post_views, int) and post_views >= int(rule["atViews"]):
        due = True
    third = (
        f"Send it in the brand's form: {where}"
        if where
        else "Open the campaign. Tap **Support**. Send it to the brand there."
    )
    out: Item = {
        "text": text,
        "steps": ["1 Open this clip's views.", "2 Record your screen while they show.", f"3 {third}"],
        "dueAt": iso(due_at or now),
        "due": due,
    }
    opens = PROOF_OPEN.get(str(sub.get("platform") or ""))
    if opens:
        out["open"] = {"label": opens[0], "href": opens[1]}
    if (stored or {}).get("doneAt"):
        out["doneAt"] = stored["doneAt"]  # type: ignore[index]
    return out


def public(
    sub: Mapping[str, Any],
    *,
    now: datetime,
    clip: Mapping[str, Any] | None = None,
    campaign: Mapping[str, Any] | None = None,
    post: Mapping[str, Any] | None = None,
    job_campaign: Mapping[str, Any] | None = None,
) -> Item:
    platform = str(sub.get("platform") or (post or {}).get("platform") or "")
    campaign_id = str(sub.get("campaignId") or "")
    out: Item = {
        "postId": str(sub.get("postId")),
        "clipId": str(sub.get("clipId") or (post or {}).get("clipId") or ""),
        "clipTitle": _title(clip),
        "campaignId": campaign_id,
        "campaignName": str((campaign or {}).get("name") or (job_campaign or {}).get("name") or "Campaign"),
        "platform": platform,
        "state": str(sub.get("state") or "waiting_for_post"),
        "line": line(sub, now),
        "views": sub.get("views") if isinstance(sub.get("views"), int) else None,
        "earned": dict(sub["earned"]) if isinstance(sub.get("earned"), Mapping) else None,
        "openCampaignHref": links.campaign_url(campaign_id) if links.UUID.match(campaign_id) else config.SITE,
        "updatedAt": str(sub.get("updatedAt") or iso(now)),
    }
    url = sub.get("url") or (post or {}).get("url")
    if isinstance(url, str) and url:
        out["url"] = url
    posted = sub.get("postedAt") or (post or {}).get("postedAt")
    if posted:
        out["postedAt"] = posted
    if out["state"] == "send_by_hand":
        out["minutesLeft"] = minutes_left(sub, now)
    if sub.get("sendBy"):
        out["sendBy"] = sub["sendBy"]
    reason = sub.get("reason")
    if isinstance(reason, Mapping) and reason.get("code"):
        shown: Item = {
            "code": reason["code"],
            "text": str(reason.get("text") or reason_text(str(reason["code"]), platform)),
        }
        if reason.get("brandSaid"):
            shown["brandSaid"] = str(reason["brandSaid"])[:300]
        out["reason"] = shown
    for name in ("flagged", "removed", "postGone"):
        if sub.get(name):
            out[name] = True
    if (post or {}).get("paidLabel") == "not_set":
        out["paidLabel"] = "not_set"
    if sub.get("viewsAt"):
        out["viewsAt"] = sub["viewsAt"]
    if out["state"] == "rejected":
        appeal: Item = {
            "href": config.SUBMISSIONS_URL,
            "words": appeal_words(job_campaign, (clip or {}).get("checklist")),
        }
        if sub.get("appealedAt"):
            appeal["askedAt"] = sub["appealedAt"]
        out["appeal"] = appeal
    post_views = (
        ((post or {}).get("metrics") or {}).get("views") if isinstance((post or {}).get("metrics"), Mapping) else None
    )
    proof = proof_for(sub, campaign, post_views if isinstance(post_views, int) else None, now)
    if proof is not None and out["state"] in ("sent", "approved", "sent_by_hand", "rejected"):
        out["proof"] = proof
    for name in ("sentAt", "reviewedAt"):
        if sub.get(name):
            out[name] = sub[name]
    return out


def _title(clip: Mapping[str, Any] | None) -> str:
    if not clip:
        return "Your clip"
    captions = obj(clip.get("captions"))
    title = captions.get("youtubeTitle") or clip.get("hook") or "Your clip"
    text = " ".join(str(title).split())
    return text[:80]


def made_up(post: Mapping[str, Any], campaign_id: str, now: datetime) -> Item:
    """A campaign post with no ``CRSUB#`` yet (it hasn't posted): ``waiting_for_post``."""
    return {
        "postId": post.get("postId"),
        "clipId": post.get("clipId"),
        "campaignId": campaign_id,
        "platform": post.get("platform"),
        "state": "waiting_for_post",
        "updatedAt": post.get("updatedAt") or iso(now),
    }


def for_clip(store: db.Store, user_id: str, post_ids: Iterable[str]) -> dict[str, Item]:
    found = store.batch_get(key(user_id, p) for p in post_ids)
    return {str(s.get("postId")): s for s in found if s.get("type") == "crsub"}
