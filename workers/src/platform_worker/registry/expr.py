"""`{{ path }}` bindings between steps. Pure and deterministic: safe inside workflows.

Paths: inputs.<key>, steps.<step_id>.output.<key>..., run.id. Lists index with `.0`.
A string that is exactly one expression keeps the value's type; otherwise values are
interpolated as text. There is deliberately no code evaluation here.
"""
from __future__ import annotations

import json
import re
from typing import Any

EXPR = re.compile(r"\{\{\s*([A-Za-z_][\w-]*(?:\.[\w-]+)*)\s*\}\}")
WHOLE = re.compile(r"^\s*\{\{\s*([A-Za-z_][\w-]*(?:\.[\w-]+)*)\s*\}\}\s*$")
ROOTS = {"inputs", "steps", "run"}


class ExpressionError(ValueError):
    pass


def lookup(ctx: dict[str, Any], path: str) -> Any:
    cur: Any = ctx
    walked: list[str] = []
    for part in path.split("."):
        walked.append(part)
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        else:
            raise ExpressionError(f"{{{{ {path} }}}}: nothing at '{'.'.join(walked)}'")
    return cur


def bind(value: Any, ctx: dict[str, Any]) -> Any:
    if isinstance(value, str):
        m = WHOLE.match(value)
        if m:
            return lookup(ctx, m.group(1))

        def sub(mm: re.Match[str]) -> str:
            v = lookup(ctx, mm.group(1))
            return v if isinstance(v, str) else json.dumps(v)

        return EXPR.sub(sub, value)
    if isinstance(value, dict):
        return {k: bind(v, ctx) for k, v in value.items()}
    if isinstance(value, list):
        return [bind(v, ctx) for v in value]
    return value


def references(value: Any) -> list[str]:
    """All expression paths used anywhere in a (nested) value."""
    if isinstance(value, str):
        return EXPR.findall(value)
    if isinstance(value, dict):
        return [p for v in value.values() for p in references(v)]
    if isinstance(value, list):
        return [p for v in value for p in references(v)]
    return []
