"""Start a run from the CLI: uv run start-sample --repo owner/name --spec path/to/spec.md"""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from temporalio.client import Client

from . import db
from .config import TASK_QUEUE_INTERPRETER, TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE
from .workflows.interpreter import RunInput


async def start(slug: str, repo: str, base: str, spec: str) -> str:
    with db.conn() as c:
        v = c.execute(
            """SELECT v.id, v.definition FROM workflow_versions v JOIN workflows w ON w.id=v.workflow_id
               WHERE w.slug=%s ORDER BY v.version DESC LIMIT 1""", (slug,)).fetchone()
        if not v:
            raise SystemExit(f"no workflow {slug!r}; run `uv run seed`")
        inputs = {"repo": repo, "base_branch": base, "spec": spec}
        run = c.execute(
            "INSERT INTO runs (workflow_version_id, temporal_workflow_id, inputs) VALUES (%s, '', %s) RETURNING id",
            (v["id"], json.dumps(inputs))).fetchone()
        run_id = str(run["id"])
        c.execute("UPDATE runs SET temporal_workflow_id=%s WHERE id=%s", (f"run-{run_id}", run_id))
    client = await Client.connect(TEMPORAL_ADDRESS, namespace=TEMPORAL_NAMESPACE)
    wf = "interpreter.v2" if v["definition"].get("version") == 2 else "interpreter"
    await client.start_workflow(wf, RunInput(run_id, v["definition"], inputs),
                                id=f"run-{run_id}", task_queue=TASK_QUEUE_INTERPRETER)
    return run_id


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workflow", default="md-spec-to-pr")
    ap.add_argument("--repo", required=True)
    ap.add_argument("--base", default="main")
    ap.add_argument("--spec", required=True, help="path to a markdown file")
    a = ap.parse_args()
    run_id = asyncio.run(start(a.workflow, a.repo, a.base, Path(a.spec).read_text()))
    print(f"started run {run_id}\n  temporal: http://localhost:8080/namespaces/default/workflows/run-{run_id}"
          f"\n  ui:       http://localhost:3000/runs/{run_id}")


if __name__ == "__main__":
    main()
