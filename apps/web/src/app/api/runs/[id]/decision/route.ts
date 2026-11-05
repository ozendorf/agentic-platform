import { sql } from "@/lib/db";
import { UUID, bad, body } from "@/lib/http";
import { temporal } from "@/lib/temporal";

export const dynamic = "force-dynamic";

/** Approve or reject: sends a Temporal signal; the workflow resumes on whichever worker is up. */
export async function POST(req: Request, ctx: RouteContext<"/api/runs/[id]/decision">) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return bad("not found", 404);
  const b = await body<{ approved?: boolean; comment?: string }>(req);
  if (typeof b?.approved !== "boolean") return bad("approved must be true or false");
  const [run] = await sql`SELECT status, temporal_workflow_id FROM runs WHERE id=${id}`;
  if (!run) return bad("not found", 404);
  if (run.status !== "waiting_approval") return bad(`run is ${run.status}, not waiting for approval`, 409);
  const handle = (await temporal()).workflow.getHandle(run.temporal_workflow_id);
  await handle.signal(b.approved ? "approve" : "reject", (b.comment ?? "").slice(0, 2000), "local-user");
  return Response.json({ ok: true });
}
