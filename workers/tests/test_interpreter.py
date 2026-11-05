"""Interpreter tests against the local Temporal (namespace `test`), with mocked activities.

Run: uv run pytest  (needs `docker compose up`)
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any

import pytest
from temporalio import activity
from temporalio.client import Client, WorkflowFailureError
from temporalio.exceptions import ApplicationError
from temporalio.worker import Replayer, Worker

from platform_worker.config import TEMPORAL_ADDRESS
from platform_worker.workflows.interpreter import Interpreter, RunInput

DEF = {"steps": [
    {"id": "prepare", "type": "git.prepare", "config": {}},
    {"id": "implement", "type": "crew", "config": {}},
    {"id": "review", "type": "human.approval", "config": {}},
    {"id": "pr", "type": "github.open_pr", "config": {}},
]}


class Calls:
    def __init__(self) -> None:
        self.log: list[str] = []
        self.crew_attempts = 0
        self.crew_fail_times = 0
        self.crew_error: Exception | None = None

    def acts(self) -> tuple[list[Any], list[Any]]:
        c = self

        @activity.defn(name="init_steps")
        def init_steps(a: dict) -> None: c.log.append("init")

        @activity.defn(name="update_run")
        def update_run(a: dict) -> None: c.log.append(f"run:{a['status']}")

        @activity.defn(name="update_step")
        def update_step(a: dict) -> None: c.log.append(f"{a['step_id']}:{a['status']}")

        @activity.defn(name="record_event")
        def record_event(a: dict) -> None: c.log.append(f"event:{a['kind']}")

        @activity.defn(name="prepare_workspace")
        def prepare_workspace(a: dict) -> dict: return {"branch": "agent/x"}

        @activity.defn(name="capture_diff")
        def capture_diff(a: dict) -> dict: return {"stat": "1 file changed", "diff_artifact_id": "d1"}

        @activity.defn(name="open_pull_request")
        def open_pull_request(a: dict) -> dict:
            assert a["summary"] == "did the thing"
            return {"pr_url": "https://github.com/o/r/pull/1"}

        @activity.defn(name="run_crew")
        def run_crew(a: dict) -> dict:
            c.crew_attempts += 1
            if c.crew_error:
                raise c.crew_error
            if c.crew_attempts <= c.crew_fail_times:
                raise RuntimeError("transient model error")
            return {"summary": "did the thing"}

        return ([init_steps, update_run, update_step, record_event, prepare_workspace, capture_diff,
                 open_pull_request], [run_crew])


@pytest.fixture
async def client() -> Client:
    return await Client.connect(TEMPORAL_ADDRESS, namespace="test")


async def run_wf(client: Client, calls: Calls, decide: str | None):
    tools, agents = calls.acts()
    wq = f"wf-{uuid.uuid4()}"
    # The interpreter routes to the fixed "tools"/"agents" queues; the test namespace isolates them.
    async with Worker(client, task_queue=wq, workflows=[Interpreter]), \
            Worker(client, task_queue="tools", activities=tools, activity_executor=_pool()), \
            Worker(client, task_queue="agents", activities=agents, activity_executor=_pool()):
        h = await client.start_workflow(Interpreter.run, RunInput("r1", DEF, {"repo": "o/r"}),
                                        id=f"t-{uuid.uuid4()}", task_queue=wq)
        if decide:
            for _ in range(100):
                p = await h.query("getProgress")
                if p["waiting_approval"]:
                    break
                await asyncio.sleep(0.1)
            await h.signal(decide, args=["lgtm", "tester"])
        try:
            return h, await h.result()
        except WorkflowFailureError as e:
            return h, e


def _pool():
    from concurrent.futures import ThreadPoolExecutor
    return ThreadPoolExecutor(4)


async def test_happy_path_and_replay(client: Client) -> None:
    calls = Calls()
    calls.crew_fail_times = 1  # first crew attempt fails, retry succeeds
    h, res = await run_wf(client, calls, "approve")
    assert res["status"] == "succeeded"
    assert res["outputs"]["pr"]["pr_url"].endswith("/pull/1")
    assert calls.crew_attempts == 2
    assert calls.log.index("review:waiting") < calls.log.index("event:approval") < calls.log.index("pr:running")
    assert calls.log[-1] == "run:succeeded"
    # Determinism: replaying the recorded history with the current code must not diverge.
    await Replayer(workflows=[Interpreter]).replay_workflow(await h.fetch_history())


async def test_reject_stops_before_pr(client: Client) -> None:
    calls = Calls()
    _, res = await run_wf(client, calls, "reject")
    assert res["status"] == "rejected"
    assert "pr:running" not in calls.log
    assert calls.log[-1] == "run:rejected"


async def test_non_retryable_error_fails_fast(client: Client) -> None:
    calls = Calls()
    calls.crew_error = ApplicationError("bad key", type="AuthError", non_retryable=True)
    _, res = await run_wf(client, calls, None)
    assert isinstance(res, WorkflowFailureError)
    assert calls.crew_attempts == 1
    assert "implement:failed" in calls.log and calls.log[-1] == "run:failed"
