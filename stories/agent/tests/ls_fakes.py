"""Fakes for Lamo Stories' agent tests (no AWS, no network): an in-memory DynamoDB table that evaluates the update and
condition expressions the agent writes (data.py's ``Expr``), a fake media bucket, a fake model client (the
``ModelClient`` contract: it records every ``complete`` call) and a fake Bedrock runtime client (for the real
``BedrockModels``). ``test_fakes_*`` check the fakes themselves."""

from __future__ import annotations

import copy
import functools
import json
import re
import shutil
import subprocess
from collections.abc import Callable
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError

from lamostories_agent.data import Expr, StoryData
from lamostories_agent.models import CallContext, Reply

REPO = Path(__file__).resolve().parents[3]
ENGINE_DIR = REPO / "web" / "src" / "stories" / "engine"
SAMPLE = ENGINE_DIR / "fixtures" / "sample-script.json"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
USER, WS = "user-1", "stories"
PK = f"USER#{USER}#WS#{WS}"


def tool(name: str) -> bool:
    return shutil.which(name) is not None


@functools.cache
def _ffmpeg_list(what: str) -> frozenset[str]:
    """The names ``ffmpeg -filters`` or ``ffmpeg -encoders`` lists (an ``ass`` encoder exists without libass, so
    the two lists are kept apart)."""
    if not tool("ffmpeg"):
        return frozenset()
    out = subprocess.run(["ffmpeg", "-hide_banner", what], capture_output=True, text=True, check=False).stdout
    return frozenset(ln.split()[1] for ln in out.splitlines() if len(ln.split()) > 1)


def ffmpeg_has(*, filters: tuple[str, ...] = (), encoders: tuple[str, ...] = ()) -> bool:
    return set(filters) <= _ffmpeg_list("-filters") and set(encoders) <= _ffmpeg_list("-encoders")


def _deno() -> bool:
    from lamostories_agent.engine import deno_binary

    return shutil.which(deno_binary()) is not None or Path(deno_binary()).is_file()


needs_deno = pytest.mark.skipif(not _deno(), reason="the engine CLI needs Deno (the venv has it from the deno wheel)")
_ENCODERS = ("libx264", "aac", "mjpeg")
needs_ffmpeg = pytest.mark.skipif(
    not ffmpeg_has(filters=("loudnorm",), encoders=_ENCODERS), reason="ffmpeg with libx264 is missing"
)
needs_libass = pytest.mark.skipif(
    not ffmpeg_has(filters=("loudnorm", "ass"), encoders=_ENCODERS), reason="ffmpeg has no libass (the ass filter)"
)


def _err(code: str, op: str = "UpdateItem", reasons: list[dict[str, Any]] | None = None) -> ClientError:
    body: dict[str, Any] = {"Error": {"Code": code, "Message": code}}
    if reasons is not None:
        body["CancellationReasons"] = reasons
    return ClientError(body, op)  # type: ignore[arg-type]


def _get(item: dict[str, Any], path: list[str]) -> Any:
    cur: Any = item
    for p in path:
        if not isinstance(cur, dict) or p not in cur:
            return None
        cur = cur[p]
    return cur


def _resolve(token: str, names: dict[str, str]) -> list[str]:
    return [names.get(p, p) for p in token.split(".")]


def condition_ok(item: dict[str, Any] | None, expr: str | None, names: dict[str, str], values: dict[str, Any]) -> bool:
    if not expr:
        return True
    for raw in expr.split(" AND "):
        part = raw.strip()
        if part == "attribute_exists(pk)":
            if item is None:
                return False
        elif part == "attribute_not_exists(pk)":
            if item is not None:
                return False
        else:
            m = re.fullmatch(r"(\S+) (=|<>) (:\w+)", part)
            assert m, f"the fake does not understand {part!r}"
            current = _get(item or {}, _resolve(m.group(1), names))
            want = values[m.group(3)]
            if (current == want) != (m.group(2) == "="):
                return False
    return True


def apply_update(item: dict[str, Any], expr: str, names: dict[str, str], values: dict[str, Any]) -> None:
    sections = re.split(r"\s*\b(SET|REMOVE|ADD)\b\s*", expr)
    pairs = list(zip(sections[1::2], sections[2::2], strict=True))
    for kind, body in pairs:
        for clause in [c.strip() for c in body.split(",") if c.strip()]:
            if kind == "SET":
                left, right = (x.strip() for x in clause.split("=", 1))
                path = _resolve(left, names)
                target = item
                for p in path[:-1]:
                    target = target.setdefault(p, {})
                target[path[-1]] = copy.deepcopy(values[right])
            elif kind == "REMOVE":
                path = _resolve(clause, names)
                target = item
                for p in path[:-1]:
                    target = target.get(p) or {}
                target.pop(path[-1], None)
            else:
                left, right = clause.split()
                path = _resolve(left, names)
                item[path[-1]] = (item.get(path[-1]) or 0) + values[right]


class FakeClient:
    def __init__(self, table: FakeTable) -> None:
        self.table = table

    def transact_write_items(self, TransactItems: list[dict[str, Any]]) -> dict[str, Any]:
        t = self.table
        t.txns.append(copy.deepcopy(TransactItems))
        if t.fail_next_txn:
            t.fail_next_txn -= 1
            raise _err("TransactionCanceledException", "TransactWriteItems", [{"Code": "TransactionConflict"}])
        reasons, ok = [], True
        for op in TransactItems:
            ((kind, body),) = op.items()
            key = body["Key"] if "Key" in body else {"pk": body["Item"]["pk"], "sk": body["Item"]["sk"]}
            item = t.items.get((key["pk"], key["sk"]))
            good = condition_ok(
                item, body.get("ConditionExpression"), body.get("ExpressionAttributeNames") or {},
                body.get("ExpressionAttributeValues") or {},
            )  # fmt: skip
            reasons.append({"Code": "None" if good else "ConditionalCheckFailed"})
            ok = ok and good
        if not ok:
            raise _err("TransactionCanceledException", "TransactWriteItems", reasons)
        for op in TransactItems:
            ((kind, body),) = op.items()
            if kind == "Put":
                t._put(body["Item"])
            elif kind == "Update":
                t._update(body)
            elif kind == "Delete":
                t.items.pop((body["Key"]["pk"], body["Key"]["sk"]), None)
        return {}


class FakeTable:
    """A DynamoDB table in memory, keyed (pk, sk); ``writes`` logs every single-item write, ``txns`` every
    transaction (as sent)."""

    name = "cf-prod-data"

    def __init__(self, page: int = 3) -> None:
        self.items: dict[tuple[str, str], dict[str, Any]] = {}
        self.writes: list[tuple[str, dict[str, Any]]] = []
        self.txns: list[list[dict[str, Any]]] = []
        self.page = page
        self.fail_next_txn = 0
        self.on_update: Callable[[dict[str, Any]], None] | None = None
        self.meta = type("Meta", (), {})()
        self.meta.client = FakeClient(self)

    def seed(self, item: dict[str, Any]) -> None:
        self.items[(item["pk"], item["sk"])] = _ddb(item)

    def item(self, sk: str, pk: str = PK) -> dict[str, Any] | None:
        got = self.items.get((pk, sk))
        return _plain(copy.deepcopy(got)) if got else None

    def prefix(self, prefix: str, pk: str = PK) -> list[dict[str, Any]]:
        return [
            _plain(copy.deepcopy(v)) for (p, s), v in sorted(self.items.items()) if p == pk and s.startswith(prefix)
        ]

    def _put(self, item: dict[str, Any]) -> None:
        self.items[(item["pk"], item["sk"])] = copy.deepcopy(item)

    def _update(self, body: dict[str, Any]) -> None:
        key = body["Key"]
        item = self.items.setdefault((key["pk"], key["sk"]), {"pk": key["pk"], "sk": key["sk"]})
        apply_update(item, body["UpdateExpression"], body.get("ExpressionAttributeNames") or {},
                     body.get("ExpressionAttributeValues") or {})  # fmt: skip

    def get_item(self, Key: dict[str, str], ConsistentRead: bool = False) -> dict[str, Any]:
        got = self.items.get((Key["pk"], Key["sk"]))
        return {"Item": copy.deepcopy(got)} if got else {}

    def query(self, **kw: Any) -> dict[str, Any]:
        assert kw["KeyConditionExpression"] == "pk = :pk AND begins_with(sk, :sk)"
        pk, prefix = kw["ExpressionAttributeValues"][":pk"], kw["ExpressionAttributeValues"][":sk"]
        rows = [v for (p, s), v in sorted(self.items.items()) if p == pk and s.startswith(prefix)]
        start = kw.get("ExclusiveStartKey")
        if start:
            rows = [r for r in rows if r["sk"] > start["sk"]]
        out: dict[str, Any] = {"Items": copy.deepcopy(rows[: self.page])}
        if len(rows) > self.page:
            out["LastEvaluatedKey"] = {"pk": pk, "sk": rows[self.page - 1]["sk"]}
        return out

    def update_item(self, **kw: Any) -> dict[str, Any]:
        self.writes.append(("update", copy.deepcopy(kw)))
        if self.on_update:
            self.on_update(kw)
        key = kw["Key"]
        item = self.items.get((key["pk"], key["sk"]))
        if not condition_ok(item, kw.get("ConditionExpression"), kw.get("ExpressionAttributeNames") or {},
                            kw.get("ExpressionAttributeValues") or {}):  # fmt: skip
            raise _err("ConditionalCheckFailedException")
        self._update(kw)
        return {}

    def put_item(self, **kw: Any) -> dict[str, Any]:
        self.writes.append(("put", copy.deepcopy(kw)))
        self._put(kw["Item"])
        return {}


def _ddb(value: Any) -> Any:
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _ddb(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_ddb(v) for v in value]
    return value


def _plain(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value


class FakeStore:
    """The agent Store's table and S3 helpers, in memory. ``objects`` is the media bucket; ``reads`` every key read."""

    bucket = "media"

    def __init__(self, table: FakeTable | None = None) -> None:
        self.table = table or FakeTable()
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.reads: list[str] = []
        self.deleted: list[str] = []
        self.modified: dict[str, Any] = {}  # key -> LastModified (an aware datetime); now when not set
        self.listed: list[str] = []

    async def upload(self, path: Path, key: str, content_type: str) -> None:
        self.objects[key] = (path.read_bytes(), content_type)

    async def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        self.objects[key] = (data, content_type)

    async def get_bytes(self, key: str) -> bytes:
        self.reads.append(key)
        return self.objects[key][0]

    async def get_json(self, key: str) -> Any:
        return json.loads(await self.get_bytes(key))

    async def download(self, key: str, path: Path) -> None:
        self.reads.append(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.objects[key][0])

    async def delete_keys(self, keys: list[str]) -> None:
        for key in keys:
            self.objects.pop(key, None)
            self.deleted.append(key)

    def get_bytes_sync(self, key: str) -> bytes:
        self.reads.append(key)
        return self.objects[key][0]

    async def list_keys(self, prefix: str) -> list[dict[str, Any]]:
        from datetime import UTC, datetime

        self.listed.append(prefix)
        return [
            {"key": k, "size": len(v[0]), "modified": self.modified.get(k) or datetime.now(UTC)}
            for k, v in sorted(self.objects.items())
            if k.startswith(prefix)
        ]


class FakeModels:
    """A ``ModelClient``: answers ``complete`` from ``answers[task]`` (a dict, a list used in turn, an exception, or
    a function of the call, run in the worker thread as the real client is) and records every call."""

    def __init__(self, answers: dict[str, Any], *, model: str = "opus-5-5", effort: str | None = "high") -> None:
        self.answers = answers
        self.calls: list[dict[str, Any]] = []
        self.model = model
        self.effort = effort

    def complete(self, ctx: CallContext, *, task: str, messages: list[dict[str, Any]], **kw: Any) -> Reply:
        self.calls.append({"ctx": ctx, "task": task, "messages": messages, **kw})
        got = self.answers[task]
        if callable(got) and not isinstance(got, type):
            got = got({"ctx": ctx, "task": task, "messages": messages, **kw})
        elif isinstance(got, list):
            got = got.pop(0) if len(got) > 1 else got[0]
        if isinstance(got, BaseException):
            raise got
        data = copy.deepcopy(got)
        return Reply(text=json.dumps(data), data=data, tool_calls=[], content=[{"text": json.dumps(data)}],
                     stop_reason="end_turn", model=self.model, effort=self.effort, effort_applied=self.effort is not None,
                     usage={"input": 10, "output": 5})  # fmt: skip

    def tasks(self) -> list[str]:
        return [c["task"] for c in self.calls]


class FakeRuntime:
    """A ``bedrock-runtime`` client: records every request body and answers from ``replies`` (each a Converse
    response, an exception, or a function of the request)."""

    def __init__(self, replies: list[Any]) -> None:
        self.replies = list(replies)
        self.requests: list[dict[str, Any]] = []

    def _next(self, body: dict[str, Any]) -> Any:
        self.requests.append(copy.deepcopy(body))
        got = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        if callable(got) and not isinstance(got, type):
            got = got(body)
        if isinstance(got, BaseException):
            raise got
        return copy.deepcopy(got)

    def converse(self, **body: Any) -> dict[str, Any]:
        out: dict[str, Any] = self._next(body)
        return out

    def converse_stream(self, **body: Any) -> dict[str, Any]:
        out: dict[str, Any] = self._next(body)
        return out


def converse_reply(
    text: str = "", *, tool: tuple[str, dict[str, Any]] | None = None, stop: str = "end_turn",
    usage: dict[str, int] | None = None,
) -> dict[str, Any]:  # fmt: skip
    content: list[dict[str, Any]] = [{"text": text}] if text else []
    if tool is not None:
        content.append({"toolUse": {"toolUseId": "tu1", "name": tool[0], "input": tool[1]}})
    return {
        "output": {"message": {"role": "assistant", "content": content}},
        "stopReason": "tool_use" if tool and stop == "end_turn" else stop,
        "usage": usage or {"inputTokens": 100, "outputTokens": 20, "cacheReadInputTokens": 0,
                           "cacheWriteInputTokens": 0},
    }  # fmt: skip


def client_error(code: str, message: str = "", op: str = "Converse") -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": message or code}}, op)  # type: ignore[arg-type]


def data(table: FakeTable | None = None) -> tuple[StoryData, FakeStore]:
    store = FakeStore(table)
    return StoryData(store), store  # type: ignore[arg-type]


# --- the fakes' own checks ---------------------------------------------------------------------------------------


def test_fakes_the_table_evaluates_the_story_expressions() -> None:
    t = FakeTable()
    t.seed({"pk": PK, "sk": "PJOB#J", "sessionId": "S", "status": "running", "meta": {"a": 1}})
    e = Expr().set({"progress": 0.5, "meta.current": 0}).remove(["error"]).add("version", 1)
    e.exists().equals("sessionId", "S").differs("status", "canceled")
    t.update_item(Key={"pk": PK, "sk": "PJOB#J"}, **e.params())
    got = t.item("PJOB#J")
    assert got is not None and got["progress"] == 0.5 and got["meta"] == {"a": 1, "current": 0} and got["version"] == 1
    bad = Expr().set({"x": 1}).exists().equals("sessionId", "OTHER")
    with pytest.raises(ClientError):
        t.update_item(Key={"pk": PK, "sk": "PJOB#J"}, **bad.params())


def test_fakes_a_transaction_is_all_or_nothing() -> None:
    t = FakeTable()
    t.seed({"pk": PK, "sk": "PJOB#J", "sessionId": "S", "status": "canceled"})
    check = Expr().exists().equals("sessionId", "S").differs("status", "canceled")
    ops = [
        {"ConditionCheck": {"TableName": t.name, "Key": {"pk": PK, "sk": "PJOB#J"}, **check.params(update=False)}},
        {"Put": {"TableName": t.name, "Item": {"pk": PK, "sk": "ASSET#A"}}},
    ]
    with pytest.raises(ClientError) as e:
        t.meta.client.transact_write_items(TransactItems=ops)
    assert e.value.response["CancellationReasons"][0]["Code"] == "ConditionalCheckFailed"
    assert t.item("ASSET#A") is None
