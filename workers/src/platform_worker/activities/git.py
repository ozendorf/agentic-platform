"""Workspace + git activities (tools queue). One workspace per run under WORKSPACES_DIR."""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError

from .. import db
from ..config import WORKSPACES_DIR, github_token

BASE_REF = "refs/platform/base"
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def workspace(run_id: str) -> Path:
    return WORKSPACES_DIR / run_id


def branch_name(run_id: str) -> str:
    return f"agent/{run_id[:8]}"


def git(cwd: Path, *args: str, check: bool = True) -> str:
    p = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and p.returncode != 0:
        # Don't leak tokens embedded in remote URLs into error messages.
        err = re.sub(r"x-access-token:[^@]+@", "x-access-token:***@", p.stderr.strip())
        raise RuntimeError(f"git {' '.join(args[:2])} failed: {err}")
    return p.stdout


def remote_url(repo: str) -> str:
    tok = github_token()
    if not tok:
        raise ApplicationError("no GitHub token (set GITHUB_TOKEN or run `gh auth login`)", type="AuthError", non_retryable=True)
    return f"https://x-access-token:{tok}@github.com/{repo}.git"


def validate_inputs(inputs: dict[str, Any]) -> tuple[str, str]:
    repo = str(inputs.get("repo", "")).strip()
    if not REPO_RE.match(repo):
        raise ApplicationError(f"invalid repo {repo!r}, expected owner/name", type="ConfigError", non_retryable=True)
    return repo, str(inputs.get("base_branch") or "main")


WS_HANDLE = re.compile(r"^[0-9a-f-]{36}$")


def resolve_workspace(handle: Any) -> Path:
    """Workspace handles are opaque ids returned by workspace.clone (the run id)."""
    h = str(handle or "")
    if not WS_HANDLE.match(h) or not workspace(h).is_dir():
        raise ApplicationError(f"unknown workspace {h!r}; pass the output of a workspace.clone step",
                               type="ConfigError", non_retryable=True)
    return workspace(h)


@activity.defn(name="prepare_workspace")
def prepare_workspace(a: dict[str, Any]) -> dict[str, Any]:
    return clone(a["run_id"], a["step_id"], a["inputs"])


def clone(run_id: str, step_id: str, inputs: dict[str, Any]) -> dict[str, Any]:
    a = {"step_id": step_id}
    repo, base = validate_inputs(inputs)
    ws = workspace(run_id)
    if ws.exists():  # retry or replay of a half-done clone: start clean
        shutil.rmtree(ws)
    ws.parent.mkdir(parents=True, exist_ok=True)
    db.emit(run_id, "log", {"message": f"cloning {repo}@{base}"}, step_id=a["step_id"])
    p = subprocess.run(
        ["git", "clone", "--depth", "50", "--branch", base, remote_url(repo), str(ws)],
        capture_output=True, text=True,
    )
    if p.returncode != 0:
        err = re.sub(r"x-access-token:[^@]+@", "***@", p.stderr)
        if "not found" in err.lower() or "authentication" in err.lower() or "403" in err:
            raise ApplicationError(f"cannot clone {repo}: {err.strip()}", type="AuthError", non_retryable=True)
        raise RuntimeError(f"clone failed: {err.strip()}")
    git(ws, "config", "user.name", "agentic-platform")
    git(ws, "config", "user.email", "agentic-platform@localhost")
    branch = branch_name(run_id)
    git(ws, "checkout", "-b", branch)
    base_sha = git(ws, "rev-parse", "HEAD").strip()
    git(ws, "update-ref", BASE_REF, base_sha)  # remembered for diffs + PR squash
    files = len(git(ws, "ls-files").splitlines())
    db.emit(run_id, "log", {"message": f"workspace ready on {branch} ({files} files)"}, step_id=a["step_id"])
    return {"workspace": run_id, "branch": branch, "base_sha": base_sha, "base_branch": base, "repo": repo,
            "files": files}


def checkpoint(ws: Path, message: str) -> bool:
    """Commit everything the agent changed so a retried later step can reset to it."""
    git(ws, "add", "-A")
    if not git(ws, "status", "--porcelain").strip():
        return False
    git(ws, "commit", "-q", "-m", message)
    return True


def reset_to_head(ws: Path) -> None:
    git(ws, "reset", "-q", "--hard", "HEAD")
    git(ws, "clean", "-qfd")


def base_sha(ws: Path) -> str:
    return git(ws, "rev-parse", BASE_REF).strip()


@activity.defn(name="capture_diff")
def capture_diff(a: dict[str, Any]) -> dict[str, Any]:
    return diff(a["run_id"], a["step_id"], workspace(a["run_id"]))


def diff(run_id: str, step_id: str, ws: Path) -> dict[str, Any]:
    a = {"step_id": step_id}
    checkpoint(ws, "agent: uncommitted changes")
    base = base_sha(ws)
    patch = git(ws, "diff", f"{base}..HEAD")
    stat = git(ws, "diff", "--shortstat", f"{base}..HEAD").strip()
    names = git(ws, "diff", "--name-status", f"{base}..HEAD").strip().splitlines()
    artifact_id = db.save_artifact(run_id, a["step_id"], "diff", patch)
    db.emit(run_id, "diff", {"artifact_id": artifact_id, "stat": stat, "files": names[:200]}, step_id=a["step_id"])
    return {"diff_artifact_id": artifact_id, "stat": stat or "no changes", "files_changed": len(names)}
