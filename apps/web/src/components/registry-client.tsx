"use client";

import { useCallback, useEffect, useState } from "react";

export interface ClientBlock {
  kind: "tool" | "agent" | "crew";
  name: string;
  title: string;
  description: string;
  owner: string;
  archived: boolean;
  version: number;
  versions: number[];
  spec: Record<string, unknown> & {
    capabilities?: string[];
    modes?: string[];
    provider?: string;
    input_schema?: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
    tools?: string[];
    model?: string;
    role?: string;
    goal?: string;
    backstory?: string;
    agents?: { key: string; ref: string }[];
    tasks?: { key: string; agent: string; description: string; expected_output: string; context?: string[] }[];
    process?: string;
  };
  provider: string | null;
  updated_at: string;
}

export interface RegistryData {
  blocks: ClientBlock[];
  providers: { id: string; name: string; kind: string; status: string; error: string | null; synced_at: string | null; tools: number }[];
  usage: Record<string, string[]>;
  capabilities: { id: string; description: string }[];
}

export function useRegistry() {
  const [data, setData] = useState<RegistryData | null>(null);
  const reload = useCallback(async () => {
    const r = await fetch("/api/registry", { cache: "no-store" });
    if (r.ok) setData(await r.json());
  }, []);
  useEffect(() => {
    fetch("/api/registry", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setData(j));
  }, []);
  return { data, reload };
}

export function CapChip({ cap, granted }: { cap: string; granted?: boolean }) {
  const write = cap === "exec" || cap.endsWith(":write");
  return (
    <span
      title={granted === false ? "not granted by this workflow" : undefined}
      className={[
        "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[11px]",
        granted === false ? "bg-err/12 text-err ring-1 ring-err/30" : write ? "bg-warn/12 text-warn" : "bg-surface-2 text-muted",
      ].join(" ")}
    >
      {cap}
    </span>
  );
}
