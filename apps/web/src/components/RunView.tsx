"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STEP_TYPES, stepLabel } from "@/lib/catalog";
import type { RunEvent, StepDef } from "@/lib/types";
import { Button, Card, StatusPill, Textarea, cx, fmtDuration, fmtNum, fmtUsd } from "./ui";

interface StepRow {
  step_id: string;
  step_type: string;
  uses: string | null;
  position: number;
  status: string;
  attempt: number;
  output: Record<string, unknown> | null;
  error: string | null;
  tokens_in: string;
  tokens_out: string;
  cost_usd: string;
  started_at: string | null;
  finished_at: string | null;
}

interface Detail {
  run: {
    id: string;
    status: string;
    inputs: { repo: string; base_branch: string; spec: string };
    pr_url: string | null;
    error: string | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    workflow_id: string;
    workflow_name: string;
    version: number;
    definition: { steps: (StepDef | { id: string; name?: string; uses: string })[] };
    resolved: Record<string, number> | null;
    cost_usd: string;
    tokens_in: string;
    tokens_out: string;
  };
  steps: StepRow[];
  usage: { model: string; tokens_in: string; tokens_out: string; cost_usd: string }[];
  temporal_url: string;
}

const REFRESH_KINDS = new Set(["run.status", "step.status", "usage", "pr", "diff", "approval"]);

export function RunView({ id }: { id: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/runs/${id}`, { cache: "no-store" });
    if (r.ok) setD(await r.json());
  }, [id]);

  const scheduleLoad = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, 250);
  }, [load]);

  useEffect(() => {
    fetch(`/api/runs/${id}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setD(j));
    const es = new EventSource(`/api/runs/${id}/events`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("run", (m) => {
      const ev = JSON.parse((m as MessageEvent).data) as RunEvent;
      setEvents((prev) => (prev.length && prev[prev.length - 1].id >= ev.id ? prev : [...prev, ev]));
      if (REFRESH_KINDS.has(ev.kind)) scheduleLoad();
    });
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      es.close();
      clearInterval(t);
    };
  }, [id, scheduleLoad]);

  const names = useMemo(() => Object.fromEntries((d?.run.definition.steps ?? []).map((s) => [s.id, s.name || stepLabel(s) || s.id])), [d]);

  if (!d) return <div className="text-sm text-muted">Loading run…</div>;
  const { run, steps, usage } = d;
  const started = run.started_at ? new Date(run.started_at).getTime() : null;
  const ended = run.finished_at ? new Date(run.finished_at).getTime() : now;
  const done = steps.filter((s) => s.status === "succeeded").length;
  const waiting = steps.find((s) => s.status === "waiting");
  const feed = selected ? events.filter((e) => e.step_id === selected) : events;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Link href="/runs" className="text-sm text-muted hover:text-text">← Runs</Link>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
            <Link href={`/workflows/${run.workflow_id}`} className="hover:underline">{run.workflow_name}</Link>
            <span className="font-mono text-base font-normal text-muted">v{run.version} · {run.id.slice(0, 8)}</span>
            <StatusPill status={run.status} />
          </h1>
          <p className="text-sm text-muted">
            <span className="font-mono">{run.inputs.repo}</span> @ <span className="font-mono">{run.inputs.base_branch}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={cx("text-xs", connected ? "text-ok" : "text-muted")}>{connected ? "● live" : "○ reconnecting"}</span>
          <a href={d.temporal_url} target="_blank" rel="noreferrer"><Button>Temporal history ↗</Button></a>
          {run.pr_url && <a href={run.pr_url} target="_blank" rel="noreferrer"><Button variant="primary">View PR ↗</Button></a>}
        </div>
      </div>

      {/* KPI strip: all measured, from Temporal-driven step state + llm_usage */}
      <Card className="grid grid-cols-2 divide-border sm:grid-cols-3 lg:grid-cols-5 lg:divide-x">
        <Kpi label="Steps" value={`${done} / ${steps.length}`} />
        <Kpi label="Duration" value={started ? fmtDuration(ended - started) : "—"} />
        <Kpi label="Tokens in / out" value={`${fmtNum(run.tokens_in)} / ${fmtNum(run.tokens_out)}`} />
        <Kpi label="Cost" value={fmtUsd(run.cost_usd)} />
        <div className="col-span-2 px-5 py-4 sm:col-span-1">
          <div className="text-xs text-muted">Cost by model</div>
          <div className="mt-1 space-y-0.5 text-xs">
            {usage.length === 0 && <span className="text-muted">—</span>}
            {usage.map((u) => (
              <div key={u.model} className="flex justify-between gap-3 tabular-nums">
                <span className="font-mono">{u.model.replace("claude-", "")}</span>
                <span>{fmtUsd(u.cost_usd)}</span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {run.error && <pre className="whitespace-pre-wrap rounded-md border border-err/30 bg-err/10 p-3 text-sm text-err">{run.error}</pre>}

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="space-y-3">
          <Card>
            <ol>
              {steps.map((s, i) => {
                const dur = s.started_at ? (s.finished_at ? new Date(s.finished_at).getTime() : now) - new Date(s.started_at).getTime() : -1;
                return (
                  <li key={s.step_id}>
                    <button
                      onClick={() => setSelected(selected === s.step_id ? null : s.step_id)}
                      className={cx("flex w-full items-start gap-3 border-b border-border px-4 py-3 text-left last:border-0 hover:bg-surface-2", selected === s.step_id && "bg-surface-2")}
                    >
                      <StepDot status={s.status} n={i + 1} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{names[s.step_id] ?? s.step_id}</div>
                        <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
                          <span className={s.uses ? "font-mono" : undefined}>{s.uses ?? STEP_TYPES[s.step_type as keyof typeof STEP_TYPES]?.label ?? s.step_type}</span>
                          {dur >= 0 && <span>{fmtDuration(dur)}</span>}
                          {Number(s.cost_usd) > 0 && <span>{fmtUsd(s.cost_usd)}</span>}
                          {s.attempt > 1 && <span className="text-warn">attempt {s.attempt}</span>}
                        </div>
                        {s.error && <div className="mt-1 line-clamp-3 text-xs text-err">{s.error}</div>}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ol>
          </Card>
          {run.resolved && (
            <details className="rounded-lg border border-border bg-surface">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Blocks used <span className="font-normal text-muted">· {Object.keys(run.resolved).length} pinned</span></summary>
              <ul className="space-y-0.5 border-t border-border px-4 py-3 font-mono text-xs">
                {Object.entries(run.resolved).sort().map(([k, v]) => (
                  <li key={k}><Link href={`/catalog/${k.split(":")[0]}/${k.split(":")[1]}`} className="hover:underline">{k}</Link><span className="text-muted">@{v}</span></li>
                ))}
              </ul>
            </details>
          )}
          <details className="rounded-lg border border-border bg-surface">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Spec</summary>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap border-t border-border px-4 py-3 font-mono text-xs">{run.inputs.spec}</pre>
          </details>
        </div>

        <div className="min-w-0 space-y-4">
          {waiting && run.status === "waiting_approval" && <ApprovalPanel runId={run.id} output={waiting.output ?? {}} onDone={load} />}
          <Card>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">Activity {selected && <span className="font-normal text-muted">· {names[selected]}</span>}</h2>
              {selected && <button className="text-xs text-muted hover:text-text" onClick={() => setSelected(null)}>show all</button>}
            </div>
            <ul className="max-h-[70vh] divide-y divide-border overflow-auto">
              {feed.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">Waiting for events…</li>}
              {[...feed].reverse().map((e) => <EventItem key={e.id} e={e} stepName={e.step_id ? names[e.step_id] : undefined} />)}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-5 py-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function StepDot({ status, n }: { status: string; n: number }) {
  const c: Record<string, string> = {
    succeeded: "bg-ok text-white",
    running: "bg-info text-white animate-pulse",
    waiting: "bg-warn text-white animate-pulse",
    failed: "bg-err text-white",
  };
  return (
    <span className={cx("mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold", c[status] ?? "bg-surface-2 text-muted")}>
      {status === "succeeded" ? "✓" : status === "failed" ? "!" : n}
    </span>
  );
}

function EventItem({ e, stepName }: { e: RunEvent; stepName?: string }) {
  const p = e.payload as Record<string, unknown>;
  const time = new Date(e.created_at).toLocaleTimeString();
  let icon = "•";
  let body: React.ReactNode = null;
  switch (e.kind) {
    case "log":
      icon = "›";
      body = <span>{String(p.message)}</span>;
      break;
    case "agent.tool":
      icon = "⚙";
      body = (
        <details>
          <summary className="cursor-pointer">
            <span className="font-mono text-accent">{String(p.tool)}</span>{" "}
            <span className="font-mono text-xs text-muted">{fmtArgs(p.args as Record<string, unknown>)}</span>
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 font-mono text-xs">{String(p.result)}</pre>
        </details>
      );
      break;
    case "agent.thought":
      icon = "💭";
      body = <p className="whitespace-pre-wrap text-muted">{String(p.text)}</p>;
      break;
    case "agent.task":
      icon = "✔";
      body = (
        <details open>
          <summary className="cursor-pointer font-medium">Task <span className="font-mono">{String(p.task ?? "")}</span> done{p.agent ? ` by ${String(p.agent)}` : ""}</summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 font-mono text-xs">{String(p.output)}</pre>
        </details>
      );
      break;
    case "tool.call":
      icon = "▶";
      body = <span>Action <span className="font-mono text-accent">{String(p.tool)}</span> <span className="font-mono text-xs text-muted">{String(p.args ?? "")}</span></span>;
      break;
    case "tool.result":
      icon = "◀";
      body = (
        <details>
          <summary className="cursor-pointer"><span className="font-mono">{String(p.tool)}</span> returned</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 font-mono text-xs">{String(p.result)}</pre>
        </details>
      );
      break;
    case "run.compiled":
      icon = "⎔";
      body = (
        <span>
          Compiled: {Object.keys((p.resolved as object) ?? {}).length} blocks pinned · grants{" "}
          {((p.capabilities as string[]) ?? []).map((c) => <code key={c} className="mr-1 text-xs">{c}</code>)}
        </span>
      );
      break;
    case "run.compile_failed":
      icon = "✕";
      body = <ul className="list-disc pl-4 text-err">{((p.problems as string[]) ?? []).map((x) => <li key={x}>{x}</li>)}</ul>;
      break;
    case "usage":
      icon = "$";
      body = <span className="text-xs text-muted">{String(p.model)}: +{fmtNum(Number(p.tokens_in))} in / +{fmtNum(Number(p.tokens_out))} out · {fmtUsd(Number(p.cost_usd))}</span>;
      break;
    case "step.status":
      icon = "◆";
      body = <span>Step <b>{stepName ?? e.step_id}</b> → <StatusPill status={String(p.status)} />{p.error ? <span className="ml-2 text-err">{String(p.error)}</span> : null}</span>;
      break;
    case "run.status":
      icon = "◉";
      body = <span>Run → <StatusPill status={String(p.status)} />{p.error ? <span className="ml-2 text-err">{String(p.error)}</span> : null}</span>;
      break;
    case "diff":
      icon = "±";
      body = <span>Diff captured: {String(p.stat || "no changes")}</span>;
      break;
    case "approval":
      icon = p.approved ? "👍" : "👎";
      body = <span>{p.approved ? "Approved" : "Rejected"} by {String(p.by)}{p.comment ? `: “${String(p.comment)}”` : ""}</span>;
      break;
    case "pr":
      icon = "⇪";
      body = <a href={String(p.url)} target="_blank" rel="noreferrer" className="text-accent hover:underline">Pull request #{String(p.number)} opened ↗</a>;
      break;
    default:
      body = <code className="text-xs">{e.kind} {JSON.stringify(p)}</code>;
  }
  return (
    <li className="flex gap-3 px-4 py-2.5 text-sm">
      <span className="w-5 shrink-0 text-center text-muted">{icon}</span>
      <div className="min-w-0 flex-1">{body}</div>
      <span className="shrink-0 font-mono text-[11px] text-muted">{time}</span>
    </li>
  );
}

function fmtArgs(a: Record<string, unknown> | undefined) {
  if (!a) return "";
  return Object.entries(a).map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v.length > 60 ? v.slice(0, 60) + "…" : v) : JSON.stringify(v)}`).join(" ");
}

function ApprovalPanel({ runId, output, onDone }: { runId: string; output: Record<string, unknown>; onDone: () => void }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const artifact = output.diff_artifact_id as string | undefined;

  useEffect(() => {
    if (artifact) fetch(`/api/artifacts/${artifact}`).then((r) => r.text()).then(setDiff);
  }, [artifact]);

  async function decide(approved: boolean) {
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/runs/${runId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved, comment }),
    });
    setBusy(false);
    if (!r.ok) return setErr((await r.json()).error);
    onDone();
  }

  return (
    <Card className="border-warn/50">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Review required</h2>
          <p className="text-xs text-muted">{String(output.stat ?? "")}. The workflow is paused durably until you decide.</p>
        </div>
      </div>
      <div className="max-h-[50vh] overflow-auto">
        {diff === null ? <p className="p-4 text-sm text-muted">Loading diff…</p> : <DiffView diff={diff} />}
      </div>
      <div className="space-y-3 border-t border-border p-4">
        <Textarea rows={2} placeholder="Optional comment (recorded in the run history)" value={comment} onChange={(e) => setComment(e.target.value)} className="font-sans" />
        <div className="flex justify-end gap-2">
          <Button variant="danger" disabled={busy} onClick={() => decide(false)}>Reject</Button>
          <Button variant="success" disabled={busy || output.files_changed === 0} onClick={() => decide(true)}>Approve & open PR</Button>
        </div>
        {err && <p className="text-sm text-err">{err}</p>}
      </div>
    </Card>
  );
}

function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <p className="p-4 text-sm text-muted">The agents made no changes.</p>;
  return (
    <pre className="font-mono text-xs leading-5">
      {diff.split("\n").map((l, i) => (
        <div
          key={i}
          className={cx(
            "px-4 whitespace-pre-wrap",
            l.startsWith("+") && !l.startsWith("+++") && "diff-add",
            l.startsWith("-") && !l.startsWith("---") && "diff-del",
            l.startsWith("@@") && "diff-hunk",
            l.startsWith("diff --git") && "mt-2 border-t border-border bg-surface-2 py-1 font-semibold",
          )}
        >
          {l || " "}
        </div>
      ))}
    </pre>
  );
}
