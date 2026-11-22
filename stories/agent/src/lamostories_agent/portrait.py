"""A character's AI portrait (docs/CONTRACTS.md §45.8, §45.11.6, ADR-75): one step, ``portrait`` ("Draw the picture").

Only with the workspace's image provider switched to ``nova-canvas`` (Amazon Nova Canvas, Bedrock in eu-west-1); the
API refuses the job while it is ``builtin-rig``, and the agent checks again. The picture is made from the
character's description and look with a fixed seed (the same character gives the same picture), saved under
``ws/{userId}/{workspaceId}/characters/{characterId}/portrait/{assetId}.png`` as a ``portrait`` asset, and shown in
the app and the Library only, never inside a posted video. ``PROVIDER#images#nova-canvas`` is written only after the
real call answered: ``on`` when it drew (or refused the content, which proves it works), ``needs_setup`` with the
reason when Bedrock says the model cannot be used."""

from __future__ import annotations

from typing import Any, ClassVar

from . import keys
from .data import AssetPut
from .pipeline import Job, StoryFailed
from .providers import ProviderContext, ProviderFailed, chosen, provider_item
from .util import JobSuperseded, log, now_iso

SIZE = 1024
COLOURS = {
    "black": (20, 20, 20),
    "white": (245, 245, 245),
    "grey": (128, 128, 128),
    "red": (220, 40, 40),
    "coral": (255, 111, 97),
    "orange": (255, 150, 40),
    "yellow": (255, 210, 60),
    "green": (60, 170, 80),
    "mint green": (71, 214, 160),
    "teal": (40, 150, 150),
    "sky blue": (98, 198, 255),
    "blue": (40, 80, 200),
    "navy": (28, 24, 66),
    "purple": (130, 60, 180),
    "pink": (255, 140, 190),
    "brown": (110, 70, 40),
    "dark brown": (59, 42, 26),
    "tan": (210, 170, 120),
    "light peach": (242, 201, 160),
    "beige": (225, 205, 170),
}


def colour_name(hex_color: Any) -> str:
    """The nearest plain colour word for ``#rrggbb`` (image models read words better than hex)."""
    try:
        r, g, b = (int(str(hex_color)[i : i + 2], 16) for i in (1, 3, 5))
    except ValueError:
        return "plain"
    return min(COLOURS, key=lambda n: sum((x - y) ** 2 for x, y in zip(COLOURS[n], (r, g, b), strict=True)))


def portrait_prompt(ch: dict[str, Any]) -> str:
    look = ch.get("look") or {}
    hair = look.get("hair") or {}
    eyes = look.get("eyes") or {}
    outfit = look.get("outfit") or {}
    parts = [
        f"A friendly flat 2D cartoon character named {str(ch.get('name') or 'the hero')[:30]}",
        f"a {look.get('body', 'bean')}-shaped body with {colour_name(look.get('skin'))} skin",
        f"{hair.get('style', 'short')} {colour_name(hair.get('color'))} hair"
        if hair.get("style") != "none"
        else "no hair",
        f"{eyes.get('shape', 'round')} {colour_name(eyes.get('color'))} eyes, {look.get('brows', 'thin')} brows",
        f"a {colour_name(outfit.get('top'))} top with {outfit.get('pattern', 'plain')} pattern and "
        f"{colour_name(outfit.get('bottom'))} trousers",
    ]
    if look.get("accessory") and look.get("accessory") != "none":
        parts.append(f"wearing a {look['accessory']}")
    if ch.get("description"):
        parts.append(str(ch["description"])[:300])
    if ch.get("personality"):
        parts.append(f"personality: {str(ch['personality'])[:200]}")
    parts.append("full body, centred, simple clean shapes, bold outlines, soft plain background, no text")
    return ", ".join(parts)


class PortraitJob(Job):
    """A portrait job: the same fencing, heartbeat and failure path as a story job, one step of its own."""

    step_keys: ClassVar[tuple[str, ...]] = (keys.PORTRAIT_STEP,)
    labels: ClassVar[dict[str, str]] = {keys.PORTRAIT_STEP: keys.PORTRAIT_LABEL}
    content_types: ClassVar[tuple[str, ...]] = ("character",)

    async def _fail(self, key: str, sentence: str, error: BaseException | None = None) -> str:
        if error is not None:
            log("warn", "stories.portrait_failed", job=self.fence.job_id, error=type(error).__name__,
                detail=str(error)[:600])  # fmt: skip
        self._step(key).update({"status": "failed", "message": sentence, "finishedAt": now_iso()})
        at = now_iso()
        await self._last_write(
            job_fields={"status": "failed", "error": sentence, "steps": self.steps, "progress": self._progress(),
                        "meta": self.meta, "heartbeatAt": at}
        )  # fmt: skip
        return "failed"

    async def _last_job_update(self, fields: dict[str, Any]) -> None:
        async with self._job_lock:
            self._closed = True
            await self.data.update_job(self.fence, fields)

    async def _run(self) -> str:
        await self._start_running()
        step = keys.PORTRAIT_STEP
        if step not in self.todo:
            return "ignored"
        self._start(step)
        await self._flush(force=True)
        try:
            await self._portrait()
        except JobSuperseded:
            raise
        except ProviderFailed as e:
            return await self._fail(step, e.sentence, e)
        except StoryFailed as e:
            return await self._fail(step, str(e), e)
        except Exception as e:
            return await self._fail(step, keys.FAILED[step], e)
        self._step(step).update({"status": "done", "finishedAt": now_iso()})
        await self._last_job_update(
            {"status": "ready", "steps": self.steps, "progress": 1.0, "meta": self.meta, "heartbeatAt": now_iso()}
        )
        log("info", "stories.portrait_done", job=self.fence.job_id)
        return "ready"

    def _provider_item(self, provider_id: str, state: str, last_error: str | None) -> dict[str, Any]:
        return provider_item(self.fence.pk, self.fence.user_id, self.fence.workspace_id, "images", provider_id, state,
                             now_iso(), last_error)  # fmt: skip

    async def _portrait(self) -> None:
        ws = await self.data.workspace(self.fence.user_id, self.fence.workspace_id)
        if not ws or ws.get("workspaceType") != "stories":
            raise StoryFailed("This workspace no longer exists.")
        config = dict(ws.get("configuration") or {})
        provider_id = chosen(config)["images"]
        self.meta.update({"providers": {"images": provider_id}})
        if provider_id != "nova-canvas":
            raise StoryFailed(keys.IMAGES_OFF)
        ch = await self.data.character(self.fence.user_id, self.fence.workspace_id, self.content_id)
        if not ch:
            raise StoryFailed("This character no longer exists.")
        seed = keys.seed_for(self.content_id, "portrait")
        self.meta["seed"] = seed
        ctx = ProviderContext(
            engine=self.engine,
            workdir=self.work,
            image_model_id=self.svc.image_model_id,
            image_client=self.svc.image_client,
            character=ch,
            seed=seed,
        )
        provider = self.svc.registry["images"][provider_id](ctx)
        try:
            png: bytes = await provider.image(portrait_prompt(ch), SIZE, SIZE, seed, [])
        except ProviderFailed as e:
            if e.state:  # the real call answered: what it proved about the provider is kept
                await self.data.write(self.fence, puts=[self._provider_item(provider_id, e.state, e.last_error)])
            raise
        self.report(1, 1)
        await self.provider_usage(provider_id, self.svc.image_model_id, images=1)
        rows = await self.data.assets(self.fence.user_id, self.fence.workspace_id, character_id=self.content_id)
        retired = [
            str(a["assetId"])
            for a in rows
            if a.get("kind") == "portrait" and int((a.get("meta") or {}).get("current", 1) or 0) == 1
        ]
        put = AssetPut(
            kind="portrait",
            key="",
            content_type="image/png",
            bytes=len(png),
            version=None,
            character_id=self.content_id,
            meta={"seed": seed, "provider": provider_id},
        )
        put.item(self.fence, now_iso())  # gives it its id
        put.key = keys.portrait_key(self.fence.user_id, self.fence.workspace_id, self.content_id, put.asset_id)
        await self.data.put_bytes(self.fence, put.key, png, "image/png")
        await self.data.write(
            self.fence, assets=[put], retire=retired, puts=[self._provider_item(provider_id, "on", None)]
        )
