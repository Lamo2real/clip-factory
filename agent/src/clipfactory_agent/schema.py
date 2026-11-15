"""A small JSON Schema checker for model output (the subset our schemas use), so bad output is caught and sent back
to the model with a precise reason instead of failing later."""

from __future__ import annotations

from typing import Any

_TYPES: dict[str, tuple[type, ...]] = {
    "object": (dict,),
    "array": (list,),
    "string": (str,),
    "number": (int, float),
    "integer": (int,),
    "boolean": (bool,),
    "null": (type(None),),
}


def _is(value: Any, t: str) -> bool:
    if t in ("number", "integer") and isinstance(value, bool):
        return False
    if t == "integer" and isinstance(value, float):
        return value.is_integer()
    return isinstance(value, _TYPES[t])


def check(schema: dict[str, Any], value: Any, path: str = "$") -> list[str]:
    """Problems with ``value`` against ``schema``; empty when it fits."""
    types = schema.get("type")
    if types is not None:
        allowed = [types] if isinstance(types, str) else list(types)
        if not any(_is(value, t) for t in allowed):
            return [f"{path} should be {' or '.join(allowed)}"]
    problems: list[str] = []
    if "enum" in schema and value not in schema["enum"]:
        problems.append(f"{path} must be one of {schema['enum']}")
    if isinstance(value, dict):
        props: dict[str, Any] = schema.get("properties") or {}
        problems += [f"{path}.{k} is missing" for k in schema.get("required") or [] if k not in value]
        if schema.get("additionalProperties") is False:
            problems += [f"{path}.{k} is not allowed" for k in value if k not in props]
        for k, sub in props.items():
            if k in value:
                problems += check(sub, value[k], f"{path}.{k}")
    elif isinstance(value, list):
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            problems.append(f"{path} has more than {schema['maxItems']} items")
        if "minItems" in schema and len(value) < schema["minItems"]:
            problems.append(f"{path} needs at least {schema['minItems']} items")
        if "items" in schema:
            for i, item in enumerate(value):
                problems += check(schema["items"], item, f"{path}[{i}]")
    elif isinstance(value, int | float) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            problems.append(f"{path} must be at least {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            problems.append(f"{path} must be at most {schema['maximum']}")
    elif isinstance(value, str) and "maxLength" in schema and len(value) > schema["maxLength"]:
        problems.append(f"{path} is longer than {schema['maxLength']} characters")
    return problems
