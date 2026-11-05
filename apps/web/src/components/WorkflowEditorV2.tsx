"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { StepDefV2, WorkflowDefV2 } from "@/lib/types";
import { CapChip, type ClientBlock, useRegistry } from "./registry-client";
import { Button, Card, Input, Label, Select, Textarea, cx } from "./ui";

interface Analysis {
  problems: string[];
  required: string[];
  steps: { id: string; kind: string; needs: string[]; tools: string[]; version: number | null; latest: number | null;
    inputs: { key: string; required: boolean; description?: string }[]; outputs: string[] }[];
}

interface Props { id: string; name: string; description: string; version: number; definition: WorkflowDefV2 }

const RUN_INPUTS = ["repo", "base_branch", "spec"];

export function WorkflowEditorV2(p: Props) {
  const router = useRouter();
  const { data: reg } = useRegistry();
  const [name, setName] = useState(p.name);
  const [description, setDescription] = useState(p.description);
  const [def, setDef] = useState<WorkflowDefV2>(p.definition);
  const [version, setVersion] = useState(p.version);
  const [open, setOpen] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [addRef, setAddRef] = useState("approval");

  useEffect(() => {
    const t = setTimeout(async () => {
      const r = await fetch("/api/workflows/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ definition: def }) });
      if (r.ok) setAnalysis(await r.json());
    }, 300);
    return () => clearTimeout(t);
  }, [def]);

  const granted = new Set(def.policy.capabilities);
  const update = (d: WorkflowDefV2) => { setDef(d); setDirty(true); setMsg(null); };
  const setSteps = (steps: StepDefV2[]) => update({ ...def, steps });
  const patch = (i: number, s: Partial<StepDefV2>) => setSteps(def.steps.map((x, j) => (j === i ? { ...x, ...s } : x)));
  const move = (i: number, d: -1 | 1) => { const n = [...def.steps]; const [s] = n.splice(i, 1); n.splice(i + d, 0, s); setSteps(n); };
  const toggleCap = (c: string, on: boolean) => update({ ...def, policy: { ...def.policy, capabilities: on ? [...new Set([...def.policy.capabilities, c])] : def.policy.capabilities.filter((x) => x !== c) } });
  const missing = (analysis?.required ?? []).filter((c) => !granted.has(c));

  function addStep() {
    const base = addRef === "approval" ? "review" : addRef.split(":")[1].split(".").pop()!.replace(/_/g, "-").slice(0, 30);
    let id = base;
    for (let n = 2; def.steps.some((s) => s.id === id); n++) id = `${base}-${n}`;
    const step: StepDefV2 = { id, name: id, uses: addRef, with: {} };
    if (addRef.startsWith("agent:")) step.task = { description: "", expected_output: "" };
    setSteps([...def.steps, step]);
    setOpen(def.steps.length);
  }

  async function save() {
    setSaving(true);
    const r = await fetch(`/api/workflows/${p.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description, definition: def }) });
    const j = await r.json();
    setSaving(false);
    if (!r.ok) return setMsg({ ok: false, text: j.error });
    setVersion(j.version);
    setDirty(false);
    setMsg({ ok: true, text: `Saved as v${j.version}` });
    router.refresh();
  }

  const blocks = useMemo(() => reg?.blocks ?? [], [reg]);
  const picker = useMemo(() => groupBlocks(blocks), [blocks]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <Link href="/workflows" className="text-sm text-muted hover:text-text">← Workflows</Link>
          <input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} className="block w-full bg-transparent text-2xl font-semibold tracking-tight outline-none" />
          <input value={description} onChange={(e) => { setDescription(e.target.value); setDirty(true); }} placeholder="Add a description" className="block w-full bg-transparent text-sm text-muted outline-none" />
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted">v{version}{dirty && " · unsaved"}</span>
          <Button variant="primary" onClick={save} disabled={saving || !dirty || (analysis?.problems.length ?? 0) > 0}>{saving ? "Saving…" : "Save new version"}</Button>
          <Link href={`/runs/new?workflow=${p.id}`}><Button disabled={dirty}>Run ▸</Button></Link>
        </div>
      </div>

      {msg && <div className={cx("whitespace-pre-wrap rounded-md p-3 text-sm", msg.ok ? "bg-ok/10 text-ok" : "bg-err/10 text-err")}>{msg.text}</div>}
      {analysis && analysis.problems.length > 0 && (
        <div className="rounded-md border border-warn/30 bg-warn/10 p-3 text-sm text-warn">
          <ul className="list-disc space-y-0.5 pl-5">{analysis.problems.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}

      {/* Policy: what this workflow is allowed to touch */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Capabilities granted</h2>
            <p className="text-xs text-muted">Every tool used by a step (directly or through its agents) must be covered. The worker gives steps nothing beyond this.</p>
          </div>
          {missing.length > 0 && <Button onClick={() => update({ ...def, policy: { ...def.policy, capabilities: [...new Set([...def.policy.capabilities, ...missing])] } })}>Grant {missing.length} required</Button>}
        </div>
        <div className="mt-3 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {(reg?.capabilities ?? []).map((c) => {
            const req = analysis?.required.includes(c.id);
            return (
              <label key={c.id} className={cx("flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-sm", granted.has(c.id) ? "border-accent/40 bg-accent/5" : req ? "border-err/40" : "border-border")}>
                <input type="checkbox" className="mt-1" checked={granted.has(c.id)} onChange={(e) => toggleCap(c.id, e.target.checked)} />
                <span>
                  <span className="font-mono text-xs">{c.id}</span>{req && <span className="ml-1.5 text-[11px] text-muted">required</span>}
                  <span className="block text-[11px] text-muted">{c.description}</span>
                </span>
              </label>
            );
          })}
        </div>
        {granted.has("exec") && (
          <div className="mt-3">
            <Label label="Allowed commands" hint="prefixes for shell.run_command, comma-separated">
              <Input value={(def.policy.allowed_commands ?? []).join(", ")} className="font-mono"
                onChange={(e) => update({ ...def, policy: { ...def.policy, allowed_commands: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })} />
            </Label>
          </div>
        )}
      </Card>

      <ol className="space-y-3">
        {def.steps.map((s, i) => {
          const a = analysis?.steps[i];
          const isOpen = open === i;
          const ref = parseRef(s.uses);
          const block = ref ? blocks.find((b) => b.kind === ref.kind && b.name === ref.name) : undefined;
          return (
            <li key={i}>
              <Card className={cx(isOpen && "border-accent/50")}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold">{i + 1}</span>
                  <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(isOpen ? null : i)}>
                    <div className="truncate font-medium">{s.name || s.id}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      <span className="font-mono">{s.uses}{a?.version && !/@\d+$/.test(s.uses) ? ` → v${a.version}` : ""}</span>
                      {a?.needs.map((c) => <CapChip key={c} cap={c} granted={granted.has(c)} />)}
                    </div>
                  </button>
                  <div className="flex items-center gap-0.5">
                    <Button variant="ghost" disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
                    <Button variant="ghost" disabled={i === def.steps.length - 1} onClick={() => move(i, 1)}>↓</Button>
                    <Button variant="ghost" onClick={() => setSteps(def.steps.filter((_, j) => j !== i))}>✕</Button>
                  </div>
                </div>
                {isOpen && (
                  <div className="space-y-4 border-t border-border px-4 py-4">
                    <div className="grid gap-4 sm:grid-cols-[1fr_1fr_2fr_120px]">
                      <Label label="Step name"><Input value={s.name ?? ""} onChange={(e) => patch(i, { name: e.target.value })} /></Label>
                      <Label label="Step id"><Input value={s.id} onChange={(e) => patch(i, { id: e.target.value })} className="font-mono" /></Label>
                      <Label label="Block">
                        <Select value={s.uses.replace(/@\d+$/, "")} onChange={(e) => patch(i, { uses: e.target.value, ...(e.target.value.startsWith("agent:") && !s.task ? { task: { description: "", expected_output: "" } } : {}) })}>
                          {picker.map((g) => (
                            <optgroup key={g.label} label={g.label}>
                              {g.items.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </optgroup>
                          ))}
                        </Select>
                      </Label>
                      <Label label="Version">
                        <Select disabled={!block} value={/@(\d+)$/.exec(s.uses)?.[1] ?? ""} onChange={(e) => patch(i, { uses: `${s.uses.replace(/@\d+$/, "")}${e.target.value ? `@${e.target.value}` : ""}` })}>
                          <option value="">latest</option>
                          {(block?.versions ?? []).map((v) => <option key={v} value={v}>v{v}</option>)}
                        </Select>
                      </Label>
                    </div>
                    {block && (
                      <p className="text-xs text-muted">
                        {block.description}{" "}
                        <Link href={`/catalog/${block.kind}/${block.name}`} className="text-accent hover:underline">open in catalog →</Link>
                        {a && a.tools.length > 0 && <span className="mt-1 block">Tools: <span className="font-mono">{[...new Set(a.tools)].join(", ")}</span></span>}
                      </p>
                    )}
                    {s.uses.startsWith("agent:") && (
                      <div className="grid gap-3">
                        <Label label="Task" hint="use {name} placeholders filled from inputs below"><Textarea rows={4} value={s.task?.description ?? ""} onChange={(e) => patch(i, { task: { ...(s.task ?? { expected_output: "" }), description: e.target.value } })} /></Label>
                        <Label label="Expected output"><Textarea rows={2} value={s.task?.expected_output ?? ""} onChange={(e) => patch(i, { task: { ...(s.task ?? { description: "" }), expected_output: e.target.value } })} /></Label>
                      </div>
                    )}
                    <InputsEditor
                      step={s}
                      suggested={a?.inputs ?? []}
                      expressions={[...RUN_INPUTS.map((k) => `{{ inputs.${k} }}`), "{{ run.id }}",
                        ...def.steps.slice(0, i).flatMap((e, j) => (analysis?.steps[j]?.outputs ?? []).map((o) => `{{ steps.${e.id}.output.${o} }}`))]}
                      onChange={(w) => patch(i, { with: w })}
                    />
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ol>

      <Card className="flex flex-wrap items-center gap-3 border-dashed p-4">
        <span className="text-sm text-muted">Add a step</span>
        <Select value={addRef} onChange={(e) => setAddRef(e.target.value)} className="w-80">
          {picker.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.items.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </optgroup>
          ))}
        </Select>
        <Button onClick={addStep}>+ Add</Button>
        <Link href="/catalog" className="ml-auto text-sm text-muted hover:text-text">Browse the catalog →</Link>
      </Card>
    </div>
  );
}

function InputsEditor({ step, suggested, expressions, onChange }: {
  step: StepDefV2; suggested: { key: string; required: boolean; description?: string }[]; expressions: string[];
  onChange: (w: Record<string, unknown>) => void;
}) {
  const w = step.with ?? {};
  const [newKey, setNewKey] = useState("");
  const keys = [...new Set([...suggested.map((s) => s.key), ...Object.keys(w)])];
  const listId = `expr-${step.id}`;
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Inputs <span className="font-normal text-muted">· values can use <code>{"{{ inputs.x }}"}</code> or <code>{"{{ steps.<id>.output.x }}"}</code></span></h3>
      <datalist id={listId}>{expressions.map((e) => <option key={e} value={e} />)}</datalist>
      <div className="space-y-1.5">
        {keys.map((k) => {
          const meta = suggested.find((s) => s.key === k);
          const v = w[k];
          return (
            <div key={k} className="grid items-center gap-2 sm:grid-cols-[180px_1fr_auto]">
              <span className="truncate font-mono text-xs" title={meta?.description}>{k}{meta?.required && <span className="text-err">*</span>}</span>
              <Input list={listId} value={v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v)} placeholder={meta?.description ?? "value or {{ expression }}"}
                className="font-mono text-xs"
                onChange={(e) => { const n = { ...w }; if (e.target.value === "") delete n[k]; else n[k] = e.target.value; onChange(n); }} />
              <Button variant="ghost" onClick={() => { const n = { ...w }; delete n[k]; onChange(n); }} disabled={!(k in w)}>✕</Button>
            </div>
          );
        })}
        <div className="flex gap-2 pt-1">
          <Input value={newKey} onChange={(e) => setNewKey(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))} placeholder="custom input name" className="w-48 font-mono text-xs" />
          <Button variant="ghost" disabled={!newKey} onClick={() => { onChange({ ...w, [newKey]: "" }); setNewKey(""); }}>+ input</Button>
        </div>
      </div>
    </div>
  );
}

function parseRef(uses: string) {
  const m = /^(tool|agent|crew):([A-Za-z0-9_.-]+)(?:@(\d+))?$/.exec(uses);
  return m ? { kind: m[1], name: m[2] } : null;
}

function groupBlocks(blocks: ClientBlock[]) {
  const live = blocks.filter((b) => !b.archived);
  const actions: Record<string, ClientBlock[]> = {};
  live.filter((b) => b.kind === "tool" && (b.spec.modes ?? []).includes("action")).forEach((b) => (actions[b.provider ?? "builtin"] ??= []).push(b));
  return [
    { label: "Human", items: [{ value: "approval", label: "Human approval" }] },
    { label: "Crews", items: live.filter((b) => b.kind === "crew").map((b) => ({ value: `crew:${b.name}`, label: `${b.title} (crew:${b.name})` })) },
    { label: "Agents", items: live.filter((b) => b.kind === "agent").map((b) => ({ value: `agent:${b.name}`, label: `${b.title} (agent:${b.name})` })) },
    ...Object.entries(actions).map(([prov, list]) => ({
      label: `Actions · ${prov === "builtin" ? "built-in" : `${prov} MCP`}`,
      items: list.map((b) => ({ value: `tool:${b.name}`, label: `${b.title} (${b.name})` })),
    })),
  ];
}
