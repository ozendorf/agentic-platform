import { UUID, bad } from "@/lib/http";
import { getRunDetail } from "@/lib/queries";
import { temporalRunUrl } from "@/lib/temporal";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: RouteContext<"/api/runs/[id]">) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return bad("not found", 404);
  const d = await getRunDetail(id);
  if (!d) return bad("not found", 404);
  return Response.json({ ...d, temporal_url: temporalRunUrl(d.run.temporal_workflow_id) });
}
