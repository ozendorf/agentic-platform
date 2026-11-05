// The building blocks offered by the step editor. Must stay in sync with the Python
// interpreter (workers/src/platform_worker/workflows/interpreter.py) and crews/tools.py.
import type { StepDef, StepType } from "./types";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", price: "$4 / $20 per MTok" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", price: "$2 / $10 per MTok" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", price: "$0.10 / $0.50 per MTok" },
] as const;
export const DEFAULT_MODEL = "claude-opus-5-5";

export const TOOLS = [
  { id: "list_files", label: "List files" },
  { id: "read_file", label: "Read file" },
  { id: "search_code", label: "Search code" },
  { id: "write_file", label: "Write file" },
  { id: "run_command", label: "Run command (allowlisted)" },
] as const;

export const STEP_TYPES: Record<StepType, { label: string; queue: string; description: string }> = {
  "git.prepare": { label: "Clone & branch", queue: "tools", description: "Clone the target repo into a run workspace and create a branch." },
  crew: { label: "CrewAI crew", queue: "agents", description: "A crew of agents with tools works in the workspace." },
  "human.approval": { label: "Human approval", queue: "—", description: "Show the diff and wait for Approve / Reject (durable, no timeout)." },
  "github.open_pr": { label: "Open pull request", queue: "tools", description: "Squash, push the branch and open a PR on GitHub." },
};

export function newStep(type: StepType, existing: StepDef[]): StepDef {
  const base = type.split(".").pop()!.replace("open_pr", "pr");
  let id = base;
  for (let i = 2; existing.some((s) => s.id === id); i++) id = `${base}-${i}`;
  const config: StepDef["config"] =
    type === "crew"
      ? {
          process: "sequential",
          allowed_commands: [],
          agents: [{ key: "engineer", role: "Software engineer", goal: "Implement the spec.", backstory: "", model: DEFAULT_MODEL, tools: ["list_files", "read_file", "search_code", "write_file"] }],
          tasks: [{ key: "implement", agent: "engineer", description: "Implement this spec:\n\n{spec}", expected_output: "A markdown summary of the change." }],
        }
      : type === "github.open_pr"
        ? { draft: false }
        : {};
  return { id, type, name: STEP_TYPES[type].label, config };
}

export function stepLabel(s: { type?: string; uses?: string; name?: string }): string {
  if (s.uses) return s.uses === "approval" ? "Human approval" : s.uses.replace(/^tool:/, "");
  return STEP_TYPES[s.type as StepType]?.label ?? s.type ?? "step";
}
