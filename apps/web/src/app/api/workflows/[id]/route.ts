import { sql } from "@/lib/db";
import { UUID, bad, body } from "@/lib/http";
import { getWorkflow } from "@/lib/queries";
import { analyze } from "@/lib/compile";
import { type AnyWorkflowDef, isV2 } from "@/lib/types";
import { validateDefinition } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: RouteContext<"/api/workflows/[id]">) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return bad("not found", 404);
  const wf = await getWorkflow(id);
  return wf ? Response.json(wf) : bad("not found", 404);
}

/** Saving always creates a new immutable version; runs keep pointing at theirs. */
export async function PUT(req: Request, ctx: RouteContext<"/api/workflows/[id]">) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return bad("not found", 404);
  const b = await body<{ name?: string; description?: string; definition: AnyWorkflowDef }>(req);
  if (!b?.definition) return bad("definition is required");
  const problems = isV2(b.definition) ? (await analyze(b.definition)).problems : validateDefinition(b.definition);
  if (problems.length) return bad(problems);
  const version = await sql.begin(async (tx) => {
    const [cur] = await tx`SELECT max(version) AS v FROM workflow_versions WHERE workflow_id=${id}`;
    if (cur?.v == null) return null;
    const next = Number(cur.v) + 1;
    await tx`INSERT INTO workflow_versions (workflow_id, version, definition) VALUES (${id}, ${next}, ${tx.json(b.definition as never)})`;
    await tx`UPDATE workflows SET updated_at=now(),
      name=COALESCE(${b.name?.trim() || null}, name), description=COALESCE(${b.description ?? null}, description) WHERE id=${id}`;
    return next;
  });
  return version == null ? bad("not found", 404) : Response.json({ version });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/workflows/[id]">) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return bad("not found", 404);
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM runs r JOIN workflow_versions v ON v.id=r.workflow_version_id WHERE v.workflow_id=${id}`;
  if (n > 0) return bad("this workflow has runs; it can't be deleted", 409);
  await sql`DELETE FROM workflows WHERE id=${id}`;
  return new Response(null, { status: 204 });
}
