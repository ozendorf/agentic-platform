import { analyze } from "@/lib/compile";
import { bad, body } from "@/lib/http";
import type { WorkflowDefV2 } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const b = await body<{ definition?: WorkflowDefV2 }>(req);
  if (!b?.definition) return bad("definition is required");
  return Response.json(await analyze(b.definition));
}
