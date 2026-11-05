"""Open the pull request (tools queue). Idempotent: a retry finds the existing PR."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import httpx
from temporalio import activity
from temporalio.exceptions import ApplicationError

from .. import db
from ..config import github_token
from .git import base_sha, branch_name, checkpoint, git, validate_inputs, workspace

API = "https://api.github.com"


def _title(spec: str, override: str | None) -> str:
    if override:
        return override
    for line in spec.splitlines():
        m = re.match(r"^#{1,3}\s+(.+)", line.strip())
        if m:
            return m.group(1).strip()[:120]
    first = next((l.strip() for l in spec.splitlines() if l.strip()), "Agent change")
    return first[:120]


def _body(spec: str, summary: str, run_id: str) -> str:
    return (
        f"Opened by the **agentic platform** (run `{run_id}`), after human approval.\n\n"
        f"## What the agent did\n\n{summary.strip() or '_no summary_'}\n\n"
        f"<details><summary>Original spec</summary>\n\n{spec.strip()}\n\n</details>\n"
    )


@activity.defn(name="open_pull_request")
def open_pull_request(a: dict[str, Any]) -> dict[str, Any]:
    cfg = a.get("config", {})
    return open_pr(a["run_id"], a["step_id"], workspace(a["run_id"]), a["inputs"], summary=a.get("summary", ""),
                   title=cfg.get("title"), draft=bool(cfg.get("draft", False)))


def open_pr(run_id: str, step_id: str, ws: Path, inputs: dict[str, Any], summary: str = "",
            title: str | None = None, draft: bool = False) -> dict[str, Any]:
    a = {"step_id": step_id, "summary": summary}
    repo, base_branch = validate_inputs(inputs)
    spec = str(inputs.get("spec", ""))
    branch = branch_name(run_id)
    title = _title(spec, title)

    checkpoint(ws, "agent: uncommitted changes")
    base = base_sha(ws)
    if not git(ws, "diff", "--name-only", f"{base}..HEAD").strip():
        raise ApplicationError("the agent produced no changes, nothing to open a PR for",
                               type="NoChangesError", non_retryable=True)

    # One clean commit for reviewers, whatever checkpoints the crew made.
    git(ws, "reset", "-q", "--soft", base)
    git(ws, "commit", "-q", "-m", title, "-m", f"Agentic platform run {run_id}")
    db.emit(run_id, "log", {"message": f"pushing {branch}"}, step_id=a["step_id"])
    git(ws, "push", "-q", "--force", "origin", f"HEAD:refs/heads/{branch}")

    headers = {"Authorization": f"Bearer {github_token()}", "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28"}
    with httpx.Client(base_url=API, headers=headers, timeout=30) as gh:
        r = gh.post(f"/repos/{repo}/pulls", json={
            "title": title, "head": branch, "base": base_branch,
            "body": _body(spec, a.get("summary", ""), run_id), "draft": draft,
        })
        if r.status_code == 422 and "already exists" in r.text:
            owner = repo.split("/")[0]
            existing = gh.get(f"/repos/{repo}/pulls", params={"head": f"{owner}:{branch}", "state": "open"}).json()
            if existing:
                pr = existing[0]
            else:
                raise RuntimeError(f"PR exists but not found: {r.text}")
        elif r.status_code in (401, 403, 404):
            raise ApplicationError(f"GitHub refused PR creation ({r.status_code}): {r.text[:300]}",
                                   type="AuthError", non_retryable=True)
        elif r.status_code >= 300:
            raise RuntimeError(f"GitHub API {r.status_code}: {r.text[:300]}")
        else:
            pr = r.json()

    db.emit(run_id, "pr", {"url": pr["html_url"], "number": pr["number"], "title": title}, step_id=a["step_id"])
    return {"pr_url": pr["html_url"], "pr_number": pr["number"], "branch": branch}
