"""Built-in tools, registered as first-class blocks (provider "builtin")."""
from __future__ import annotations

from typing import Any

PATH = {"type": "object", "properties": {"path": {"type": "string", "description": "Path relative to the repository root"}}}
WS = {"workspace": {"type": "string", "description": "Workspace handle from workspace.clone"}}


def tool(name: str, title: str, description: str, caps: list[str], modes: list[str],
         schema: dict[str, Any]) -> dict[str, Any]:
    return {"name": name, "title": title, "description": description,
            "spec": {"provider": "builtin", "impl": name, "description": description, "capabilities": caps,
                     "modes": modes, "input_schema": schema}}


BUILTIN_TOOLS: list[dict[str, Any]] = [
    tool("fs.list_files", "List files", "List files under a directory of the repository (recursive, skips build/vendor dirs).",
         ["repo:read"], ["agent", "action"], PATH),
    tool("fs.read_file", "Read file", "Read a text file from the repository.", ["repo:read"], ["agent", "action"], PATH),
    tool("fs.search_code", "Search code", "Search tracked files for a regular expression (git grep).",
         ["repo:read"], ["agent", "action"],
         {"type": "object", "properties": {"pattern": {"type": "string"}}, "required": ["pattern"]}),
    tool("fs.write_file", "Write file", "Create or overwrite a file in the repository with its full content.",
         ["repo:write"], ["agent", "action"],
         {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
          "required": ["path", "content"]}),
    tool("shell.run_command", "Run command", "Run an allowlisted command from the repository root (no shell operators).",
         ["exec"], ["agent", "action"],
         {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}),
    tool("workspace.clone", "Clone & branch", "Clone a GitHub repository into the run's workspace and create a working branch.",
         ["github:read"], ["action"],
         {"type": "object", "properties": {"repo": {"type": "string", "description": "owner/name"},
                                           "base_branch": {"type": "string"}}, "required": ["repo"]}),
    tool("workspace.diff", "Capture diff", "Commit pending changes and capture the diff against the base commit.",
         ["repo:read"], ["action"], {"type": "object", "properties": WS, "required": ["workspace"]}),
    tool("github.open_pr", "Open pull request", "Squash the branch to one commit, push it and open a pull request.",
         ["github:write"], ["action"],
         {"type": "object", "properties": {**WS, "repo": {"type": "string"}, "base_branch": {"type": "string"},
                                           "title": {"type": "string"}, "summary": {"type": "string"},
                                           "spec": {"type": "string"}, "draft": {"type": "boolean"}},
          "required": ["workspace", "repo"]}),
]
