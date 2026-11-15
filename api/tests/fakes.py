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


class FakeTable:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str], dict[str, Any]] = {}
        self.calls: list[tuple[str, dict[str, Any]]] = []

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

    def scan(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("scan", kw))
        assert re.fullmatch(r"#type = :type AND #field IN \(.+\)", kw["FilterExpression"]), kw["FilterExpression"]
        values = kw["ExpressionAttributeValues"]
        field = kw["ExpressionAttributeNames"]["#field"]
        allowed = [v for k, v in values.items() if k.startswith(":v")]
        found = [i for i in self.items.values() if i.get("type") == values[":type"] and i.get(field) in allowed]
        return {"Items": copy.deepcopy(found)}


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


class FakeSQS:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.fail = False

    def send_message(self, QueueUrl: str, MessageBody: str) -> dict[str, Any]:
        if self.fail:
            raise client_error("ServiceUnavailable", 503)
        self.sent.append({"QueueUrl": QueueUrl, "body": json.loads(MessageBody)})
        return {"MessageId": str(len(self.sent))}


class FakeScheduler:
    def __init__(self) -> None:
        self.schedules: dict[str, dict[str, Any]] = {}
        self.fail_next = 0

    def create_schedule(self, **kw: Any) -> dict[str, Any]:
        if self.fail_next:
            self.fail_next -= 1
            raise client_error("ThrottlingException", 429)
        if kw["Name"] in self.schedules:
            raise client_error("ConflictException", 409)
        self.schedules[kw["Name"]] = kw
        return {"ScheduleArn": f"arn:aws:scheduler:::schedule/{kw['GroupName']}/{kw['Name']}"}


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
