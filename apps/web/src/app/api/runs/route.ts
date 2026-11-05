import { sql } from "@/lib/db";
import { UUID, bad, body } from "@/lib/http";
import { listRuns } from "@/lib/queries";
import { analyze } from "@/lib/compile";
import { INTERPRETER_QUEUE, temporal } from "@/lib/temporal";
import { isV2 } from "@/lib/types";

export const dynamic = "force-dynamic";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
const MAX_SPEC = 200_000;

export async function GET() {
  return Response.json(await listRuns());
}

export async function POST(req: Request) {
  const b = await body<{ workflowId?: string; repo?: string; base_branch?: string; spec?: string }>(req);
  if (!b || !UUID.test(b.workflowId ?? "")) return bad("workflowId is required");
  const repo = (b.repo ?? "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  const base = (b.base_branch ?? "main").trim() || "main";
  const spec = b.spec ?? "";
  const problems = [
    !REPO.test(repo) && "repo must look like owner/name",
    !BRANCH.test(base) && "base branch is invalid",
    !spec.trim() && "the markdown spec is empty",
    spec.length > MAX_SPEC && `the spec is too large (max ${MAX_SPEC / 1000} KB)`,
  ].filter(Boolean) as string[];
  if (problems.length) return bad(problems);

  const [v] = await sql`SELECT id, definition FROM workflow_versions WHERE workflow_id=${b.workflowId!}
                        ORDER BY version DESC LIMIT 1`;
  if (!v) return bad("workflow not found", 404);
  if (!v.definition?.steps?.length) return bad("this workflow has no steps yet");

  if (isV2(v.definition)) {
    const { problems: compileProblems } = await analyze(v.definition);
    if (compileProblems.length) return bad(["this workflow doesn't compile:", ...compileProblems]);
  }
  const inputs = { repo, base_branch: base, spec };
  const [run] = await sql`INSERT INTO runs (workflow_version_id, temporal_workflow_id, inputs)
    VALUES (${v.id}, ${"pending-" + crypto.randomUUID()}, ${sql.json(inputs)}) RETURNING id`;
  const workflowId = `run-${run.id}`;
  await sql`UPDATE runs SET temporal_workflow_id=${workflowId} WHERE id=${run.id}`;

  try {
    const client = await temporal();
    // Shape matches the Python RunInput dataclass. The definition snapshot is pinned here.
    await client.workflow.start(isV2(v.definition) ? "interpreter.v2" : "interpreter", {
      workflowId,
      taskQueue: INTERPRETER_QUEUE,
      args: [{ run_id: run.id, definition: v.definition, inputs }],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sql`UPDATE runs SET status='failed', error=${"could not start: " + msg}, finished_at=now() WHERE id=${run.id}`;
    return bad(`Temporal is unreachable (${msg}). Is docker compose up?`, 503);
  }
  return Response.json({ id: run.id }, { status: 201 });
}
