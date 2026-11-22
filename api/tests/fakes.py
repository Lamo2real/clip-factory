"""In-memory stand-ins for the boto3 clients the Lambdas use. No network, no moto.

``FakeTable`` understands exactly the expression shapes ``db.Store`` builds, so the real ``Store`` code runs in
every test.
"""

from __future__ import annotations

import copy
import io
import json
import re
from decimal import Decimal
from typing import Any

from botocore.exceptions import ClientError


def client_error(code: str, status: int = 400) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": code}, "ResponseMetadata": {"HTTPStatusCode": status}}, "op")


def _sort_key(item: dict[str, Any], name: str) -> str:
    return str(item.get(name, ""))


class _FakeTableClient:
    """``Table.meta.client``: the high-level DynamoDB client (Python types in and out, like boto3's resource client)."""

    def __init__(self, table: FakeTable) -> None:
        self._table = table
        self.fail_transact = False

    def transact_write_items(self, TransactItems: list[dict[str, Any]]) -> dict[str, Any]:
        table = self._table
        table.calls.append(("transact_write_items", {"TransactItems": TransactItems}))
        assert len(TransactItems) <= 100
        if self.fail_transact:
            raise client_error("InternalServerError", 500)
        snapshot = copy.deepcopy(table.items)
        try:
            for action in TransactItems:
                ((kind, request),) = action.items()
                body = dict(request)
                assert body.pop("TableName", table.name) == table.name
                if kind == "Put":
                    table.put_item(**body)
                elif kind == "Update":
                    table.update_item(**body)
                else:
                    raise AssertionError(kind)
        except ClientError:
            table.items = snapshot
            raise client_error("TransactionCanceledException") from None
        return {}

    def batch_get_item(self, RequestItems: dict[str, Any]) -> dict[str, Any]:
        table = self._table
        table.calls.append(("batch_get_item", {"RequestItems": RequestItems}))
        request = RequestItems[table.name]
        assert len(request["Keys"]) <= 100
        found = [
            copy.deepcopy(table.items[(k["pk"], k["sk"])]) for k in request["Keys"] if (k["pk"], k["sk"]) in table.items
        ]
        return {"Responses": {table.name: found}, "UnprocessedKeys": {}}


class _Meta:
    def __init__(self, client: _FakeTableClient) -> None:
        self.client = client


class FakeTable:
    name = "cf-prod-data"

    def __init__(self) -> None:
        self.items: dict[tuple[str, str], dict[str, Any]] = {}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.meta = _Meta(_FakeTableClient(self))
        self.fail_queries = False
        self.page_size: int | None = None  # set to force pagination in tests

    # helpers for tests
    def all(self) -> list[dict[str, Any]]:
        return [copy.deepcopy(v) for v in self.items.values()]

    def raw(self, pk: str, sk: str) -> dict[str, Any] | None:
        return self.items.get((pk, sk))

    # boto3 Table API
    def get_item(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("get_item", kw))
        item = self.items.get((kw["Key"]["pk"], kw["Key"]["sk"]))
        return {"Item": copy.deepcopy(item)} if item else {}

    def put_item(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("put_item", kw))
        item = kw["Item"]
        for value in _walk(item):
            assert not isinstance(value, float), "floats must be stored as Decimal"
        key = (item["pk"], item["sk"])
        condition = kw.get("ConditionExpression")
        if condition and not evaluate(
            condition,
            self.items.get(key),
            kw.get("ExpressionAttributeNames", {}),
            kw.get("ExpressionAttributeValues", {}),
        ):
            raise client_error("ConditionalCheckFailedException")
        self.items[key] = copy.deepcopy(item)
        return {}

    def delete_item(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("delete_item", kw))
        key = (kw["Key"]["pk"], kw["Key"]["sk"])
        condition = kw.get("ConditionExpression")
        if condition and not evaluate(
            condition,
            self.items.get(key),
            kw.get("ExpressionAttributeNames", {}),
            kw.get("ExpressionAttributeValues", {}),
        ):
            raise client_error("ConditionalCheckFailedException")
        old = self.items.pop(key, None)
        if kw.get("ReturnValues") == "ALL_OLD" and old is not None:
            return {"Attributes": copy.deepcopy(old)}
        return {}

    def update_item(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("update_item", kw))
        key = (kw["Key"]["pk"], kw["Key"]["sk"])
        names = kw.get("ExpressionAttributeNames", {})
        values = kw.get("ExpressionAttributeValues", {})
        for value in _walk(values):
            assert not isinstance(value, float), "floats must be stored as Decimal"
        current = self.items.get(key)
        condition = kw.get("ConditionExpression")
        if condition and not evaluate(condition, current, names, values):
            raise client_error("ConditionalCheckFailedException")
        target = copy.deepcopy(current) if current is not None else {"pk": key[0], "sk": key[1]}
        apply_update(kw["UpdateExpression"], target, names, values)
        self.items[key] = target
        return {"Attributes": copy.deepcopy(target)}

    def query(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("query", kw))
        if self.fail_queries:
            raise client_error("ProvisionedThroughputExceededException", 400)
        index = kw.get("IndexName")
        pk_name, sk_name = INDEX_KEYS[index]
        expression = kw["KeyConditionExpression"]
        assert expression.split(" ", 1)[0] == pk_name, expression
        assert not (kw.get("ConsistentRead") and index), "GSIs do not support ConsistentRead"
        values = kw["ExpressionAttributeValues"]
        names = kw.get("ExpressionAttributeNames", {})
        matches = [
            i for i in self.items.values() if pk_name in i and sk_name in i and evaluate(expression, i, names, values)
        ]
        if "FilterExpression" in kw:
            matches = [i for i in matches if evaluate(kw["FilterExpression"], i, names, values)]
        matches.sort(key=lambda i: (_sort_key(i, sk_name), i["pk"], i["sk"]), reverse=not kw["ScanIndexForward"])
        start = kw.get("ExclusiveStartKey")
        if start:
            marker = (start[sk_name], start["pk"], start["sk"])
            idx = next(n for n, i in enumerate(matches) if (_sort_key(i, sk_name), i["pk"], i["sk"]) == marker)
            matches = matches[idx + 1 :]
        limit = kw.get("Limit") or self.page_size
        out: dict[str, Any] = {}
        if limit and len(matches) > limit:
            matches = matches[:limit]
            last = matches[-1]
            out["LastEvaluatedKey"] = {k: last[k] for k in {"pk", "sk", pk_name, sk_name}}
        out["Items"] = copy.deepcopy(matches)
        return out


INDEX_KEYS: dict[str | None, tuple[str, str]] = {
    None: ("pk", "sk"),
    "gsi1": ("gsi1pk", "gsi1sk"),
    "gsi2": ("gsi2pk", "gsi2sk"),
}


# --- a small DynamoDB expression engine (conditions, key conditions, updates) ---------------------------------------

_TOKEN = re.compile(r"\s*(#\w+|:\w+|<>|<=|>=|[()=<>,+-]|[A-Za-z_][\w.]*)")
_MISSING = object()


def _tokens(text: str) -> list[str]:
    out: list[str] = []
    pos = 0
    text = text.strip()
    while pos < len(text):
        m = _TOKEN.match(text, pos)
        assert m, f"cannot parse expression at {text[pos:]!r}"
        out.append(m.group(1))
        pos = m.end()
        while pos < len(text) and text[pos].isspace():
            pos += 1
    return out


class _Eval:
    def __init__(self, text: str, item: dict[str, Any] | None, names: dict[str, str], values: dict[str, Any]) -> None:
        self.toks = _tokens(text)
        self.i = 0
        self.item = item or {}
        self.names = names
        self.values = values

    def peek(self) -> str | None:
        return self.toks[self.i] if self.i < len(self.toks) else None

    def take(self, expected: str | None = None) -> str:
        tok = self.toks[self.i]
        if expected is not None:
            assert tok.upper() == expected, f"expected {expected}, got {tok}"
        self.i += 1
        return tok

    def run(self) -> bool:
        result = self.or_expr()
        assert self.peek() is None, f"trailing tokens: {self.toks[self.i :]}"
        return result

    def or_expr(self) -> bool:
        result = self.and_expr()
        while (self.peek() or "").upper() == "OR":
            self.take()
            right = self.and_expr()
            result = result or right
        return result

    def and_expr(self) -> bool:
        result = self.not_expr()
        while (self.peek() or "").upper() == "AND":
            self.take()
            right = self.not_expr()
            result = result and right
        return result

    def not_expr(self) -> bool:
        if (self.peek() or "").upper() == "NOT":
            self.take()
            return not self.not_expr()
        return self.primary()

    def name(self, tok: str) -> str:
        return self.names[tok] if tok.startswith("#") else tok

    def operand(self) -> Any:
        tok = self.take()
        if tok.startswith(":"):
            return self.values[tok]
        return self.item.get(self.name(tok), _MISSING)

    def primary(self) -> bool:
        tok = self.peek()
        assert tok is not None
        if tok == "(":
            self.take()
            result = self.or_expr()
            self.take(")")
            return result
        lowered = tok.lower()
        if lowered in {"attribute_exists", "attribute_not_exists"}:
            self.take()
            self.take("(")
            path = self.name(self.take())
            self.take(")")
            present = path in self.item
            return present if lowered == "attribute_exists" else not present
        if lowered == "begins_with":
            self.take()
            self.take("(")
            left = self.operand()
            self.take(",")
            right = self.operand()
            self.take(")")
            if right == "":
                # Real DynamoDB answers ValidationException for an empty key-attribute value.
                raise client_error("ValidationException", 400)
            return isinstance(left, str) and left.startswith(right)
        left = self.operand()
        op = self.take()
        if op.upper() == "IN":
            self.take("(")
            options = [self.operand()]
            while self.peek() == ",":
                self.take()
                options.append(self.operand())
            self.take(")")
            return left is not _MISSING and left in options
        if op.upper() == "BETWEEN":
            low = self.operand()
            self.take("AND")
            high = self.operand()
            return left is not _MISSING and low <= left <= high
        right = self.operand()
        if left is _MISSING or right is _MISSING:
            return op == "<>" and (left is _MISSING) != (right is _MISSING)
        if op == "=":
            return bool(left == right)
        if op == "<>":
            return bool(left != right)
        if type(left) is not type(right) and not (_is_num(left) and _is_num(right)):
            return False
        return bool({"<": left < right, "<=": left <= right, ">": left > right, ">=": left >= right}[op])


def _is_num(v: Any) -> bool:
    return isinstance(v, int | Decimal) and not isinstance(v, bool)


def evaluate(text: str, item: dict[str, Any] | None, names: dict[str, str], values: dict[str, Any]) -> bool:
    return _Eval(text, item, names, values).run()


def _split_top(text: str) -> list[str]:
    parts, depth, current = [], 0, ""
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(current.strip())
            current = ""
        else:
            current += ch
    if current.strip():
        parts.append(current.strip())
    return parts


def apply_update(expression: str, item: dict[str, Any], names: dict[str, str], values: dict[str, Any]) -> None:
    clauses = re.split(r"\b(SET|REMOVE|ADD|DELETE)\b", expression)
    assert clauses[0].strip() == "", expression

    def name(tok: str) -> str:
        return names[tok.strip()] if tok.strip().startswith("#") else tok.strip()

    def value(tok: str) -> Any:
        tok = tok.strip()
        if tok.startswith(":"):
            return copy.deepcopy(values[tok])
        m = re.fullmatch(r"if_not_exists\((\S+?),\s*(\S+?)\)", tok)
        if m:
            current = item.get(name(m.group(1)), _MISSING)
            return copy.deepcopy(current) if current is not _MISSING else value(m.group(2))
        m = re.fullmatch(r"(.+?)\s*([+-])\s*(.+)", tok)
        if m:
            left, right = value(m.group(1)), value(m.group(3))
            return left + right if m.group(2) == "+" else left - right
        found = item.get(name(tok), _MISSING)
        assert found is not _MISSING, f"{tok} is not set"
        return copy.deepcopy(found)

    for keyword, body in zip(clauses[1::2], clauses[2::2], strict=True):
        for part in _split_top(body):
            if keyword == "SET":
                target, expr = part.split("=", 1)
                if "." in target:  # a map key: "#w.#n" (DynamoDB needs the map to exist already)
                    parent, child = target.strip().split(".", 1)
                    holder = item.get(name(parent))
                    assert isinstance(holder, dict), f"{parent} is not a map"
                    holder[name(child)] = value(expr)
                else:
                    item[name(target)] = value(expr)
            elif keyword == "REMOVE":
                item.pop(name(part), None)
            elif keyword == "ADD":
                target, operand = part.split()
                add = copy.deepcopy(values[operand])
                current = item.get(name(target))
                if isinstance(add, set):
                    item[name(target)] = (current or set()) | add
                else:
                    item[name(target)] = (current or 0) + add
            else:  # DELETE from a set
                target, operand = part.split()
                current = item.get(name(target)) or set()
                item[name(target)] = current - values[operand]
                if not item[name(target)]:
                    item.pop(name(target))


def _walk(value: Any) -> Any:
    if isinstance(value, dict):
        for v in value.values():
            yield from _walk(v)
    elif isinstance(value, list):
        for v in value:
            yield from _walk(v)
    else:
        yield value


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.presigned: list[tuple[str, dict[str, Any], int]] = []
        self.deleted: list[str] = []
        self.reads: list[str] = []
        self.put_types: dict[str, str] = {}
        self.read_errors: dict[str, list[Exception]] = {}  # key -> errors raised by the next get_object calls
        self.puts: list[dict[str, Any]] = []
        self.multipart: dict[str, dict[str, Any]] = {}

    def generate_presigned_url(self, op: str, Params: dict[str, Any], ExpiresIn: int) -> str:
        self.presigned.append((op, Params, ExpiresIn))
        return f"https://{Params['Bucket']}.s3.eu-north-1.amazonaws.com/{Params['Key']}?op={op}&X-Amz-Signature=fake"

    def head_object(self, Bucket: str, Key: str) -> dict[str, Any]:
        if Key not in self.objects:
            raise client_error("404", 404)
        return {"ContentLength": len(self.objects[Key])}

    def put_object(self, **kw: Any) -> dict[str, Any]:
        self.puts.append({k: v for k, v in kw.items() if k != "Body"})
        self.objects[kw["Key"]] = bytes(kw["Body"])
        if "ContentType" in kw:
            self.put_types[kw["Key"]] = kw["ContentType"]
        return {}

    def get_object(self, Bucket: str, Key: str) -> dict[str, Any]:
        self.reads.append(Key)
        pending = self.read_errors.get(Key)
        if pending:
            raise pending.pop(0)
        if Key not in self.objects:
            raise client_error("NoSuchKey", 404)
        return {"Body": io.BytesIO(self.objects[Key])}

    def delete_object(self, Bucket: str, Key: str) -> dict[str, Any]:
        self.objects.pop(Key, None)
        self.deleted.append(Key)
        return {}

    # Multipart (docs/CONTRACTS.md §35.3): parts are "sent" by the test through ``send_part``.
    def create_multipart_upload(self, Bucket: str, Key: str, ContentType: str) -> dict[str, Any]:
        upload_id = f"up-{len(self.multipart) + 1}"
        self.multipart[upload_id] = {"key": Key, "parts": {}, "aborted": False}
        return {"UploadId": upload_id}

    def send_part(self, upload_id: str, n: int, body: bytes) -> str:
        etag = f'"etag-{upload_id}-{n}"'
        self.multipart[upload_id]["parts"][n] = (etag, body)
        return etag

    def complete_multipart_upload(self, Bucket: str, Key: str, UploadId: str, MultipartUpload: Any) -> dict[str, Any]:
        up = self.multipart.get(UploadId)
        if up is None or up["aborted"] or up["key"] != Key:
            raise client_error("NoSuchUpload", 404)
        body = b""
        for p in MultipartUpload["Parts"]:
            etag, data = up["parts"][p["PartNumber"]]
            if etag != p["ETag"]:
                raise client_error("InvalidPart", 400)
            body += data
        self.objects[Key] = body
        return {}

    def abort_multipart_upload(self, Bucket: str, Key: str, UploadId: str) -> dict[str, Any]:
        up = self.multipart.get(UploadId)
        if up is None:
            raise client_error("NoSuchUpload", 404)
        up["aborted"] = True
        return {}

    def list_objects_v2(self, Bucket: str, Prefix: str, **_: Any) -> dict[str, Any]:
        return {"Contents": [{"Key": k} for k in sorted(self.objects) if k.startswith(Prefix)], "IsTruncated": False}

    def delete_objects(self, Bucket: str, Delete: dict[str, Any]) -> dict[str, Any]:
        for obj in Delete["Objects"]:
            self.delete_object(Bucket, obj["Key"])
        return {}


class FakeAgentCore:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.stopped: list[str] = []
        self.live_sessions: set[str] | None = None  # None: every session exists
        self.fail = False
        self.reply: dict[str, Any] | None = None

    def stop_runtime_session(self, **kw: Any) -> dict[str, Any]:
        if self.fail:
            raise client_error("ServiceUnavailableException", 503)
        if self.live_sessions is not None and kw["runtimeSessionId"] not in self.live_sessions:
            raise client_error("ResourceNotFoundException", 404)
        self.stopped.append(kw["runtimeSessionId"])
        return {"runtimeSessionId": kw["runtimeSessionId"]}

    def invoke_agent_runtime(self, **kw: Any) -> dict[str, Any]:
        self.calls.append({**kw, "payload": json.loads(kw["payload"])})
        if self.fail:
            raise client_error("ServiceUnavailableException", 503)
        payload = self.calls[-1]["payload"]
        reply = self.reply if self.reply is not None else {"accepted": True, "jobId": payload.get("jobId")}
        return {"statusCode": 200, "response": io.BytesIO(json.dumps(reply).encode())}


class FakeBedrock:
    """Answers like Claude Fable 5.1 on Converse: a reasoning block first (thinking is always on), then the text."""

    def __init__(
        self, text: str = "Rage moments with a face-cam hook get the most shares.", stop_reason: str = "end_turn"
    ) -> None:
        self.text = text
        self.stop_reason = stop_reason
        self.calls: list[dict[str, Any]] = []
        self.fail = False

    def converse(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(kw)
        if self.fail:
            raise client_error("ThrottlingException", 429)
        content: list[dict[str, Any]] = [{"reasoningContent": {"reasoningText": {"text": "Comparing the posts..."}}}]
        if self.text:
            content.append({"text": self.text})
        return {"output": {"message": {"role": "assistant", "content": content}}, "stopReason": self.stop_reason}


def decimal_free(value: Any) -> bool:
    return not any(isinstance(v, Decimal) for v in _walk(value))


# --- durable flows -------------------------------------------------------------------------------------------------


class FakeLambda:
    """The plain Lambda client the API starts durable executions with (Invoke on the alias)."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.started: dict[str, str] = {}  # execution name -> payload
        self.fail = False
        self.callbacks: list[tuple[str, dict[str, Any]]] = []  # the job flow's callbacks the API sent (§35)
        self.closed_callbacks: set[str] = set()

    def send_durable_execution_callback_success(self, **kw: Any) -> dict[str, Any]:
        return self._callback("success", kw)

    def send_durable_execution_callback_failure(self, **kw: Any) -> dict[str, Any]:
        return self._callback("failure", kw)

    def _callback(self, kind: str, kw: dict[str, Any]) -> dict[str, Any]:
        if kw["CallbackId"] in self.closed_callbacks:
            raise client_error("ResourceNotFoundException", 404)
        self.callbacks.append((kind, kw))
        return {}

    def invoke(self, **kw: Any) -> dict[str, Any]:
        payload = kw["Payload"].decode() if isinstance(kw["Payload"], bytes) else kw["Payload"]
        self.calls.append({**kw, "Payload": payload, "payload": json.loads(payload)})
        if self.fail:
            raise client_error("ServiceException", 500)
        if "DurableExecutionName" not in kw:  # a plain async Invoke (cf-prod-stats, cf-prod-learn)
            assert kw["InvocationType"] == "Event"
            return {"StatusCode": 202}
        name = kw["DurableExecutionName"]
        if name in self.started and self.started[name] != payload:
            raise client_error("DurableExecutionAlreadyStartedException", 409)
        existed = name in self.started
        self.started[name] = payload
        out: dict[str, Any] = {"StatusCode": 202}
        if not existed:
            out["DurableExecutionArn"] = f"{kw['FunctionName'].rsplit(':', 1)[0]}:1/durable-execution/{name}/x"
        return out


class FakeCallback:
    def __init__(self, result: Any = None, error: BaseException | None = None) -> None:
        self.callback_id = "cb-123"
        self.operation_id = "op-1"
        self._result = result
        self._error = error
        self.waited = 0

    def result(self) -> Any:
        self.waited += 1
        if self._error is not None:
            raise self._error
        return self._result


class FakeDurableContext:
    """Stands in for ``DurableContext``: ``step`` runs at once (applying the step's retry strategy, without sleeping)
    and records its name; ``wait`` records the duration; ``create_callback`` returns ``callback``.

    ``replay`` names steps whose function runs twice, like an attempt that was interrupted after its work but before
    its checkpoint (steps are at-least-once).
    """

    def __init__(
        self,
        callback: FakeCallback | None = None,
        replay: set[str] | None = None,
        then: list[FakeCallback] | None = None,
    ) -> None:
        self.callback = callback or FakeCallback(result=json.dumps({"jobId": "x", "clipCount": 0}))
        self.then = list(then or [])  # the callbacks of later attempts (a resumed job), in order
        self.steps: list[str] = []
        self.attempts: dict[str, int] = {}
        self.configs: dict[str, Any] = {}
        self.waits: list[tuple[str | None, int]] = []
        self.callbacks: list[tuple[str | None, Any]] = []
        self.results: dict[str, Any] = {}
        self.replay = replay or set()

    def create_callback(self, name: str | None = None, config: Any = None) -> FakeCallback:
        self.callbacks.append((name, config))
        if len(self.callbacks) > 1 and self.then:
            self.callback = self.then.pop(0)
        return self.callback

    def wait(self, duration: Any, name: str | None = None) -> None:
        self.waits.append((name, duration.to_seconds()))

    def step(self, func: Any, name: str | None = None, config: Any = None) -> Any:
        from aws_durable_execution_sdk_python import StepError

        assert name, "every step has a contract name"
        assert name not in self.steps, f"step name used twice: {name}"
        self.steps.append(name)
        self.configs[name] = config
        attempt = 0
        while True:
            attempt += 1
            self.attempts[name] = attempt
            try:
                if name in self.replay:
                    func(None)
                result = func(None)
            except Exception as e:
                strategy = getattr(config, "retry_strategy", None)
                if strategy is not None and strategy(e, attempt).should_retry:
                    continue
                raise StepError(message=str(e), error_type=type(e).__name__) from None
            # Checkpoints are JSON: a step result must survive the round trip unchanged.
            assert json.loads(json.dumps(result)) == result, f"{name} returned a non-JSON result"
            self.results[name] = result
            return result


# --- vectors, embeddings, WebSocket, SSM ----------------------------------------------------------------------------


class FakeS3Vectors:
    def __init__(self) -> None:
        self.vectors: dict[str, dict[str, Any]] = {}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.query_result: list[dict[str, Any]] | None = None
        self.fail = False

    def _check(self, op: str, kw: dict[str, Any]) -> None:
        self.calls.append((op, kw))
        assert kw["vectorBucketName"] == "cf-prod-vectors-123"
        assert kw["indexName"] == "clips"
        if self.fail:
            raise client_error("ServiceUnavailableException", 503)

    def put_vectors(self, **kw: Any) -> dict[str, Any]:
        self._check("put_vectors", kw)
        assert len(kw["vectors"]) <= 500
        for v in kw["vectors"]:
            assert len(v["data"]["float32"]) == 1024
            assert all(isinstance(x, float) for x in v["data"]["float32"])
            filterable = {
                k: v["metadata"][k] for k in v["metadata"] if k not in {"hook", "title", "summary", "performance"}
            }
            assert len(json.dumps(filterable)) < 2048
            self.vectors[v["key"]] = copy.deepcopy(v)
        return {}

    def get_vectors(self, **kw: Any) -> dict[str, Any]:
        self._check("get_vectors", kw)
        out = []
        for key in kw["keys"]:
            if key in self.vectors:
                v: dict[str, Any] = {"key": key}
                if kw.get("returnData"):
                    v["data"] = copy.deepcopy(self.vectors[key]["data"])
                if kw.get("returnMetadata"):
                    v["metadata"] = copy.deepcopy(self.vectors[key]["metadata"])
                out.append(v)
        return {"vectors": out}

    def delete_vectors(self, **kw: Any) -> dict[str, Any]:
        self._check("delete_vectors", kw)
        for key in kw["keys"]:
            self.vectors.pop(key, None)
        return {}

    def query_vectors(self, **kw: Any) -> dict[str, Any]:
        self._check("query_vectors", kw)
        if self.query_result is not None:
            return {"vectors": copy.deepcopy(self.query_result)}
        clauses = kw.get("filter", {}).get("$and", [])
        wanted = {k: c["$eq"] for clause in clauses for k, c in clause.items()}
        hits = []
        for key, v in self.vectors.items():
            if all(v["metadata"].get(k) == value for k, value in wanted.items()):
                hits.append(
                    {"key": key, "distance": float(v.get("distance", 0.1)), "metadata": copy.deepcopy(v["metadata"])}
                )
        hits.sort(key=lambda h: h["distance"])
        return {"vectors": hits[: kw["topK"]]}


class FakeEmbeddings:
    """``bedrock-runtime`` InvokeModel for Titan Text Embeddings V2."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def invoke_model(self, **kw: Any) -> dict[str, Any]:
        self.calls.append({**kw, "body": json.loads(kw["body"])})
        return {"body": io.BytesIO(json.dumps({"embedding": [0.01] * 1024, "inputTextTokenCount": 3}).encode())}


class GoneException(Exception):
    pass


class FakeManagement:
    """``apigatewaymanagementapi``: PostToConnection."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, dict[str, Any]]] = []
        self.gone: set[str] = set()
        self.broken: set[str] = set()

    def post_to_connection(self, ConnectionId: str, Data: bytes) -> dict[str, Any]:
        if ConnectionId in self.gone:
            raise client_error("GoneException", 410)
        if ConnectionId in self.broken:
            raise client_error("LimitExceededException", 429)
        self.sent.append((ConnectionId, json.loads(Data.decode("utf-8"))))
        return {}


class FakeSSM:
    def __init__(self, value: str = "verify-me-123") -> None:
        self.value = value
        self.calls: list[dict[str, Any]] = []

    def get_parameter(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(kw)
        return {"Parameter": {"Name": kw["Name"], "Value": self.value}}


# --- platform HTTP ---------------------------------------------------------------------------------------------------

FIXTURES = __import__("pathlib").Path(__file__).parent / "fixtures"
STATS_FIXTURES = FIXTURES / "stats"


def stats_fixture(name: str) -> bytes:
    """``"youtube_videos_list"`` → fixtures/stats/…; ``"publish/youtube_processed"`` → fixtures/publish/…"""
    folder = FIXTURES if "/" in name else STATS_FIXTURES
    return (folder / f"{name}.json").read_bytes()


class FakeHttp:
    """An ``HttpClient`` that answers with recorded responses, in order, and records every request.

    Each answer is ``(status, body)`` or ``(status, body, headers)``; ``body`` is a fixture name, a dict or bytes.
    An answer may also be an exception instance, which is raised (a network error)."""

    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.calls: list[Any] = []

    def __call__(self, request: Any) -> Any:
        from clipfactory_api.platforms import HttpResponse

        self.calls.append(request)
        assert self.answers, f"unexpected request: {request.method} {request.url}"
        answer = self.answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        status, body, *rest = answer
        headers = {k.lower(): v for k, v in (rest[0] if rest else {}).items()}
        if isinstance(body, str):
            raw = stats_fixture(body)
        elif isinstance(body, bytes):
            raw = body
        else:
            raw = json.dumps(body).encode()
        return HttpResponse(status, headers, raw)

    @property
    def urls(self) -> list[str]:
        return [c.url for c in self.calls]


# --- Secrets Manager, CloudFront ----------------------------------------------------------------------------------


class FakeSecretsManager:
    """``secretsmanager``: GetSecretValue, CreateSecret, PutSecretValue, DeleteSecret (names → strings)."""

    def __init__(self, values: dict[str, str] | None = None) -> None:
        self.values: dict[str, str] = dict(values or {})
        self.tags: dict[str, list[dict[str, str]]] = {}
        self.calls: list[tuple[str, str]] = []
        self.writes: list[tuple[str, str]] = []  # (op, name) in order

    def json(self, name: str) -> Any:
        return json.loads(self.values[name]) if name in self.values else None

    # Versions (§38.9, additive): every write gets a VersionId; a read can ask for one version. A name in
    # ``scheduled`` answers create/put with InvalidRequestException (deleted moments ago) that many more times.

    def _version(self, name: str, text: str) -> str:
        self.version_counter = getattr(self, "version_counter", 0) + 1
        version = f"v{self.version_counter}"
        self.versions.setdefault(name, {})[version] = text
        return version

    @property
    def versions(self) -> dict[str, dict[str, str]]:
        if not hasattr(self, "_versions"):
            self._versions: dict[str, dict[str, str]] = {}
        return self._versions

    @property
    def scheduled(self) -> dict[str, int]:
        if not hasattr(self, "_scheduled"):
            self._scheduled: dict[str, int] = {}
        return self._scheduled

    def _check_scheduled(self, name: str) -> None:
        if self.scheduled.get(name, 0) > 0:
            self.scheduled[name] -= 1
            raise client_error("InvalidRequestException", 400)

    def get_secret_value(self, SecretId: str, VersionId: str | None = None) -> dict[str, Any]:
        self.calls.append(("get", SecretId))
        if SecretId not in self.values:
            raise client_error("ResourceNotFoundException", 400)
        if VersionId is not None:
            found = self.versions.get(SecretId, {}).get(VersionId)
            if found is None:
                raise client_error("ResourceNotFoundException", 400)
            return {"Name": SecretId, "SecretString": found, "VersionId": VersionId}
        return {"Name": SecretId, "SecretString": self.values[SecretId]}

    def create_secret(self, Name: str, SecretString: str, Tags: list[dict[str, str]] | None = None) -> dict[str, Any]:
        self.calls.append(("create", Name))
        self._check_scheduled(Name)
        if Name in self.values:
            raise client_error("ResourceExistsException", 400)
        self.values[Name] = SecretString
        self.tags[Name] = list(Tags or [])
        self.writes.append(("create", Name))
        return {"Name": Name, "VersionId": self._version(Name, SecretString)}

    def put_secret_value(self, SecretId: str, SecretString: str) -> dict[str, Any]:
        self.calls.append(("put", SecretId))
        self._check_scheduled(SecretId)
        if SecretId not in self.values:
            raise client_error("ResourceNotFoundException", 400)
        self.values[SecretId] = SecretString
        self.writes.append(("put", SecretId))
        return {"Name": SecretId, "VersionId": self._version(SecretId, SecretString)}

    def delete_secret(self, SecretId: str, ForceDeleteWithoutRecovery: bool = False) -> dict[str, Any]:
        self.calls.append(("delete", SecretId))
        assert ForceDeleteWithoutRecovery is True
        if SecretId not in self.values:
            raise client_error("ResourceNotFoundException", 400)
        del self.values[SecretId]
        self.versions.pop(SecretId, None)
        self.writes.append(("delete", SecretId))
        return {"Name": SecretId}


class FakeCloudFront:
    def __init__(self) -> None:
        self.invalidations: list[dict[str, Any]] = []

    def create_invalidation(self, DistributionId: str, InvalidationBatch: dict[str, Any]) -> dict[str, Any]:
        self.invalidations.append({"DistributionId": DistributionId, **InvalidationBatch})
        return {"Invalidation": {"Id": "I1"}}


class FakeVideo:
    """A ``VideoSource`` of ``size`` bytes (byte ``i`` is ``i % 251``) that records every read."""

    def __init__(self, size: int) -> None:
        self.size = size
        self.reads: list[tuple[int, int]] = []

    def read(self, start: int, end: int) -> bytes:
        self.reads.append((start, end))
        return bytes(i % 251 for i in range(start, min(end, start + 64))) + b"\0" * max(0, end - start - 64)

    def presigned_url(self, seconds: int = 3600) -> str:
        return "https://cf-prod-media-123.s3.eu-north-1.amazonaws.com/jobs/j/clips/c/clip.mp4?X-Amz-Signature=fake"
