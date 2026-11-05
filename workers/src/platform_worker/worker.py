"""Run the platform's Temporal workers. By default one process serves all three queues;
`--queues agents` etc. lets you run (and kill) them independently."""
from __future__ import annotations

import argparse
import asyncio
import logging
import signal
from concurrent.futures import ThreadPoolExecutor

from temporalio.client import Client
from temporalio.worker import Worker

from .config import (TASK_QUEUE_AGENTS, TASK_QUEUE_INTERPRETER, TASK_QUEUE_TOOLS, TEMPORAL_ADDRESS,
                     TEMPORAL_NAMESPACE)

ALL = [TASK_QUEUE_INTERPRETER, TASK_QUEUE_TOOLS, TASK_QUEUE_AGENTS]


def build_workers(client: Client, queues: list[str], pool: ThreadPoolExecutor) -> list[Worker]:
    workers: list[Worker] = []
    if TASK_QUEUE_INTERPRETER in queues:
        from .workflows.interpreter import Interpreter
        from .workflows.interpreter_v2 import InterpreterV2
        from .workflows.registry_sync import SyncProvider
        # v1 stays registered so runs started before the registry can finish (replay safety).
        workers.append(Worker(client, task_queue=TASK_QUEUE_INTERPRETER, workflows=[Interpreter, InterpreterV2, SyncProvider]))
    if TASK_QUEUE_TOOLS in queues:
        from .activities import git, github, registry_v2, state
        workers.append(Worker(
            client, task_queue=TASK_QUEUE_TOOLS, activity_executor=pool, max_concurrent_activities=20,
            activities=[state.init_steps, state.update_run, state.update_step, state.record_event,
                        git.prepare_workspace, git.capture_diff, github.open_pull_request,
                        registry_v2.compile_run, registry_v2.run_tool, registry_v2.sync_tool_provider],
        ))
    if TASK_QUEUE_AGENTS in queues:
        from .activities import crew
        # Crews are slow and cost money: keep concurrency low.
        workers.append(Worker(client, task_queue=TASK_QUEUE_AGENTS, activity_executor=pool,
                              max_concurrent_activities=2, activities=[crew.run_crew, crew.run_crew_plan]))
    return workers


async def run(queues: list[str]) -> None:
    client = await Client.connect(TEMPORAL_ADDRESS, namespace=TEMPORAL_NAMESPACE)
    with ThreadPoolExecutor(max_workers=24) as pool:
        workers = build_workers(client, queues, pool)
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        logging.info("worker up on queues %s (temporal %s)", queues, TEMPORAL_ADDRESS)
        async with asyncio.TaskGroup() as tg:
            for w in workers:
                tg.create_task(w.run())
            await stop.wait()
            logging.info("shutting down")
            for w in workers:
                tg.create_task(w.shutdown())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--queues", default=",".join(ALL), help=f"comma-separated subset of {ALL}")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    asyncio.run(run([q.strip() for q in args.queues.split(",") if q.strip()]))


if __name__ == "__main__":
    main()
