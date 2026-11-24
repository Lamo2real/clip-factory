"""The ``/v1/workspaces`` core routes Lamo Stories' own Lambda serves (docs/CONTRACTS.md §45.5), checked by
test_ws_http.py (Clip Factory's route table has none of them). Builder A fills this set."""

from __future__ import annotations

W = "/v1/workspaces/stories"
IDEA = f"{W}/ideas/01J0000000000000000000000A"
CHAR = f"{W}/characters/01J0000000000000000000000B"
STORY = f"{W}/stories/01J0000000000000000000000C"
TASK = f"{W}/tasks/01J0000000000000000000000E"
SERIES = f"{W}/series/01J0000000000000000000000F"
DRAFT = f"{W}/video-drafts/01J0000000000000000000000G"

EXPECTED: set[tuple[str, str]] = {
    ("GET", "/v1/workspaces"),
    ("POST", "/v1/workspaces"),
    ("GET", W),
    ("PATCH", W),
    ("GET", f"{W}/dashboard"),
    ("GET", f"{W}/ideas"),
    ("POST", f"{W}/ideas"),
    ("POST", f"{W}/ideas/generate"),
    ("PATCH", IDEA),
    ("DELETE", IDEA),
    ("POST", f"{IDEA}/expand"),
    ("POST", f"{IDEA}/variations"),
    ("GET", TASK),
    ("GET", f"{W}/characters"),
    ("POST", f"{W}/characters"),
    ("POST", f"{W}/characters/design/uploads"),
    ("POST", f"{W}/characters/design"),
    ("GET", CHAR),
    ("PUT", CHAR),
    ("DELETE", CHAR),
    ("POST", f"{CHAR}/references"),
    ("POST", f"{CHAR}/references/01J0000000000000000000000D/complete"),
    ("DELETE", f"{CHAR}/references/01J0000000000000000000000D"),
    ("POST", f"{CHAR}/portrait"),
    ("GET", f"{W}/stories"),
    ("POST", f"{W}/stories"),
    ("GET", STORY),
    ("GET", f"{STORY}/jobs"),
    ("PATCH", STORY),
    ("DELETE", STORY),
    ("POST", f"{STORY}/produce"),
    ("POST", f"{STORY}/cancel"),
    ("POST", f"{STORY}/approve"),
    ("POST", f"{STORY}/reject"),
    ("POST", f"{STORY}/changes"),
    ("POST", f"{STORY}/captions"),
    ("GET", f"{STORY}/download"),
    ("POST", f"{STORY}/download"),
    ("GET", f"{W}/library"),
    ("GET", f"{W}/providers"),
    ("POST", f"{W}/providers/luma-ray/check"),  # §45.37 G7: Try it moved from Nova Reel (ended) to Luma AI Ray2
    ("GET", f"{W}/guidance"),
    # §45.44: series (routes/series.py)
    ("GET", f"{W}/series"),
    ("POST", f"{W}/series"),
    ("GET", SERIES),
    ("PATCH", SERIES),
    ("DELETE", SERIES),
    ("POST", f"{SERIES}/recap"),
    ("PUT", f"{STORY}/series"),
    # §45.47: video drafts (routes/video_drafts.py)
    ("GET", f"{W}/video-drafts"),
    ("POST", f"{W}/video-drafts"),
    ("GET", DRAFT),
    ("PUT", DRAFT),
    ("DELETE", DRAFT),
}
