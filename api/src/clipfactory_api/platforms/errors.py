"""Platform errors → one plain sentence for the owner (docs/CONTRACTS.md §17.6 "Friendly errors").

``friendly(platform, status, body)`` returns ``(retryable, sentence)``. ``classify`` also says what kind of problem
it was (a dead token, X credits, a rate limit...), and ``error_for`` turns an HTTP answer into the exception the
clip-flow understands. Raw platform messages go to the logs (never a token), never to the owner.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from ..log import log
from .base import HttpResponse, PublishError, ReconnectNeededError, RetryablePublishError
from .stub import LABELS

META_RATE_CODES = frozenset({"4", "17", "32", "613", "80001", "80002"})
META_FILE_SUBCODES = frozenset({"2207026", "2207052", "2207053", "2207004", "2207009", "2207057", "2207082"})
META_DAILY_SUBCODES = frozenset({"2207042"})
TIKTOK_FILE_CODES = frozenset(
    {"file_format_check_failed", "duration_check_failed", "frame_rate_check_failed", "picture_size_check_failed"}
)
TIKTOK_TOKEN_CODES = frozenset({"access_token_invalid", "scope_not_authorized", "token_not_authorized"})
YOUTUBE_RATE_REASONS = frozenset({"rateLimitExceeded", "userRateLimitExceeded", "backendError"})
YOUTUBE_DAILY_REASONS = frozenset({"quotaExceeded", "dailyLimitExceeded"})
YOUTUBE_CHANNEL_REASONS = frozenset({"forbidden", "uploadLimitExceeded", "youtubeSignupRequired"})
YOUTUBE_TOKEN_REASONS = frozenset({"authError", "invalid_token", "unauthorized"})


@dataclass(frozen=True)
class Problem:
    kind: str  # reconnect | credits | rate | daily | file | banned | private | down | duplicate | other
    retryable: bool
    sentence: str
    code: str = ""


def _label(platform: str) -> str:
    return LABELS.get(platform, platform)


def _body(body: Any) -> Any:
    if isinstance(body, bytes | str):
        try:
            return json.loads(body or "null")
        except ValueError:
            return None
    return body


def _youtube_reasons(body: Any) -> list[str]:
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, str):
        return [error]
    if not isinstance(error, dict):
        return []
    reasons = [str(e.get("reason")) for e in error.get("errors") or [] if isinstance(e, dict) and e.get("reason")]
    if error.get("status"):
        reasons.append(str(error["status"]))
    return reasons


def _tiktok_code(body: Any) -> str:
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict):
        return str(error.get("code") or "")
    return str(error or "")


def _meta_codes(body: Any) -> tuple[str, str]:
    error = body.get("error") if isinstance(body, dict) else None
    if not isinstance(error, dict):
        return "", ""
    code = error.get("code")
    sub = error.get("error_subcode")
    return (str(code) if code is not None else "", str(sub) if sub is not None else "")


def _x_text(body: Any) -> str:
    if not isinstance(body, dict):
        return ""
    parts = [str(body.get(k) or "") for k in ("title", "detail", "type")]
    for e in body.get("errors") or []:
        if isinstance(e, dict):
            parts += [str(e.get(k) or "") for k in ("title", "detail", "message", "type")]
    return " ".join(parts).lower()


def classify(platform: str, status: int, body: Any) -> Problem:
    name = _label(platform)
    parsed = _body(body)
    slow = f"{name} says slow down. Clip Factory tries again later."
    daily = f"{name} says slow down. Press Try again tomorrow."
    file_bad = f"{name} did not like this video file."
    down = f"{name} did not answer."
    reconnect = f"Connect {name} again in Settings › Posting › Set up posting, then press Try again."
    if platform == "youtube":
        reasons = set(_youtube_reasons(parsed))
        if reasons & YOUTUBE_DAILY_REASONS:
            return Problem("daily", False, daily, "quotaExceeded")
        if reasons & YOUTUBE_RATE_REASONS and status < 500:
            return Problem("rate", True, slow, "rateLimitExceeded")
        if reasons & YOUTUBE_CHANNEL_REASONS:
            code = next(iter(sorted(reasons & YOUTUBE_CHANNEL_REASONS)))
            return Problem(
                "other", False, "YouTube did not accept the upload. Check your channel in YouTube Studio.", code
            )
        if status == 401 or reasons & YOUTUBE_TOKEN_REASONS or "invalid_grant" in reasons:
            return Problem("reconnect", False, reconnect, "token_dead")
        if reasons & {"invalidVideoMetadata", "mediaBodyRequired", "invalidFilename"}:
            return Problem("file", False, file_bad, "file")
    elif platform == "tiktok":
        code = _tiktok_code(parsed)
        if code == "rate_limit_exceeded" or status == 429:
            return Problem("rate", True, slow, code or "429")
        if code == "spam_risk_too_many_posts":
            return Problem("daily", False, daily, code)
        if code in {"spam_risk_user_banned_from_posting", "spam_risk_too_many_pending_share", "spam_risk"}:
            return Problem("banned", False, "TikTok is not letting this account post right now.", code)
        if code == "unaudited_client_can_only_post_to_private_accounts":
            return Problem(
                "private", False, "Make your TikTok account private (Setup step 3), then press Try again.", code
            )
        if code == "reached_active_user_cap":
            return Problem("daily", False, "TikTok's daily limit for your app is reached. Try tomorrow.", code)
        if code in TIKTOK_FILE_CODES:
            return Problem("file", False, file_bad, code)
        if code in TIKTOK_TOKEN_CODES or status == 401:
            return Problem("reconnect", False, reconnect, code or "401")
        if code in {"internal_error", "internal"}:
            return Problem("down", True, down, code)
    elif platform in {"instagram", "facebook"}:
        code, sub = _meta_codes(parsed)
        if sub in META_DAILY_SUBCODES or (platform == "instagram" and code == "9"):
            return Problem("daily", False, f"{name}'s daily limit is reached. Press Try again tomorrow.", sub or code)
        if code in META_RATE_CODES:
            return Problem("rate", True, slow, code)
        if code == "190" or status == 401:
            return Problem("reconnect", False, reconnect, "190")
        if sub in META_FILE_SUBCODES or code == "352":
            return Problem("file", False, file_bad, sub or code)
    elif platform == "x":
        text = _x_text(parsed)
        if status == 429:
            return Problem("rate", True, slow, "429")
        if status == 402 or "creditsdepleted" in text.replace(" ", "") or "credits" in text:
            return Problem(
                "credits",
                False,
                "Your X credits ran out. Buy more in console.x.com › Billing › Credits, then press Try again.",
                "credits",
            )
        if status == 403 and "duplicate" in text:
            return Problem("duplicate", False, "X already has this post.", "duplicate")
        if status == 401:
            return Problem("reconnect", False, reconnect, "401")
        if "media" in text and ("invalid" in text or "unsupported" in text):
            return Problem("file", False, file_bad, "media")
    if status >= 500 or status == 0:
        return Problem("down", True, down, str(status))
    return Problem("other", False, f"Posting to {name} did not work. Press Try again.", str(status))


def friendly(platform: str, status: int, body: Any) -> tuple[bool, str]:
    problem = classify(platform, status, body)
    return problem.retryable, problem.sentence


class PlatformProblem(PublishError):
    """A ``PublishError`` that remembers what kind of problem it was."""

    def __init__(self, problem: Problem) -> None:
        super().__init__(problem.sentence)
        self.problem = problem


class RetryablePlatformProblem(RetryablePublishError):
    def __init__(self, problem: Problem) -> None:
        super().__init__(problem.sentence)
        self.problem = problem


class ReconnectProblem(ReconnectNeededError):
    def __init__(self, problem: Problem) -> None:
        super().__init__(problem.sentence)
        self.problem = problem


def error_for(platform: str, resp: HttpResponse, *, step: str = "") -> PublishError:
    """The exception for a failed platform answer; the raw message is logged (it never holds a token)."""
    problem = classify(platform, resp.status, resp.body)
    log("warning", "publish.platform_error", platform=platform, status=resp.status, code=problem.code, step=step)
    if problem.kind == "reconnect":
        return ReconnectProblem(problem)
    if problem.retryable:
        return RetryablePlatformProblem(problem)
    return PlatformProblem(problem)


def down(platform: str) -> RetryablePublishError:
    return RetryablePlatformProblem(Problem("down", True, f"{_label(platform)} did not answer.", "network"))
