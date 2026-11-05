"""Environment + static configuration shared by every worker process."""
from __future__ import annotations

import os
import subprocess
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(REPO_ROOT / ".env")

# Everything stays local: no CrewAI telemetry / cloud tracing.
for _k, _v in {"CREWAI_DISABLE_TELEMETRY": "true", "CREWAI_DISABLE_TRACKING": "true",
               "OTEL_SDK_DISABLED": "true", "CREWAI_TRACING_ENABLED": "false"}.items():
    os.environ.setdefault(_k, _v)

TASK_QUEUE_INTERPRETER = "wf-interpreter"
TASK_QUEUE_AGENTS = "agents"
TASK_QUEUE_TOOLS = "tools"

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://platform:platform@localhost:5432/app")
TEMPORAL_ADDRESS = os.environ.get("TEMPORAL_ADDRESS", "localhost:7233")
TEMPORAL_NAMESPACE = os.environ.get("TEMPORAL_NAMESPACE", "default")
WORKSPACES_DIR = (REPO_ROOT / os.environ.get("WORKSPACES_DIR", ".workspaces")).resolve()

# USD per million tokens (input, output). Anthropic first-party rates, 2026-10.
MODEL_PRICING: dict[str, tuple[float, float]] = {
    "claude-opus-5-5": (4.00, 20.00),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-haiku-5-5": (0.10, 0.50),
}
DEFAULT_MODEL = "claude-opus-5-5"


def cost_usd(model: str, tokens_in: int, tokens_out: int) -> float:
    pin, pout = MODEL_PRICING.get(model.split("/")[-1], (0.0, 0.0))
    return (tokens_in * pin + tokens_out * pout) / 1_000_000


@lru_cache(maxsize=1)
def github_token() -> str:
    tok = os.environ.get("GITHUB_TOKEN", "").strip()
    if tok:
        return tok
    try:
        return subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""
