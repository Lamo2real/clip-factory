"""The route table for ``/v1`` (docs/CONTRACTS.md §5). Order matters only where paths overlap."""

from __future__ import annotations

from ..http import Route, route
from . import clips, jobs, performance, skills, system, weeks

ROUTES: list[Route] = [
    route("GET", "/v1/health", system.health, public=True),
    route("GET", "/v1/me", system.me),
    route("POST", "/v1/uploads", system.create_upload),
    route("POST", "/v1/jobs", jobs.create),
    route("GET", "/v1/jobs", jobs.list_jobs),
    route("GET", "/v1/jobs/{jobId}", jobs.get_job),
    route("POST", "/v1/jobs/{jobId}/cancel", jobs.cancel),
    route("POST", "/v1/jobs/{jobId}/retry", jobs.retry),
    route("GET", "/v1/clips", clips.list_clips),
    route("GET", "/v1/clips/{clipId}", clips.get_clip),
    route("PATCH", "/v1/clips/{clipId}", clips.patch_clip),
    route("GET", "/v1/clips/{clipId}/similar", clips.similar),
    route("POST", "/v1/clips/{clipId}/confirm", clips.confirm),
    route("POST", "/v1/clips/{clipId}/decline", clips.decline),
    route("GET", "/v1/clips/{clipId}/performance", performance.get_performance),
    route("POST", "/v1/clips/{clipId}/stats/refresh", performance.refresh),
    route("GET", "/v1/skills", skills.list_skills),
    route("POST", "/v1/skills/uploads", skills.create_upload),
    route("POST", "/v1/skills", skills.register),
    route("PATCH", "/v1/skills/{skillId}", skills.patch_skill),
    route("DELETE", "/v1/skills/{skillId}", skills.delete_skill),
    route("GET", "/v1/skills/{skillId}/content", skills.content),
    route("GET", "/v1/settings", system.get_settings),
    route("PUT", "/v1/settings", system.put_settings),
    route("POST", "/v1/settings/cookies", system.create_cookies_upload),
    route("DELETE", "/v1/settings/cookies", system.delete_cookies),
    route("GET", "/v1/accounts", system.list_accounts),
    route("POST", "/v1/accounts/{platform}/connect", system.connect_account),
    route("GET", "/v1/posts", system.list_posts),
    route("GET", "/v1/insights", system.insights),
    route("GET", "/v1/weeks/{week}", weeks.get_week),
    route("PUT", "/v1/weeks/{week}/best", weeks.put_best),
]
