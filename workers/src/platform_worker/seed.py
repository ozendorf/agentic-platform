"""Seed the registry (builtin tools, agents, crews) and the first workflow."""
from __future__ import annotations

import json

from . import db
from .config import DEFAULT_MODEL
from .registry.builtins import BUILTIN_TOOLS
from .registry.store import upsert_block, upsert_provider

AGENTS = [
    {
        "name": "spec-planner", "title": "Spec planner",
        "description": "Reads a codebase and turns a markdown spec into a minimal implementation plan. Read-only.",
        "spec": {
            "role": "Staff engineer (planner)",
            "goal": "Turn a markdown spec into a precise, minimal implementation plan for this repository.",
            "backstory": "You read codebases quickly, find the conventions already in use, and plan the smallest "
                         "change that fully satisfies the spec. You never write code.",
            "model": DEFAULT_MODEL,
            "tools": ["fs.list_files", "fs.read_file", "fs.search_code"],
        },
    },
    {
        "name": "spec-engineer", "title": "Spec engineer",
        "description": "Implements a plan in the repository following its conventions, with tests, and runs them.",
        "spec": {
            "role": "Senior software engineer",
            "goal": "Implement the plan exactly, following the repository's existing conventions, with tests.",
            "backstory": "You make focused, reviewable changes. You write complete files, keep style consistent, "
                         "add or update tests, and run them when a test command is available.",
            "model": DEFAULT_MODEL,
            "tools": ["fs.list_files", "fs.read_file", "fs.search_code", "fs.write_file", "shell.run_command"],
        },
    },
    {
        "name": "code-reviewer", "title": "Code reviewer",
        "description": "Reviews a change for correctness, tests and conventions. Read-only.",
        "spec": {
            "role": "Pragmatic code reviewer",
            "goal": "Find real problems in a change (bugs, missing tests, broken conventions) and nothing else.",
            "backstory": "You review like a senior teammate: specific, brief, and you never nitpick style that "
                         "matches the codebase.",
            "model": DEFAULT_MODEL,
            "tools": ["fs.list_files", "fs.read_file", "fs.search_code"],
        },
    },
]

CREWS = [
    {
        "name": "implement-spec", "title": "Implement a spec",
        "description": "A planner and an engineer implement a markdown spec in a workspace. "
                       "Inputs: spec, repo, base_branch, workspace.",
        "spec": {
            "process": "sequential",
            "agents": [{"key": "planner", "ref": "agent:spec-planner"},
                       {"key": "engineer", "ref": "agent:spec-engineer"}],
            "tasks": [
                {"key": "plan", "agent": "planner",
                 "description": "Repository: {repo} (base branch {base_branch}).\n\nExplore the repository, then "
                                "write an implementation plan for this spec:\n\n<spec>\n{spec}\n</spec>",
                 "expected_output": "A numbered plan: files to create or modify (with paths), what changes in each, "
                                    "tests to add, and the command to run them if any."},
                {"key": "implement", "agent": "engineer", "context": ["plan"],
                 "description": "Implement the plan for this spec in the repository using your tools. Write every "
                                "changed file in full. Run the tests if a test command is available.\n\n"
                                "<spec>\n{spec}\n</spec>",
                 "expected_output": "A short markdown summary for the pull request: what changed and why, the list "
                                    "of files touched, and the test results."},
            ],
        },
    },
]

W = "{{ steps.prepare.output.workspace }}"
MD_TO_PR_V2 = {
    "version": 2,
    "policy": {
        "capabilities": ["github:read", "repo:read", "repo:write", "exec", "github:write"],
        "allowed_commands": ["python -m pytest", "pytest", "npm test", "npm run", "pnpm test", "go test",
                             "cargo test", "make test", "ls"],
    },
    "steps": [
        {"id": "prepare", "name": "Clone repo & create branch", "uses": "tool:workspace.clone",
         "with": {"repo": "{{ inputs.repo }}", "base_branch": "{{ inputs.base_branch }}"}},
        {"id": "implement", "name": "Implement the spec", "uses": "crew:implement-spec",
         "with": {"spec": "{{ inputs.spec }}", "repo": "{{ inputs.repo }}",
                  "base_branch": "{{ inputs.base_branch }}", "workspace": W}},
        {"id": "review", "name": "Human review of the diff", "uses": "approval", "with": {"workspace": W}},
        {"id": "pr", "name": "Open pull request", "uses": "tool:github.open_pr",
         "with": {"workspace": W, "repo": "{{ inputs.repo }}", "base_branch": "{{ inputs.base_branch }}",
                  "spec": "{{ inputs.spec }}", "summary": "{{ steps.implement.output.summary }}"}},
    ],
}


def seed_registry() -> None:
    pid = upsert_provider("builtin", "builtin")
    for t in BUILTIN_TOOLS:
        v, new = upsert_block("tool", t["name"], t["title"], t["description"], t["spec"], provider_id=pid)
        print(f"tool:{t['name']}@{v}{' (new)' if new else ''}")
    for a in AGENTS:
        v, new = upsert_block("agent", a["name"], a["title"], a["description"], a["spec"])
        print(f"agent:{a['name']}@{v}{' (new)' if new else ''}")
    for c in CREWS:
        v, new = upsert_block("crew", c["name"], c["title"], c["description"], c["spec"])
        print(f"crew:{c['name']}@{v}{' (new)' if new else ''}")


def upsert_workflow(slug: str, name: str, description: str, definition: dict) -> None:
    with db.conn() as c:
        wf = c.execute(
            """INSERT INTO workflows (slug, name, description) VALUES (%s,%s,%s)
               ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id""",
            (slug, name, description),
        ).fetchone()
        latest = c.execute("SELECT version, definition FROM workflow_versions WHERE workflow_id=%s "
                           "ORDER BY version DESC LIMIT 1", (wf["id"],)).fetchone()
        if latest and latest["definition"].get("version") == 2:
            print(f"{slug}: already on a v2 definition (v{latest['version']})")
            return
        v = (latest["version"] if latest else 0) + 1
        c.execute("INSERT INTO workflow_versions (workflow_id, version, definition) VALUES (%s,%s,%s)",
                  (wf["id"], v, json.dumps(definition)))
        c.execute("UPDATE workflows SET updated_at=now() WHERE id=%s", (wf["id"],))
        print(f"{slug}: seeded v{v} (registry blocks)")


def main() -> None:
    seed_registry()
    upsert_workflow("md-spec-to-pr", "Markdown spec → PR",
                    "A crew plans and implements a markdown spec in a GitHub repo, a human approves the diff, "
                    "and a pull request opens.", MD_TO_PR_V2)


if __name__ == "__main__":
    main()
