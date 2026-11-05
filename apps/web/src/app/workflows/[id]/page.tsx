import { notFound } from "next/navigation";
import { WorkflowEditor } from "@/components/WorkflowEditor";
import { WorkflowEditorV2 } from "@/components/WorkflowEditorV2";
import { isV2 } from "@/lib/types";
import { UUID } from "@/lib/http";
import { getWorkflow } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function WorkflowPage({ params }: PageProps<"/workflows/[id]">) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const wf = await getWorkflow(id);
  if (!wf) notFound();
  const d = wf.definition as unknown;
  if (isV2(d)) return <WorkflowEditorV2 id={wf.id} name={wf.name} description={wf.description} version={wf.version} definition={d} />;
  return <WorkflowEditor id={wf.id} name={wf.name} description={wf.description} version={wf.version} definition={wf.definition} />;
}
