import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  secondary: "border border-border bg-surface hover:bg-surface-2",
  ghost: "text-muted hover:bg-surface-2 hover:text-text",
  danger: "border border-err/40 text-err hover:bg-err/10",
  success: "bg-ok text-white hover:opacity-90",
};

export function Button({ variant = "secondary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...p}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant],
        className,
      )}
    />
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-lg border border-border bg-surface", className)}>{children}</div>;
}

const field = "w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20";

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx(field, p.className)} />;
}
export function Textarea(p: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cx(field, "font-mono text-[13px] leading-5", p.className)} />;
}
export function Select(p: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={cx(field, "pr-8", p.className)} />;
}

export function Label({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted">
        {label}
        {hint && <span className="ml-1 font-normal opacity-75">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}

const STATUS: Record<string, { c: string; label?: string }> = {
  pending: { c: "bg-surface-2 text-muted" },
  running: { c: "bg-info/12 text-info" },
  waiting: { c: "bg-warn/15 text-warn", label: "waiting" },
  waiting_approval: { c: "bg-warn/15 text-warn", label: "needs approval" },
  succeeded: { c: "bg-ok/12 text-ok" },
  failed: { c: "bg-err/12 text-err" },
  rejected: { c: "bg-err/12 text-err" },
  skipped: { c: "bg-surface-2 text-muted" },
};

export function StatusPill({ status }: { status: string }) {
  const s = STATUS[status] ?? STATUS.pending;
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", s.c)}>
      {(status === "running" || status === "waiting_approval" || status === "waiting") && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {s.label ?? status}
    </span>
  );
}

export function fmtUsd(v: number | string) {
  const n = Number(v);
  return n === 0 ? "$0.00" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
export function fmtNum(v: number | string) {
  return Number(v).toLocaleString("en-US");
}
export function fmtDuration(ms: number) {
  if (ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
export function timeAgo(iso: string) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
