import Link from "next/link";
import { Card, StatusPill, timeAgo } from "@/components/ui";
import { NewWorkflowButton } from "@/components/NewWorkflowButton";
import { stepLabel } from "@/lib/catalog";
import { listWorkflows } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  const workflows = await listWorkflows();
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workflows</h1>
          <p className="mt-1 text-sm text-muted">Durable agentic workflows, orchestrated by Temporal and powered by CrewAI.</p>
        </div>
        <NewWorkflowButton />
      </div>
      {workflows.length === 0 && (
        <Card className="p-8 text-center text-sm text-muted">No workflows yet. Run <code>uv run seed</code> in <code>workers/</code> or create one.</Card>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {workflows.map((w) => (
          <Card key={w.id} className="flex flex-col p-5 transition hover:border-accent/50">
            <div className="flex items-start justify-between gap-3">
              <Link href={`/workflows/${w.id}`} className="font-medium hover:underline">{w.name}</Link>
              <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">v{w.version}</span>
            </div>
            <p className="mt-1.5 line-clamp-2 text-sm text-muted">{w.description || "No description"}</p>
            <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs">
              {w.definition.steps.map((s, i) => (
                <span key={s.id} className="flex items-center gap-1.5">
                  {i > 0 && <span className="text-muted">→</span>}
                  <span className="rounded border border-border px-1.5 py-0.5">{stepLabel(s)}</span>
                </span>
              ))}
            </div>
            <div className="mt-5 flex items-center justify-between border-t border-border pt-3 text-xs text-muted">
              <span>
                {w.runs} run{w.runs === 1 ? "" : "s"} · updated {timeAgo(w.updated_at)}
                {w.last_run_status && <span className="ml-2"><StatusPill status={w.last_run_status} /></span>}
              </span>
              <div className="flex gap-3">
                <Link href={`/workflows/${w.id}`} className="hover:text-text">Edit</Link>
                <Link href={`/runs/new?workflow=${w.id}`} className="font-medium text-accent hover:underline">Run →</Link>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
