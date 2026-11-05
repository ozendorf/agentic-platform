"""Compiler against the seeded registry in the local app DB (`uv run seed` first)."""
import copy

import pytest

from platform_worker.registry.compile import CompileError, compile_definition
from platform_worker.seed import MD_TO_PR_V2


def test_seeded_workflow_compiles_and_pins_versions():
    plan = compile_definition(MD_TO_PR_V2)
    assert [s["kind"] for s in plan["steps"]] == ["action", "crew", "approval", "action"]
    crew = plan["steps"][1]["crew"]
    assert [a["key"] for a in crew["agents"]] == ["planner", "engineer"]
    assert all("spec" in t for a in crew["agents"] for t in a["spec"]["tools"])  # tool specs inlined
    assert plan["resolved"]["crew:implement-spec"] >= 1


def test_capability_grant_is_enforced():
    d = copy.deepcopy(MD_TO_PR_V2)
    d["policy"]["capabilities"] = ["github:read", "repo:read"]
    with pytest.raises(CompileError) as e:
        compile_definition(d)
    msg = str(e.value)
    assert "fs.write_file' needs repo:write" in msg and "github.open_pr' needs github:write" in msg


def test_unknown_block_and_forward_reference():
    d = copy.deepcopy(MD_TO_PR_V2)
    d["steps"][1]["uses"] = "crew:does-not-exist"
    d["steps"][0]["with"]["repo"] = "{{ steps.pr.output.url }}"
    with pytest.raises(CompileError) as e:
        compile_definition(d)
    assert "not in the registry" in str(e.value) and "doesn't run before" in str(e.value)


def test_agent_step_becomes_crew_of_one():
    d = {"version": 2, "policy": {"capabilities": ["repo:read"]}, "steps": [
        {"id": "review", "uses": "agent:code-reviewer@1", "with": {},
         "task": {"description": "Review {repo}", "expected_output": "findings"}}]}
    s = compile_definition(d)["steps"][0]
    assert s["kind"] == "crew" and s["crew"]["tasks"][0]["agent"] == "agent"
