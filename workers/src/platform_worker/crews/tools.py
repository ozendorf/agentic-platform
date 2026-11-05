"""CrewAI tools bound to one run's workspace. Every path is confined to that directory."""
from __future__ import annotations

import shlex
import subprocess
from pathlib import Path
from typing import Any, Callable

from crewai.tools import BaseTool
from pydantic import BaseModel, Field, PrivateAttr

MAX_READ = 200_000
MAX_OUT = 12_000
SKIP_DIRS = {".git", "node_modules", ".venv", "dist", "build", "__pycache__", ".next", "target"}

Reporter = Callable[[str, dict[str, Any], str], None]


class WorkspaceTool(BaseTool):
    """Base: resolves paths inside the workspace and reports every call to the timeline."""

    _root: Path = PrivateAttr()
    _report: Reporter = PrivateAttr()
    _agent: str = PrivateAttr(default="")

    def bind(self, root: Path, report: Reporter, agent: str) -> "WorkspaceTool":
        self._root, self._report, self._agent = root.resolve(), report, agent
        return self

    def _path(self, rel: str) -> Path:
        p = (self._root / (rel or ".").lstrip("/")).resolve()
        if p != self._root and not p.is_relative_to(self._root):
            raise ValueError(f"path {rel!r} is outside the workspace")
        if ".git" in p.relative_to(self._root).parts:
            raise ValueError("the .git directory is off limits")
        return p

    def _run(self, **kwargs: Any) -> str:
        try:
            result = self.act(**kwargs)
        except Exception as e:  # tool errors go back to the model, not up the stack
            result = f"ERROR: {e}"
        self._report(self.name, kwargs, result)
        return result

    def act(self, **kwargs: Any) -> str:  # pragma: no cover - abstract
        raise NotImplementedError


class PathArg(BaseModel):
    path: str = Field(".", description="Path relative to the repository root")


class ListFiles(WorkspaceTool):
    name: str = "list_files"
    description: str = "List files under a directory of the repository (recursive, skips build/vendor dirs)."
    args_schema: type[BaseModel] = PathArg

    def act(self, path: str = ".") -> str:
        base = self._path(path)
        if base.is_file():
            return str(base.relative_to(self._root))
        out: list[str] = []
        for p in sorted(base.rglob("*")):
            rel = p.relative_to(self._root)
            if any(part in SKIP_DIRS for part in rel.parts) or not p.is_file():
                continue
            out.append(str(rel))
            if len(out) >= 500:
                out.append("... (truncated at 500 files)")
                break
        return "\n".join(out) or "(empty)"


class ReadFile(WorkspaceTool):
    name: str = "read_file"
    description: str = "Read a text file from the repository."
    args_schema: type[BaseModel] = PathArg

    def act(self, path: str = ".") -> str:
        p = self._path(path)
        if not p.is_file():
            return f"ERROR: {path} is not a file"
        data = p.read_text(errors="replace")
        return data if len(data) <= MAX_READ else data[:MAX_READ] + "\n... (truncated)"


class WriteArgs(BaseModel):
    path: str = Field(..., description="Path relative to the repository root")
    content: str = Field(..., description="The complete new content of the file")


class WriteFile(WorkspaceTool):
    name: str = "write_file"
    description: str = "Create or overwrite a file in the repository with the given full content."
    args_schema: type[BaseModel] = WriteArgs

    def act(self, path: str, content: str) -> str:
        p = self._path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        existed = p.exists()
        p.write_text(content)
        return f"{'updated' if existed else 'created'} {path} ({len(content)} chars)"


class SearchArgs(BaseModel):
    pattern: str = Field(..., description="Regular expression to search for (git grep -E)")


class SearchCode(WorkspaceTool):
    name: str = "search_code"
    description: str = "Search tracked files for a regular expression. Returns file:line:match."
    args_schema: type[BaseModel] = SearchArgs

    def act(self, pattern: str) -> str:
        p = subprocess.run(["git", "grep", "-n", "-I", "-E", "-e", pattern], cwd=self._root,
                           capture_output=True, text=True, timeout=30)
        out = p.stdout or "(no matches)"
        return out[:MAX_OUT]


class CommandArgs(BaseModel):
    command: str = Field(..., description="Command line to run from the repository root")


class RunCommand(WorkspaceTool):
    name: str = "run_command"
    description: str = "Run an allowlisted command (e.g. tests) from the repository root."
    args_schema: type[BaseModel] = CommandArgs
    _allowed: list[str] = PrivateAttr(default_factory=list)

    def allow(self, prefixes: list[str]) -> "RunCommand":
        self._allowed = prefixes
        self.description = (
            "Run a command from the repository root. Allowed command prefixes: "
            + (", ".join(prefixes) if prefixes else "(none)")
        )
        return self

    def act(self, command: str) -> str:
        argv = shlex.split(command)
        if not any(argv[: len(shlex.split(a))] == shlex.split(a) for a in self._allowed):
            return f"ERROR: command not allowed. Allowed prefixes: {self._allowed}"
        if any(tok in command for tok in (";", "&&", "||", "|", "`", "$(", ">")):
            return "ERROR: shell operators are not allowed"
        try:
            p = subprocess.run(argv, cwd=self._root, capture_output=True, text=True, timeout=300)
        except subprocess.TimeoutExpired:
            return "ERROR: command timed out after 300s"
        out = f"exit code {p.returncode}\n--- stdout ---\n{p.stdout}\n--- stderr ---\n{p.stderr}"
        return out[-MAX_OUT:]


TOOL_CLASSES: dict[str, type[WorkspaceTool]] = {
    "list_files": ListFiles,
    "read_file": ReadFile,
    "write_file": WriteFile,
    "search_code": SearchCode,
    "run_command": RunCommand,
}

# Registry impl name -> class (builtin provider).
BUILTIN_IMPLS: dict[str, type[WorkspaceTool]] = {
    "fs.list_files": ListFiles,
    "fs.read_file": ReadFile,
    "fs.write_file": WriteFile,
    "fs.search_code": SearchCode,
    "shell.run_command": RunCommand,
}


def _schema_model(name: str, schema: dict[str, Any]) -> type[BaseModel]:
    """Pydantic args model from a JSON schema (top-level properties only; enough for tool calling)."""
    from pydantic import create_model

    py = {"string": str, "integer": int, "number": float, "boolean": bool, "array": list, "object": dict}
    req = set(schema.get("required", []))
    fields: dict[str, Any] = {}
    for prop, s in (schema.get("properties") or {}).items():
        t = py.get(s.get("type") if isinstance(s.get("type"), str) else "string", Any)
        desc = s.get("description", "")
        fields[prop] = (t, Field(..., description=desc)) if prop in req else (t | None, Field(None, description=desc))
    return create_model(f"{name.replace('.', '_')}_args", **fields)  # type: ignore[call-overload]


class McpTool(BaseTool):
    """A single MCP tool, registered as its own block and granted individually."""

    name: str
    description: str
    _server: dict[str, Any] = PrivateAttr()
    _remote: str = PrivateAttr()
    _report: Reporter = PrivateAttr()

    @classmethod
    def from_spec(cls, block_name: str, spec: dict[str, Any], report: Reporter) -> "McpTool":
        t = cls(name=block_name.replace(".", "__"), description=spec.get("description") or block_name,
                args_schema=_schema_model(block_name, spec.get("input_schema") or {}))
        t._server, t._remote, t._report = spec["server"], spec["impl"], report
        return t

    def _run(self, **kwargs: Any) -> str:
        from ..mcp_runtime import call_tool_sync

        args = {k: v for k, v in kwargs.items() if v is not None}
        try:
            out = call_tool_sync(self._server, self._remote, args)
            result = ("ERROR: " if out.get("is_error") else "") + out["result"]
        except Exception as e:
            result = f"ERROR: {e}"
        self._report(self.name, args, result)
        return result[:MAX_OUT]
