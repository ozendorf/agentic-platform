export type StepType = "git.prepare" | "crew" | "human.approval" | "github.open_pr";

export interface CrewAgent {
  key: string;
  role: string;
  goal: string;
  backstory?: string;
  model?: string;
  tools?: string[];
  max_iter?: number;
}

export interface CrewTask {
  key: string;
  agent: string;
  description: string;
  expected_output: string;
  context?: string[];
}

export interface StepDef {
  id: string;
  type: StepType;
  name?: string;
  config: Record<string, unknown> & {
    agents?: CrewAgent[];
    tasks?: CrewTask[];
    process?: "sequential" | "hierarchical";
    allowed_commands?: string[];
    draft?: boolean;
    title?: string;
  };
}

export interface WorkflowDef {
  steps: StepDef[];
}

export type RunStatus = "pending" | "running" | "waiting_approval" | "succeeded" | "failed" | "rejected";
export type StepStatus = "pending" | "running" | "waiting" | "succeeded" | "failed" | "skipped";

export interface RunEvent {
  id: number;
  step_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
}

// ---- v2: workflows assembled from registry blocks --------------------------------
export interface StepDefV2 {
  id: string;
  name?: string;
  /** "tool:<name>[@v]" | "agent:<name>[@v]" | "crew:<name>[@v]" | "approval" */
  uses: string;
  with?: Record<string, unknown>;
  task?: { description: string; expected_output: string };
}

export interface WorkflowDefV2 {
  version: 2;
  policy: { capabilities: string[]; allowed_commands?: string[] };
  steps: StepDefV2[];
}

export type AnyWorkflowDef = WorkflowDef | WorkflowDefV2;

export function isV2(d: unknown): d is WorkflowDefV2 {
  return !!d && (d as { version?: number }).version === 2;
}
