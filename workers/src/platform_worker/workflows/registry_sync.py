"""Sync an MCP provider's tools into the registry, as a (tiny) durable workflow."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy


@workflow.defn(name="registry.sync_provider")
class SyncProvider:
    @workflow.run
    async def run(self, provider_id: str) -> dict[str, Any]:
        return await workflow.execute_activity(
            "sync_tool_provider", provider_id, task_queue="tools",
            start_to_close_timeout=timedelta(minutes=5),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
