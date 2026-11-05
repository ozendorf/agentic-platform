import { sql } from "@/lib/db";
import { bad } from "@/lib/http";
import { INTERPRETER_QUEUE, temporal } from "@/lib/temporal";

export const dynamic = "force-dynamic";

/**
 * Re-sync an MCP provider that an operator already registered with `uv run mcp-add`.
 * Registering providers (i.e. choosing the command a worker executes) is CLI-only on purpose.
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/providers/[name]/sync">) {
  const { name } = await ctx.params;
  const [p] = await sql`UPDATE tool_providers SET status='syncing' WHERE name=${name} AND kind='mcp' RETURNING id`;
  if (!p) return bad("not found", 404);
  await (await temporal()).workflow.start("registry.sync_provider", {
    workflowId: `sync-provider-${name}-${Date.now()}`,
    taskQueue: INTERPRETER_QUEUE,
    args: [p.id],
  });
  return Response.json({ ok: true });
}
