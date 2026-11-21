"""What the ``/v1/workspaces`` routes need beyond ``App`` (docs/CONTRACTS.md §45.5), without changing ``app.py``.

``of(app)`` builds the dependencies once per ``App`` from the environment on first use and keeps them on the app;
tests call ``install(app, WsDeps(...))`` with fakes first. Builders A and B add the fields they need here (additively;
each field has a default so the other builder's tests keep working).
SCAFFOLD (Phase 1).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from . import types as ws

# The attribute on App that holds them (a plain literal: the skills scan forbids computed getattr names).


@dataclass
class WsDeps:
    story_flow_arn: str = ""  # STORY_FLOW_ARN: the story flow's alias (builder B); empty = publishing not switched on
    ws_secret_prefix: str = ws.WS_SECRET_PREFIX  # WS_SECRET_PREFIX
    agent: Any = None  # workspaces.agent.StoryAgent (builder A); None = making videos not switched on
    flow: Any = None  # workspaces.flow.StoryFlowStarter (builder B)
    secrets: Any = None  # the workspace Secrets wrapper (builder B)
    extra: Any = None  # room for later needs without changing this shape
    s3: Any = None  # an S3 client for download links (builder A, workspaces/media.py); None = made on first use


def from_env(app: Any) -> WsDeps:
    """Plain values from the environment; the AWS-backed parts are filled by the builders' own factories."""
    from . import agent

    return WsDeps(
        story_flow_arn=os.environ.get("STORY_FLOW_ARN", ""),
        ws_secret_prefix=os.environ.get("WS_SECRET_PREFIX", ws.WS_SECRET_PREFIX),
        agent=agent.from_env(),  # None until AGENT_RUNTIME_ARN is set; its client is made on first use
    )


def of(app: Any) -> WsDeps:
    found = getattr(app, "_cf_workspace_deps", None)
    if isinstance(found, WsDeps):
        return found
    deps = from_env(app)
    app._cf_workspace_deps = deps
    return deps


def install(app: Any, deps: WsDeps) -> WsDeps:
    """For tests (and the builders' factories): use these dependencies for this app."""
    app._cf_workspace_deps = deps
    return deps
