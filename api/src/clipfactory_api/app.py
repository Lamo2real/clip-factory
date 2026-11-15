"""What a request handler needs, built once per warm Lambda from the environment (docs/CONTRACTS.md §9).

Tests build ``App`` directly with fake clients; nothing here talks to AWS until a handler runs.
"""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from . import db, s3
from .agent_client import AgentClient
from .clock import Clock, utcnow
from .log import log
from .skills import BuiltinSkill, load_builtins


@dataclass
class App:
    store: db.Store
    media: s3.Media
    agent: AgentClient
    queue: Any
    queue_url: str
    version: str = "dev"
    clock: Clock = utcnow
    # (user id, access token) → the owner's email. Cognito access tokens carry no email claim.
    email_lookup: Callable[[str, str], str | None] = lambda _sub, _token: None
    builtins: Callable[[], list[BuiltinSkill]] = load_builtins
    _builtin_cache: list[BuiltinSkill] | None = field(default=None, repr=False)

    def builtin_skills(self) -> list[BuiltinSkill]:
        if self._builtin_cache is None:
            self._builtin_cache = self.builtins()
        return self._builtin_cache

    def enqueue_publish(self, user_id: str, clip_id: str) -> None:
        self.queue.send_message(QueueUrl=self.queue_url, MessageBody=json.dumps({"userId": user_id, "clipId": clip_id}))


def region() -> str:
    return os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "eu-north-1"


def table(name: str) -> Any:
    import boto3
    from botocore.config import Config

    config = Config(retries={"mode": "standard", "max_attempts": 5}, connect_timeout=3, read_timeout=10)
    return boto3.resource("dynamodb", region_name=region(), config=config).Table(name)


# Short timeouts for calls made inside the 29 s API request: botocore's defaults (60 s connect and read, legacy
# retries) would let one slow endpoint outlive the Lambda after the request's writes are already committed.
def _short_config() -> Any:
    from botocore.config import Config

    return Config(retries={"mode": "standard", "max_attempts": 2}, connect_timeout=3, read_timeout=5)


def sqs_client(reg: str) -> Any:
    import boto3

    return boto3.client("sqs", region_name=reg, config=_short_config())


def _cognito_email_lookup(client: Any) -> Callable[[str, str], str | None]:
    cache: dict[str, str] = {}
    lock = threading.Lock()

    def lookup(sub: str, token: str) -> str | None:
        with lock:
            if sub in cache:
                return cache[sub]
        if not token:
            return None
        try:
            out = client.get_user(AccessToken=token)
        except Exception as e:
            log("warning", "me.email_lookup_failed", error=type(e).__name__)
            return None
        email = next((a.get("Value") for a in out.get("UserAttributes", []) if a.get("Name") == "email"), None)
        if email:
            with lock:
                if len(cache) > 100:
                    cache.clear()
                cache[sub] = email
        return email

    return lookup


def from_env() -> App:
    import boto3

    from . import agent_client

    env = os.environ
    reg = region()
    return App(
        store=db.Store(table(env["TABLE_NAME"])),
        media=s3.Media(s3.make_client(reg), env["MEDIA_BUCKET"]),
        agent=AgentClient(agent_client.make_client(reg), env.get("AGENT_RUNTIME_ARN", "")),
        queue=sqs_client(reg),
        queue_url=env.get("PUBLISH_QUEUE_URL", ""),
        version=env.get("VERSION", "dev"),
        email_lookup=_cognito_email_lookup(boto3.client("cognito-idp", region_name=reg, config=_short_config())),
    )
