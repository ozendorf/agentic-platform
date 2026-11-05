"""Compile a v2 workflow definition into a self-contained, version-pinned run plan.

Runs inside an activity at the start of every run, so the plan (with every block spec
inlined) is recorded in Temporal history: replays and retries never see registry edits.

  definition step  uses: "tool:<name>[@v]" | "agent:<name>[@v]" | "crew:<name>[@v]" | "approval"
  compiled step    kind: "action" | "crew" | "approval"  (an agent step = a crew of one)
"""
from __future__ import annotations

import re
from typing import Any

from ..config import MODEL_PRICING
from .expr import references
from .store import get_block

REF = re.compile(r"^(tool|agent|crew):([A-Za-z0-9_.-]+)(?:@(\d+))?$")
STEP_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")


class CompileError(ValueError):
    def __init__(self, problems: list[str]):
        super().__init__("\n".join(problems))
        self.problems = problems


def parse_ref(ref: str, default_kind: str | None = None) -> tuple[str, str, int | None]:
    if default_kind and ":" not in ref:
        ref = f"{default_kind}:{ref}"
    m = REF.match(ref or "")
    if not m:
        raise CompileError([f"invalid reference {ref!r} (expected kind:name[@version])"])
    return m.group(1), m.group(2), int(m.group(3)) if m.group(3) else None


class Compiler:
    def __init__(self, definition: dict[str, Any]):
        self.d = definition
        policy = definition.get("policy") or {}
        self.granted: set[str] = set(policy.get("capabilities") or [])
        self.allowed_commands: list[str] = list(policy.get("allowed_commands") or [])
        self.resolved: dict[str, int] = {}
        self.problems: list[str] = []

    # -- block resolution ---------------------------------------------------------
    def _load(self, kind: str, name: str, version: int | None, at: str) -> dict[str, Any] | None:
        b = get_block(kind, name, version)
        if b is None:
            self.problems.append(f"{at}: {kind} '{name}'{f'@{version}' if version else ''} is not in the registry")
            return None
        if b["archived"] and version is None:
            self.problems.append(f"{at}: {kind} '{name}' is archived; pin a version to keep using it")
        self.resolved[f"{kind}:{name}"] = b["version"]
        return b

    def tool(self, ref: str, mode: str, at: str) -> dict[str, Any] | None:
        _, name, ver = parse_ref(ref, "tool")
        b = self._load("tool", name, ver, at)
        if not b:
            return None
        spec = b["spec"]
        if mode not in spec.get("modes", []):
            self.problems.append(f"{at}: tool '{name}' can't be used as {'an agent tool' if mode == 'agent' else 'an action'}")
        missing = [c for c in spec.get("capabilities", []) if c not in self.granted]
        if missing:
            self.problems.append(f"{at}: tool '{name}' needs {', '.join(missing)}, which this workflow doesn't grant")
        return {"name": name, "version": b["version"], "spec": spec}

    def agent(self, ref: str, at: str) -> dict[str, Any] | None:
        _, name, ver = parse_ref(ref, "agent")
        b = self._load("agent", name, ver, at)
        if not b:
            return None
        spec = b["spec"]
        model = spec.get("model")
        if model and model not in MODEL_PRICING:
            self.problems.append(f"{at}: agent '{name}' uses model {model!r}, which isn't enabled")
        tools = [t for t in (self.tool(r, "agent", f"{at} › agent {name}") for r in spec.get("tools", [])) if t]
        return {"name": name, "version": b["version"], "spec": {**spec, "tools": tools}}

    def crew(self, ref: str, at: str) -> dict[str, Any] | None:
        _, name, ver = parse_ref(ref, "crew")
        b = self._load("crew", name, ver, at)
        if not b:
            return None
        spec = b["spec"]
        agents = []
        for a in spec.get("agents", []):
            resolved = self.agent(a["ref"], f"{at} › crew {name}")
            if resolved:
                agents.append({"key": a["key"], **resolved})
        keys = {a["key"] for a in spec.get("agents", [])}
        for t in spec.get("tasks", []):
            if t.get("agent") not in keys:
                self.problems.append(f"{at} › crew {name}: task {t.get('key')} uses unknown agent {t.get('agent')!r}")
        return {"name": name, "version": b["version"], "process": spec.get("process", "sequential"),
                "manager_model": spec.get("manager_model"), "agents": agents, "tasks": spec.get("tasks", [])}

    # -- workflow -----------------------------------------------------------------
    def compile(self) -> dict[str, Any]:
        steps = self.d.get("steps") or []
        if self.d.get("version") != 2:
            raise CompileError(["only version 2 definitions can be compiled"])
        if not steps:
            raise CompileError(["a workflow needs at least one step"])
        out: list[dict[str, Any]] = []
        earlier: set[str] = set()
        for i, s in enumerate(steps):
            sid = s.get("id", "")
            at = f"step {i + 1} ({sid or '?'})"
            if not STEP_ID.match(sid):
                self.problems.append(f"{at}: id must be lowercase letters, digits, - or _")
            if sid in earlier:
                self.problems.append(f"{at}: duplicate id")
            with_ = s.get("with") or {}
            for path in references(with_) + references(s.get("task") or {}):
                root, _, rest = path.partition(".")
                if root not in ("inputs", "steps", "run"):
                    self.problems.append(f"{at}: unknown expression root in {{{{ {path} }}}}")
                elif root == "steps" and rest.split(".")[0] not in earlier:
                    self.problems.append(f"{at}: {{{{ {path} }}}} refers to a step that doesn't run before this one")
            base = {"id": sid, "name": s.get("name") or sid, "uses": s.get("uses"), "with": with_}
            uses = s.get("uses") or ""
            try:
                if uses == "approval":
                    if "workspace" in with_ and "repo:read" not in self.granted:
                        self.problems.append(f"{at}: showing a workspace diff needs repo:read")
                    out.append({**base, "kind": "approval"})
                else:
                    kind, _, _ = parse_ref(uses)
                    if kind == "tool":
                        t = self.tool(uses, "action", at)
                        out.append({**base, "kind": "action", "tool": t})
                    elif kind == "crew":
                        out.append({**base, "kind": "crew", "crew": self.crew(uses, at)})
                    else:  # a single agent is a crew of one with the step's task
                        a = self.agent(uses, at)
                        task = s.get("task") or {}
                        if not task.get("description") or not task.get("expected_output"):
                            self.problems.append(f"{at}: an agent step needs a task description and expected output")
                        crew = None
                        if a:
                            crew = {"name": a["name"], "version": a["version"], "process": "sequential",
                                    "agents": [{"key": "agent", **a}],
                                    "tasks": [{"key": sid, "agent": "agent", "description": task.get("description", ""),
                                               "expected_output": task.get("expected_output", "")}]}
                        out.append({**base, "kind": "crew", "crew": crew})
            except CompileError as e:
                self.problems.extend(f"{at}: {p}" for p in e.problems)
            earlier.add(sid)
        if self.problems:
            raise CompileError(self.problems)
        return {"steps": out, "policy": {"capabilities": sorted(self.granted), "allowed_commands": self.allowed_commands},
                "resolved": self.resolved}


def compile_definition(definition: dict[str, Any]) -> dict[str, Any]:
    return Compiler(definition).compile()
