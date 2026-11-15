"""S3 Vectors: "what worked before" (docs/CONTRACTS.md §14.6).

Every clip has one vector in the index ``clips`` of the vector bucket ``cf-prod-vectors-<account>``: key = clipId,
1024 float32 values from Amazon Titan Text Embeddings V2 (cosine). The agent writes it at finalize (status
``review``); the clip-flow merges in ``confirmed`` or ``performed`` plus the measured performance; Decline deletes
it; ``GET /v1/clips/{id}/similar`` reads it to find the owner's measured clips most like this one.

Filterable metadata: ``userId``, ``momentType``, ``platforms`` (list), ``status``, ``scoreBucket``.
Non-filterable (declared on the index, frozen): ``hook``, ``title``, ``summary``, ``performance`` (JSON string).
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from .log import log

Item = dict[str, Any]

DIMENSIONS = 1024
DEFAULT_EMBED_MODEL = "amazon.titan-embed-text-v2:0"  # config/models.json embeddingModel; Terraform passes it in
EMBED_TEXT_CHARS = 8000
SIMILAR_TOP_K = 6  # the clip itself may come back, so one more than the 5 we show
SIMILAR_MAX = 5
# Non-filterable metadata may hold up to 40 KB per vector; these caps keep each one far below that (and match the
# agent, which writes the first version of every vector).
MAX_HOOK = 300
MAX_TITLE = 300
MAX_SUMMARY = 2000
PERFORMANCE_FIELDS = ("views", "likes", "comments", "shares", "posts", "checkedAt")
STATUSES = ("review", "confirmed", "performed")


def embed_text(clip: Mapping[str, Any]) -> str:
    """The text a clip is embedded from. Identical in ``api`` and ``agent`` (both test it against one fixture)."""
    return f"{clip.get('momentType') or ''}\n{clip.get('hook') or ''}\n{_title(clip)}\n{clip.get('summary') or ''}"[
        :EMBED_TEXT_CHARS
    ]


def _title(clip: Mapping[str, Any]) -> str:
    captions = clip.get("captions")
    return str(captions.get("youtubeTitle") or "") if isinstance(captions, Mapping) else ""


def score_bucket(score: object) -> str:
    """``low`` for a score of 4 or less, ``mid`` for 5 to 7, ``high`` for 8 or more."""
    try:
        value = float(score)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        value = 0.0
    if value >= 8:
        return "high"
    if value >= 5:
        return "mid"
    return "low"


def clip_metadata(clip: Mapping[str, Any], status: str, platforms: Iterable[str]) -> Item:
    """The full metadata of a clip's vector, without ``performance``."""
    if status not in STATUSES:
        raise ValueError(f"unknown vector status: {status}")
    return {
        "userId": str(clip["userId"]),
        "momentType": str(clip.get("momentType") or ""),
        "platforms": [str(p) for p in platforms],
        "status": status,
        "scoreBucket": score_bucket(clip.get("score")),
        "hook": str(clip.get("hook") or "")[:MAX_HOOK],
        "title": _title(clip)[:MAX_TITLE],
        "summary": str(clip.get("summary") or "")[:MAX_SUMMARY],
    }


def performance_json(performance: Mapping[str, Any]) -> str:
    return json.dumps({k: performance[k] for k in PERFORMANCE_FIELDS if k in performance}, separators=(",", ":"))


def parse_performance(raw: object) -> Item | None:
    if isinstance(raw, Mapping):
        return dict(raw)
    if isinstance(raw, str) and raw:
        try:
            value = json.loads(raw)
        except ValueError:
            return None
        return value if isinstance(value, dict) else None
    return None


@dataclass(frozen=True)
class Hit:
    """One similar clip from the index (the route adds the cover link from the Clip item)."""

    clip_id: str
    similarity: float
    metadata: Item


def make_clients(region: str) -> tuple[Any, Any]:
    """(s3vectors client, bedrock-runtime client) with short timeouts."""
    import boto3
    from botocore.config import Config

    config = Config(retries={"mode": "standard", "max_attempts": 3}, connect_timeout=3, read_timeout=10)
    return (
        boto3.client("s3vectors", region_name=region, config=config),
        boto3.client("bedrock-runtime", region_name=region, config=config),
    )


class Vectors:
    def __init__(self, s3vectors: Any, bedrock: Any, bucket: str, index: str, embed_model_id: str) -> None:
        self._s3v = s3vectors
        self._bedrock = bedrock
        self.bucket = bucket
        self.index = index
        self.embed_model_id = embed_model_id

    @property
    def configured(self) -> bool:
        return bool(self.bucket and self.index)

    # --- embeddings ---------------------------------------------------------------------------------------------

    def embed(self, text: str) -> list[float]:
        """Titan Text Embeddings V2 through InvokeModel (not Converse): 1024 normalised floats."""
        out = self._bedrock.invoke_model(
            modelId=self.embed_model_id,
            contentType="application/json",
            accept="application/json",
            body=json.dumps({"inputText": text or " ", "dimensions": DIMENSIONS, "normalize": True}),
        )
        body = out["body"]
        raw = body.read() if hasattr(body, "read") else body
        embedding = json.loads(raw).get("embedding")
        if not isinstance(embedding, list) or len(embedding) != DIMENSIONS:
            raise ValueError("the embedding model returned an unexpected vector")
        return [float(x) for x in embedding]

    # --- reads and writes ---------------------------------------------------------------------------------------

    def get(self, clip_id: str, *, data: bool = True, metadata: bool = True) -> Item | None:
        out = self._s3v.get_vectors(
            vectorBucketName=self.bucket,
            indexName=self.index,
            keys=[clip_id],
            returnData=data,
            returnMetadata=metadata,
        )
        found = [v for v in out.get("vectors", []) if v.get("key") == clip_id]
        return dict(found[0]) if found else None

    def upsert_clip(
        self,
        clip: Mapping[str, Any],
        *,
        status: str,
        platforms: Iterable[str] | None = None,
        performance: Mapping[str, Any] | None = None,
    ) -> str:
        """Merges ``status`` (and ``platforms``/``performance`` when given) into the clip's vector, keeping its
        values; a missing vector is embedded from the Clip item. Returns ``updated`` or ``created``. Safe to repeat."""
        if status not in STATUSES:
            raise ValueError(f"unknown vector status: {status}")
        clip_id = str(clip["clipId"])
        existing = self.get(clip_id)
        values = ((existing or {}).get("data") or {}).get("float32")
        if existing is not None and isinstance(values, list) and values:
            metadata = dict(existing.get("metadata") or {})
            metadata["status"] = status
            metadata.setdefault("userId", str(clip["userId"]))
            if platforms is not None:
                metadata["platforms"] = [str(p) for p in platforms]
            outcome = "updated"
        else:
            values = self.embed(embed_text(clip))
            metadata = clip_metadata(clip, status, platforms or [])
            outcome = "created"
        if performance is not None:
            metadata["performance"] = performance_json(performance)
        self._s3v.put_vectors(
            vectorBucketName=self.bucket,
            indexName=self.index,
            vectors=[{"key": clip_id, "data": {"float32": [float(x) for x in values]}, "metadata": metadata}],
        )
        return outcome

    def delete_clip(self, user_id: str, clip_id: str) -> None:
        """Deletes the clip's vector (the caller has checked the clip is ``user_id``'s). A missing key is fine."""
        self._s3v.delete_vectors(vectorBucketName=self.bucket, indexName=self.index, keys=[clip_id])
        log("info", "vectors.deleted", clipId=clip_id)

    def similar(self, user_id: str, clip_id: str, k: int = SIMILAR_MAX) -> list[Hit]:
        """The owner's measured (``performed``) clips most like ``clip_id``, best first, without the clip itself."""
        own = self.get(clip_id, data=True, metadata=False)
        values = ((own or {}).get("data") or {}).get("float32")
        if not isinstance(values, list) or not values:
            return []
        out = self._s3v.query_vectors(
            vectorBucketName=self.bucket,
            indexName=self.index,
            queryVector={"float32": [float(x) for x in values]},
            topK=SIMILAR_TOP_K,
            filter={"$and": [{"userId": {"$eq": user_id}}, {"status": {"$eq": "performed"}}]},
            returnMetadata=True,
            returnDistance=True,
        )
        hits = []
        for row in out.get("vectors", []):
            key = str(row.get("key") or "")
            metadata = dict(row.get("metadata") or {})
            if not key or key == clip_id or metadata.get("userId") != user_id:
                continue
            distance = float(row.get("distance") or 0.0)
            similarity = round(min(1.0, max(0.0, 1.0 - distance)), 2)
            hits.append(Hit(key, similarity, metadata))
        hits.sort(key=lambda h: -h.similarity)
        return hits[:k]
