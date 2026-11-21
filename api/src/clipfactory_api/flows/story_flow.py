"""``cf-prod-story-flow`` (durable, alias ``live``): sends one approved Lamo Stories video to the workspace's own
social accounts, checking every destination before every platform call (docs/CONTRACTS.md §45.14, ADR-73).

SCAFFOLD (Phase 1): builder B implements it. Until then it sends nothing.
"""

from __future__ import annotations

from typing import Any

from aws_durable_execution_sdk_python import DurableContext, durable_execution


@durable_execution
def handler(event: Any, context: DurableContext) -> dict[str, Any]:
    return {"sent": 0, "reason": "not_built"}
