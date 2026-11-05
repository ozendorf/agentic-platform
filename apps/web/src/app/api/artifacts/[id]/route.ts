import { sql } from "@/lib/db";
import { UUID, bad } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: RouteContext<"/api/artifacts/[id]">) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return bad("not found", 404);
  const [a] = await sql`SELECT content FROM artifacts WHERE id=${id}`;
  if (!a) return bad("not found", 404);
  return new Response(a.content, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
