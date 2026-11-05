"""Turn every tool of an MCP server into its own first-class, versioned tool block."""
from __future__ import annotations

import json
from typing import Any

from .. import db
from ..mcp_runtime import list_tools_sync
from .capabilities import mcp_capability
from .store import upsert_block


def sync_provider(provider_id: str) -> dict[str, Any]:
    p = db.fetchone("SELECT id, name, kind, config FROM tool_providers WHERE id=%s", (provider_id,))
    if not p or p["kind"] != "mcp":
        raise ValueError(f"no MCP provider {provider_id}")
    server = {k: p["config"].get(k) for k in ("transport", "command", "args", "env")}
    try:
        tools = list_tools_sync(server)
    except Exception as e:
        db.execute("UPDATE tool_providers SET status='error', error=%s WHERE id=%s", (str(e)[:2000], provider_id))
        raise
    seen, created = [], 0
    for t in tools:
        ann = getattr(t, "annotations", None)
        read_only = bool(getattr(ann, "readOnlyHint", False)) if ann else False
        name = f"{p['name']}.{t.name}"
        spec = {
            "provider": "mcp", "impl": t.name, "server": server,
            "description": (t.description or "").strip()[:2000],
            "input_schema": t.inputSchema or {"type": "object", "properties": {}},
            "capabilities": [mcp_capability(p["name"], read_only)],
            "modes": ["agent", "action"],
            "annotations": ann.model_dump(exclude_none=True) if ann else {},
        }
        title = (getattr(ann, "title", None) if ann else None) or t.name.replace("_", " ").capitalize()
        _, new = upsert_block("tool", name, title, spec["description"].split("\n")[0][:300], spec,
                              provider_id=str(p["id"]), owner=f"mcp:{p['name']}")
        created += int(new)
        seen.append(name)
    # Tools that disappeared upstream are archived (pinned versions keep working).
    db.execute("UPDATE blocks SET archived = NOT (name = ANY(%s)) WHERE provider_id=%s", (seen, provider_id))
    db.execute("UPDATE tool_providers SET status='ok', error=NULL, synced_at=now() WHERE id=%s", (provider_id,))
    return {"tools": len(seen), "new_versions": created}


def add_provider(name: str, command: str, args: list[str], env: dict[str, str]) -> str:
    row = db.fetchone(
        """INSERT INTO tool_providers (name, kind, config) VALUES (%s, 'mcp', %s)
           ON CONFLICT (name) DO UPDATE SET config=EXCLUDED.config RETURNING id""",
        (name, json.dumps({"transport": "stdio", "command": command, "args": args, "env": env})),
    )
    return str(row["id"])  # type: ignore[index]
