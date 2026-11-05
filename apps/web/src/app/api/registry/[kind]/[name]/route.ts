import { MODELS } from "@/lib/catalog";
import { bad, body } from "@/lib/http";
import { type AgentSpec, type CrewSpec, type ToolSpec, getBlock, saveBlock } from "@/lib/registry";

export const dynamic = "force-dynamic";

const NAME = /^[a-z0-9][a-z0-9-]{1,60}$/;
const KEY = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const models = new Set<string>(MODELS.map((m) => m.id));
const bare = (ref: string, kind: string) => ref.replace(new RegExp(`^${kind}:`), "").replace(/@\d+$/, "");

export async function GET(req: Request, ctx: RouteContext<"/api/registry/[kind]/[name]">) {
  const { kind, name } = await ctx.params;
  if (!["tool", "agent", "crew"].includes(kind)) return bad("not found", 404);
  const v = new URL(req.url).searchParams.get("version");
  const b = await getBlock(kind as "tool", name, v ? Number(v) : undefined);
  if (!b) return bad("not found", 404);
  if (kind === "tool") delete (b.spec as Record<string, unknown>).server; // never ship provider commands to browsers
  return Response.json(b);
}

async function validate(kind: string, spec: unknown): Promise<string[]> {
  const p: string[] = [];
  if (kind === "agent") {
    const a = spec as AgentSpec;
    if (!a?.role?.trim() || !a?.goal?.trim()) p.push("an agent needs a role and a goal");
    if (a?.model && !models.has(a.model)) p.push(`unknown model ${a.model}`);
    for (const t of a?.tools ?? []) {
      const tb = await getBlock("tool", bare(t, "tool"));
      if (!tb) p.push(`tool ${t} is not in the registry`);
      else if (!(tb.spec as ToolSpec).modes.includes("agent")) p.push(`tool ${t} can't be given to an agent`);
    }
  } else {
    const c = spec as CrewSpec;
    if (!c?.agents?.length || !c?.tasks?.length) p.push("a crew needs at least one agent and one task");
    const keys = new Set<string>();
    for (const a of c?.agents ?? []) {
      if (!KEY.test(a.key)) p.push(`agent key "${a.key}" is invalid`);
      if (keys.has(a.key)) p.push(`agent key "${a.key}" is used twice`);
      keys.add(a.key);
      if (!(await getBlock("agent", bare(a.ref, "agent")))) p.push(`agent ${a.ref} is not in the registry`);
    }
    const seen = new Set<string>();
    for (const t of c?.tasks ?? []) {
      if (!KEY.test(t.key)) p.push(`task key "${t.key}" is invalid`);
      if (!keys.has(t.agent)) p.push(`task ${t.key} is assigned to unknown agent "${t.agent}"`);
      if (!t.description?.trim() || !t.expected_output?.trim()) p.push(`task ${t.key} needs a description and an expected output`);
      (t.context ?? []).forEach((x) => seen.has(x) || p.push(`task ${t.key}: context "${x}" must be an earlier task`));
      seen.add(t.key);
    }
  }
  return p;
}

/** Save a new immutable version of an agent or crew (created on first save). Tools come from providers. */
export async function PUT(req: Request, ctx: RouteContext<"/api/registry/[kind]/[name]">) {
  const { kind, name } = await ctx.params;
  if (kind !== "agent" && kind !== "crew") return bad("only agents and crews are edited here; tools come from providers");
  if (!NAME.test(name)) return bad("name must be lowercase letters, digits and dashes");
  const b = await body<{ title?: string; description?: string; spec?: unknown }>(req);
  if (!b?.spec || !b.title?.trim()) return bad("title and spec are required");
  const problems = await validate(kind, b.spec);
  if (problems.length) return bad(problems);
  const version = await saveBlock(kind, name, b.title.trim(), b.description ?? "", b.spec);
  return Response.json({ version });
}
