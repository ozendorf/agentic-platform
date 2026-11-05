import { BUILTIN_CAPABILITIES, describeCapability } from "@/lib/capabilities";
import { type ToolSpec, listBlocks, listProviders, usage } from "@/lib/registry";

export const dynamic = "force-dynamic";

export async function GET() {
  const [blocks, providers, used] = await Promise.all([listBlocks(), listProviders(), usage()]);
  const caps = new Set(Object.keys(BUILTIN_CAPABILITIES));
  blocks.filter((b) => b.kind === "tool").forEach((b) => (b.spec as ToolSpec).capabilities.forEach((c) => caps.add(c)));
  for (const b of blocks) if (b.kind === "tool") delete (b.spec as Record<string, unknown>).server;
  return Response.json({
    blocks,
    // Never expose provider commands/env to the browser: name, status and counts only.
    providers: providers.map((p) => ({ id: p.id, name: p.name, kind: p.kind, status: p.status, error: p.error, synced_at: p.synced_at, tools: p.tools })),
    usage: used,
    capabilities: [...caps].sort().map((id) => ({ id, description: describeCapability(id) })),
  });
}
