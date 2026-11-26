"""Live updates over the API Gateway WebSocket API ``cf-prod-ws`` (docs/CONTRACTS.md §14.2).

``authorizer`` checks the Cognito access token on ``$connect``; ``ws`` stores and removes Connection items and
answers pings; ``broadcast`` turns DynamoDB stream records into small JSON events for the owner's open connections.
"""

from __future__ import annotations

import json
from typing import Any

MAX_EVENT_BYTES = 24 * 1024  # the WebSocket frame limit is 32 KB; larger events are sent as "partial"


def management_client(endpoint: str, *, read_timeout: int = 5, max_attempts: int = 2) -> Any:
    """The ``@connections`` client for ``https://{api-id}.execute-api.{region}.amazonaws.com/live``."""
    import boto3
    from botocore.config import Config

    from ..app import region

    config = Config(
        retries={"mode": "standard", "max_attempts": max_attempts}, connect_timeout=2, read_timeout=read_timeout
    )
    return boto3.client("apigatewaymanagementapi", endpoint_url=endpoint, region_name=region(), config=config)


def encode(message: dict[str, Any]) -> bytes:
    return json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def is_gone(e: BaseException) -> bool:
    """PostToConnection on a closed connection raises GoneException (HTTP 410)."""
    if type(e).__name__ == "GoneException":
        return True
    response = getattr(e, "response", None)
    if isinstance(response, dict):
        code = response.get("Error", {}).get("Code")
        status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        return bool(code == "GoneException" or status == 410)
    return False
