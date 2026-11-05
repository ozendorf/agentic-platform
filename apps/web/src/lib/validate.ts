import { MODELS, STEP_TYPES, TOOLS } from "./catalog";
import type { WorkflowDef } from "./types";

const ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const modelIds = new Set<string>(MODELS.map((m) => m.id));
const toolIds = new Set<string>(TOOLS.map((t) => t.id));

/** Returns a list of human-readable problems; empty means valid. */
export function validateDefinition(def: unknown): string[] {
  const errs: string[] = [];
  const d = def as WorkflowDef;
  if (!d || !Array.isArray(d.steps) || d.steps.length === 0) return ["a workflow needs at least one step"];
  const ids = new Set<string>();
  let prepared = false;
  d.steps.forEach((s, i) => {
    const at = `step ${i + 1} (${s?.id ?? "?"})`;
    if (!s || !ID.test(s.id ?? "")) errs.push(`${at}: id must be lowercase letters, digits, - or _`);
    if (ids.has(s.id)) errs.push(`${at}: duplicate id`);
    ids.add(s.id);
    if (!(s.type in STEP_TYPES)) errs.push(`${at}: unknown type ${s.type}`);
    if (s.type === "git.prepare") prepared = true;
    if ((s.type === "crew" || s.type === "github.open_pr" || s.type === "human.approval") && !prepared)
      errs.push(`${at}: needs a "Clone & branch" step before it`);
    if (s.type === "crew") {
      const agents = s.config.agents ?? [];
      const tasks = s.config.tasks ?? [];
      if (!agents.length) errs.push(`${at}: a crew needs at least one agent`);
      if (!tasks.length) errs.push(`${at}: a crew needs at least one task`);
      const keys = new Set(agents.map((a) => a.key));
      agents.forEach((a) => {
        if (!ID.test(a.key ?? "")) errs.push(`${at}: agent key "${a.key}" is invalid`);
        if (!a.role?.trim() || !a.goal?.trim()) errs.push(`${at}: agent ${a.key} needs a role and a goal`);
        if (a.model && !modelIds.has(a.model)) errs.push(`${at}: agent ${a.key} uses unknown model ${a.model}`);
        (a.tools ?? []).forEach((t) => toolIds.has(t) || errs.push(`${at}: agent ${a.key} has unknown tool ${t}`));
      });
      const seen = new Set<string>();
      tasks.forEach((t) => {
        if (!ID.test(t.key ?? "")) errs.push(`${at}: task key "${t.key}" is invalid`);
        if (!keys.has(t.agent)) errs.push(`${at}: task ${t.key} is assigned to unknown agent "${t.agent}"`);
        if (!t.description?.trim() || !t.expected_output?.trim()) errs.push(`${at}: task ${t.key} needs a description and expected output`);
        (t.context ?? []).forEach((c) => seen.has(c) || errs.push(`${at}: task ${t.key} context "${c}" must be an earlier task`));
        seen.add(t.key);
      });
    }
  });
  return errs;
}
