import { notFound } from "next/navigation";
import { RunView } from "@/components/RunView";
import { UUID } from "@/lib/http";

export default async function RunPage({ params }: PageProps<"/runs/[id]">) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <RunView id={id} />;
}
