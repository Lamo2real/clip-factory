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
        if kw.get("ConditionExpression") == "attribute_not_exists(pk)" and key in self.items:
            raise client_error("ConditionalCheckFailedException")
        self.items[key] = copy.deepcopy(item)
        return {}

    def delete_item(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("delete_item", kw))
        self.items.pop((kw["Key"]["pk"], kw["Key"]["sk"]), None)
        return {}

    def update_item(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("update_item", kw))
        key = (kw["Key"]["pk"], kw["Key"]["sk"])
        names = kw.get("ExpressionAttributeNames", {})
        values = kw.get("ExpressionAttributeValues", {})
        current = self.items.get(key)
        for clause in kw["ConditionExpression"].split(" AND "):
            if clause == "attribute_exists(pk)":
                if current is None:
                    raise client_error("ConditionalCheckFailedException")
                continue
            absent = re.fullmatch(r"attribute_not_exists\((#a\d+)\)", clause)
            if absent:
                if current is not None and names[absent.group(1)] in current:
                    raise client_error("ConditionalCheckFailedException")
                continue
            m = re.fullmatch(r"(#c\d+) IN \((.+)\)", clause)
            assert m, clause
            allowed = [values[p.strip()] for p in m.group(2).split(",")]
            if current is None or current.get(names[m.group(1)]) not in allowed:
                raise client_error("ConditionalCheckFailedException")
        assert current is not None
        expression = kw["UpdateExpression"]
        set_part = re.search(r"SET (.+?)(?: REMOVE |$)", expression)
        remove_part = re.search(r"REMOVE (.+)$", expression)
        if set_part:
            for assignment in set_part.group(1).split(", "):
                name, value = assignment.split(" = ")
                current[names[name]] = copy.deepcopy(values[value])
        if remove_part:
            for name in remove_part.group(1).split(", "):
                current.pop(names[name], None)
        return {"Attributes": copy.deepcopy(current)}

    def query(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("query", kw))
        if self.fail_queries:
            raise client_error("ProvisionedThroughputExceededException", 400)
        m = re.fullmatch(r"(\w+) = :pk AND begins_with\((\w+), :prefix\)", kw["KeyConditionExpression"])
        assert m, kw["KeyConditionExpression"]
        pk_name, sk_name = m.groups()
        assert ("IndexName" in kw) == (pk_name == "gsi1pk")
        assert not (kw.get("ConsistentRead") and "IndexName" in kw), "GSIs do not support ConsistentRead"
        pk, prefix = kw["ExpressionAttributeValues"][":pk"], kw["ExpressionAttributeValues"][":prefix"]
        matches = [
            i for i in self.items.values() if i.get(pk_name) == pk and str(i.get(sk_name, "")).startswith(prefix)
        ]
        matches.sort(key=lambda i: (_sort_key(i, sk_name), i["pk"], i["sk"]), reverse=not kw["ScanIndexForward"])
        start = kw.get("ExclusiveStartKey")
        if start:
            marker = (start[sk_name], start["pk"], start["sk"])
            idx = next(n for n, i in enumerate(matches) if (_sort_key(i, sk_name), i["pk"], i["sk"]) == marker)
            matches = matches[idx + 1 :]
        limit = kw.get("Limit")
        out: dict[str, Any] = {}
        if limit and len(matches) > limit:
            matches = matches[:limit]
            last = matches[-1]
            out["LastEvaluatedKey"] = {k: last[k] for k in {"pk", "sk", pk_name, sk_name}}
        out["Items"] = copy.deepcopy(matches)
        return out


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

    def generate_presigned_url(self, op: str, Params: dict[str, Any], ExpiresIn: int) -> str:
        self.presigned.append((op, Params, ExpiresIn))
        return f"https://{Params['Bucket']}.s3.eu-north-1.amazonaws.com/{Params['Key']}?op={op}&X-Amz-Signature=fake"

    def head_object(self, Bucket: str, Key: str) -> dict[str, Any]:
        if Key not in self.objects:
            raise client_error("404", 404)
        return {"ContentLength": len(self.objects[Key])}

    def get_object(self, Bucket: str, Key: str) -> dict[str, Any]:
        if Key not in self.objects:
            raise client_error("NoSuchKey", 404)
        return {"Body": io.BytesIO(self.objects[Key])}

    def delete_object(self, Bucket: str, Key: str) -> dict[str, Any]:
        self.objects.pop(Key, None)
        self.deleted.append(Key)
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

    def invoke(self, **kw: Any) -> dict[str, Any]:
        payload = kw["Payload"].decode() if isinstance(kw["Payload"], bytes) else kw["Payload"]
        self.calls.append({**kw, "Payload": payload, "payload": json.loads(payload)})
        if self.fail:
            raise client_error("ServiceException", 500)
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

    def __init__(self, callback: FakeCallback | None = None, replay: set[str] | None = None) -> None:
        self.callback = callback or FakeCallback(result=json.dumps({"jobId": "x", "clipCount": 0}))
        self.steps: list[str] = []
        self.attempts: dict[str, int] = {}
        self.configs: dict[str, Any] = {}
        self.waits: list[tuple[str | None, int]] = []
        self.callbacks: list[tuple[str | None, Any]] = []
        self.results: dict[str, Any] = {}
        self.replay = replay or set()

    def create_callback(self, name: str | None = None, config: Any = None) -> FakeCallback:
        self.callbacks.append((name, config))
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
