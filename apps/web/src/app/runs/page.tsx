import Link from "next/link";
import { Card, StatusPill, fmtDuration, fmtUsd, timeAgo } from "@/components/ui";
import { listRuns } from "@/lib/queries";

export const dynamic = "force-dynamic";

function elapsed(start: string, end: string | null) {
  return (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
}

export default async function RunsPage() {
  const runs = await listRuns(100);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-muted">
            <tr>
              {["Run", "Workflow", "Repo", "Status", "Cost", "Duration", "Started", "PR"].map((h) => (
                <th key={h} className="px-4 py-2.5 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-muted">No runs yet.</td></tr>
            )}
            {runs.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                <td className="px-4 py-2.5 font-mono text-xs"><Link href={`/runs/${r.id}`} className="text-accent hover:underline">{r.id.slice(0, 8)}</Link></td>
                <td className="px-4 py-2.5">{r.workflow_name} <span className="text-xs text-muted">v{r.version}</span></td>
                <td className="px-4 py-2.5 font-mono text-xs">{r.inputs.repo}</td>
                <td className="px-4 py-2.5"><StatusPill status={r.status} /></td>
                <td className="px-4 py-2.5 tabular-nums">{fmtUsd(r.cost_usd)}</td>
                <td className="px-4 py-2.5 tabular-nums text-muted">
                  {r.started_at ? fmtDuration(elapsed(r.started_at, r.finished_at)) : "—"}
                </td>
                <td className="px-4 py-2.5 text-muted">{timeAgo(r.created_at)}</td>
                <td className="px-4 py-2.5">{r.pr_url ? <a href={r.pr_url} target="_blank" rel="noreferrer" className="text-accent hover:underline">#{r.pr_url.split("/").pop()}</a> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
