"""Fakes for the creative agents' tests (builder E2): a DynamoDB table that reads exactly the expression grammar of
``tasks.store``, an S3 bucket, a scripted model client and the picture helper. No AWS, no network.

Also the store's own tests: the fake and the real ``Store`` agree on conditions, transactions and pagination.
"""

from __future__ import annotations

import copy
import io
import re
import shutil
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

import pytest
from boto3.dynamodb.types import TypeDeserializer, TypeSerializer
from botocore.exceptions import ClientError

from lamostories_agent import models
from lamostories_agent.tasks import catalog as engine
from lamostories_agent.tasks.common import plain
from lamostories_agent.tasks.services import Services
from lamostories_agent.tasks.store import Expr, Store, to_ddb

USER = "u-1"
WS = "stories"
PK = f"USER#{USER}#WS#{WS}"
_SER = TypeSerializer()
_DES = TypeDeserializer()


def _err(code: str, **extra: Any) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": code}, **extra}, "op")


class FakeDynamo:
    """Items keyed by (pk, sk), held as plain Python values."""

    def __init__(self) -> None:
        self.items: dict[tuple[str, str], dict[str, Any]] = {}
        self.writes: list[tuple[str, str, str]] = []  # (op, pk, sk) of every accepted write
        self.refused: list[tuple[str, str, str]] = []
        self.on_write: Callable[[str, str, str], None] | None = None

    # --- helpers --------------------------------------------------------------------------------------------------

    def seed(self, item: dict[str, Any]) -> None:
        self.items[(item["pk"], item["sk"])] = copy.deepcopy(item)

    def get(self, pk: str, sk: str) -> dict[str, Any] | None:
        found = self.items.get((pk, sk))
        return copy.deepcopy(found) if found else None

    def prefixed(self, pk: str, prefix: str) -> list[dict[str, Any]]:
        return [copy.deepcopy(v) for (p, s), v in sorted(self.items.items()) if p == pk and s.startswith(prefix)]

    @staticmethod
    def _key(key: dict[str, Any]) -> tuple[str, str]:
        return key["pk"]["S"], key["sk"]["S"]

    @staticmethod
    def _value(raw: dict[str, Any]) -> Any:
        return plain(_DES.deserialize(raw))

    def _cond_ok(
        self, item: dict[str, Any] | None, cond: str | None, names: dict[str, str], values: dict[str, Any]
    ) -> bool:
        if not cond:
            return True
        current = item or {}
        for raw in cond.split(" AND "):
            clause = raw.strip()
            m = re.fullmatch(r"attribute_(exists|not_exists)\((#n\d+)\)", clause)
            if m:
                there = names[m.group(2)] in current
                if (m.group(1) == "exists") != there:
                    return False
                continue
            m = re.fullmatch(r"(#n\d+) (=|<>) (:v\d+)", clause)
            if m:
                have = current.get(names[m.group(1)])
                want = self._value(values[m.group(3)])
                if (m.group(2) == "=") != (have == want and names[m.group(1)] in current):
                    return False
                continue
            m = re.fullmatch(r"(#n\d+) IN \(([^)]*)\)", clause)
            if m:
                have = current.get(names[m.group(1)])
                options = [self._value(values[t.strip()]) for t in m.group(2).split(",")]
                if names[m.group(1)] not in current or have not in options:
                    return False
                continue
            raise AssertionError(f"the fake does not read this condition: {clause}")
        return True

    def _apply(self, item: dict[str, Any], update: str, names: dict[str, str], values: dict[str, Any]) -> None:
        parts = re.split(r"\b(SET|REMOVE|ADD)\b", update)
        for i in range(1, len(parts), 2):
            kind, body = parts[i], parts[i + 1].strip()
            for piece in [p.strip() for p in body.split(",") if p.strip()]:
                if kind == "SET":
                    name, value = (x.strip() for x in piece.split("="))
                    item[names[name]] = self._value(values[value])
                elif kind == "REMOVE":
                    item.pop(names[piece], None)
                else:
                    name, value = piece.split()
                    item[names[name]] = item.get(names[name], 0) + self._value(values[value])

    # --- the client ----------------------------------------------------------------------------------------------

    def get_item(self, *, TableName: str, Key: dict[str, Any], ConsistentRead: bool = False) -> dict[str, Any]:
        found = self.items.get(self._key(Key))
        return {"Item": {k: _SER.serialize(to_ddb(v)) for k, v in found.items()}} if found else {}

    def query(self, **params: Any) -> dict[str, Any]:
        values = params["ExpressionAttributeValues"]
        pk, prefix = values[":pk"]["S"], values[":prefix"]["S"]
        rows = [v for (p, s), v in sorted(self.items.items()) if p == pk and s.startswith(prefix)]
        if not params.get("ScanIndexForward", True):
            rows.reverse()
        start = params.get("ExclusiveStartKey")
        if start:
            at = next(i for i, r in enumerate(rows) if (r["pk"], r["sk"]) == self._key(start))
            rows = rows[at + 1 :]
        limit = params.get("Limit") or 1000
        page = rows[:limit]
        out: dict[str, Any] = {"Items": [{k: _SER.serialize(to_ddb(v)) for k, v in r.items()} for r in page]}
        if len(rows) > limit:
            last = page[-1]
            out["LastEvaluatedKey"] = {"pk": {"S": last["pk"]}, "sk": {"S": last["sk"]}}
        return out

    def _accept(self, op: str, pk: str, sk: str) -> None:
        self.writes.append((op, pk, sk))
        if self.on_write:
            self.on_write(op, pk, sk)

    def update_item(self, *, TableName: str, Key: dict[str, Any], **p: Any) -> dict[str, Any]:
        pk, sk = self._key(Key)
        item = self.items.get((pk, sk))
        if not self._cond_ok(
            item,
            p.get("ConditionExpression"),
            p.get("ExpressionAttributeNames", {}),
            p.get("ExpressionAttributeValues", {}),
        ):
            self.refused.append(("update", pk, sk))
            raise _err("ConditionalCheckFailedException")
        new = copy.deepcopy(item) if item else {"pk": pk, "sk": sk}
        self._apply(
            new,
            p.get("UpdateExpression", ""),
            p.get("ExpressionAttributeNames", {}),
            p.get("ExpressionAttributeValues", {}),
        )
        self.items[(pk, sk)] = new
        self._accept("update", pk, sk)
        return {}

    def put_item(
        self, *, TableName: str, Item: dict[str, Any], ConditionExpression: str | None = None
    ) -> dict[str, Any]:
        item = {k: self._value(v) for k, v in Item.items()}
        key = (item["pk"], item["sk"])
        if ConditionExpression == "attribute_not_exists(pk)" and key in self.items:
            self.refused.append(("put", *key))
            raise _err("ConditionalCheckFailedException")
        self.items[key] = item
        self._accept("put", *key)
        return {}

    def transact_write_items(self, *, TransactItems: list[dict[str, Any]]) -> dict[str, Any]:
        reasons = []
        for op in TransactItems:
            ((kind, body),) = op.items()
            if kind == "Put":
                item = {k: self._value(v) for k, v in body["Item"].items()}
                ok = (item["pk"], item["sk"]) not in self.items
            else:
                current = self.items.get(self._key(body["Key"]))
                ok = self._cond_ok(
                    current,
                    body.get("ConditionExpression"),
                    body.get("ExpressionAttributeNames", {}),
                    body.get("ExpressionAttributeValues", {}),
                )
            reasons.append({"Code": "None" if ok else "ConditionalCheckFailed"})
        if any(r["Code"] != "None" for r in reasons):
            self.refused.append(("transact", "", ""))
            raise _err("TransactionCanceledException", CancellationReasons=reasons)
        for op in TransactItems:
            ((kind, body),) = op.items()
            if kind == "Put":
                self.put_item(TableName=body["TableName"], Item=body["Item"])
            elif kind == "Update":
                self.update_item(
                    TableName=body["TableName"],
                    Key=body["Key"],
                    **{k: v for k, v in body.items() if k not in ("TableName", "Key")},
                )
        return {}


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.files: dict[str, Path] = {}  # big objects served from disk (the fixture video)
        self.reads: list[str] = []
        self.writes: list[str] = []

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        self.reads.append(Key)
        if Key in self.files:
            return {"Body": io.BytesIO(self.files[Key].read_bytes())}
        if Key not in self.objects:
            raise _err("NoSuchKey")
        return {"Body": io.BytesIO(self.objects[Key])}

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, ContentType: str = "") -> dict[str, Any]:
        self.writes.append(Key)
        self.objects[Key] = bytes(Body)
        return {}

    def download_file(self, bucket: str, key: str, filename: str) -> None:
        self.reads.append(key)
        if key in self.files:
            shutil.copyfile(self.files[key], filename)
            return
        if key not in self.objects:
            raise _err("404")
        Path(filename).write_bytes(self.objects[key])


def reply(
    text: str = "",
    *,
    data: Any = None,
    tools: Iterable[tuple[str, dict[str, Any]]] = (),
    stop: str | None = None,
    model: str = "opus-5-5",
    effort: str | None = "high",
    applied: bool = True,
    usage: dict[str, int] | None = None,
) -> models.Reply:
    calls = [{"toolUseId": f"t{n}", "name": name, "input": args} for n, (name, args) in enumerate(tools)]
    content: list[dict[str, Any]] = [{"text": text}] if text else []
    content += [{"toolUse": c} for c in calls]
    return models.Reply(
        text=text,
        data=data,
        tool_calls=calls,
        content=content,
        stop_reason=stop or ("tool_use" if calls else "end_turn"),
        model=model,
        effort=effort,
        effort_applied=applied,
        usage=usage or {"input": 100, "output": 20},
    )


class FakeModel:
    """Answers each ``complete`` with the next scripted reply (or raises the next scripted exception)."""

    def __init__(self, *script: models.Reply | BaseException | Callable[[dict[str, Any]], models.Reply]) -> None:
        self.script = list(script)
        self.calls: list[dict[str, Any]] = []
        self.chunk = 4  # characters per streamed piece

    def complete(
        self,
        ctx: models.CallContext,
        *,
        task: str,
        messages: list[dict[str, Any]],
        override: dict[str, Any] | None = None,
        schema: dict[str, Any] | None = None,
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int = 16000,
        on_text: Callable[[str], None] | None = None,
    ) -> models.Reply:
        call = {
            "ctx": ctx,
            "task": task,
            "messages": copy.deepcopy(messages),
            "override": copy.deepcopy(override),
            "schema": schema,
            "tools": tools,
            "max_tokens": max_tokens,
        }
        self.calls.append(call)
        if not self.script:
            raise AssertionError(f"no scripted reply left for {task}")
        nxt = self.script.pop(0)
        if callable(nxt) and not isinstance(nxt, models.Reply):
            nxt = nxt(call)
        if isinstance(nxt, BaseException):
            raise nxt
        assert isinstance(nxt, models.Reply)
        if on_text and nxt.text:
            for i in range(0, len(nxt.text), self.chunk):
                on_text(nxt.text[i : i + self.chunk])
        return nxt

    def texts(self, n: int) -> str:
        """Every text block of call ``n``'s messages, joined."""
        out = []
        for m in self.calls[n]["messages"]:
            for b in m["content"]:
                if "text" in b:
                    out.append(b["text"])
        return "\n".join(out)

    def images(self, n: int) -> list[dict[str, Any]]:
        return [b for m in self.calls[n]["messages"] for b in m["content"] if "image" in b]


class FakeImages:
    def __init__(self, fail: bool = False) -> None:
        self.paths: list[Path] = []
        self.fail = fail

    def __call__(self, path: Path) -> bytes:
        if self.fail:
            raise ValueError("cannot open")
        assert path.exists(), path
        self.paths.append(path)
        return b"\xff\xd8jpeg:" + path.name.encode()


def services(
    tmp_path: Path, model: FakeModel, *, images: FakeImages | None = None
) -> tuple[Services, FakeDynamo, FakeS3]:
    db, s3 = FakeDynamo(), FakeS3()
    svc = Services(
        store=Store(db, "cf-test"),
        s3=s3,
        bucket="media",
        model=model,
        to_model_image=images or FakeImages(),
        catalog=engine.engine_catalog,
        work_dir=tmp_path / "work",
        heartbeat_s=30.0,
        stream_every_s=0.5,
    )
    return svc, db, s3


def task_item(
    task_id: str, kind: str, *, status: str = "queued", session: str = "cfstory-s1", **extra: Any
) -> dict[str, Any]:
    return {
        "pk": PK,
        "sk": f"TASK#{task_id}",
        "type": "ws_task",
        "userId": USER,
        "workspaceId": WS,
        "taskId": task_id,
        "kind": kind,
        "status": status,
        "sessionId": session,
        "heartbeatAt": "2026-11-21T18:00:00.000Z",
        "model": None,
        "effort": None,
        "effortApplied": None,
        "result": None,
        "createdAt": "2026-11-21T18:00:00.000Z",
        "updatedAt": "2026-11-21T18:00:00.000Z",
        **extra,
    }


def character_item(char_id: str, name: str, **extra: Any) -> dict[str, Any]:
    return {
        "pk": PK,
        "sk": f"CHAR#{char_id}",
        "type": "ws_character",
        "userId": USER,
        "workspaceId": WS,
        "characterId": char_id,
        "name": name,
        "personality": f"{name} is cheerful and a bit clumsy.",
        "traits": ["curious"],
        "movementStyle": "bouncy",
        "expressions": ["neutral", "happy", "surprised"],
        **extra,
    }


def idea_item(idea_id: str, **extra: Any) -> dict[str, Any]:
    return {
        "pk": PK,
        "sk": f"IDEA#{idea_id}",
        "type": "ws_idea",
        "userId": USER,
        "workspaceId": WS,
        "ideaId": idea_id,
        "title": "The great sandwich chase",
        "logline": "Bo drops a sandwich and chases it down a hill.",
        "category": "comedy",
        "characterIds": [],
        "status": "saved",
        "safetyTopicId": None,
        "needsGuidance": False,
        "storyIds": [],
        "createdAt": "2026-11-21T17:00:00.000Z",
        "updatedAt": "2026-11-21T17:00:00.000Z",
        **extra,
    }


def good_character(name: str = "Pip") -> dict[str, Any]:
    return {
        "name": name,
        "description": "A small round driver with a big red scarf.",
        "personality": "Careful, cheerful, a bit nervous on ice.",
        "traits": ["careful", "cheerful"],
        "movementStyle": "bouncy",
        "expressions": ["neutral", "happy", "scared", "relieved"],
        "look": {
            "body": "round",
            "skin": "#F2C9A0",
            "height": 1.0,
            "width": 1.3,
            "hair": {"style": "curly", "color": "#3b2a1a"},
            "eyes": {"shape": "round", "color": "#222244"},
            "brows": "thick",
            "nose": "button",
            "mouth": "wide",
            "outfit": {"top": "#d33f3f", "bottom": "#334455", "accent": "#ffcc00", "pattern": "stripes"},
            "accessory": "scarf",
            "outline": "#1c1842",
        },
        "voice": {"style": "babble", "pitch": 1.4, "noises": ["gasp", "yay", "phew"], "sfx": ["boing"]},
    }


# --- the store and the fake agree ------------------------------------------------------------------------------


def test_store_conditions_updates_and_transactions_on_the_fake() -> None:
    db = FakeDynamo()
    store = Store(db, "t")
    db.seed({"pk": PK, "sk": "TASK#1", "status": "queued", "sessionId": "s1", "n": 1})
    ok = store.update(
        PK,
        "TASK#1",
        Expr()
        .set({"status": "running", "x": 1.5})
        .exists()
        .eq("sessionId", "s1")
        .is_in("status", ["queued", "running"]),
    )
    assert ok and db.get(PK, "TASK#1")["status"] == "running" and db.get(PK, "TASK#1")["x"] == 1.5
    assert not store.update(PK, "TASK#1", Expr().set({"status": "done"}).exists().eq("sessionId", "other"))
    assert db.get(PK, "TASK#1")["status"] == "running"
    assert store.update(PK, "TASK#1", Expr().remove(["x"]).add("n", 2).exists())
    assert "x" not in db.get(PK, "TASK#1") and db.get(PK, "TASK#1")["n"] == 3
    assert store.put_new({"pk": PK, "sk": "MEM#1", "text": "hi"})
    assert not store.put_new({"pk": PK, "sk": "MEM#1", "text": "again"})
    check = Expr().exists().eq("sessionId", "nope")
    assert not store.transact([("put", PK, "MEM#2", {"text": "x"}), ("check", PK, "TASK#1", check)])
    assert db.get(PK, "MEM#2") is None
    good = Expr().exists().eq("sessionId", "s1")
    assert store.transact([("put", PK, "MEM#2", {"text": "x"}), ("check", PK, "TASK#1", good)])
    assert db.get(PK, "MEM#2") == {"pk": PK, "sk": "MEM#2", "text": "x"}


def test_store_query_reads_every_page_and_newest_first() -> None:
    db = FakeDynamo()
    store = Store(db, "t")
    for i in range(7):
        db.seed({"pk": PK, "sk": f"MEM#{i:02d}", "i": i})
    db.seed({"pk": "USER#u-1", "sk": "MEM#99", "i": 99})  # Lamo Clips' partition is never read
    orig = db.query
    db.query = lambda **p: orig(**{**p, "Limit": 3})  # type: ignore[method-assign]
    assert [m["i"] for m in store.query(PK, "MEM#")] == list(range(7))
    assert [m["i"] for m in store.query(PK, "MEM#", newest_first=True, limit=2)] == [6, 5]


def test_condition_check_carries_only_its_own_names() -> None:
    e = Expr().set({"a": 1}).exists().eq("sessionId", "s")
    params = e.params(with_update=False)
    assert "UpdateExpression" not in params
    assert set(params["ExpressionAttributeNames"].values()) == {"pk", "sessionId"}
    assert list(params["ExpressionAttributeValues"]) == [":v1"]


def test_plain_names_only() -> None:
    with pytest.raises(ValueError):
        Expr().set({"a.b": 1})
