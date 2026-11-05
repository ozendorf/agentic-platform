import { notFound } from "next/navigation";
import { BlockEditor } from "@/components/BlockEditor";

export default async function BlockPage({ params }: PageProps<"/catalog/[kind]/[name]">) {
  const { kind, name } = await params;
  if (kind !== "tool" && kind !== "agent" && kind !== "crew") notFound();
  if (kind === "tool" && name === "new") notFound();
  return <BlockEditor kind={kind} name={decodeURIComponent(name)} />;
}
