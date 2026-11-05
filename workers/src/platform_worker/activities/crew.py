"""The `crew` step: one heartbeating activity that runs a whole CrewAI crew.

Durability contract: if the worker dies mid-crew, Temporal retries this activity. On a
retry we reset the workspace to the last checkpoint (the state before this step began),
so a crew never sees half of a previous attempt's edits.
"""
from __future__ import annotations

import contextvars
import json
import os
import threading
from pathlib import Path
from typing import Any, Callable

from temporalio import activity
from temporalio.exceptions import ApplicationError

from .. import db
from ..config import cost_usd
from .git import checkpoint, reset_to_head, workspace

PREVIEW = 600


def _preview(v: Any, n: int = PREVIEW) -> str:
    s = str(v)
    return s if len(s) <= n else s[:n] + "…"


class Heartbeater:
    """Heartbeats on a timer so Temporal notices a dead worker within heartbeat_timeout,
    even while a single long model call is in flight."""

    def __init__(self, every: float = 15.0) -> None:
        self._stop = threading.Event()
        self._every = every
        self._detail: dict[str, Any] = {}
        ctx = contextvars.copy_context()  # carries the activity context into the thread
        self._t = threading.Thread(target=lambda: ctx.run(self._loop), daemon=True)

    def _loop(self) -> None:
        while not self._stop.wait(self._every):
            try:
                activity.heartbeat(self._detail)
            except Exception:
                pass

    def update(self, **detail: Any) -> None:
        self._detail.update(detail)

    def __enter__(self) -> "Heartbeater":
        self._t.start()
        return self

    def __exit__(self, *_: Any) -> None:
        self._stop.set()


def _execute(run_id: str, step_id: str, ws: Path | None, make: Callable[..., tuple[Any, dict[str, Any]]],
             inputs: dict[str, Any]) -> dict[str, Any]:
    """Run a crew with live events, per-model usage, heartbeats and crash-safe workspace handling."""
    info = activity.info()
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise ApplicationError("ANTHROPIC_API_KEY is not set in .env; the crew can't call the model",
                               type="AuthError", non_retryable=True)
    if info.attempt > 1:
        db.execute("UPDATE run_steps SET attempt=%s WHERE run_id=%s AND step_id=%s", (info.attempt, run_id, step_id))
        if ws is not None:
            reset_to_head(ws)
        db.emit(run_id, "log", {"message": f"retry #{info.attempt}"
                                + (": workspace reset to last checkpoint" if ws is not None else "")}, step_id=step_id)

    hb = Heartbeater()

    def report(tool: str, args: dict[str, Any], result: str) -> None:
        shown = {k: (_preview(v, 200) if k == "content" else v) for k, v in args.items()}
        db.emit(run_id, "agent.tool", {"tool": tool, "args": shown, "result": _preview(result)}, step_id=step_id)
        hb.update(last_tool=tool)

    def step_cb(step: Any) -> None:
        thought = getattr(step, "thought", None) or getattr(step, "text", None)
        if thought:
            db.emit(run_id, "agent.thought", {"text": _preview(thought, 1500)}, step_id=step_id)
        push_usage()

    def task_cb(out: Any) -> None:
        db.emit(run_id, "agent.task", {"task": getattr(out, "name", None), "agent": getattr(out, "agent", None),
                                        "output": _preview(getattr(out, "raw", out), 2000)}, step_id=step_id)
        push_usage()

    reported: dict[str, tuple[int, int]] = {}
    lock = threading.Lock()
    llms: dict[str, Any] = {}

    def push_usage() -> None:
        """Record usage deltas per model since the last call (live cost strip)."""
        with lock:
            for key, llm in llms.items():
                u = llm.get_token_usage_summary()
                prev_in, prev_out = reported.get(key, (0, 0))
                d_in, d_out = u.prompt_tokens - prev_in, u.completion_tokens - prev_out
                if d_in <= 0 and d_out <= 0:
                    continue
                reported[key] = (u.prompt_tokens, u.completion_tokens)
                model = llm.model.split("/")[-1]
                c = cost_usd(model, d_in, d_out)
                with db.conn() as conn:
                    conn.execute("INSERT INTO llm_usage (run_id, step_id, model, tokens_in, tokens_out, cost_usd)"
                                 " VALUES (%s,%s,%s,%s,%s,%s)", (run_id, step_id, model, d_in, d_out, c))
                    conn.execute("UPDATE run_steps SET tokens_in=tokens_in+%s, tokens_out=tokens_out+%s,"
                                 " cost_usd=cost_usd+%s WHERE run_id=%s AND step_id=%s",
                                 (d_in, d_out, c, run_id, step_id))
                db.emit(run_id, "usage", {"model": model, "tokens_in": d_in, "tokens_out": d_out, "cost_usd": c},
                        step_id=step_id)

    crew, built = make(report, step_cb, task_cb)
    llms.update(built)
    db.emit(run_id, "log", {"message": f"crew starting: {len(crew.agents)} agents, {len(crew.tasks)} tasks"},
            step_id=step_id)

    with hb:
        try:
            result = crew.kickoff(inputs={k: v if isinstance(v, str) else json.dumps(v) for k, v in inputs.items()})
        except ApplicationError:
            raise
        except Exception as e:
            # CrewAI wraps errors in long (sometimes cyclic) __cause__ chains that break
            # Temporal's failure serialisation, so re-raise a flat error without the chain.
            msg = str(e)
            low = msg.lower()
            if any(k in low for k in ("authentication", "api key", "api_key", "401", "permission_error")):
                raise ApplicationError(f"model provider auth failed: {_preview(msg, 300)}",
                                       type="AuthError", non_retryable=True) from None
            raise ApplicationError(f"{type(e).__name__}: {_preview(msg, 1000)}", type=type(e).__name__) from None
        finally:
            push_usage()

    summary = str(result.raw)
    artifact_id = db.save_artifact(run_id, step_id, "crew_output", summary)
    changed = checkpoint(ws, f"agent: {step_id}") if ws is not None else False
    return {"summary": summary[:4000], "output_artifact_id": artifact_id, "changed": changed}


@activity.defn(name="run_crew")
def run_crew(a: dict[str, Any]) -> dict[str, Any]:
    """v1 interpreter (inline crew config). Kept for runs started before the registry."""
    from ..crews.builder import build_crew

    run_id, step_id, cfg = a["run_id"], a["step_id"], a.get("config", {})
    ws = workspace(run_id)
    if not ws.exists():
        raise ApplicationError("workspace missing, add a git.prepare step before the crew",
                               type="ConfigError", non_retryable=True)
    inputs = {"spec": str(a["inputs"].get("spec", "")), "repo": str(a["inputs"].get("repo", "")),
              "base_branch": str(a["inputs"].get("base_branch", "main")), "previous": a.get("previous", "")}
    return _execute(run_id, step_id, ws, lambda r, s, t: build_crew(cfg, ws, r, s, t), inputs)


@activity.defn(name="run_crew_plan")
def run_crew_plan(a: dict[str, Any]) -> dict[str, Any]:
    """v2 interpreter: crew compiled from registry blocks. `inputs.workspace` (optional)
    gives the crew's workspace tools their root; every other input feeds task templates."""
    from ..crews.builder import build_crew_from_plan
    from .git import resolve_workspace

    run_id, step_id, plan = a["run_id"], a["step_id"], a["crew"]
    inputs = dict(a.get("inputs") or {})
    ws = resolve_workspace(inputs["workspace"]) if inputs.get("workspace") else None
    allowed = (a.get("policy") or {}).get("allowed_commands", [])
    return _execute(run_id, step_id, ws,
                    lambda r, s, t: build_crew_from_plan(plan, ws, r, s, t, allowed), inputs)
