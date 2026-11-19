"""What a request handler needs, built once per warm Lambda from the environment (docs/CONTRACTS.md §9).

Tests build ``App`` directly with fake clients; nothing here talks to AWS until a handler runs.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import db, s3
from .agent_client import AgentClient
from .async_invoke import AsyncInvoker
from .clock import Clock, utcnow
from .flow_client import FlowClient
from .log import log
from .skills import BuiltinSkill, load_builtins
from .vectors import Vectors

if TYPE_CHECKING:
    from .follow.platforms import FollowEnv
    from .oauth import OAuthEnv
    from .routes.setup import WebFiles


@dataclass
class HelpDeps:
    """Ask Clip Factory (docs/CONTRACTS.md §19.6). Off unless ``HELP_ENABLED`` is "true". The Bedrock client is
    made on the first model call, so no other route pays for it."""

    enabled: bool = False
    model_id: str = ""
    monthly_cap: int = 2000
    rate_per_minute: int = 6
    rate_per_hour: int = 60
    app_url: str = ""
    # () → bedrock-runtime client; None turns the model step off.
    bedrock: Callable[[], Any] | None = None
    # (url, timeout seconds, max bytes) → body, for the deployed corpus; None uses the bundled copy only.
    fetcher: Callable[[str, float, int], bytes] | None = None
    corpus_file: Path | None = None  # tests: a corpus file instead of the bundled one


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def help_from_env(reg: str) -> HelpDeps:
    env = os.environ
    model_id = env.get("HELP_MODEL_ID", "")
    client: list[Any] = []

    def bedrock() -> Any:
        if not client:
            from .help.model import make_client

            client.append(make_client(reg))
        return client[0]

    def fetch(url: str, timeout: float, max_bytes: int) -> bytes:
        from .help.corpus import urllib_fetch

        return urllib_fetch(url, timeout, max_bytes)

    return HelpDeps(
        enabled=env.get("HELP_ENABLED", "false").strip().lower() == "true",
        model_id=model_id,
        monthly_cap=_int_env("HELP_MONTHLY_CAP", 2000),
        rate_per_minute=_int_env("HELP_RATE_PER_MINUTE", 6),
        rate_per_hour=_int_env("HELP_RATE_PER_HOUR", 60),
        app_url=env.get("APP_URL", ""),
        bedrock=bedrock if model_id else None,
        fetcher=fetch,
    )


@dataclass
class App:
    store: db.Store
    media: s3.Media
    agent: AgentClient  # cancel and stop only; process_job is sent by the job-flow
    flows: FlowClient
    vectors: Vectors | None = None  # None when the vector index is not configured
    invoker: AsyncInvoker | None = None  # cf-prod-stats / cf-prod-learn (§16.2)
    version: str = "dev"
    clock: Clock = utcnow
    # (user id, access token) → the owner's email. Cognito access tokens carry no email claim.
    email_lookup: Callable[[str, str], str | None] = lambda _sub, _token: None
    builtins: Callable[[], list[BuiltinSkill]] = load_builtins
    oauth: OAuthEnv | None = None  # posting setup (§17.4); None until its secrets and URLs are configured
    web_files: WebFiles | None = None  # TikTok verification files on the web bucket (§17.4)
    help: HelpDeps = field(default_factory=HelpDeps)
    # Follow creators (§24): built on first use from ``oauth`` (the same secrets and hooks URL); tests may set it.
    follow: FollowEnv | None = None
    _builtin_cache: list[BuiltinSkill] | None = field(default=None, repr=False)

    def builtin_skills(self) -> list[BuiltinSkill]:
        if self._builtin_cache is None:
            self._builtin_cache = self.builtins()
        return self._builtin_cache


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

    from . import agent_client, flow_client, vectors

    env = os.environ
    reg = region()
    lambda_client = flow_client.make_client(reg)
    vector_store = None
    if env.get("VECTOR_BUCKET") and env.get("VECTOR_INDEX"):
        s3v, bedrock = vectors.make_clients(reg)
        vector_store = Vectors(
            s3v,
            bedrock,
            env["VECTOR_BUCKET"],
            env["VECTOR_INDEX"],
            env.get("EMBED_MODEL_ID", vectors.DEFAULT_EMBED_MODEL),
        )
    oauth, web_files = _posting_setup(env, reg)
    return App(
        store=db.Store(table(env["TABLE_NAME"])),
        media=s3.Media(s3.make_client(reg), env["MEDIA_BUCKET"]),
        agent=AgentClient(agent_client.make_client(reg), env.get("AGENT_RUNTIME_ARN", "")),
        flows=FlowClient(lambda_client, env.get("JOB_FLOW_ARN", ""), env.get("CLIP_FLOW_ARN", "")),
        vectors=vector_store,
        invoker=AsyncInvoker(
            lambda_client,
            env.get("STATS_FUNCTION_ARN", ""),
            env.get("LEARN_FUNCTION_ARN", ""),
            env.get("MONEY_FUNCTION_ARN", ""),
        ),
        version=env.get("VERSION", "dev"),
        email_lookup=_cognito_email_lookup(boto3.client("cognito-idp", region_name=reg, config=_short_config())),
        oauth=oauth,
        web_files=web_files,
        help=help_from_env(reg),
    )


def _posting_setup(env: Any, reg: str) -> tuple[OAuthEnv | None, WebFiles | None]:
    """Secrets Manager, the state key and the public URLs of §17.9; both None when any is missing."""
    import boto3

    from .oauth import OAuthEnv, money_scopes_from_config, scopes_from_config
    from .oauth.secrets import PREFIX, Secrets
    from .routes.setup import WebFiles
    from .stats import config

    if not (env.get("OAUTH_STATE_SECRET") and env.get("HOOKS_URL") and env.get("APP_URL")):
        return None, None
    secrets = Secrets(
        boto3.client("secretsmanager", region_name=reg, config=_short_config()), env.get("SECRET_PREFIX") or PREFIX
    )
    state_name = env["OAUTH_STATE_SECRET"]
    oauth = OAuthEnv(
        secrets=secrets,
        app_url=env["APP_URL"],
        hooks_url=env["HOOKS_URL"],
        state_key=lambda: secrets.read_text(state_name).encode(),
        graph_version=config.load().graph_api_version,
        scopes=scopes_from_config(),
        money_scopes=money_scopes_from_config(),
    )
    web_files = None
    if env.get("WEB_BUCKET") and env.get("DISTRIBUTION_ID"):
        web_files = WebFiles(
            boto3.client("s3", region_name=reg, config=_short_config()),
            env["WEB_BUCKET"],
            boto3.client("cloudfront", config=_short_config()),
            env["DISTRIBUTION_ID"],
        )
    return oauth, web_files
