"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DEFAULT_MODEL, MODELS, STEP_TYPES, TOOLS, newStep } from "@/lib/catalog";
import type { CrewAgent, CrewTask, StepDef, StepType, WorkflowDef } from "@/lib/types";
import { validateDefinition } from "@/lib/validate";
import { Button, Card, Input, Label, Select, Textarea, cx } from "./ui";

interface Props {
  id: string;
  name: string;
  description: string;
  version: number;
  definition: WorkflowDef;
}

export function WorkflowEditor(p: Props) {
  const router = useRouter();
  const [name, setName] = useState(p.name);
  const [description, setDescription] = useState(p.description);
  const [steps, setSteps] = useState<StepDef[]>(p.definition.steps);
  const [version, setVersion] = useState(p.version);
  const [open, setOpen] = useState<string | null>(steps.find((s) => s.type === "crew")?.id ?? null);
  const [addType, setAddType] = useState<StepType>("crew");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  const problems = useMemo(() => validateDefinition({ steps }), [steps]);

  function update(next: StepDef[]) {
    setSteps(next);
    setDirty(true);
    setMsg(null);
  }
  const patchStep = (i: number, s: Partial<StepDef>) => update(steps.map((x, j) => (j === i ? { ...x, ...s } : x)));
  const patchConfig = (i: number, c: Partial<StepDef["config"]>) =>
    update(steps.map((x, j) => (j === i ? { ...x, config: { ...x.config, ...c } } : x)));
  const move = (i: number, d: -1 | 1) => {
    const n = [...steps];
    const [s] = n.splice(i, 1);
    n.splice(i + d, 0, s);
    update(n);
  };

  async function save() {
    setSaving(true);
    const r = await fetch(`/api/workflows/${p.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description, definition: { steps } }),
    });
    const j = await r.json();
    setSaving(false);
    if (!r.ok) return setMsg({ ok: false, text: j.error });
    setVersion(j.version);
    setDirty(false);
    setMsg({ ok: true, text: `Saved as v${j.version}` });
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <Link href="/workflows" className="text-sm text-muted hover:text-text">← Workflows</Link>
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); setDirty(true); }}
            className="block w-full bg-transparent text-2xl font-semibold tracking-tight outline-none"
          />
          <input
            value={description}
            onChange={(e) => { setDescription(e.target.value); setDirty(true); }}
            placeholder="Add a description"
            className="block w-full bg-transparent text-sm text-muted outline-none"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted">v{version}{dirty && " · unsaved"}</span>
          <Button variant="primary" onClick={save} disabled={saving || !dirty || problems.length > 0}>
            {saving ? "Saving…" : "Save new version"}
          </Button>
          <Link href={`/runs/new?workflow=${p.id}`}>
            <Button disabled={dirty}>Run ▸</Button>
          </Link>
        </div>
      </div>

      {msg && <div className={cx("rounded-md p-3 text-sm", msg.ok ? "bg-ok/10 text-ok" : "bg-err/10 text-err whitespace-pre-wrap")}>{msg.text}</div>}
      {problems.length > 0 && (
        <div className="rounded-md border border-warn/30 bg-warn/10 p-3 text-sm text-warn">
          <ul className="list-disc space-y-0.5 pl-5">{problems.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}

      <ol className="space-y-3">
        {steps.map((s, i) => {
          const meta = STEP_TYPES[s.type];
          const isOpen = open === s.id;
          return (
            <li key={i}>
              <Card className={cx(isOpen && "border-accent/50")}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold">{i + 1}</span>
                  <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(isOpen ? null : s.id)}>
                    <div className="truncate font-medium">{s.name || meta.label}</div>
                    <div className="truncate text-xs text-muted">
                      {meta.label} · <span className="font-mono">{s.id}</span> · queue <span className="font-mono">{meta.queue}</span>
                      {s.type === "crew" && ` · ${s.config.agents?.length ?? 0} agents, ${s.config.tasks?.length ?? 0} tasks`}
                    </div>
                  </button>
                  <div className="flex items-center gap-0.5">
                    <Button variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</Button>
                    <Button variant="ghost" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</Button>
                    <Button variant="ghost" onClick={() => update(steps.filter((_, j) => j !== i))} aria-label="Delete">✕</Button>
                    <Button variant="ghost" onClick={() => setOpen(isOpen ? null : s.id)}>{isOpen ? "▴" : "▾"}</Button>
                  </div>
                </div>
                {isOpen && (
                  <div className="space-y-4 border-t border-border px-4 py-4">
                    <p className="text-sm text-muted">{meta.description}</p>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Label label="Step name"><Input value={s.name ?? ""} onChange={(e) => patchStep(i, { name: e.target.value })} /></Label>
                      <Label label="Step id" hint="unique, used in events"><Input value={s.id} onChange={(e) => patchStep(i, { id: e.target.value })} className="font-mono" /></Label>
                    </div>
                    {s.type === "crew" && <CrewEditor step={s} onChange={(c) => patchConfig(i, c)} />}
                    {s.type === "github.open_pr" && (
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Label label="PR title override" hint="default: first heading of the spec">
                          <Input value={s.config.title ?? ""} onChange={(e) => patchConfig(i, { title: e.target.value || undefined })} />
                        </Label>
                        <label className="flex items-center gap-2 pt-6 text-sm">
                          <input type="checkbox" checked={!!s.config.draft} onChange={(e) => patchConfig(i, { draft: e.target.checked })} />
                          Open as draft
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ol>

      <Card className="flex flex-wrap items-center gap-3 border-dashed p-4">
        <span className="text-sm text-muted">Add a step</span>
        <Select value={addType} onChange={(e) => setAddType(e.target.value as StepType)} className="w-56">
          {Object.entries(STEP_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
        <Button onClick={() => { const s = newStep(addType, steps); update([...steps, s]); setOpen(s.id); }}>+ Add</Button>
      </Card>
    </div>
  );
}

function CrewEditor({ step, onChange }: { step: StepDef; onChange: (c: Partial<StepDef["config"]>) => void }) {
  const agents = step.config.agents ?? [];
  const tasks = step.config.tasks ?? [];
  const setAgent = (i: number, a: Partial<CrewAgent>) => onChange({ agents: agents.map((x, j) => (j === i ? { ...x, ...a } : x)) });
  const setTask = (i: number, t: Partial<CrewTask>) => onChange({ tasks: tasks.map((x, j) => (j === i ? { ...x, ...t } : x)) });

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Label label="Process">
          <Select value={step.config.process ?? "sequential"} onChange={(e) => onChange({ process: e.target.value as "sequential" | "hierarchical" })}>
            <option value="sequential">Sequential: tasks run in order</option>
            <option value="hierarchical">Hierarchical: a manager agent delegates</option>
          </Select>
        </Label>
        <Label label="Allowed commands" hint="comma-separated prefixes for run_command">
          <Input
            value={(step.config.allowed_commands ?? []).join(", ")}
            onChange={(e) => onChange({ allowed_commands: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
            className="font-mono"
            placeholder="npm test, pytest"
          />
        </Label>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Agents</h3>
          <Button variant="ghost" onClick={() => onChange({ agents: [...agents, { key: `agent${agents.length + 1}`, role: "", goal: "", backstory: "", model: DEFAULT_MODEL, tools: ["list_files", "read_file", "search_code"] }] })}>+ Agent</Button>
        </div>
        {agents.map((a, i) => (
          <div key={i} className="space-y-3 rounded-md border border-border bg-surface-2/50 p-3">
            <div className="grid gap-3 sm:grid-cols-[140px_1fr_200px_auto]">
              <Label label="Key"><Input value={a.key} onChange={(e) => setAgent(i, { key: e.target.value })} className="font-mono" /></Label>
              <Label label="Role"><Input value={a.role} onChange={(e) => setAgent(i, { role: e.target.value })} /></Label>
              <Label label="Model">
                <Select value={a.model ?? DEFAULT_MODEL} onChange={(e) => setAgent(i, { model: e.target.value })}>
                  {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </Select>
              </Label>
              <div className="flex items-end"><Button variant="ghost" onClick={() => onChange({ agents: agents.filter((_, j) => j !== i) })}>✕</Button></div>
            </div>
            <Label label="Goal"><Input value={a.goal} onChange={(e) => setAgent(i, { goal: e.target.value })} /></Label>
            <Label label="Backstory"><Textarea rows={2} value={a.backstory ?? ""} onChange={(e) => setAgent(i, { backstory: e.target.value })} className="font-sans" /></Label>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {TOOLS.map((t) => (
                <label key={t.id} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={(a.tools ?? []).includes(t.id)}
                    onChange={(e) => setAgent(i, { tools: e.target.checked ? [...(a.tools ?? []), t.id] : (a.tools ?? []).filter((x) => x !== t.id) })}
                  />
                  {t.label}
                </label>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Tasks <span className="font-normal text-muted">· variables: <code>{"{spec}"}</code> <code>{"{repo}"}</code> <code>{"{base_branch}"}</code> <code>{"{previous}"}</code></span></h3>
          <Button variant="ghost" onClick={() => onChange({ tasks: [...tasks, { key: `task${tasks.length + 1}`, agent: agents[0]?.key ?? "", description: "", expected_output: "" }] })}>+ Task</Button>
        </div>
        {tasks.map((t, i) => (
          <div key={i} className="space-y-3 rounded-md border border-border bg-surface-2/50 p-3">
            <div className="grid gap-3 sm:grid-cols-[140px_1fr_1fr_auto]">
              <Label label="Key"><Input value={t.key} onChange={(e) => setTask(i, { key: e.target.value })} className="font-mono" /></Label>
              <Label label="Assigned agent">
                <Select value={t.agent} onChange={(e) => setTask(i, { agent: e.target.value })}>
                  {agents.map((a) => <option key={a.key} value={a.key}>{a.role || a.key}</option>)}
                </Select>
              </Label>
              <Label label="Uses output of" hint="earlier tasks">
                <Select
                  multiple
                  value={t.context ?? []}
                  onChange={(e) => setTask(i, { context: Array.from(e.target.selectedOptions).map((o) => o.value) })}
                  className="h-[34px] focus:h-20"
                >
                  {tasks.slice(0, i).map((x) => <option key={x.key} value={x.key}>{x.key}</option>)}
                </Select>
              </Label>
              <div className="flex items-end"><Button variant="ghost" onClick={() => onChange({ tasks: tasks.filter((_, j) => j !== i) })}>✕</Button></div>
            </div>
            <Label label="Description"><Textarea rows={5} value={t.description} onChange={(e) => setTask(i, { description: e.target.value })} /></Label>
            <Label label="Expected output"><Textarea rows={2} value={t.expected_output} onChange={(e) => setTask(i, { expected_output: e.target.value })} /></Label>
          </div>
        ))}
      </section>
    </div>
  );
}
