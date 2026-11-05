"""Generic interpreter: walks a workflow definition (ordered list of steps).

Deterministic by construction: no I/O here. Every side effect is an activity, referenced
by name so this module never imports CrewAI/psycopg into the workflow sandbox. The
definition snapshot is part of the workflow input, so editing a workflow never changes a
running (or replaying) execution.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError

TOOLS = "tools"
AGENTS = "agents"

# Errors our activities raise as non-retryable. Listed here as well so a misbehaving
# activity that raises them without the flag still won't be retried.
NON_RETRYABLE = ["ConfigError", "AuthError", "NoChangesError"]

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


@workflow.defn(name="interpreter")
class Interpreter:
    def __init__(self) -> None:
        self._decision: Decision | None = None
        self._progress = Progress()

    # ---- external API -------------------------------------------------------------
    @workflow.signal
    def approve(self, comment: str = "", by: str = "local") -> None:
        self._decision = Decision(True, comment, by)

    @workflow.signal
    def reject(self, comment: str = "", by: str = "local") -> None:
        self._decision = Decision(False, comment, by)

    @workflow.query(name="getProgress")
    def get_progress(self) -> Progress:
        return self._progress

    # ---- main loop ----------------------------------------------------------------
    @workflow.run
    async def run(self, inp: RunInput) -> dict[str, Any]:
        steps: list[dict[str, Any]] = inp.definition["steps"]
        ctx: dict[str, Any] = {"run_id": inp.run_id, "inputs": inp.inputs, "outputs": {}}

        await workflow.execute_activity(
            "init_steps",
            {"run_id": inp.run_id, "steps": [{"id": s["id"], "type": s["type"]} for s in steps]},
            **FAST,
        )
        await self._set_run(inp.run_id, "running")
        for step in steps:
            sid = step["id"]
            self._progress.current_step = sid
            await self._set_step(inp.run_id, sid, "running")
            try:
                out = await self._exec(step, ctx)
            except ActivityError as err:
                msg = _root_message(err)
                await self._set_step(inp.run_id, sid, "failed", error=msg)
                await self._set_run(inp.run_id, "failed", error=f"{sid}: {msg}")
                raise ApplicationError(f"step {sid} failed: {msg}", non_retryable=True) from err

            if out.get("rejected"):
                await self._set_step(inp.run_id, sid, "failed", output=out, error="rejected by reviewer")
                await self._set_run(inp.run_id, "rejected")
                self._progress.status = "rejected"
                return {"status": "rejected", "outputs": ctx["outputs"]}

            ctx["outputs"][sid] = out
            self._progress.completed.append(sid)
            await self._set_step(inp.run_id, sid, "succeeded", output=out)

        result = {"status": "succeeded", "outputs": ctx["outputs"]}
        pr_url = next((o.get("pr_url") for o in ctx["outputs"].values() if o.get("pr_url")), None)
        await self._set_run(inp.run_id, "succeeded", pr_url=pr_url)
        self._progress.status = "succeeded"
        return result

    async def _exec(self, step: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        stype, sid, cfg = step["type"], step["id"], step.get("config", {})
        base = {"run_id": ctx["run_id"], "step_id": sid, "inputs": ctx["inputs"], "config": cfg}

        if stype == "git.prepare":
            return await workflow.execute_activity(
                "prepare_workspace",
                base,
                task_queue=TOOLS,
                start_to_close_timeout=timedelta(minutes=5),
                retry_policy=RetryPolicy(maximum_attempts=3, non_retryable_error_types=NON_RETRYABLE),
            )

        if stype == "crew":
            return await workflow.execute_activity(
                "run_crew",
                {**base, "previous": _last_summary(ctx)},
                task_queue=AGENTS,
                start_to_close_timeout=timedelta(minutes=int(cfg.get("timeout_minutes", 60))),
                heartbeat_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(
                    initial_interval=timedelta(seconds=10),
                    backoff_coefficient=2.0,
                    maximum_attempts=int(cfg.get("max_attempts", 3)),
                    non_retryable_error_types=NON_RETRYABLE,
                ),
            )

        if stype == "human.approval":
            diff = await workflow.execute_activity(
                "capture_diff", base, task_queue=TOOLS,
                start_to_close_timeout=timedelta(minutes=2),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
            self._decision = None
            self._progress.waiting_approval = True
            await self._set_step(ctx["run_id"], sid, "waiting", output=diff)
            await self._set_run(ctx["run_id"], "waiting_approval")
            # Durable wait: survives worker restarts, costs nothing while idle.
            await workflow.wait_condition(lambda: self._decision is not None)
            self._progress.waiting_approval = False
            d = self._decision
            assert d is not None
            await workflow.execute_activity(
                "record_event",
                {"run_id": ctx["run_id"], "step_id": sid, "kind": "approval",
                 "payload": {"approved": d.approved, "comment": d.comment, "by": d.by}},
                **FAST,
            )
            await self._set_run(ctx["run_id"], "running")
            return {**diff, "approved": d.approved, "comment": d.comment, "rejected": not d.approved}

        if stype == "github.open_pr":
            return await workflow.execute_activity(
                "open_pull_request",
                {**base, "summary": _last_summary(ctx)},
                task_queue=TOOLS,
                start_to_close_timeout=timedelta(minutes=5),
                retry_policy=RetryPolicy(maximum_attempts=4, non_retryable_error_types=NON_RETRYABLE),
            )

        raise ApplicationError(f"unknown step type {stype!r}", type="ConfigError", non_retryable=True)

    # ---- state mirroring into App Postgres ---------------------------------------
    async def _set_run(self, run_id: str, status: str, **extra: Any) -> None:
        self._progress.status = status
        await workflow.execute_activity("update_run", {"run_id": run_id, "status": status, **extra}, **FAST)

    async def _set_step(self, run_id: str, step_id: str, status: str, **extra: Any) -> None:
        await workflow.execute_activity(
            "update_step", {"run_id": run_id, "step_id": step_id, "status": status, **extra}, **FAST
        )


def _last_summary(ctx: dict[str, Any]) -> str:
    for out in reversed(list(ctx["outputs"].values())):
        if out.get("summary"):
            return str(out["summary"])
    return ""


def _root_message(err: BaseException) -> str:
    cur: BaseException | None = err
    msg = str(err)
    while cur is not None:
        if str(cur):
            msg = str(cur)
        cur = cur.__cause__
    return msg
