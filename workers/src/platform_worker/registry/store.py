"""Registry persistence (sync psycopg)."""
from __future__ import annotations

import json
from typing import Any

from .. import db


def upsert_provider(name: str, kind: str, config: dict[str, Any] | None = None) -> str:
    row = db.fetchone(
        """INSERT INTO tool_providers (name, kind, config) VALUES (%s,%s,%s)
           ON CONFLICT (name) DO UPDATE SET config=EXCLUDED.config RETURNING id""",
        (name, kind, json.dumps(config or {})),
    )
    return str(row["id"])  # type: ignore[index]


def upsert_block(kind: str, name: str, title: str, description: str, spec: dict[str, Any],
                 provider_id: str | None = None, owner: str = "platform") -> tuple[int, bool]:
    """Create the block if needed and add a new version when the spec changed.
    Returns (latest_version, created_new_version)."""
    with db.conn() as c:
        b = c.execute(
            """INSERT INTO blocks (kind, name, title, description, provider_id, owner) VALUES (%s,%s,%s,%s,%s,%s)
               ON CONFLICT (kind, name) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description,
                 archived=false
               RETURNING id""",
            (kind, name, title, description, provider_id, owner),
        ).fetchone()
        latest = c.execute(
            "SELECT version, spec FROM block_versions WHERE block_id=%s ORDER BY version DESC LIMIT 1", (b["id"],)
        ).fetchone()
        if latest and latest["spec"] == spec:
            return latest["version"], False
        v = (latest["version"] if latest else 0) + 1
        c.execute("INSERT INTO block_versions (block_id, version, spec) VALUES (%s,%s,%s)",
                  (b["id"], v, json.dumps(spec)))
        c.execute("UPDATE blocks SET updated_at=now() WHERE id=%s", (b["id"],))
        return v, True


def get_block(kind: str, name: str, version: int | None = None) -> dict[str, Any] | None:
    sql = """SELECT b.name, b.title, b.archived, v.version, v.spec FROM blocks b
             JOIN block_versions v ON v.block_id=b.id WHERE b.kind=%s AND b.name=%s"""
    if version is None:
        return db.fetchone(sql + " ORDER BY v.version DESC LIMIT 1", (kind, name))
    return db.fetchone(sql + " AND v.version=%s", (kind, name, version))
