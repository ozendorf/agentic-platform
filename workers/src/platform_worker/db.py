"""Sync Postgres helpers. Activities run in a thread pool, so sync psycopg is fine."""
from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any, Iterator

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import DATABASE_URL

_pool: ConnectionPool | None = None


def pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(DATABASE_URL, min_size=1, max_size=10, kwargs={"row_factory": dict_row}, open=True)
    return _pool


@contextmanager
def conn() -> Iterator[Any]:
    with pool().connection() as c:
        yield c


def execute(sql: str, params: tuple | dict = ()) -> None:
    with conn() as c:
        c.execute(sql, params)


def fetchone(sql: str, params: tuple | dict = ()) -> dict | None:
    with conn() as c:
        return c.execute(sql, params).fetchone()


def emit(run_id: str, kind: str, payload: dict | None = None, step_id: str | None = None) -> None:
    """Append to the run timeline. A trigger fans it out via pg_notify to SSE clients."""
    execute(
        "INSERT INTO run_events (run_id, step_id, kind, payload) VALUES (%s, %s, %s, %s)",
        (run_id, step_id, kind, json.dumps(payload or {}, default=str)),
    )


def save_artifact(run_id: str, step_id: str, kind: str, content: str) -> str:
    row = fetchone(
        "INSERT INTO artifacts (run_id, step_id, kind, content) VALUES (%s,%s,%s,%s) RETURNING id",
        (run_id, step_id, kind, content),
    )
    return str(row["id"])  # type: ignore[index]
