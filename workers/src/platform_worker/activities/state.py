"""Small, idempotent activities that mirror workflow state into App Postgres."""
from __future__ import annotations

import json
from typing import Any

from temporalio import activity

from .. import db

RUN_TERMINAL = {"succeeded", "failed", "rejected"}


@activity.defn(name="init_steps")
def init_steps(a: dict[str, Any]) -> None:
    with db.conn() as c:
        for pos, s in enumerate(a["steps"]):
            c.execute(
                """INSERT INTO run_steps (run_id, step_id, step_type, position) VALUES (%s,%s,%s,%s)
                   ON CONFLICT (run_id, step_id) DO NOTHING""",
                (a["run_id"], s["id"], s["type"], pos),
            )


@activity.defn(name="update_run")
def update_run(a: dict[str, Any]) -> None:
    status = a["status"]
    db.execute(
        """UPDATE runs SET status=%(status)s,
             started_at = COALESCE(started_at, CASE WHEN %(status)s='running' THEN now() END),
             finished_at = CASE WHEN %(terminal)s THEN now() ELSE finished_at END,
             pr_url = COALESCE(%(pr_url)s, pr_url),
             error = COALESCE(%(error)s, error)
           WHERE id=%(run_id)s""",
        {"status": status, "terminal": status in RUN_TERMINAL, "pr_url": a.get("pr_url"),
         "error": a.get("error"), "run_id": a["run_id"]},
    )
    db.emit(a["run_id"], "run.status", {k: v for k, v in a.items() if k != "run_id"})


@activity.defn(name="update_step")
def update_step(a: dict[str, Any]) -> None:
    status = a["status"]
    db.execute(
        """UPDATE run_steps SET status=%(status)s,
             attempt = CASE WHEN %(status)s='running' THEN attempt+1 ELSE attempt END,
             started_at = CASE WHEN %(status)s='running' THEN now() ELSE started_at END,
             finished_at = CASE WHEN %(status)s IN ('succeeded','failed') THEN now() ELSE finished_at END,
             output = COALESCE(%(output)s::jsonb, output),
             error = %(error)s
           WHERE run_id=%(run_id)s AND step_id=%(step_id)s""",
        {"status": status, "output": json.dumps(a["output"]) if "output" in a else None,
         "error": a.get("error"), "run_id": a["run_id"], "step_id": a["step_id"]},
    )
    db.emit(a["run_id"], "step.status", {"status": status, "error": a.get("error")}, step_id=a["step_id"])


@activity.defn(name="record_event")
def record_event(a: dict[str, Any]) -> None:
    db.emit(a["run_id"], a["kind"], a.get("payload"), step_id=a.get("step_id"))
