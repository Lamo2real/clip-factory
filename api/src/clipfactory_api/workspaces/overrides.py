"""The owner's per-request model and effort (``ModelOverride``) and a video's own setting (``Story.ai``), checked
against Lamo Stories' own model list (docs/CONTRACTS.md §45.6, §45.25, ADR-77).

Only what can be checked without resolving the levels is checked here: the model is a key of
``stories/config/models.json``, the effort is one of the five levels, and when both are given the model offers that
effort ("Claude Haiku 5.5 does not offer Maximum. Pick another level."). An effort alone is checked against the
effective model by Lamo Stories' agent when it calls, with the same sentence; it is never swapped for another.
Overrides are carried on the stored item (``PJOB#.configuration.override``, ``TASK#.override``) and never saved as a
setting. Clip Factory's ``config/models.json`` is never read.
"""

from __future__ import annotations

from typing import Any

from .. import validate
from ..errors import bad_request
from . import config


def _model(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, str) or not value:
        raise bad_request(f"{field} must be a model key.", field)
    found = config.model(value)
    if found is None:
        raise bad_request("We don't know that model. Pick one in Lamo Stories › Settings › AI.", field)
    return found


def _effort(value: Any, field: str) -> str:
    if value not in config.EFFORTS:
        raise bad_request("effort must be low, medium, high, xhigh or max.", field)
    return str(value)


def _pair(model: dict[str, Any] | None, effort: str | None, field: str) -> None:
    if model is None or effort is None:
        return
    offered = list(model.get("efforts") or [])
    if not offered:
        raise bad_request(f"{model.get('label')} has no effort setting; it runs at its own level.", field)
    if effort not in offered:
        raise bad_request(
            f"{model.get('label')} does not offer {config.EFFORT_LABEL[effort]}. Pick another level.", field
        )


def model_override(value: Any, field: str = "override") -> dict[str, str] | None:
    """``ModelOverride`` ``{ model?, effort? }``, checked; None when absent or empty (nothing to override)."""
    if value is None:
        return None
    body = validate.obj(value, field)
    validate.only_keys(body, {"model", "effort"})
    out: dict[str, str] = {}
    model = None
    if body.get("model") is not None:
        model = _model(body["model"], f"{field}.model")
        out["model"] = str(body["model"])
    if body.get("effort") is not None:
        out["effort"] = _effort(body["effort"], f"{field}.effort")
    _pair(model, out.get("effort"), field)
    return out or None


def ai_setting(value: Any, field: str = "ai") -> dict[str, str | None]:
    """A video's own ``{ model: string | null, effort: Effort | null }`` (§45.25 level 2), kept with it."""
    body = validate.obj(value, field)
    validate.only_keys(body, {"model", "effort"})
    model = _model(body["model"], f"{field}.model") if body.get("model") is not None else None
    effort = _effort(body["effort"], f"{field}.effort") if body.get("effort") is not None else None
    _pair(model, effort, field)
    return {"model": str(body["model"]) if model is not None else None, "effort": effort}


def empty_setting() -> dict[str, None]:
    return {"model": None, "effort": None}
