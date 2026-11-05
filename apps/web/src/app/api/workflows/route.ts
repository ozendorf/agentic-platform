import { sql } from "@/lib/db";
import { bad, body } from "@/lib/http";
import { listWorkflows } from "@/lib/queries";
import { analyze } from "@/lib/compile";
import { type AnyWorkflowDef, isV2 } from "@/lib/types";
import { validateDefinition } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await listWorkflows());
}

function slugify(s: string) {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "workflow";
}

export async function POST(req: Request) {
  const b = await body<{ name?: string; description?: string; definition?: AnyWorkflowDef }>(req);
  if (!b?.name?.trim()) return bad("name is required");
  const definition = b.definition ?? { steps: [] };
  if (definition.steps.length) {
    const problems = isV2(definition) ? (await analyze(definition)).problems : validateDefinition(definition);
    if (problems.length) return bad(problems);
  }
  let slug = slugify(b.name);
  const taken = await sql`SELECT slug FROM workflows WHERE slug LIKE ${slug + "%"}`;
  if (taken.some((r) => r.slug === slug)) slug = `${slug}-${taken.length + 1}`;
  const id = await sql.begin(async (tx) => {
    const [wf] = await tx`INSERT INTO workflows (slug, name, description) VALUES (${slug}, ${b.name!.trim()}, ${b.description ?? ""}) RETURNING id`;
    await tx`INSERT INTO workflow_versions (workflow_id, version, definition) VALUES (${wf.id}, 1, ${tx.json(definition as never)})`;
    return wf.id as string;
  });
  return Response.json({ id }, { status: 201 });
}
