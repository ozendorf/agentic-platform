"""MCP client runtime. One long-lived session per MCP server per worker process, driven by
a private event loop thread, so sync callers (activities, CrewAI tools) can call tools
without spawning the server for every call."""
from __future__ import annotations

import asyncio
import json
import os
import threading
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from .config import github_token

_loop: asyncio.AbstractEventLoop | None = None
_lock = threading.Lock()
_conns: dict[str, "_Conn"] = {}

# Values like "$GITHUB_TOKEN" in a server's env are resolved here, never stored in the DB.
SECRET_SOURCES = {"GITHUB_TOKEN": github_token}


def _resolve_env(env: dict[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in (env or {}).items():
        if isinstance(v, str) and v.startswith("$"):
            name = v[1:]
            out[k] = SECRET_SOURCES[name]() if name in SECRET_SOURCES else os.environ.get(name, "")
        else:
            out[k] = str(v)
    return out


def _loop_thread() -> asyncio.AbstractEventLoop:
    global _loop
    with _lock:
        if _loop is None:
            _loop = asyncio.new_event_loop()
            threading.Thread(target=_loop.run_forever, daemon=True, name="mcp-loop").start()
        return _loop


class _Conn:
    def __init__(self, server: dict[str, Any]):
        self.server = server
        self.queue: asyncio.Queue[tuple[str, tuple, asyncio.Future]] = asyncio.Queue()
        self.ready: asyncio.Future = asyncio.get_running_loop().create_future()
        self.task = asyncio.get_running_loop().create_task(self._run())

    async def _run(self) -> None:
        params = StdioServerParameters(command=self.server["command"], args=list(self.server.get("args", [])),
                                       env={**os.environ, **_resolve_env(self.server.get("env", {}))})
        try:
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    self.ready.set_result(True)
                    while True:
                        op, args, fut = await self.queue.get()
                        try:
                            if op == "list":
                                fut.set_result(await session.list_tools())
                            else:
                                fut.set_result(await session.call_tool(*args))
                        except Exception as e:  # keep the session alive for later calls
                            fut.set_exception(e)
        except Exception as e:
            if not self.ready.done():
                self.ready.set_exception(e)
        finally:
            _conns.pop(_key(self.server), None)

    async def request(self, op: str, *args: Any) -> Any:
        await asyncio.wait_for(asyncio.shield(self.ready), timeout=120)
        fut = asyncio.get_running_loop().create_future()
        await self.queue.put((op, args, fut))
        return await asyncio.wait_for(fut, timeout=300)


def _key(server: dict[str, Any]) -> str:
    return json.dumps({k: server.get(k) for k in ("command", "args", "env")}, sort_keys=True)


async def _request(server: dict[str, Any], op: str, *args: Any) -> Any:
    k = _key(server)
    conn = _conns.get(k)
    if conn is None or conn.task.done():
        conn = _conns[k] = _Conn(server)
    return await conn.request(op, *args)


def _run_sync(coro: Any) -> Any:
    return asyncio.run_coroutine_threadsafe(coro, _loop_thread()).result(timeout=330)


def list_tools_sync(server: dict[str, Any]) -> list[Any]:
    return _run_sync(_request(server, "list")).tools


def _content_text(c: Any) -> str:
    """Flatten MCP content blocks (text, embedded resources, images) into text for the model."""
    if getattr(c, "type", None) == "text":
        return c.text
    if getattr(c, "type", None) == "resource":
        r = c.resource
        if getattr(r, "text", None) is not None:
            return f"--- {r.uri} ---\n{r.text}"
        return f"[binary resource {r.uri} ({getattr(r, 'mimeType', '?')})]"
    if getattr(c, "type", None) == "image":
        return f"[image {getattr(c, 'mimeType', '')}]"
    return json.dumps(c.model_dump(mode="json")) if hasattr(c, "model_dump") else str(c)


def call_tool_sync(server: dict[str, Any], name: str, args: dict[str, Any]) -> dict[str, Any]:
    res = _run_sync(_request(server, "call", name, args))
    text = "\n".join(_content_text(c) for c in res.content)
    out: dict[str, Any] = {"result": text}
    if getattr(res, "structuredContent", None):
        out["data"] = res.structuredContent
    if res.isError:
        out["is_error"] = True
    return out
