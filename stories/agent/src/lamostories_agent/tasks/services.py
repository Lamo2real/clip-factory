"""What the creative agents need from the world, in one place: the table, the media bucket, the model client, the
picture helper and the engine's catalog (docs/CONTRACTS.md §45.11.4, §45.25, §45.33).

Built lazily from the runtime's environment on the first action (``CF_STORIES_TABLE``, ``CF_MEDIA_BUCKET``,
``CF_REGION``, ``CF_WORK_DIR``), so importing and registering never touches AWS. Every model call goes through
builder E's ``ModelClient`` (``models.default_client()``, or the runner's ``model_client``): it resolves the model
and effort, adds the agent's instructions, its enabled skills and the memory, and writes ``MODELSTATUS#`` and
``USAGE#``. Every picture goes through builder E's ``images.to_model_image``. Tests install fakes with ``install``.
"""

from __future__ import annotations

import asyncio
import importlib
import os
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import models
from .common import TaskFailed, log
from .store import Store

PICTURE_FAILED = "I can't open that picture. Try a screenshot or a photo."


class ServiceMissing(TaskFailed):
    """A piece the runtime needs is not there (a deploy problem, never the owner's)."""


@dataclass
class Services:
    store: Store
    s3: Any
    bucket: str
    model: models.ModelClient
    to_model_image: Callable[[Path], Any]
    catalog: Callable[[], dict[str, Any]]
    work_dir: Path = field(default_factory=lambda: Path(os.environ.get("CF_WORK_DIR") or "/tmp/ls-work"))
    ffmpeg: str = "ffmpeg"
    ffprobe: str = "ffprobe"
    heartbeat_s: float = 20.0  # ≤ 30 s for tasks and chat turns, ≤ 60 s for jobs (§45.9.1, §45.11.1)
    stream_every_s: float = 0.5  # the chat's text is written at most this often (§45.27)


_installed: Services | None = None


def install(services: Services | None) -> None:
    """Tests (and builder E, if it wants to share its clients) put the services in place; ``None`` forgets them."""
    global _installed  # noqa: PLW0603 (one set of services per process)
    _installed = services


def get(runner: Any = None) -> Services:
    global _installed  # noqa: PLW0603
    if _installed is None:
        _installed = from_env(runner)
    return _installed


def find_model_client(runner: Any = None) -> models.ModelClient:
    """Builder E's client: the runner's ``model_client`` when it carries one, else ``models.default_client()``."""
    client = getattr(runner, "model_client", None)
    if client is None:
        factory = getattr(models, "default_client", None) or getattr(models, "get_client", None)
        client = factory() if callable(factory) else None
    if client is None or not callable(getattr(client, "complete", None)):
        raise ServiceMissing("The AI helper is not set up in Lamo Stories' agent yet. Tap Try again later.")
    return client


def find_image_helper() -> Callable[[Path], Any]:
    try:
        images = importlib.import_module("lamostories_agent.images")  # builder E's picture helper (§45.33)
    except ImportError as e:
        raise ServiceMissing("The picture helper is not set up in Lamo Stories' agent yet.") from e
    helper = getattr(images, "to_model_image", None)
    if not callable(helper):
        raise ServiceMissing("The picture helper is not set up in Lamo Stories' agent yet.")
    return helper


def from_env(runner: Any = None) -> Services:
    import boto3
    from botocore.config import Config

    from . import catalog

    table = os.environ.get("CF_STORIES_TABLE") or os.environ.get("TABLE_NAME") or ""
    bucket = os.environ.get("CF_MEDIA_BUCKET") or os.environ.get("MEDIA_BUCKET") or ""
    if not table or not bucket:
        raise ServiceMissing("Lamo Stories' agent has no table or bucket set. Tap Try again later.")
    region = os.environ.get("CF_REGION") or os.environ.get("AWS_REGION") or None
    cfg = Config(retries={"max_attempts": 4, "mode": "standard"}, connect_timeout=5, read_timeout=30)
    session = boto3.session.Session(region_name=region)
    return Services(
        store=Store(session.client("dynamodb", config=cfg), table),
        s3=session.client("s3", config=cfg),
        bucket=bucket,
        model=find_model_client(runner),
        to_model_image=_lazy_images(),
        catalog=catalog.engine_catalog,
    )


def _lazy_images() -> Callable[[Path], Any]:
    found: list[Callable[[Path], Any]] = []

    def call(path: Path) -> Any:
        if not found:
            found.append(find_image_helper())
        return found[0](path)

    return call


def image_block(value: Any) -> dict[str, Any]:
    """Builder E's helper's answer as one Converse image block (it may give the block, the image part, or JPEG bytes)."""
    if isinstance(value, bytes | bytearray):
        return {"image": {"format": "jpeg", "source": {"bytes": bytes(value)}}}
    if isinstance(value, dict):
        if "image" in value:
            return value
        if "source" in value:
            return {"image": value}
    if isinstance(value, tuple) and len(value) == 2 and isinstance(value[0], bytes | bytearray):
        return {
            "image": {"format": str(value[1] or "jpeg").replace("jpg", "jpeg"), "source": {"bytes": bytes(value[0])}}
        }
    raise TaskFailed(PICTURE_FAILED)


def picture(svc: Services, path: Path) -> dict[str, Any]:
    """One picture through the helper (long edge ≤ 1568 px, JPEG, no EXIF); one it cannot open fails the work."""
    try:
        return image_block(svc.to_model_image(path))
    except TaskFailed:
        raise
    except Exception as e:
        log("warning", "stories.picture_failed", error=type(e).__name__)
        raise TaskFailed(PICTURE_FAILED) from e


class LocalRunner:
    """Used only when the server was built without builder E's runner (the scaffold): one asyncio task per id."""

    def __init__(self) -> None:
        self.tasks: dict[str, asyncio.Task[None]] = {}

    def spawn(self, id: str, session_id: str, coro: Coroutine[Any, Any, None]) -> bool:
        running = self.tasks.get(id)
        if running is not None and not running.done():
            coro.close()
            return False
        task = asyncio.get_running_loop().create_task(coro, name=f"creative-{id}")
        self.tasks[id] = task
        task.add_done_callback(lambda t: self.tasks.pop(id, None) if self.tasks.get(id) is t else None)
        return True

    def cancel(self, id: str) -> bool:
        task = self.tasks.get(id)
        if task is None or task.done():
            return False
        task.cancel()
        return True

    def busy(self) -> bool:
        return any(not t.done() for t in self.tasks.values())

    async def shutdown(self) -> None:
        running = [t for t in self.tasks.values() if not t.done()]
        for t in running:
            t.cancel()
        if running:
            await asyncio.wait(running, timeout=20)


_local: LocalRunner | None = None


def runner_for(actions: Any, runner: Any) -> Any:
    """Builder E's runner, or (scaffold only) one shared local runner whose busy state ``/ping`` sees."""
    global _local  # noqa: PLW0603
    if runner is not None:
        return runner
    if _local is None:
        _local = LocalRunner()
    checks = getattr(actions, "busy_checks", None)
    if isinstance(checks, list) and _local.busy not in checks:
        checks.append(_local.busy)
    return _local


def accept(runner: Any, id: str, session_id: str, coro: Coroutine[Any, Any, None]) -> dict[str, Any]:
    """Starts the work in the background and answers at once (§45.11.1)."""
    try:
        started = runner.spawn(id, session_id, coro)
    except Exception:
        coro.close()
        raise
    if started is False:
        log("info", "stories.duplicate_ignored", id=id)
    return {"accepted": True, "id": id}
