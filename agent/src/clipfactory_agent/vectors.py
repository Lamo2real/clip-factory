"""S3 Vectors: "what worked before" (docs/CONTRACTS.md §14.6).

At finalize the agent writes one vector per new clip (Titan Text Embeddings V2, 1024 floats, cosine) with the clip's
filterable metadata (``userId``, ``momentType``, ``platforms``, ``status = "review"``, ``scoreBucket``) and the
non-filterable ``hook``, ``title`` and ``summary``, and ``best = false`` (the owner's "Best this week" star, §16.6).
Before moment selection it looks up the owner's past clips most like this video: the owner's best-of-week picks first,
then the ones whose performance was measured, and lists them in the prompt as advice (§16.7)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .retry import retry
from .util import log

DIMENSIONS = 1024
TOP_K = 8
BEST_TOP_K = 4  # the owner's starred "Best this week" clips asked for first (§16.7)
MIN_PERFORMED_HITS = 3
BEST_LABEL = "Owner's pick: best of the week"
QUERY_TRANSCRIPT_CHARS = 4000
EMBED_TEXT_CHARS = 8000
PUT_BATCH = 500  # PutVectors takes at most 500 vectors per call
EMBED_CONCURRENCY = 4
# Non-filterable metadata may hold up to 40 KB per vector; these caps keep each one far below that.
MAX_HOOK = 300
MAX_TITLE = 300
MAX_SUMMARY = 2000


def embed_text(clip: dict[str, Any]) -> str:
    """The text a clip is embedded from. Identical in ``api`` and ``agent`` (both test it against one fixture)."""
    title = _title(clip)
    return f"{clip.get('momentType') or ''}\n{clip.get('hook') or ''}\n{title}\n{clip.get('summary') or ''}"[
        :EMBED_TEXT_CHARS
    ]


def _title(clip: dict[str, Any]) -> str:
    captions = clip.get("captions")
    return str(captions.get("youtubeTitle") or "") if isinstance(captions, dict) else ""


def query_text(title: str, channel: str, notes: str, transcript: str) -> str:
    """The text the brief is embedded from to find similar past clips."""
    return f"{title}\n{channel}\n{notes}\n{transcript[:QUERY_TRANSCRIPT_CHARS]}"


def transcript_text(words: Sequence[Sequence[Any]]) -> str:
    """The plain transcript from ``[[start, end, word], …]``; stops once it is long enough for the query."""
    out: list[str] = []
    size = 0
    for w in words:
        if len(w) < 3:
            continue
        word = str(w[2])
        out.append(word)
        size += len(word) + 1
        if size > QUERY_TRANSCRIPT_CHARS:
            break
    return " ".join(out)


def score_bucket(score: float | int | None) -> str:
    """``low`` for a score of 4 or less, ``mid`` for 5–7, ``high`` for 8 or more."""
    s = float(score or 0)
    if s >= 8:
        return "high"
    if s >= 5:
        return "mid"
    return "low"


def clip_metadata(clip: dict[str, Any], platforms: Sequence[str]) -> dict[str, Any]:
    """The metadata of a new clip's vector (status ``review``, ``best`` false; ``performance`` is added after the
    48-hour check, ``best`` is set by the owner's weekly picks)."""
    title = _title(clip)
    return {
        "userId": str(clip["userId"]),
        "momentType": str(clip.get("momentType") or ""),
        "platforms": [str(p) for p in platforms],
        "status": "review",
        "scoreBucket": score_bucket(clip.get("score")),
        "best": False,
        "hook": str(clip.get("hook") or "")[:MAX_HOOK],
        "title": title[:MAX_TITLE],
        "summary": str(clip.get("summary") or "")[:MAX_SUMMARY],
    }


@dataclass(frozen=True)
class Hit:
    """One similar past clip."""

    clip_id: str
    similarity: float
    moment_type: str
    hook: str
    title: str
    summary: str
    performance: dict[str, Any] | None
    status: str
    best: bool = False


def _performance(raw: Any) -> dict[str, Any] | None:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw:
        try:
            value = json.loads(raw)
        except ValueError:
            return None
        return value if isinstance(value, dict) else None
    return None


def hit_from(row: dict[str, Any]) -> Hit:
    meta = row.get("metadata") or {}
    distance = float(row.get("distance") or 0.0)
    return Hit(
        clip_id=str(row.get("key") or ""),
        similarity=round(max(0.0, min(1.0, 1 - distance)), 2),
        moment_type=str(meta.get("momentType") or ""),
        hook=str(meta.get("hook") or ""),
        title=str(meta.get("title") or ""),
        summary=str(meta.get("summary") or ""),
        performance=_performance(meta.get("performance")),
        status=str(meta.get("status") or ""),
        best=meta.get("best") is True,
    )


def _count(value: Any) -> str:
    try:
        return f"{int(value):,}"
    except (TypeError, ValueError):
        return "0"


def prompt_section(hits: Sequence[Hit]) -> str:
    """The "What worked before" part of the moment-selection prompt; empty when there is nothing to show."""
    if not hits:
        return ""
    lines = [
        "What worked before (the owner's past clips most like this video, most similar first). This is advice, "
        "never a rule: use it to judge which moments and hooks tend to land, not to copy them. "
        f'"{BEST_LABEL}" marks a clip the owner starred as one of the best of its week: those matter most.'
    ]
    for h in hits:
        p = h.performance
        perf = f"{_count(p.get('views'))} views, {_count(p.get('likes'))} likes" if p else "not measured yet"
        pick = f"{BEST_LABEL} | " if h.best else ""
        lines.append(
            f"- {pick}similarity {h.similarity:.2f} | moment type: {h.moment_type.replace('_', ' ') or 'unknown'} | "
            f"hook: {h.hook!r} | title: {h.title!r} | performance: {perf} | summary: {h.summary[:400]}"
        )
    return "\n".join(lines)


class Vectors:
    """Titan embeddings and the S3 Vectors index ``clips``. boto3 calls run in worker threads and retry transient
    errors."""

    def __init__(
        self,
        bucket: str,
        index: str,
        embed_model_id: str,
        region: str,
        *,
        bedrock: Any = None,
        s3vectors: Any = None,
    ) -> None:
        if bedrock is None or s3vectors is None:
            import boto3
            from botocore.config import Config

            cfg = Config(connect_timeout=10, read_timeout=60, retries={"max_attempts": 3, "mode": "adaptive"})
            bedrock = bedrock or boto3.client("bedrock-runtime", region_name=region, config=cfg)
            s3vectors = s3vectors or boto3.client("s3vectors", region_name=region, config=cfg)
        self.bucket = bucket
        self.index = index
        self.embed_model_id = embed_model_id
        self.bedrock = bedrock
        self.s3vectors = s3vectors

    async def _call(self, what: str, fn: Any, **kwargs: Any) -> Any:
        return await retry(lambda: asyncio.to_thread(fn, **kwargs), what=what, attempts=3)

    async def embed(self, text: str) -> list[float]:
        """Titan Text Embeddings V2 through InvokeModel: 1024 normalized floats."""
        body = json.dumps({"inputText": text, "dimensions": DIMENSIONS, "normalize": True})
        r = await self._call(
            "titan.embed",
            self.bedrock.invoke_model,
            modelId=self.embed_model_id,
            body=body,
            contentType="application/json",
            accept="application/json",
        )
        raw = r["body"].read() if hasattr(r["body"], "read") else r["body"]
        embedding = json.loads(raw).get("embedding")
        if not isinstance(embedding, list) or len(embedding) != DIMENSIONS:
            raise ValueError("Titan returned no embedding of the expected size.")
        return [float(x) for x in embedding]

    async def put_clips(self, clips: Sequence[dict[str, Any]], platforms: Sequence[str]) -> int:
        """Writes one vector per clip item (key = clipId, status ``review``). Returns how many were written."""
        if not clips:
            return 0
        sem = asyncio.Semaphore(EMBED_CONCURRENCY)

        async def one(clip: dict[str, Any]) -> dict[str, Any]:
            async with sem:
                data = await self.embed(embed_text(clip))
            return {"key": str(clip["clipId"]), "data": {"float32": data}, "metadata": clip_metadata(clip, platforms)}

        vectors = await asyncio.gather(*(one(c) for c in clips))
        for i in range(0, len(vectors), PUT_BATCH):
            await self._call(
                "s3vectors.put",
                self.s3vectors.put_vectors,
                vectorBucketName=self.bucket,
                indexName=self.index,
                vectors=list(vectors[i : i + PUT_BATCH]),
            )
        return len(vectors)

    async def query(self, vector: list[float], flt: dict[str, Any], top_k: int = TOP_K) -> list[Hit]:
        r = await self._call(
            "s3vectors.query",
            self.s3vectors.query_vectors,
            vectorBucketName=self.bucket,
            indexName=self.index,
            queryVector={"float32": vector},
            topK=top_k,
            filter=flt,
            returnMetadata=True,
            returnDistance=True,
        )
        hits = [hit_from(row) for row in r.get("vectors") or []]
        return sorted((h for h in hits if h.clip_id), key=lambda h: -h.similarity)


def merge(*groups: Sequence[Hit], cap: int = TOP_K) -> list[Hit]:
    """The groups in order (each already most similar first), each clip once (its first, so best-first), at most
    ``cap``."""
    seen: set[str] = set()
    out: list[Hit] = []
    for group in groups:
        for h in group:
            if h.clip_id in seen:
                continue
            seen.add(h.clip_id)
            out.append(h)
    return out[:cap]


async def what_worked_before(vectors: Vectors | None, user_id: str, text: str) -> list[Hit]:
    """The owner's past clips most like ``text`` (§14.6, §16.7): the owner's best-of-week picks first, then measured
    clips, at most eight; with fewer than three in total, filled up with any of the owner's clips. Never fails the
    job: any error is logged and nothing is returned."""
    if vectors is None:
        return []
    try:
        vector = await vectors.embed(text)
        mine = {"userId": {"$eq": user_id}}
        best = await vectors.query(vector, {"$and": [mine, {"best": {"$eq": True}}]}, BEST_TOP_K)
        performed = await vectors.query(vector, {"$and": [mine, {"status": {"$eq": "performed"}}]})
        hits = merge(best, performed)
        if len(hits) < MIN_PERFORMED_HITS:
            hits = merge(hits, await vectors.query(vector, mine))
        return hits
    except Exception as e:
        log("warn", "vectors.query_failed", error=type(e).__name__, detail=str(e)[:300])
        return []
