"""uv run mcp-add --name github --env GITHUB_PERSONAL_ACCESS_TOKEN='$GITHUB_TOKEN' -- docker run -i --rm \\
        -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server

Registers (or updates) a stdio MCP server and syncs its tools into the registry.
Env values starting with $ are resolved at call time and never stored."""
from __future__ import annotations

import argparse

from .registry.mcp_sync import add_provider, sync_provider


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True, help="namespace for the tools, e.g. github")
    ap.add_argument("--env", action="append", default=[], help="NAME=value or NAME=$SECRET")
    ap.add_argument("command", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = [c for c in a.command if c != "--"]
    env = dict(e.split("=", 1) for e in a.env)
    pid = add_provider(a.name, cmd[0], cmd[1:], env)
    print(sync_provider(pid))


if __name__ == "__main__":
    main()
