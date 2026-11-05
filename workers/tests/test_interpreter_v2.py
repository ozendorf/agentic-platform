"""Interpreter v2 against the local Temporal (namespace `test`) with mocked activities."""
from __future__ import annotations

import asyncio
import uuid
from concurrent.futures import ThreadPoolExecutor

from temporalio import activity
from temporalio.client import Client
from temporalio.worker import Replayer, Worker

from platform_worker.config import TEMPORAL_ADDRESS
from platform_worker.seed import MD_TO_PR_V2
from platform_worker.workflows.interpreter_v2 import InterpreterV2, RunInput

PLAN = {
    "policy": {"capabilities": ["repo:read"], "allowed_commands": []},
    "resolved": {},
    "steps": [
        {"id": "prepare", "kind": "action", "uses": "tool:workspace.clone", "with": MD_TO_PR_V2["steps"][0]["with"],
         "tool": {"name": "workspace.clone", "version": 1, "spec": {"provider": "builtin"}}},
        {"id": "implement", "kind": "crew", "uses": "crew:implement-spec", "with": MD_TO_PR_V2["steps"][1]["with"],
         "crew": {"name": "implement-spec", "version": 1}},
        {"id": "review", "kind": "approval", "uses": "approval", "with": MD_TO_PR_V2["steps"][2]["with"]},
        {"id": "pr", "kind": "action", "uses": "tool:github.open_pr", "with": MD_TO_PR_V2["steps"][3]["with"],
         "tool": {"name": "github.open_pr", "version": 1, "spec": {"provider": "builtin"}}},
    ],
}


async def test_v2_binds_outputs_between_blocks() -> None:
    client = await Client.connect(TEMPORAL_ADDRESS, namespace="test")
    seen: dict[str, dict] = {}

    @activity.defn(name="compile_definition")
    def compile_definition(a: dict) -> dict:
        return PLAN

    @activity.defn(name="run_tool")
    def run_tool(a: dict) -> dict:
        seen[a["tool"]["name"]] = a["args"]
        return {"workspace.clone": {"workspace": "ws-123"}, "workspace.diff": {"stat": "1 file"},
                "github.open_pr": {"pr_url": "https://github.com/o/r/pull/9"}}[a["tool"]["name"]]

    @activity.defn(name="run_crew_plan")
    def run_crew_plan(a: dict) -> dict:
        seen["crew"] = a["inputs"]
        return {"summary": "implemented it"}

    noop = [activity.defn(name=n)(lambda a: None) for n in ("update_run", "update_step", "record_event")]
    wq = f"wf-{uuid.uuid4()}"
    pool = ThreadPoolExecutor(4)
    async with Worker(client, task_queue=wq, workflows=[InterpreterV2]), \
            Worker(client, task_queue="tools", activities=[compile_definition, run_tool, *noop], activity_executor=pool), \
            Worker(client, task_queue="agents", activities=[run_crew_plan], activity_executor=pool):
        h = await client.start_workflow(
            InterpreterV2.run, RunInput("r1", {"version": 2}, {"repo": "o/r", "base_branch": "main", "spec": "# S"}),
            id=f"t-{uuid.uuid4()}", task_queue=wq)
        for _ in range(100):
            if (await h.query("getProgress"))["waiting_approval"]:
                break
            await asyncio.sleep(0.1)
        await h.signal("approve", args=["ok", "tester"])
        res = await h.result()

    assert res["status"] == "succeeded"
    assert seen["workspace.clone"] == {"repo": "o/r", "base_branch": "main"}
    assert seen["crew"]["workspace"] == "ws-123" and seen["crew"]["spec"] == "# S"
    assert seen["workspace.diff"] == {"workspace": "ws-123"}
    assert seen["github.open_pr"]["summary"] == "implemented it"
    assert res["steps"]["pr"]["output"]["pr_url"].endswith("/9")
    await Replayer(workflows=[InterpreterV2]).replay_workflow(await h.fetch_history())
