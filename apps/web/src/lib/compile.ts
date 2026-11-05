import "server-only";
import { MODELS } from "./catalog";
import { type AgentSpec, type Block, type CrewSpec, type ToolSpec, getBlock } from "./registry";
import type { WorkflowDefV2 } from "./types";

// Editor-time mirror of workers/src/platform_worker/registry/compile.py. The Python compiler is
// authoritative (it runs at the start of every run); this one powers live feedback in the UI.

const REF = /^(tool|agent|crew):([A-Za-z0-9_.-]+)(?:@(\d+))?$/;
const STEP_ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const EXPR = /\{\{\s*([A-Za-z_][\w-]*(?:\.[\w-]+)*)\s*\}\}/g;
const TEMPLATE_VAR = /\{([A-Za-z_]\w*)\}/g;
const models = new Set<string>(MODELS.map((m) => m.id));

export interface StepAnalysis {
  id: string;
  kind: "action" | "crew" | "approval" | "unknown";
  ref: string;
  version: number | null;
  latest: number | null;
  needs: string[];
  tools: string[];
  inputs: { key: string; required: boolean; description?: string }[];
  outputs: string[];
}

export interface Analysis {
  problems: string[];
  steps: StepAnalysis[];
  required: string[];
}

function refsIn(v: unknown): string[] {
  if (typeof v === "string") return [...v.matchAll(EXPR)].map((m) => m[1]);
  if (Array.isArray(v)) return v.flatMap(refsIn);
  if (v && typeof v === "object") return Object.values(v).flatMap(refsIn);
  return [];
}

const OUTPUTS: Record<string, string[]> = {
  "workspace.clone": ["workspace", "branch", "base_sha", "base_branch", "repo", "files"],
  "workspace.diff": ["diff_artifact_id", "stat", "files_changed"],
  "github.open_pr": ["pr_url", "pr_number", "branch"],
};

export async function analyze(def: WorkflowDefV2): Promise<Analysis> {
  const problems: string[] = [];
  const granted = new Set(def.policy?.capabilities ?? []);
  const required = new Set<string>();
  const cache = new Map<string, Promise<Block | null>>();
  const load = (kind: "tool" | "agent" | "crew", name: string, v?: number) => {
    const k = `${kind}:${name}@${v ?? ""}`;
    if (!cache.has(k)) cache.set(k, getBlock(kind, name, v));
    return cache.get(k)!;
  };
  const parse = (ref: string, dflt?: string) => {
    const m = REF.exec(dflt && !ref.includes(":") ? `${dflt}:${ref}` : ref);
    return m ? { kind: m[1] as "tool" | "agent" | "crew", name: m[2], version: m[3] ? Number(m[3]) : undefined } : null;
  };

  async function tool(ref: string, mode: "agent" | "action", at: string, needs: Set<string>, names: string[]) {
    const r = parse(ref, "tool");
    if (!r) return problems.push(`${at}: invalid tool reference ${ref}`), null;
    const b = await load("tool", r.name, r.version);
    if (!b) return problems.push(`${at}: tool '${r.name}' is not in the registry`), null;
    const spec = b.spec as ToolSpec;
    if (!spec.modes.includes(mode)) problems.push(`${at}: tool '${r.name}' can't be used as ${mode === "agent" ? "an agent tool" : "an action"}`);
    spec.capabilities.forEach((c) => needs.add(c));
    names.push(r.name);
    return { b, spec };
  }

  async function agent(ref: string, at: string, needs: Set<string>, names: string[]) {
    const r = parse(ref, "agent");
    if (!r) return problems.push(`${at}: invalid agent reference ${ref}`), null;
    const b = await load("agent", r.name, r.version);
    if (!b) return problems.push(`${at}: agent '${r.name}' is not in the registry`), null;
    const spec = b.spec as AgentSpec;
    if (spec.model && !models.has(spec.model)) problems.push(`${at}: agent '${r.name}' uses an unknown model`);
    for (const t of spec.tools ?? []) await tool(t, "agent", `${at} › agent ${r.name}`, needs, names);
    return b;
  }

  const steps: StepAnalysis[] = [];
  const earlier = new Set<string>();
  for (const [i, s] of (def.steps ?? []).entries()) {
    const at = `step ${i + 1} (${s.id || "?"})`;
    if (!STEP_ID.test(s.id ?? "")) problems.push(`${at}: id must be lowercase letters, digits, - or _`);
    if (earlier.has(s.id)) problems.push(`${at}: duplicate id`);
    for (const p of [...refsIn(s.with ?? {}), ...refsIn(s.task ?? {})]) {
      const [root, sid] = p.split(".");
      if (!["inputs", "steps", "run"].includes(root)) problems.push(`${at}: unknown expression root in {{ ${p} }}`);
      else if (root === "steps" && !earlier.has(sid)) problems.push(`${at}: {{ ${p} }} refers to a step that doesn't run before this one`);
    }
    const needs = new Set<string>();
    const tools: string[] = [];
    const a: StepAnalysis = { id: s.id, kind: "unknown", ref: s.uses, version: null, latest: null, needs: [], tools, inputs: [], outputs: [] };
    if (s.uses === "approval") {
      a.kind = "approval";
      a.inputs = [{ key: "workspace", required: false, description: "Show this workspace's diff to the reviewer" }, { key: "message", required: false }];
      a.outputs = ["approved", "comment", "stat", "diff_artifact_id"];
      if (s.with?.workspace) needs.add("repo:read");
    } else {
      const r = parse(s.uses ?? "");
      if (!r) problems.push(`${at}: pick a block for this step`);
      else if (r.kind === "tool") {
        a.kind = "action";
        const t = await tool(s.uses, "action", at, needs, tools);
        if (t) {
          a.version = t.b.version;
          a.latest = t.b.versions.at(-1) ?? t.b.version;
          const req = new Set(t.spec.input_schema?.required ?? []);
          a.inputs = Object.entries(t.spec.input_schema?.properties ?? {}).map(([key, p]) => ({ key, required: req.has(key), description: p.description }));
          a.outputs = OUTPUTS[r.name] ?? ["result", "data"];
          for (const k of req) if (!(k in (s.with ?? {}))) problems.push(`${at}: tool '${r.name}' needs input '${k}'`);
        }
      } else if (r.kind === "agent") {
        a.kind = "crew";
        const b = await agent(s.uses, at, needs, tools);
        if (b) {
          a.version = b.version;
          a.latest = b.versions.at(-1) ?? b.version;
        }
        if (!s.task?.description || !s.task?.expected_output) problems.push(`${at}: an agent step needs a task description and expected output`);
        const vars = new Set([...(s.task?.description ?? "").matchAll(TEMPLATE_VAR)].map((m) => m[1]));
        a.inputs = [{ key: "workspace", required: needs.has("repo:read") || needs.has("repo:write") || needs.has("exec") }, ...[...vars].map((key) => ({ key, required: true }))];
        a.outputs = ["summary", "output_artifact_id", "changed"];
      } else {
        a.kind = "crew";
        const b = await load("crew", r.name, r.version);
        if (!b) problems.push(`${at}: crew '${r.name}' is not in the registry`);
        else {
          a.version = b.version;
          a.latest = b.versions.at(-1) ?? b.version;
          const spec = b.spec as CrewSpec;
          for (const ag of spec.agents) await agent(ag.ref, `${at} › crew ${r.name}`, needs, tools);
          const vars = new Set(spec.tasks.flatMap((t) => [...`${t.description} ${t.expected_output}`.matchAll(TEMPLATE_VAR)].map((m) => m[1])));
          const ws = needs.has("repo:read") || needs.has("repo:write") || needs.has("exec");
          a.inputs = [...(ws ? [{ key: "workspace", required: true, description: "Workspace for the crew's file tools" }] : []), ...[...vars].map((key) => ({ key, required: true }))];
          for (const v of vars) if (!(v in (s.with ?? {}))) problems.push(`${at}: crew '${r.name}' uses {${v}} in its tasks; set it in "with"`);
        }
        a.outputs = ["summary", "output_artifact_id", "changed"];
      }
    }
    a.needs = [...needs].sort();
    a.needs.forEach((c) => required.add(c));
    const missing = a.needs.filter((c) => !granted.has(c));
    if (missing.length) problems.push(`${at}: needs ${missing.join(", ")}, which this workflow doesn't grant`);
    steps.push(a);
    earlier.add(s.id);
  }
  if (!def.steps?.length) problems.push("a workflow needs at least one step");
  return { problems, steps, required: [...required].sort() };
}
