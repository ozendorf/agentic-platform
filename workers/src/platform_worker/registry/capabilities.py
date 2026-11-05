"""Capabilities: what a tool can touch. A workflow grants a set, each tool declares what it
needs, and compile refuses a workflow that uses a tool outside its grant."""
from __future__ import annotations

BUILTIN_CAPABILITIES: dict[str, str] = {
    "repo:read": "Read files in the run's workspace",
    "repo:write": "Create or modify files in the run's workspace",
    "exec": "Run allowlisted commands in the workspace",
    "github:read": "Read from GitHub (clone repositories, read the API)",
    "github:write": "Push branches and open pull requests on GitHub",
}


def describe(cap: str) -> str:
    if cap in BUILTIN_CAPABILITIES:
        return BUILTIN_CAPABILITIES[cap]
    ns, _, level = cap.partition(":")
    return f"{'Read from' if level == 'read' else 'Write to'} {ns} (MCP)"


def mcp_capability(provider: str, read_only: bool) -> str:
    return f"{provider}:{'read' if read_only else 'write'}"
