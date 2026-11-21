"""Real posting: a start → check → finish publisher per platform (docs/CONTRACTS.md §17.6).

Every upload is sent from Clip Factory as a file (no media-host verification needed); presigned URLs are only the
Instagram ``video_url`` and Facebook ``file_url`` fallbacks. Each call that creates something on the platform is
followed at once by ``job.save(handle)`` (the post's internal ``publishHandle``), so a replayed step resumes the
same upload instead of making a second one.

* ``start``: create the upload and send the bytes → ``processing`` (or ``ready_to_finish``).
* ``check``: read the platform's processing status → ``processing`` | ``ready_to_finish`` | ``done``.
* ``finish``: the publish call where the platform has one (Instagram, Facebook, X) → ``done`` or ``processing``.
"""

from __future__ import annotations

import json
import re
import secrets
from collections.abc import Callable
from datetime import timedelta
from typing import Any
from urllib.parse import quote, urlencode

from ..clock import iso, parse
from ..log import log
from . import errors
from .base import (
    GRAPH_HOST,
    HttpRequest,
    HttpResponse,
    NetworkError,
    NotConnectedError,
    Progress,
    Published,
    PublishError,
    PublishJob,
    appsecret_proof,
    obj,
)

MB = 1024 * 1024
YOUTUBE_UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status"
YOUTUBE_VIDEOS = "https://www.googleapis.com/youtube/v3/videos"
YOUTUBE_CATEGORY_GAMING = "20"
TIKTOK_API = "https://open.tiktokapis.com"
TIKTOK_SINGLE_MAX = 64 * MB
TIKTOK_CHUNK = 10 * MB
RUPLOAD = "https://rupload.facebook.com"
X_API = "https://api.x.com/2"
X_MAX_CHARS = 280
CAPTION_MAX = 2200
# TikTok's rule: branded content (a paid partnership) is only for Everyone or Friends (§17.8).
BRANDED_PRIVACY = ("PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS")
HASHTAGS_MAX = 30
_URL = re.compile(r"(https?://\S+|www\.\S+)", re.IGNORECASE)
_HASHTAG = re.compile(r"#\w+")
LOOKUP_SLACK = timedelta(minutes=2)  # clock drift between Clip Factory and Meta


# --- shared helpers ----------------------------------------------------------------------------------------------


def _send(job: PublishJob, platform: str, request: HttpRequest) -> HttpResponse:
    try:
        return job.http(request)
    except NetworkError as e:
        raise errors.down(platform) from e


def _json(resp: HttpResponse) -> dict[str, Any]:
    found = resp.json()
    return found if isinstance(found, dict) else {}


def _ok(platform: str, resp: HttpResponse, step: str) -> dict[str, Any]:
    data = _json(resp)
    error = data.get("error")
    tiktok_failed = platform == "tiktok" and isinstance(error, dict) and str(error.get("code") or "ok") != "ok"
    if resp.status >= 400 or tiktok_failed or (platform in {"instagram", "facebook"} and isinstance(error, dict)):
        raise errors.error_for(platform, resp, step=step)
    return data


def _bearer(token: str, extra: dict[str, str] | None = None) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Accept": "application/json", **(extra or {})}


def _captions(job: PublishJob) -> dict[str, Any]:
    raw = job.clip.get("captions")
    return raw if isinstance(raw, dict) else {}


def _preset(job: PublishJob, platform: str) -> dict[str, Any]:
    """My settings for one platform (§36), from the owner's Settings; {} when there are none."""
    preset = job.settings.get("postPreset")
    part = preset.get(platform) if isinstance(preset, dict) else None
    return part if isinstance(part, dict) else {}


def _choice_of(options: dict[str, Any], preset: dict[str, Any], key: str) -> Any:
    """This clip's own choice when it has one, else My settings' (None when neither says)."""
    return options[key] if key in options else preset.get(key)


def _now(job: PublishJob) -> str:
    return iso(job.now())


def _same_text(text: str) -> str:
    return " ".join(text.split())


def strip_angles(text: str) -> str:
    return text.replace("<", "").replace(">", "")


def cut_bytes(text: str, limit: int) -> str:
    raw = text.encode()
    if len(raw) <= limit:
        return text
    return raw[:limit].decode("utf-8", "ignore")


def cut_words(text: str, limit: int) -> str:
    """At most ``limit`` characters, cut at a word with "…" when it is too long."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    head = text[: limit - 1]
    if " " in head:
        head = head.rsplit(" ", 1)[0]
    return head.rstrip() + "…"


def x_text(caption: str) -> str:
    """X caption with every URL removed (a link costs extra on X), ≤ 280 characters."""
    return cut_words(_URL.sub("", caption), X_MAX_CHARS)


def instagram_caption(caption: str) -> str:
    """≤ 2200 characters and ≤ 30 hashtags (extra ones are dropped)."""
    seen = 0

    def keep(match: re.Match[str]) -> str:
        nonlocal seen
        seen += 1
        return match.group(0) if seen <= HASHTAGS_MAX else ""

    trimmed = _HASHTAG.sub(keep, caption)
    trimmed = re.sub(r"[ \t]{2,}", " ", trimmed).strip()
    return trimmed[:CAPTION_MAX]


def chunk_plan(size: int, chunk: int) -> list[tuple[int, int]]:
    """``[(start, end)]`` byte ranges (end exclusive) of ``chunk`` bytes, the last one carrying the rest."""
    if size <= 0:
        return []
    count = max(1, size // chunk)
    plan = [(i * chunk, (i + 1) * chunk) for i in range(count)]
    plan[-1] = (plan[-1][0], size)
    return plan


def tiktok_chunks(size: int) -> tuple[int, int]:
    """``(chunk_size, total_chunk_count)``: one chunk up to 64 MB, else 10 MB chunks, the last carrying the rest."""
    if size <= TIKTOK_SINGLE_MAX:
        return size, 1
    return TIKTOK_CHUNK, size // TIKTOK_CHUNK


def _publish_settings(job: PublishJob, key: str, default: Any) -> Any:
    return job.config.get(key, default)


def _without_session(handle: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in handle.items() if k not in {"sessionUri", "uploadUrl"}}


# --- YouTube -------------------------------------------------------------------------------------------------------


class YouTubePublisher:
    platform = "youtube"
    start_semantics = "at_least_once"
    finish_semantics = "at_least_once"
    needs_credentials = True

    def metadata(self, job: PublishJob) -> dict[str, Any]:
        captions = _captions(job)
        title = strip_angles(str(captions.get("youtubeTitle") or job.clip.get("hook") or "Clip")).strip()[:100]
        description = cut_bytes(strip_angles(str(captions.get("youtubeDescription") or "")), 5000)
        # This clip's choices from its YouTube row (§36.3) win; then My settings; a post without them keeps the old
        # behaviour (the saved youtubePrivacy, Gaming, not made for kids).
        opts = job.options
        preset = _preset(job, "youtube")
        privacy = str(opts.get("privacy") or job.settings.get("youtubePrivacy") or "public")
        category = str(opts.get("category") or preset.get("category") or YOUTUBE_CATEGORY_GAMING)
        status: dict[str, Any] = {
            "privacyStatus": privacy if privacy in {"public", "unlisted", "private"} else "public",
            # Only this clip's own switch can say made for kids; My settings never do (§36.2).
            "selfDeclaredMadeForKids": opts.get("madeForKids") is True,
            "containsSyntheticMedia": False,
        }
        if _choice_of(opts, preset, "embeddable") is False:
            status["embeddable"] = False
        return {
            "snippet": {
                "title": title or "Clip",
                "description": description,
                "categoryId": category if category.isdigit() else YOUTUBE_CATEGORY_GAMING,
            },
            "status": status,
        }

    @staticmethod
    def upload_url(job: PublishJob) -> str:
        """The resumable upload URL; ``notifySubscribers=false`` only when the owner turned the bell off (§36)."""
        off = _choice_of(job.options, _preset(job, "youtube"), "notifySubscribers") is False
        return YOUTUBE_UPLOAD + ("&notifySubscribers=false" if off else "")

    def start(self, job: PublishJob) -> Progress:
        handle = job.handle
        if handle.get("videoId"):
            return Progress("processing", _without_session(handle), self._every(job))
        token = job.creds.access_token
        size = job.video.size
        session = str(handle.get("sessionUri") or "")
        offset = 0
        if session:
            offset_or_done = self._resume(job, session, size)
            if isinstance(offset_or_done, str):
                return self._uploaded(job, {**handle, "videoId": offset_or_done})
            if offset_or_done < 0:
                session = ""  # the session expired: start a new one
            else:
                offset = offset_or_done
        if not session:
            body = json.dumps(self.metadata(job), separators=(",", ":")).encode()
            headers = _bearer(
                token,
                {
                    "Content-Type": "application/json; charset=UTF-8",
                    "X-Upload-Content-Length": str(size),
                    "X-Upload-Content-Type": "video/mp4",
                },
            )
            resp = _send(job, self.platform, HttpRequest("POST", self.upload_url(job), headers, body))
            _ok(self.platform, resp, "init")
            session = resp.headers.get("location", "")
            if not session.startswith("https://"):
                raise errors.down(self.platform)
            handle = {"sessionUri": session}
            job.save(handle)
        chunk = int(_publish_settings(job, "chunkMb", 8)) * MB
        while offset < size:
            end = min(offset + chunk, size)
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "video/mp4",
                "Content-Length": str(end - offset),
                "Content-Range": f"bytes {offset}-{end - 1}/{size}",
            }
            resp = _send(job, self.platform, HttpRequest("PUT", session, headers, job.video.read(offset, end)))
            if resp.status == 308:
                offset = _next_offset(resp.headers.get("range"), end)
                continue
            data = _ok(self.platform, resp, "upload")
            video_id = str(data.get("id") or "")
            if not video_id:
                raise errors.down(self.platform)
            return self._uploaded(job, {"sessionUri": session, "videoId": video_id})
        raise errors.down(self.platform)

    def _resume(self, job: PublishJob, session: str, size: int) -> int | str:
        """The next byte to send, the video id when the upload already finished, or -1 when the session is gone."""
        headers = {"Authorization": f"Bearer {job.creds.access_token}", "Content-Range": f"bytes */{size}"}
        resp = _send(job, self.platform, HttpRequest("PUT", session, headers, b""))
        if resp.status == 308:
            return _next_offset(resp.headers.get("range"), 0)
        if resp.status in {200, 201}:
            return str(_json(resp).get("id") or "")
        if resp.status in {404, 410}:
            return -1
        _ok(self.platform, resp, "resume")
        return -1

    def _uploaded(self, job: PublishJob, handle: dict[str, Any]) -> Progress:
        handle = _without_session(handle)  # the upload URL is a capability: keep it only while the upload runs
        job.save(handle)
        return Progress("processing", handle, self._every(job))

    def _every(self, job: PublishJob) -> int:
        return int(_publish_settings(job, "checkSeconds", 30))

    def check(self, job: PublishJob, handle: dict[str, Any]) -> Progress:
        video_id = str(handle.get("videoId") or "")
        url = f"{YOUTUBE_VIDEOS}?part=status,processingDetails&id={quote(video_id, safe='')}"
        resp = _send(job, self.platform, HttpRequest("GET", url, _bearer(job.creds.access_token)))
        data = _ok(self.platform, resp, "check")
        items = data.get("items") or []
        if not items:
            return Progress("processing", handle, self._every(job))
        status = (items[0].get("status") or {}) if isinstance(items[0], dict) else {}
        upload = str(status.get("uploadStatus") or "")
        if upload == "processed":
            return Progress("done", handle, published=self.published(job, handle))
        if upload in {"rejected", "failed", "deleted"}:
            reason = str(status.get("rejectionReason") or status.get("failureReason") or upload)
            sentence = (
                "YouTube did not accept this video as a duplicate. Press Try again with another clip."
                if reason == "duplicate"
                else "YouTube did not accept this video. Check it in YouTube Studio."
            )
            raise PublishError(sentence)
        return Progress("processing", handle, self._every(job))

    def finish(self, job: PublishJob, handle: dict[str, Any]) -> Progress:
        return self.check(job, handle)

    def published(self, job: PublishJob, handle: dict[str, Any]) -> Published:
        video_id = str(handle.get("videoId") or "")
        return Published(
            url=f"https://www.youtube.com/shorts/{video_id}",
            posted_at=_now(job),
            platform_post_id=video_id,
            stats_id=video_id,
        )


def _next_offset(range_header: str | None, fallback: int) -> int:
    """``Range: bytes=0-12345`` → 12346."""
    if not range_header:
        return 0 if fallback == 0 else fallback
    try:
        return int(range_header.rsplit("-", 1)[1]) + 1
    except (IndexError, ValueError):
        return fallback


# --- TikTok --------------------------------------------------------------------------------------------------------


class TikTokPublisher:
    platform = "tiktok"
    start_semantics = "at_most_once"
    finish_semantics = "at_least_once"
    needs_credentials = True

    def _post(self, job: PublishJob, path: str, payload: dict[str, Any], step: str) -> dict[str, Any]:
        headers = _bearer(job.creds.access_token, {"Content-Type": "application/json; charset=UTF-8"})
        body = json.dumps(payload, separators=(",", ":")).encode()
        resp = _send(job, self.platform, HttpRequest("POST", f"{TIKTOK_API}{path}", headers, body))
        return _ok(self.platform, resp, step)

    def creator(self, job: PublishJob) -> dict[str, Any]:
        data = self._post(job, "/v2/post/publish/creator_info/query/", {}, "creator_info")
        return obj(data.get("data"))

    def post_info(self, job: PublishJob, creator: dict[str, Any]) -> dict[str, Any]:
        options = job.options
        privacy = options.get("privacyLevel")
        allowed = [str(o) for o in creator.get("privacy_level_options") or []]
        if not isinstance(privacy, str) or privacy not in allowed:
            raise PublishError("Pick who can see it on TikTok again, then press Try again.")
        # TikTok's rule: branded content (a paid partnership) is only for Everyone or Friends.
        if options.get("brandContent") and privacy not in BRANDED_PRIVACY:
            raise PublishError("Pick who can see it on TikTok again, then press Try again.")
        caption = str(_captions(job).get("tiktok") or "")
        return {
            "title": caption[:CAPTION_MAX],
            "privacy_level": privacy,
            "disable_comment": bool(options.get("disableComment")) or bool(creator.get("comment_disabled")),
            "disable_duet": bool(options.get("disableDuet")) or bool(creator.get("duet_disabled")),
            "disable_stitch": bool(options.get("disableStitch")) or bool(creator.get("stitch_disabled")),
            "brand_content_toggle": bool(options.get("brandContent")),
            "brand_organic_toggle": bool(options.get("brandOrganic")),
            "is_aigc": False,
        }

    def start(self, job: PublishJob) -> Progress:
        handle = job.handle
        if handle.get("uploaded"):
            return Progress("processing", handle, self._every(job))
        if not handle.get("publishId"):
            creator = self.creator(job)
            limit = creator.get("max_video_post_duration_sec")
            duration = job.clip.get("durationSec")
            if isinstance(limit, int | float) and isinstance(duration, int | float) and duration > limit:
                raise PublishError("This clip is longer than TikTok allows for your account. Upload a shorter one.")
            size = job.video.size
            chunk_size, count = tiktok_chunks(size)
            data = self._post(
                job,
                "/v2/post/publish/video/init/",
                {
                    "post_info": self.post_info(job, creator),
                    "source_info": {
                        "source": "FILE_UPLOAD",
                        "video_size": size,
                        "chunk_size": chunk_size,
                        "total_chunk_count": count,
                    },
                },
                "init",
            )
            found = obj(data.get("data"))
            publish_id = str(found.get("publish_id") or "")
            upload_url = str(found.get("upload_url") or "")
            if not publish_id or not upload_url.startswith("https://"):
                raise errors.down(self.platform)
            handle = {
                "publishId": publish_id,
                "uploadUrl": upload_url,
                "username": str(creator.get("creator_username") or ""),
                "privacy": str(job.options.get("privacyLevel") or ""),
            }
            job.save(handle)
        self._upload(job, str(handle["uploadUrl"]))
        handle = {k: v for k, v in handle.items() if k != "uploadUrl"} | {"uploaded": True}
        job.save(handle)
        return Progress("processing", handle, self._every(job))

    def _upload(self, job: PublishJob, upload_url: str) -> None:
        size = job.video.size
        chunk_size, _ = tiktok_chunks(size)
        for start, end in chunk_plan(size, chunk_size):
            headers = {
                "Content-Type": "video/mp4",
                "Content-Length": str(end - start),
                "Content-Range": f"bytes {start}-{end - 1}/{size}",
            }
            resp = _send(job, self.platform, HttpRequest("PUT", upload_url, headers, job.video.read(start, end)))
            if resp.status >= 400:
                raise errors.error_for(self.platform, resp, step="upload")

    def _every(self, job: PublishJob) -> int:
        return int(_publish_settings(job, "checkSeconds", 15))

    def status(self, job: PublishJob, handle: dict[str, Any]) -> dict[str, Any]:
        data = self._post(job, "/v2/post/publish/status/fetch/", {"publish_id": handle.get("publishId")}, "status")
        return obj(data.get("data"))

    def check(self, job: PublishJob, handle: dict[str, Any]) -> Progress:
        found = self.status(job, handle)
        state = str(found.get("status") or "")
        if state == "PUBLISH_COMPLETE":
            ids = [str(i) for i in found.get("publicaly_available_post_id") or [] if i]
            done = {**handle, "postIds": ids}
            return Progress("done", done, published=self.published(job, done))
        if state == "FAILED":
            reason = str(found.get("fail_reason") or "")
            problem = errors.classify(self.platform, 400, {"error": {"code": reason}})
            if reason in {"internal", "internal_error"}:
                raise errors.RetryablePlatformProblem(problem)
            raise errors.PlatformProblem(problem)
        return Progress("processing", handle, self._every(job))

    def finish(self, job: PublishJob, handle: dict[str, Any]) -> Progress:
        return self.check(job, handle)

    def published(self, job: PublishJob, handle: dict[str, Any]) -> Published:
        username = str(handle.get("username") or "")
        profile = f"https://www.tiktok.com/@{username}" if username else "https://www.tiktok.com/"
        ids = [str(i) for i in handle.get("postIds") or []]
        if handle.get("privacy") == "SELF_ONLY":
            return Published(profile, _now(job), platform_post_id=str(handle.get("publishId")), privacy="private")
        stats = ids[0] if ids else None
        url = f"{profile}/video/{stats}" if stats and username else profile
        return Published(url, _now(job), platform_post_id=str(handle.get("publishId")), stats_id=stats)

    def public_id(self, job: PublishJob, handle: dict[str, Any]) -> str | None:
        """The public post id TikTok gives after moderation (the follow-up loop of §17.6)."""
        found = self.status(job, handle)
        ids = [str(i) for i in found.get("publicaly_available_post_id") or [] if i]
        return ids[0] if ids else None


# --- Meta (Instagram, Facebook) ------------------------------------------------------------------------------------


class _Graph:
    platform = ""

    def _graph(self, job: PublishJob, path: str) -> str:
        return f"{GRAPH_HOST}/{job.graph_api_version}/{path.lstrip('/')}"

    def _proof(self, job: PublishJob) -> str:
        return appsecret_proof(job.creds.app.client_secret, job.creds.access_token)

    def _get(self, job: PublishJob, path: str, params: dict[str, str], step: str) -> dict[str, Any]:
        query = urlencode({**params, "appsecret_proof": self._proof(job)})
        resp = _send(
            job, self.platform, HttpRequest("GET", f"{self._graph(job, path)}?{query}", _bearer(job.creds.access_token))
        )
        return _ok(self.platform, resp, step)

    def _post(self, job: PublishJob, path: str, params: dict[str, str], step: str) -> HttpResponse:
        body = urlencode({**params, "appsecret_proof": self._proof(job)}).encode()
        headers = _bearer(job.creds.access_token, {"Content-Type": "application/x-www-form-urlencoded"})
        return _send(job, self.platform, HttpRequest("POST", self._graph(job, path), headers, body))


class InstagramPublisher(_Graph):
    platform = "instagram"
    start_semantics = "at_least_once"
    finish_semantics = "at_most_once"
    needs_credentials = True

    def _ig(self, job: PublishJob) -> str:
        found = str(job.creds.data.get("igUserId") or job.account.get("accountId") or "")
        if not found:
            raise NotConnectedError("Connect Instagram in Settings › Posting › Set up posting.")
        return found

    def start(self, job: PublishJob) -> Progress:
        handle = job.handle
        if handle.get("uploaded"):
            return Progress("processing", handle, self._every(job))
        ig = self._ig(job)
        source = str(_publish_settings(job, "source", "resumable"))
        if not handle.get("container"):
            limit = self._get(job, f"{ig}/content_publishing_limit", {"fields": "config,quota_usage"}, "limit")
            rows = limit.get("data") or []
            row = rows[0] if rows and isinstance(rows[0], dict) else {}
            used = row.get("quota_usage")
            total = (row.get("config") or {}).get("quota_total") if isinstance(row.get("config"), dict) else None
            if isinstance(used, int) and isinstance(total, int) and used >= total:
                raise PublishError("Instagram's daily limit is reached. Press Try again tomorrow.")
            container = self._container(job, ig, source)
            # When the container was made: the Reel it becomes can only be newer (see _already_published).
            handle = {"container": container, "containerAt": _now(job)}
            job.save(handle)
            if source == "video_url":
                handle = {**handle, "uploaded": True}
                job.save(handle)
                return Progress("processing", handle, self._every(job))
        container = str(handle["container"])
        size = job.video.size
        headers = {
            "Authorization": f"OAuth {job.creds.access_token}",
            "offset": "0",
            "file_size": str(size),
            "Content-Type": "application/octet-stream",
        }
        url = f"{RUPLOAD}/ig-api-upload/{job.graph_api_version}/{quote(container, safe='')}"
        resp = _send(job, self.platform, HttpRequest("POST", url, headers, job.video.read(0, size)))
        if resp.status >= 500:
            # rupload.facebook.com sometimes answers 5xx for a good file (seen in prod, 21 Nov 2026). Instagram can
            # fetch the same file itself: start a new container from the media bucket's link instead.
            log("warning", "publish.instagram_upload_fallback", status=resp.status)
            handle = {"container": self._container(job, ig, "video_url"), "containerAt": _now(job), "uploaded": True}
            job.save(handle)
            return Progress("processing", handle, self._every(job))
        _ok(self.platform, resp, "upload")
        handle = {**handle, "uploaded": True}
        job.save(handle)
        return Progress("processing", handle, self._every(job))

    def _container(self, job: PublishJob, ig: str, source: str) -> str:
        """Creates the Reels container: resumable (the file is sent next) or video_url (Instagram fetches it)."""
        params = {
            "media_type": "REELS",
            "caption": instagram_caption(str(_captions(job).get("instagram") or "")),
            # Reels shared to the main feed reach more people; off only when the owner says so (§36).
            "share_to_feed": "false"
            if _choice_of(job.options, _preset(job, "instagram"), "shareToFeed") is False
            else "true",
        }
        if source == "video_url":
            params["video_url"] = job.video.presigned_url(3600)
        else:
            params["upload_type"] = "resumable"
        data = _ok(self.platform, self._post(job, f"{ig}/media", params, "container"), "container")
        container = str(data.get("id") or "")
        if not container:
            raise errors.down(self.platform)
        return container

    def _every(self, job: PublishJob) -> int:
        return int(_publish_settings(job, "checkSeconds", 60))

    def check(self, job: PublishJob, handle: dict[str, Any]) -> Progress:
        if handle.get("mediaId"):
            return Progress("done", handle, published=self._published(job, handle))
        data = self._get(job, str(handle["container"]), {"fields": "status_code,status"}, "check")
        code = str(data.get("status_code") or "")
        if code == "FINISHED":
            return Progress("ready_to_finish", handle, 0)
        if code in {"ERROR", "EXPIRED"}:
            # ``status`` holds Meta's reason ("Error: ... 2207026"); it goes to the logs, never to the owner.
            log(
                "warning",
                "publish.container_failed",
                platform=self.platform,
                code=code,
                status=str(data.get("status") or "")[:300],
            )
            if code == "EXPIRED":  # not published within 24 h: Try again starts a fresh upload (§17.6)
                raise errors.PlatformProblem(
                    errors.Problem("other", False, "Instagram waited too long for this upload. Press Try again.", code)
                )
            raise errors.PlatformProblem(errors.Problem("file", False, "Instagram did not like this video file.", code))
        if code == "PUBLISHED":  # already posted (a finish that was cut off): never publish it twice
            return self._already_published(job, handle)
        return Progress("processing", handle, self._every(job))

    def _already_published(self, job: PublishJob, handle: dict[str, Any]) -> Progress:
        """Find the Reel a published container became. Meta has no container → media link, so the newest few
        posts are matched on the caption that was sent and on being newer than the container; never a guess."""
        fields = {"fields": "id,permalink,timestamp,caption", "limit": "5"}
        found = self._get(job, f"{self._ig(job)}/media", fields, "lookup")
        sent = _same_text(instagram_caption(str(_captions(job).get("instagram") or "")))
        made = parse(handle.get("containerAt"))
        matches = []
        for row in found.get("data") or []:
            if not isinstance(row, dict) or not row.get("id") or _same_text(str(row.get("caption") or "")) != sent:
                continue
            posted = parse(row.get("timestamp"))
            if made is not None and (posted is None or posted < made - LOOKUP_SLACK):
                continue
            matches.append(row)
        if len(matches) != 1:
            log("warning", "publish.lookup_unmatched", platform=self.platform, rows=len(found.get("data") or []))
            raise errors.PlatformProblem(
                errors.Problem(
                    "other",
                    False,
                    "Instagram may have posted this already. Look on Instagram before you press Try again.",
                    "lookup",
                )
            )
        row = matches[0]
        handle = {**handle, "mediaId": str(row["id"]), "permalink": str(row.get("permalink") or "")}
        job.save(handle)
        return Progress("done", handle, published=self._published(job, handle))

    def _status_code(self, job: PublishJob, handle: dict[str, Any]) -> str:
        data = self._get(job, str(handle["container"]), {"fields": "status_code"}, "check")
        return str(data.get("status_code") or "")

    def finish(self, job: PublishJob, handle: dict[str, Any]) -> Progress:
        if handle.get("mediaId"):
            return Progress("done", handle, published=self._published(job, handle))
        if handle.get("publishing"):
            # An earlier publish call lost its answer: Meta may have posted it. Look before publishing again.
            if self._status_code(job, handle) == "PUBLISHED":
                return self._already_published(job, handle)
        else:
            handle = {**handle, "publishing": True}
            job.save(handle)
        try:
            resp = self._post(
                job, f"{self._ig(job)}/media_publish", {"creation_id": str(handle["container"])}, "publish"
            )
            data = _ok(self.platform, resp, "publish")
            media_id = str(data.get("id") or "")
            if not media_id:
                raise errors.down(self.platform)
        except PublishError:
            # Timeouts, 5xx and "already published" answers can all come after Meta posted the Reel.
            try:
                published = self._status_code(job, handle) == "PUBLISHED"
            except PublishError:
                published = False
            if published:
                return self._already_published(job, handle)
            raise
        handle = {**handle, "mediaId": media_id}
        job.save(handle)
        return Progress("done", handle, published=self._published(job, handle))

    def _published(self, job: PublishJob, handle: dict[str, Any]) -> Published:
        media_id = str(handle["mediaId"])
        permalink = str(handle.get("permalink") or "")
        if not permalink:
            try:
                permalink = str(self._get(job, media_id, {"fields": "permalink"}, "permalink").get("permalink") or "")
            except PublishError:
                permalink = ""
        return Published(
            url=permalink or "https://www.instagram.com/",
            posted_at=_now(job),
            platform_post_id=media_id,
            stats_id=media_id,
        )


class FacebookPublisher(_Graph):
    platform = "facebook"
    start_semantics = "at_least_once"
    finish_semantics = "at_least_once"
    needs_credentials = True

    def _page(self, job: PublishJob) -> str:
        found = str(job.creds.data.get("pageId") or job.account.get("accountId") or "")
        if not found:
            raise NotConnectedError("Connect Facebook in Settings › Posting › Set up posting.")
        return found

    def start(self, job: PublishJob) -> Progress:
        handle = job.handle
        if handle.get("uploaded"):
            return Progress("processing", handle, self._every(job))
        page = self._page(job)
        offset = 0
        duration = job.clip.get("durationSec")
        if not handle.get("videoId") and isinstance(duration, int | float) and not 3 <= duration <= 90:
            raise errors.PlatformProblem(
                errors.Problem("file", False, "Facebook Reels must be 3 to 90 seconds long.", "duration")
            )
        if not handle.get("videoId"):
            data = _ok(
                self.platform, self._post(job, f"{page}/video_reels", {"upload_phase": "start"}, "start"), "start"
            )
            video_id = str(data.get("video_id") or "")
            if not video_id:
                raise errors.down(self.platform)
            handle = {"videoId": video_id}
            job.save(handle)
        else:
            status = self._status(job, str(handle["videoId"]))
            transferred = (status.get("uploading_phase") or {}).get("bytes_transfered")
            offset = int(transferred) if isinstance(transferred, int) else 0
        video_id = str(handle["videoId"])
        size = job.video.size
        url = f"{RUPLOAD}/video-upload/{job.graph_api_version}/{quote(video_id, safe='')}"
        headers = {"Authorization": f"OAuth {job.creds.access_token}", "offset": str(offset), "file_size": str(size)}
        if str(_publish_settings(job, "source", "binary")) == "file_url":
            headers["file_url"] = job.video.presigned_url(3600)
            body = b""
        else:
            headers["Content-Type"] = "application/octet-stream"
            body = job.video.read(offset, size) if offset < size else b""
        if offset < size or headers.get("file_url"):
            _ok(self.platform, _send(job, self.platform, HttpRequest("POST", url, headers, body)), "upload")
        handle = {**handle, "uploaded": True}
        job.save(handle)
        return Progress("processing", handle, self._every(job))

    def _every(self, job: PublishJob) -> int:
        return int(_publish_settings(job, "checkSeconds", 30))

    def _status(self, job: PublishJob, video_id: str) -> dict[str, Any]:
        data = self._get(job, video_id, {"fields": "status"}, "status")
        return obj(data.get("status"))

    def check(self, job: PublishJob, handle: dict[str, Any]) -> Progress:
        status = self._status(job, str(handle["videoId"]))
        video = str(status.get("video_status") or "")
        phases = [
            str((status.get(p) or {}).get("status") or "")
            for p in ("uploading_phase", "processing_phase", "publishing_phase")
        ]
        if video in {"error", "upload_failed", "expired"} or "error" in phases:
            # Meta's reason ("Resolution too low...") goes to the logs, never to the owner.
            # Meta's docs show one ``error`` object per phase; some answers carry an ``errors`` list: read both.
            found = [
                f"{e.get('code')}: {e.get('message')}"
                for p in ("uploading_phase", "processing_phase", "publishing_phase")
                for e in [obj(status.get(p)).get("error"), *(obj(status.get(p)).get("errors") or [])]
                if isinstance(e, dict)
            ]
            log("warning", "publish.video_failed", platform=self.platform, video=video, errors="; ".join(found)[:300])
            raise errors.PlatformProblem(errors.Problem("file", False, "Facebook did not like this video file.", video))
        if not handle.get("finished"):
            # The docs list "completed"; their samples (and real answers) say "complete": take both.
            if phases[0] in {"complete", "completed"} or video == "upload_complete":
                return Progress("ready_to_finish", handle, 0)
            return Progress("processing", handle, self._every(job))
        if phases[2] in {"complete", "completed"} and video in {"ready", "published", ""}:
            return Progress("done", handle, published=self._published(job, handle))
        return Progress("processing", handle, self._every(job))

    def finish(self, job: PublishJob, handle: dict[str, Any]) -> Progress:
        if handle.get("finished"):
            return self.check(job, handle)
        page = self._page(job)
        params = {
            "upload_phase": "finish",
            "video_id": str(handle["videoId"]),
            "video_state": "PUBLISHED",
            "description": str(_captions(job).get("facebook") or "")[:CAPTION_MAX],
        }
        data = _ok(self.platform, self._post(job, f"{page}/video_reels", params, "finish"), "finish")
        handle = {**handle, "finished": True}
        if data.get("post_id"):
            handle["postId"] = str(data["post_id"])
        job.save(handle)
        return Progress("processing", handle, self._every(job))

    def _published(self, job: PublishJob, handle: dict[str, Any]) -> Published:
        video_id = str(handle["videoId"])
        url = ""
        try:
            url = str(self._get(job, video_id, {"fields": "permalink_url"}, "permalink").get("permalink_url") or "")
        except PublishError:
            url = ""
        if url.startswith("/"):
            url = f"https://www.facebook.com{url}"
        if not url.startswith("https://"):
            url = f"https://www.facebook.com/reel/{video_id}"
        return Published(
            url=url,
            posted_at=_now(job),
            platform_post_id=str(handle.get("postId") or video_id),
            stats_id=video_id,
        )


# --- X -------------------------------------------------------------------------------------------------------------


def _multipart(fields: dict[str, str], file_field: str, data: bytes) -> tuple[bytes, str]:
    boundary = "cf" + secrets.token_hex(12)
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="clip.mp4"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n".encode()
        + data
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


class XPublisher:
    platform = "x"
    start_semantics = "at_least_once"
    finish_semantics = "at_most_once"
    needs_credentials = True

    def _post_json(self, job: PublishJob, url: str, payload: dict[str, Any] | None, step: str) -> dict[str, Any]:
        body = json.dumps(payload, separators=(",", ":")).encode() if payload is not None else b""
        headers = _bearer(job.creds.access_token, {"Content-Type": "application/json"})
        return _ok(self.platform, _send(job, self.platform, HttpRequest("POST", url, headers, body)), step)

    def start(self, job: PublishJob) -> Progress:
        handle = job.handle
        if handle.get("finalized"):
            return Progress("processing", handle, int(handle.get("checkAfter") or 5))
        size = job.video.size
        data = self._post_json(
            job,
            f"{X_API}/media/upload/initialize",
            {"media_type": "video/mp4", "total_bytes": size, "media_category": "tweet_video"},
            "initialize",
        )
        media_id = str((data.get("data") or {}).get("id") or "")
        if not media_id:
            raise errors.down(self.platform)
        handle = {"mediaId": media_id}
        job.save(handle)
        chunk = int(_publish_settings(job, "chunkMb", 4)) * MB
        for index, start in enumerate(range(0, size, chunk)):
            end = min(start + chunk, size)
            body, content_type = _multipart({"segment_index": str(index)}, "media", job.video.read(start, end))
            headers = _bearer(job.creds.access_token, {"Content-Type": content_type})
            url = f"{X_API}/media/upload/{quote(media_id, safe='')}/append"
            _ok(self.platform, _send(job, self.platform, HttpRequest("POST", url, headers, body)), "append")
        final = self._post_json(job, f"{X_API}/media/upload/{quote(media_id, safe='')}/finalize", None, "finalize")
        info = (final.get("data") or {}).get("processing_info") or {}
        handle = {"mediaId": media_id, "finalized": True}
        job.save(handle)
        return self._progress(handle, info)

    def _progress(self, handle: dict[str, Any], info: dict[str, Any]) -> Progress:
        state = str(info.get("state") or "succeeded")
        if state == "succeeded":
            return Progress("ready_to_finish", handle, 0)
        if state == "failed":
            raise PublishError("X did not like this video file.")
        after = info.get("check_after_secs")
        wait = min(int(after), 60) if isinstance(after, int) and after > 0 else 5
        return Progress("processing", {**handle, "checkAfter": wait}, wait)

    def check(self, job: PublishJob, handle: dict[str, Any]) -> Progress:
        url = f"{X_API}/media/upload?command=STATUS&media_id={quote(str(handle['mediaId']), safe='')}"
        resp = _send(job, self.platform, HttpRequest("GET", url, _bearer(job.creds.access_token)))
        data = _ok(self.platform, resp, "status")
        return self._progress(handle, (data.get("data") or {}).get("processing_info") or {})

    def finish(self, job: PublishJob, handle: dict[str, Any]) -> Progress:
        if not handle.get("tweetId"):
            text = x_text(str(_captions(job).get("x") or ""))
            tweet: dict[str, Any] = {"text": text, "media": {"media_ids": [str(handle["mediaId"])]}}
            replies = _choice_of(job.options, _preset(job, "x"), "replies")
            if replies in {"following", "mentionedUsers", "verified"}:
                tweet["reply_settings"] = replies  # "everyone" sends nothing: X's default (§36)
            data = self._post_json(job, f"{X_API}/tweets", tweet, "tweet")
            tweet_id = str((data.get("data") or {}).get("id") or "")
            if not tweet_id:
                raise errors.down(self.platform)
            handle = {**handle, "tweetId": tweet_id}
            job.save(handle)
        username = str(job.creds.data.get("username") or "i")
        tweet_id = str(handle["tweetId"])
        published = Published(
            url=f"https://x.com/{username}/status/{tweet_id}",
            posted_at=_now(job),
            platform_post_id=tweet_id,
            stats_id=tweet_id,
        )
        return Progress("done", handle, published=published)


# --- the old one-call adapters (tests, local runs) -----------------------------------------------------------------


class AdapterPublisher:
    """Wraps a ``PlatformAdapter.publish`` (one call, done at once) as a publisher."""

    needs_credentials = False
    finish_semantics = "at_least_once"

    def __init__(self, adapter: Any) -> None:
        self.adapter = adapter
        self.platform = str(adapter.platform)
        self.start_semantics = "at_least_once" if getattr(adapter, "idempotent", False) else "at_most_once"

    def start(self, job: PublishJob) -> Progress:
        published = self.adapter.publish(job.clip, job.account, idempotency_key=str(job.post["postId"]))
        return Progress("done", {}, published=published)

    def check(self, job: PublishJob, handle: dict[str, Any]) -> Progress:  # pragma: no cover - never processing
        raise PublishError("nothing to check")

    def finish(self, job: PublishJob, handle: dict[str, Any]) -> Progress:  # pragma: no cover
        raise PublishError("nothing to finish")


PUBLISHERS: dict[str, Callable[[], Any]] = {
    "youtube": YouTubePublisher,
    "tiktok": TikTokPublisher,
    "instagram": InstagramPublisher,
    "facebook": FacebookPublisher,
    "x": XPublisher,
}


def publisher_for(platform: str) -> Any:
    try:
        return PUBLISHERS[platform]()
    except KeyError as e:
        raise NotConnectedError(f"Unknown platform: {platform}.") from e
