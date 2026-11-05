"""Build a CrewAI Crew from a `crew` step config (data only, no code in definitions)."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from crewai import LLM, Agent, Crew, Process, Task
from temporalio.exceptions import ApplicationError

from ..config import DEFAULT_MODEL, MODEL_PRICING
from .tools import BUILTIN_IMPLS, TOOL_CLASSES, McpTool, Reporter, RunCommand

DEFAULT_TOOLS = ["list_files", "read_file", "search_code", "write_file"]


def config_error(msg: str) -> ApplicationError:
    return ApplicationError(msg, type="ConfigError", non_retryable=True)


def make_llm(model: str) -> LLM:
    if model not in MODEL_PRICING:
        raise config_error(f"model {model!r} is not enabled (choose one of {sorted(MODEL_PRICING)})")
    # No temperature/top_p: current Claude models reject sampling params.
    return LLM(model=f"anthropic/{model}", max_tokens=32000)


def build_crew(cfg: dict[str, Any], root: Path, report: Reporter, step_cb: Any, task_cb: Any
               ) -> tuple[Crew, dict[str, LLM]]:
    agents_cfg = cfg.get("agents") or []
    tasks_cfg = cfg.get("tasks") or []
    if not agents_cfg or not tasks_cfg:
        raise config_error("a crew step needs at least one agent and one task")

    llms: dict[str, LLM] = {}  # agent key -> llm (for per-model usage accounting)
    agents: dict[str, Agent] = {}
    for a in agents_cfg:
        key = a["key"]
        model = a.get("model") or cfg.get("model") or DEFAULT_MODEL
        tools = []
        for tname in a.get("tools", DEFAULT_TOOLS):
            cls = TOOL_CLASSES.get(tname)
            if cls is None:
                raise config_error(f"unknown tool {tname!r} on agent {key}")
            t = cls().bind(root, report, key)
            if isinstance(t, RunCommand):
                t.allow(list(cfg.get("allowed_commands", [])))
            tools.append(t)
        llms[key] = make_llm(model)
        agents[key] = Agent(
            role=a["role"], goal=a["goal"], backstory=a.get("backstory", ""),
            llm=llms[key], tools=tools, allow_delegation=False,
            max_iter=int(a.get("max_iter", cfg.get("max_iter", 30))),
            verbose=False,
        )

    tasks: dict[str, Task] = {}
    for t in tasks_cfg:
        if t["agent"] not in agents:
            raise config_error(f"task {t['key']} references unknown agent {t['agent']!r}")
        tasks[t["key"]] = Task(
            name=t["key"], description=t["description"], expected_output=t["expected_output"],
            agent=agents[t["agent"]], context=[tasks[c] for c in t.get("context", []) if c in tasks] or None,
        )

    process = Process.hierarchical if cfg.get("process") == "hierarchical" else Process.sequential
    extra: dict[str, Any] = {}
    if process == Process.hierarchical:
        llms["__manager__"] = make_llm(cfg.get("manager_model") or DEFAULT_MODEL)
        extra["manager_llm"] = llms["__manager__"]

    crew = Crew(
        agents=list(agents.values()), tasks=list(tasks.values()), process=process,
        step_callback=step_cb, task_callback=task_cb, verbose=False, memory=False, tracing=False,
        **extra,
    )
    return crew, {k: v for k, v in llms.items()}


def build_crew_from_plan(plan: dict[str, Any], root: Path | None, report: Reporter, step_cb: Any, task_cb: Any,
                         allowed_commands: list[str]) -> tuple[Crew, dict[str, LLM]]:
    """Build a crew from a compiled (registry-resolved, version-pinned) crew plan."""
    llms: dict[str, LLM] = {}
    agents: dict[str, Agent] = {}
    for a in plan["agents"]:
        key, spec = a["key"], a["spec"]
        tools: list[Any] = []
        for t in spec.get("tools", []):
            tspec = t["spec"]
            if tspec["provider"] == "mcp":
                tools.append(McpTool.from_spec(t["name"], tspec, lambda n, args, r, k=key: report(n, args, r)))
                continue
            cls = BUILTIN_IMPLS.get(tspec.get("impl", ""))
            if cls is None:
                raise config_error(f"tool {t['name']} can't be used by an agent")
            if root is None:
                raise config_error(f"agent {a['name']} uses workspace tools, but the step has no `workspace` input")
            tool = cls().bind(root, report, key)
            if isinstance(tool, RunCommand):
                tool.allow(allowed_commands)
            tools.append(tool)
        llms[key] = make_llm(spec.get("model") or DEFAULT_MODEL)
        agents[key] = Agent(role=spec["role"], goal=spec["goal"], backstory=spec.get("backstory", ""),
                            llm=llms[key], tools=tools, allow_delegation=False,
                            max_iter=int(spec.get("max_iter", 30)), verbose=False)
    tasks: dict[str, Task] = {}
    for t in plan["tasks"]:
        tasks[t["key"]] = Task(name=t["key"], description=t["description"], expected_output=t["expected_output"],
                               agent=agents[t["agent"]],
                               context=[tasks[c] for c in t.get("context", []) if c in tasks] or None)
    process = Process.hierarchical if plan.get("process") == "hierarchical" else Process.sequential
    extra: dict[str, Any] = {}
    if process == Process.hierarchical:
        llms["__manager__"] = make_llm(plan.get("manager_model") or DEFAULT_MODEL)
        extra["manager_llm"] = llms["__manager__"]
    crew = Crew(agents=list(agents.values()), tasks=list(tasks.values()), process=process, step_callback=step_cb,
                task_callback=task_cb, verbose=False, memory=False, tracing=False, **extra)
    return crew, llms
