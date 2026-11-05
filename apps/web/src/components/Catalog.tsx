"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CapChip, type ClientBlock, useRegistry } from "./registry-client";
import { Button, Card, Input, StatusPill, cx, timeAgo } from "./ui";

type Tab = "agent" | "crew" | "tool" | "providers";
const TABS: { id: Tab; label: string }[] = [
  { id: "agent", label: "Agents" },
  { id: "crew", label: "Crews" },
  { id: "tool", label: "Tools" },
  { id: "providers", label: "Providers" },
];

export function Catalog() {
  const { data, reload } = useRegistry();
  const [tab, setTab] = useState<Tab>("agent");
  const [q, setQ] = useState("");
  const [cap, setCap] = useState<string | null>(null);

  const blocks = useMemo(() => {
    if (!data) return [];
    const needle = q.toLowerCase();
    return data.blocks.filter(
      (b) =>
        b.kind === tab &&
        !b.archived &&
        (!needle || `${b.name} ${b.title} ${b.description}`.toLowerCase().includes(needle)) &&
        (!cap || (b.spec.capabilities ?? []).includes(cap)),
    );
  }, [data, tab, q, cap]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { providers: data?.providers.length ?? 0 };
    data?.blocks.forEach((b) => {
      if (!b.archived) c[b.kind] = (c[b.kind] ?? 0) + 1;
    });
    return c;
  }, [data]);

  const toolsByProvider = useMemo(() => {
    const g: Record<string, ClientBlock[]> = {};
    blocks.forEach((b) => (g[b.provider ?? "builtin"] ??= []).push(b));
    return g;
  }, [blocks]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Catalog</h1>
          <p className="mt-1 text-sm text-muted">Versioned building blocks. Workflows reference them by name and pin a version per run.</p>
        </div>
        {(tab === "agent" || tab === "crew") && (
          <Link href={`/catalog/${tab}/new`}><Button variant="primary">+ New {tab}</Button></Link>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => { setTab(t.id); setCap(null); }}
            className={cx("-mb-px border-b-2 px-3 py-2 text-sm", tab === t.id ? "border-accent font-medium" : "border-transparent text-muted hover:text-text")}
          >
            {t.label} <span className="ml-1 text-xs text-muted">{counts[t.id] ?? 0}</span>
          </button>
        ))}
        {tab !== "providers" && (
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="mb-1 ml-auto w-56" />
        )}
      </div>

      {!data && <p className="text-sm text-muted">Loading…</p>}

      {data && tab === "tool" && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted">Capability:</span>
            <button onClick={() => setCap(null)} className={cx("rounded px-2 py-0.5", !cap ? "bg-accent text-accent-fg" : "bg-surface-2")}>all</button>
            {data.capabilities.map((c) => (
              <button key={c.id} title={c.description} onClick={() => setCap(cap === c.id ? null : c.id)}
                className={cx("rounded px-2 py-0.5 font-mono", cap === c.id ? "bg-accent text-accent-fg" : "bg-surface-2")}>{c.id}</button>
            ))}
          </div>
          {Object.entries(toolsByProvider).map(([prov, tools]) => (
            <section key={prov} className="space-y-2">
              <h2 className="text-sm font-semibold">{prov === "builtin" ? "Built-in" : `${prov} (MCP)`} <span className="font-normal text-muted">· {tools.length}</span></h2>
              <Card className="divide-y divide-border">
                {tools.map((t) => (
                  <div key={t.name} className="flex flex-wrap items-start gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{t.name}</span>
                        <span className="font-mono text-[11px] text-muted">v{t.version}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted">{t.description}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {(t.spec.modes ?? []).map((m) => <span key={m} className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted">{m}</span>)}
                      {(t.spec.capabilities ?? []).map((c) => <CapChip key={c} cap={c} />)}
                    </div>
                  </div>
                ))}
              </Card>
            </section>
          ))}
        </>
      )}

      {data && (tab === "agent" || tab === "crew") && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {blocks.map((b) => {
            const used = data.usage[`${b.kind}:${b.name}`] ?? [];
            const tools = tab === "agent" ? b.spec.tools ?? [] : [];
            return (
              <Card key={b.name} className="flex flex-col p-5">
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/catalog/${b.kind}/${b.name}`} className="font-medium hover:underline">{b.title}</Link>
                  <span className="shrink-0 font-mono text-[11px] text-muted">{b.kind}:{b.name}@{b.version}</span>
                </div>
                <p className="mt-1.5 line-clamp-2 text-sm text-muted">{b.description || "No description"}</p>
                {tab === "agent" && (
                  <div className="mt-3 space-y-2 text-xs">
                    <div className="text-muted">{b.spec.role} · <span className="font-mono">{String(b.spec.model ?? "default").replace("claude-", "")}</span></div>
                    <div className="flex flex-wrap gap-1">{tools.map((t) => <span key={t} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono">{t}</span>)}</div>
                  </div>
                )}
                {tab === "crew" && (
                  <div className="mt-3 text-xs text-muted">
                    {(b.spec.agents ?? []).map((a) => a.ref.replace("agent:", "")).join(" → ")} · {(b.spec.tasks ?? []).length} tasks · {b.spec.process}
                  </div>
                )}
                <div className="mt-auto flex items-center justify-between border-t border-border pt-3 text-xs text-muted" style={{ marginTop: "1rem" }}>
                  <span>{used.length ? `used by ${used.join(", ")}` : "not used yet"}</span>
                  <span>{b.owner} · {timeAgo(b.updated_at)}</span>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {data && tab === "providers" && (
        <div className="space-y-4">
          <Card className="divide-y divide-border">
            {data.providers.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{p.name} <span className="ml-1 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-normal text-muted">{p.kind}</span></div>
                  <div className="text-xs text-muted">{p.tools} tools{p.synced_at && ` · synced ${timeAgo(p.synced_at)}`}</div>
                  {p.error && <div className="mt-1 text-xs text-err">{p.error}</div>}
                </div>
                <StatusPill status={p.status === "ok" ? "succeeded" : p.status === "syncing" ? "running" : "failed"} />
                {p.kind === "mcp" && (
                  <Button onClick={async () => { await fetch(`/api/providers/${p.name}/sync`, { method: "POST" }); setTimeout(reload, 4000); }}>Re-sync</Button>
                )}
              </div>
            ))}
          </Card>
          <Card className="p-4 text-sm">
            <p className="font-medium">Add an MCP server</p>
            <p className="mt-1 text-muted">
              Providers run commands on the worker, so they&apos;re registered from the CLI by someone with access to the machine.
              Every tool the server exposes becomes its own versioned block, with a <code>&lt;name&gt;:read</code> or <code>&lt;name&gt;:write</code> capability taken from its MCP annotations.
            </p>
            <pre className="mt-3 overflow-x-auto rounded bg-surface-2 p-3 font-mono text-xs">{`cd workers && uv run mcp-add --name github \\
  --env 'GITHUB_PERSONAL_ACCESS_TOKEN=$GITHUB_TOKEN' -- \\
  docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN \\
  ghcr.io/github/github-mcp-server stdio --toolsets repos,issues,pull_requests`}</pre>
          </Card>
        </div>
      )}
    </div>
  );
}
