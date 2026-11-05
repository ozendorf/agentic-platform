"""Activities for the v2 interpreter: compile a definition, run any registered tool."""
from __future__ import annotations

import json
from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError

from .. import db
from ..crews.tools import BUILTIN_IMPLS, RunCommand
from ..registry.compile import CompileError, compile_definition
from .git import clone, diff, resolve_workspace
from .github import open_pr


def _preview(v: Any, n: int = 600) -> str:
    s = v if isinstance(v, str) else json.dumps(v, default=str)
    return s if len(s) <= n else s[:n] + "…"


@activity.defn(name="compile_definition")
def compile_run(a: dict[str, Any]) -> dict[str, Any]:
    run_id = a["run_id"]
    try:
        plan = compile_definition(a["definition"])
    except CompileError as e:
        db.emit(run_id, "run.compile_failed", {"problems": e.problems})
        raise ApplicationError("workflow failed to compile:\n" + "\n".join(e.problems), {"problems": e.problems},
                               type="ConfigError", non_retryable=True) from None
    with db.conn() as c:
        c.execute("UPDATE runs SET resolved=%s WHERE id=%s", (json.dumps(plan["resolved"]), run_id))
        for pos, s in enumerate(plan["steps"]):
            c.execute(
                """INSERT INTO run_steps (run_id, step_id, step_type, position, uses) VALUES (%s,%s,%s,%s,%s)
                   ON CONFLICT (run_id, step_id) DO UPDATE SET uses=EXCLUDED.uses""",
                (run_id, s["id"], s["kind"], pos, s["uses"]),
            )
    db.emit(run_id, "run.compiled", {"resolved": plan["resolved"], "capabilities": plan["policy"]["capabilities"]})
    return plan


# -- builtin action implementations ------------------------------------------------
def _clone(run_id: str, step_id: str, args: dict[str, Any], policy: dict[str, Any]) -> Any:
    return clone(run_id, step_id, args)


def _diff(run_id: str, step_id: str, args: dict[str, Any], policy: dict[str, Any]) -> Any:
    return diff(run_id, step_id, resolve_workspace(args.get("workspace")))


def _open_pr(run_id: str, step_id: str, args: dict[str, Any], policy: dict[str, Any]) -> Any:
    ws = resolve_workspace(args.get("workspace"))
    return open_pr(run_id, step_id, ws, args, summary=str(args.get("summary") or ""),
                   title=args.get("title") or None, draft=bool(args.get("draft", False)))


ACTIONS = {"workspace.clone": _clone, "workspace.diff": _diff, "github.open_pr": _open_pr}


def run_registered_tool(run_id: str, step_id: str, tool: dict[str, Any], args: dict[str, Any],
                        policy: dict[str, Any]) -> Any:
    spec = tool["spec"]
    impl = spec.get("impl", tool["name"])
    if spec["provider"] == "builtin":
        if impl in ACTIONS:
            return ACTIONS[impl](run_id, step_id, args, policy)
        if impl in BUILTIN_IMPLS:  # workspace tools used directly as actions
            args = dict(args)
            ws = resolve_workspace(args.pop("workspace", run_id))
            t = BUILTIN_IMPLS[impl]().bind(ws, lambda *_: None, step_id)
            if isinstance(t, RunCommand):
                t.allow(policy.get("allowed_commands", []))
            out = t.act(**args)
            if isinstance(out, str) and out.startswith("ERROR"):
                raise ApplicationError(out, type="ToolError", non_retryable=True)
            return {"result": out}
        raise ApplicationError(f"builtin tool {impl!r} has no implementation", type="ConfigError", non_retryable=True)
    if spec["provider"] == "mcp":
        from ..mcp_runtime import call_tool_sync
        return call_tool_sync(spec["server"], spec["impl"], args)
    raise ApplicationError(f"unknown provider {spec['provider']!r}", type="ConfigError", non_retryable=True)


@activity.defn(name="run_tool")
def run_tool(a: dict[str, Any]) -> dict[str, Any]:
    run_id, step_id, tool, args = a["run_id"], a["step_id"], a["tool"], a.get("args") or {}
    db.emit(run_id, "tool.call", {"tool": f"{tool['name']}@{tool['version']}", "args": _preview(args, 400)},
            step_id=step_id)
    out = run_registered_tool(run_id, step_id, tool, args, a.get("policy") or {})
    if not isinstance(out, dict):
        out = {"result": out}
    db.emit(run_id, "tool.result", {"tool": tool["name"], "result": _preview(out)}, step_id=step_id)
    return out


@activity.defn(name="sync_tool_provider")
def sync_tool_provider(provider_id: str) -> dict[str, Any]:
    from ..registry.mcp_sync import sync_provider

    return sync_provider(provider_id)
