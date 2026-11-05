"""Generic interpreter v2: runs any workflow assembled from registry blocks.

1. `compile_definition` (activity) resolves every `uses:` reference to a pinned block version
   and enforces the workflow's capability grant. Its result is recorded in history, so the
   whole run (including replays) uses exactly that plan.
2. Each step's `with:` is bound from `inputs`, earlier `steps.<id>.output` and `run`.
3. Dispatch by kind: action -> run_tool (tools queue), crew -> run_crew_plan (agents queue),
   approval -> durable wait on a signal.

No I/O here; all side effects are activities referenced by name.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError

with workflow.unsafe.imports_passed_through():
    from ..registry.expr import ExpressionError, bind

TOOLS = "tools"
AGENTS = "agents"
NON_RETRYABLE = ["ConfigError", "AuthError", "NoChangesError", "ToolError"]

FAST = dict(
    task_queue=TOOLS,
    start_to_close_timeout=timedelta(seconds=30),
    retry_policy=RetryPolicy(maximum_attempts=5, non_retryable_error_types=NON_RETRYABLE),
)


@dataclass
class RunInput:
    run_id: str
    definition: dict[str, Any]
    inputs: dict[str, Any]


@dataclass
class Decision:
    approved: bool
    comment: str = ""
    by: str = "local"


@dataclass
class Progress:
    status: str = "pending"
    current_step: str | None = None
    completed: list[str] = field(default_factory=list)
    waiting_approval: bool = False


@workflow.defn(name="interpreter.v2")
class InterpreterV2:
    def __init__(self) -> None:
        self._decision: Decision | None = None
        self._progress = Progress()

    @workflow.signal
    def approve(self, comment: str = "", by: str = "local") -> None:
        self._decision = Decision(True, comment, by)

    @workflow.signal
    def reject(self, comment: str = "", by: str = "local") -> None:
        self._decision = Decision(False, comment, by)

    @workflow.query(name="getProgress")
    def get_progress(self) -> Progress:
        return self._progress

    @workflow.run
    async def run(self, inp: RunInput) -> dict[str, Any]:
        await self._set_run(inp.run_id, "running")
        try:
            plan = await workflow.execute_activity(
                "compile_definition", {"run_id": inp.run_id, "definition": inp.definition}, **FAST
            )
        except ActivityError as err:
            msg = _root_message(err)
            await self._set_run(inp.run_id, "failed", error=msg)
            raise ApplicationError(msg, non_retryable=True) from err

        ctx: dict[str, Any] = {"inputs": inp.inputs, "steps": {}, "run": {"id": inp.run_id}}
        for step in plan["steps"]:
            sid = step["id"]
            self._progress.current_step = sid
            await self._set_step(inp.run_id, sid, "running")
            try:
                args = bind(step.get("with") or {}, ctx)
                out = await self._exec(inp.run_id, step, args, plan["policy"])
            except (ActivityError, ExpressionError) as err:
                msg = _root_message(err)
                await self._set_step(inp.run_id, sid, "failed", error=msg)
                await self._set_run(inp.run_id, "failed", error=f"{sid}: {msg}")
                raise ApplicationError(f"step {sid} failed: {msg}", non_retryable=True) from err

            if out.get("rejected"):
                await self._set_step(inp.run_id, sid, "failed", output=out, error="rejected by reviewer")
                await self._set_run(inp.run_id, "rejected")
                return {"status": "rejected", "steps": ctx["steps"]}

            ctx["steps"][sid] = {"output": out}
            self._progress.completed.append(sid)
            await self._set_step(inp.run_id, sid, "succeeded", output=out)

        pr_url = next((s["output"].get("pr_url") for s in ctx["steps"].values() if s["output"].get("pr_url")), None)
        await self._set_run(inp.run_id, "succeeded", pr_url=pr_url)
        return {"status": "succeeded", "steps": ctx["steps"]}

    async def _exec(self, run_id: str, step: dict[str, Any], args: dict[str, Any],
                    policy: dict[str, Any]) -> dict[str, Any]:
        sid, kind = step["id"], step["kind"]
        base = {"run_id": run_id, "step_id": sid, "policy": policy}

        if kind == "action":
            tool = step["tool"]
            long = tool["name"] in ("workspace.clone", "github.open_pr") or tool["spec"]["provider"] == "mcp"
            return await workflow.execute_activity(
                "run_tool", {**base, "tool": tool, "args": args}, task_queue=TOOLS,
                start_to_close_timeout=timedelta(minutes=5 if long else 2),
                retry_policy=RetryPolicy(maximum_attempts=4, initial_interval=timedelta(seconds=2),
                                         non_retryable_error_types=NON_RETRYABLE),
            )

        if kind == "crew":
            return await workflow.execute_activity(
                "run_crew_plan", {**base, "crew": step["crew"], "inputs": args}, task_queue=AGENTS,
                start_to_close_timeout=timedelta(minutes=int(args.get("timeout_minutes", 60))),
                heartbeat_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(initial_interval=timedelta(seconds=10), backoff_coefficient=2.0,
                                         maximum_attempts=3, non_retryable_error_types=NON_RETRYABLE),
            )

        if kind == "approval":
            shown: dict[str, Any] = {}
            if args.get("workspace"):  # show the reviewer the diff of that workspace
                diff_tool = {"name": "workspace.diff", "version": 0,
                             "spec": {"provider": "builtin", "impl": "workspace.diff"}}
                shown = await workflow.execute_activity(
                    "run_tool", {**base, "tool": diff_tool, "args": {"workspace": args["workspace"]}},
                    task_queue=TOOLS, start_to_close_timeout=timedelta(minutes=2),
                    retry_policy=RetryPolicy(maximum_attempts=3, non_retryable_error_types=NON_RETRYABLE),
                )
            self._decision = None
            self._progress.waiting_approval = True
            await self._set_step(run_id, sid, "waiting", output={**shown, "message": args.get("message", "")})
            await self._set_run(run_id, "waiting_approval")
            await workflow.wait_condition(lambda: self._decision is not None)
            self._progress.waiting_approval = False
            d = self._decision
            assert d is not None
            await workflow.execute_activity(
                "record_event", {"run_id": run_id, "step_id": sid, "kind": "approval",
                                 "payload": {"approved": d.approved, "comment": d.comment, "by": d.by}}, **FAST)
            await self._set_run(run_id, "running")
            return {**shown, "approved": d.approved, "comment": d.comment, "rejected": not d.approved}

        raise ApplicationError(f"unknown step kind {kind!r}", type="ConfigError", non_retryable=True)

    async def _set_run(self, run_id: str, status: str, **extra: Any) -> None:
        self._progress.status = status
        await workflow.execute_activity("update_run", {"run_id": run_id, "status": status, **extra}, **FAST)

    async def _set_step(self, run_id: str, step_id: str, status: str, **extra: Any) -> None:
        await workflow.execute_activity(
            "update_step", {"run_id": run_id, "step_id": step_id, "status": status, **extra}, **FAST)


def _root_message(err: BaseException) -> str:
    cur: BaseException | None = err
    msg = str(err)
    while cur is not None:
        if str(cur):
            msg = str(cur)
        cur = cur.__cause__
    return msg
