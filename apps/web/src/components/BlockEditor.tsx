"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_MODEL, MODELS } from "@/lib/catalog";
import { CapChip, type ClientBlock, useRegistry } from "./registry-client";
import { Button, Card, Input, Label, Select, Textarea, cx } from "./ui";

type Kind = "tool" | "agent" | "crew";
type AgentSpec = { role: string; goal: string; backstory: string; model: string; tools: string[]; max_iter?: number };
type CrewSpec = {
  process: "sequential" | "hierarchical";
  agents: { key: string; ref: string }[];
  tasks: { key: string; agent: string; description: string; expected_output: string; context?: string[] }[];
};

const EMPTY_AGENT: AgentSpec = { role: "", goal: "", backstory: "", model: DEFAULT_MODEL, tools: ["fs.list_files", "fs.read_file", "fs.search_code"] };
const EMPTY_CREW: CrewSpec = { process: "sequential", agents: [], tasks: [] };

export function BlockEditor({ kind, name }: { kind: Kind; name: string }) {
  const router = useRouter();
  const isNew = name === "new";
  const { data } = useRegistry();
  const [block, setBlock] = useState<ClientBlock | null>(null);
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [spec, setSpec] = useState<AgentSpec | CrewSpec>(kind === "crew" ? EMPTY_CREW : EMPTY_AGENT);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isNew) return;
    const q = viewVersion ? `?version=${viewVersion}` : "";
    fetch(`/api/registry/${kind}/${name}${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: ClientBlock | null) => {
        if (!b) return;
        setBlock(b);
        setTitle(b.title);
        setDescription(b.description);
        setSpec(b.spec as unknown as AgentSpec | CrewSpec);
      });
  }, [kind, name, isNew, viewVersion]);

  const latest = block?.versions.at(-1);
  const readOnly = kind === "tool" || (viewVersion !== null && viewVersion !== latest);

  async function save() {
    setSaving(true);
    setMsg(null);
    const target = isNew ? slug : name;
    const r = await fetch(`/api/registry/${kind}/${target}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, description, spec }),
    });
    const j = await r.json();
    setSaving(false);
    if (!r.ok) return setMsg({ ok: false, text: j.error });
    if (isNew) return router.push(`/catalog/${kind}/${target}`);
    setMsg({ ok: true, text: `Saved ${kind}:${name}@${j.version}. Workflows that don't pin a version pick it up on their next run.` });
    setViewVersion(null);
    setBlock((b) => (b ? { ...b, version: j.version, versions: [...b.versions, j.version] } : b));
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Link href="/catalog" className="text-sm text-muted hover:text-text">← Catalog</Link>
          <h1 className="text-2xl font-semibold tracking-tight">{isNew ? `New ${kind}` : title}</h1>
          {!isNew && <p className="font-mono text-xs text-muted">{kind}:{name} · owner {block?.owner}</p>}
        </div>
        {!isNew && block && (
          <div className="flex items-center gap-2">
            <Select value={viewVersion ?? latest ?? ""} onChange={(e) => setViewVersion(Number(e.target.value))} className="w-36">
              {[...block.versions].reverse().map((v) => <option key={v} value={v}>v{v}{v === latest ? " (latest)" : ""}</option>)}
            </Select>
            {kind !== "tool" && <Button variant="primary" onClick={save} disabled={saving || readOnly}>{saving ? "Saving…" : "Save new version"}</Button>}
          </div>
        )}
        {isNew && <Button variant="primary" onClick={save} disabled={saving || !slug}>{saving ? "Creating…" : `Create ${kind}`}</Button>}
      </div>

      {msg && <div className={cx("whitespace-pre-wrap rounded-md p-3 text-sm", msg.ok ? "bg-ok/10 text-ok" : "bg-err/10 text-err")}>{msg.text}</div>}
      {readOnly && kind !== "tool" && <div className="rounded-md bg-warn/10 p-3 text-sm text-warn">Viewing an older version (read-only). Runs that pinned it keep using it.</div>}

      {kind === "tool" && block && <ToolView block={block} />}

      {kind !== "tool" && (
        <Card className="space-y-4 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Label label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={readOnly} /></Label>
            {isNew ? (
              <Label label="Name" hint="lowercase-with-dashes, used in references">
                <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} className="font-mono" placeholder={kind === "agent" ? "security-triager" : "triage-and-fix"} />
              </Label>
            ) : (
              <Label label="Reference"><Input value={`${kind}:${name}`} disabled className="font-mono" /></Label>
            )}
          </div>
          <Label label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} disabled={readOnly} /></Label>
        </Card>
      )}

      {kind === "agent" && data && <AgentForm spec={spec as AgentSpec} onChange={setSpec} tools={data.blocks.filter((b) => b.kind === "tool")} readOnly={readOnly} />}
      {kind === "crew" && data && <CrewForm spec={spec as CrewSpec} onChange={setSpec} agents={data.blocks.filter((b) => b.kind === "agent")} readOnly={readOnly} />}
    </div>
  );
}

function ToolView({ block }: { block: ClientBlock }) {
  const props = block.spec.input_schema?.properties ?? {};
  const req = new Set(block.spec.input_schema?.required ?? []);
  return (
    <Card className="space-y-4 p-5">
      <p className="text-sm">{String(block.spec.description ?? block.description)}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">Provider</span><span className="font-mono">{block.provider ?? "builtin"}</span>
        <span className="ml-3 text-muted">Usable as</span>{(block.spec.modes ?? []).map((m) => <span key={m} className="rounded border border-border px-1.5">{m}</span>)}
        <span className="ml-3 text-muted">Needs</span>{(block.spec.capabilities ?? []).map((c) => <CapChip key={c} cap={c} />)}
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold">Inputs</h3>
        <table className="w-full text-sm">
          <tbody>
            {Object.entries(props).map(([k, p]) => (
              <tr key={k} className="border-t border-border">
                <td className="py-1.5 pr-3 font-mono text-xs">{k}{req.has(k) && <span className="text-err">*</span>}</td>
                <td className="py-1.5 pr-3 font-mono text-xs text-muted">{p.type ?? "any"}</td>
                <td className="py-1.5 text-xs text-muted">{p.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function AgentForm({ spec, onChange, tools, readOnly }: { spec: AgentSpec; onChange: (s: AgentSpec) => void; tools: ClientBlock[]; readOnly: boolean }) {
  const [q, setQ] = useState("");
  const set = (p: Partial<AgentSpec>) => onChange({ ...spec, ...p });
  const selected = new Set(spec.tools.map((t) => t.replace(/^tool:/, "").replace(/@\d+$/, "")));
  const byName = useMemo(() => Object.fromEntries(tools.map((t) => [t.name, t])), [tools]);
  const needs = [...new Set([...selected].flatMap((t) => byName[t]?.spec.capabilities ?? []))].sort();
  const groups = useMemo(() => {
    const g: Record<string, ClientBlock[]> = {};
    tools
      .filter((t) => !t.archived && (t.spec.modes ?? []).includes("agent"))
      .filter((t) => !q || `${t.name} ${t.description}`.toLowerCase().includes(q.toLowerCase()))
      .forEach((t) => (g[t.provider ?? "builtin"] ??= []).push(t));
    return g;
  }, [tools, q]);

  return (
    <>
      <Card className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_220px_120px]">
          <Label label="Role"><Input value={spec.role} onChange={(e) => set({ role: e.target.value })} disabled={readOnly} /></Label>
          <Label label="Model">
            <Select value={spec.model ?? DEFAULT_MODEL} onChange={(e) => set({ model: e.target.value })} disabled={readOnly}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} · {m.price}</option>)}
            </Select>
          </Label>
          <Label label="Max iterations"><Input type="number" min={1} max={100} value={spec.max_iter ?? 30} onChange={(e) => set({ max_iter: Number(e.target.value) })} disabled={readOnly} /></Label>
        </div>
        <Label label="Goal"><Input value={spec.goal} onChange={(e) => set({ goal: e.target.value })} disabled={readOnly} /></Label>
        <Label label="Backstory / instructions"><Textarea rows={4} value={spec.backstory ?? ""} onChange={(e) => set({ backstory: e.target.value })} disabled={readOnly} className="font-sans" /></Label>
      </Card>

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Tools <span className="font-normal text-muted">· {selected.size} selected</span></h3>
            <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted">Needs {needs.length ? needs.map((c) => <CapChip key={c} cap={c} />) : "nothing"}</div>
          </div>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools…" className="w-56" />
        </div>
        <div className="mt-4 space-y-4">
          {Object.entries(groups).map(([prov, list]) => (
            <div key={prov}>
              <div className="mb-1.5 text-xs font-semibold text-muted">{prov === "builtin" ? "Built-in" : `${prov} (MCP)`}</div>
              <div className="grid gap-1 sm:grid-cols-2">
                {list.map((t) => (
                  <label key={t.name} className={cx("flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5", selected.has(t.name) ? "border-accent/50 bg-accent/5" : "border-border")}>
                    <input
                      type="checkbox"
                      className="mt-1"
                      disabled={readOnly}
                      checked={selected.has(t.name)}
                      onChange={(e) => set({ tools: e.target.checked ? [...spec.tools, t.name] : spec.tools.filter((x) => x.replace(/^tool:/, "").replace(/@\d+$/, "") !== t.name) })}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-xs">{t.name}</span>
                        <span className="flex gap-1">{(t.spec.capabilities ?? []).map((c) => <CapChip key={c} cap={c} />)}</span>
                      </span>
                      <span className="line-clamp-1 text-[11px] text-muted">{t.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

function CrewForm({ spec, onChange, agents, readOnly }: { spec: CrewSpec; onChange: (s: CrewSpec) => void; agents: ClientBlock[]; readOnly: boolean }) {
  const set = (p: Partial<CrewSpec>) => onChange({ ...spec, ...p });
  const setAgent = (i: number, p: Partial<CrewSpec["agents"][0]>) => set({ agents: spec.agents.map((a, j) => (j === i ? { ...a, ...p } : a)) });
  const setTask = (i: number, p: Partial<CrewSpec["tasks"][0]>) => set({ tasks: spec.tasks.map((t, j) => (j === i ? { ...t, ...p } : t)) });
  const vars = [...new Set(spec.tasks.flatMap((t) => [...`${t.description} ${t.expected_output}`.matchAll(/\{([A-Za-z_]\w*)\}/g)].map((m) => m[1])))];

  return (
    <>
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Agents</h3>
          <div className="flex items-center gap-2">
            <Select value={spec.process} onChange={(e) => set({ process: e.target.value as CrewSpec["process"] })} disabled={readOnly} className="w-64">
              <option value="sequential">Sequential: tasks in order</option>
              <option value="hierarchical">Hierarchical: a manager delegates</option>
            </Select>
            <Button variant="ghost" disabled={readOnly} onClick={() => set({ agents: [...spec.agents, { key: `agent${spec.agents.length + 1}`, ref: `agent:${agents[0]?.name ?? ""}` }] })}>+ Agent</Button>
          </div>
        </div>
        {spec.agents.map((a, i) => {
          const name = a.ref.replace(/^agent:/, "").replace(/@\d+$/, "");
          const pinned = /@(\d+)$/.exec(a.ref)?.[1] ?? "";
          const b = agents.find((x) => x.name === name);
          return (
            <div key={i} className="grid gap-3 rounded-md border border-border bg-surface-2/50 p-3 sm:grid-cols-[140px_1fr_120px_auto]">
              <Label label="Key in this crew"><Input value={a.key} onChange={(e) => setAgent(i, { key: e.target.value })} className="font-mono" disabled={readOnly} /></Label>
              <Label label="Agent">
                <Select value={name} onChange={(e) => setAgent(i, { ref: `agent:${e.target.value}${pinned ? `@${pinned}` : ""}` })} disabled={readOnly}>
                  {agents.map((x) => <option key={x.name} value={x.name}>{x.title} ({x.name})</option>)}
                </Select>
              </Label>
              <Label label="Version">
                <Select value={pinned} onChange={(e) => setAgent(i, { ref: `agent:${name}${e.target.value ? `@${e.target.value}` : ""}` })} disabled={readOnly}>
                  <option value="">latest</option>
                  {(b?.versions ?? []).map((v) => <option key={v} value={v}>v{v}</option>)}
                </Select>
              </Label>
              <div className="flex items-end"><Button variant="ghost" disabled={readOnly} onClick={() => set({ agents: spec.agents.filter((_, j) => j !== i) })}>✕</Button></div>
            </div>
          );
        })}
      </Card>

      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">
            Tasks{" "}
            <span className="font-normal text-muted">· use <code>{"{name}"}</code> placeholders; workflows fill them via the step&apos;s inputs{vars.length > 0 && <>: {vars.map((v) => <code key={v} className="ml-1">{`{${v}}`}</code>)}</>}</span>
          </h3>
          <Button variant="ghost" disabled={readOnly} onClick={() => set({ tasks: [...spec.tasks, { key: `task${spec.tasks.length + 1}`, agent: spec.agents[0]?.key ?? "", description: "", expected_output: "" }] })}>+ Task</Button>
        </div>
        {spec.tasks.map((t, i) => (
          <div key={i} className="space-y-3 rounded-md border border-border bg-surface-2/50 p-3">
            <div className="grid gap-3 sm:grid-cols-[140px_1fr_1fr_auto]">
              <Label label="Key"><Input value={t.key} onChange={(e) => setTask(i, { key: e.target.value })} className="font-mono" disabled={readOnly} /></Label>
              <Label label="Agent">
                <Select value={t.agent} onChange={(e) => setTask(i, { agent: e.target.value })} disabled={readOnly}>
                  {spec.agents.map((a) => <option key={a.key} value={a.key}>{a.key}</option>)}
                </Select>
              </Label>
              <Label label="Uses output of">
                <Select multiple value={t.context ?? []} disabled={readOnly} className="h-[34px] focus:h-20"
                  onChange={(e) => setTask(i, { context: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
                  {spec.tasks.slice(0, i).map((x) => <option key={x.key} value={x.key}>{x.key}</option>)}
                </Select>
              </Label>
              <div className="flex items-end"><Button variant="ghost" disabled={readOnly} onClick={() => set({ tasks: spec.tasks.filter((_, j) => j !== i) })}>✕</Button></div>
            </div>
            <Label label="Description"><Textarea rows={5} value={t.description} onChange={(e) => setTask(i, { description: e.target.value })} disabled={readOnly} /></Label>
            <Label label="Expected output"><Textarea rows={2} value={t.expected_output} onChange={(e) => setTask(i, { expected_output: e.target.value })} disabled={readOnly} /></Label>
          </div>
        ))}
      </Card>
    </>
  );
}
