import { StartRunForm } from "@/components/StartRunForm";
import { listWorkflows } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function NewRunPage({ searchParams }: PageProps<"/runs/new">) {
  const { workflow } = await searchParams;
  const workflows = (await listWorkflows()).map((w) => ({ id: w.id, name: w.name, version: w.version }));
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Start a run</h1>
        <p className="mt-1 text-sm text-muted">The run pins the workflow&apos;s current version. Later edits won&apos;t affect it.</p>
      </div>
      <StartRunForm workflows={workflows} initialWorkflow={typeof workflow === "string" ? workflow : workflows[0]?.id} />
    </div>
  );
}
