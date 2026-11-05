"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, Input, Label, Select, Textarea } from "./ui";

const SAMPLE = `# Add a health check endpoint

Add a \`GET /health\` endpoint that returns \`{"status": "ok"}\` with HTTP 200.

## Acceptance criteria
- The endpoint follows the existing routing conventions of the project.
- A test covers the new endpoint.
- The README documents it in one line.
`;

export function StartRunForm({ workflows, initialWorkflow }: {
  workflows: { id: string; name: string; version: number }[];
  initialWorkflow?: string;
}) {
  const router = useRouter();
  const [workflowId, setWorkflowId] = useState(initialWorkflow ?? "");
  const [repo, setRepo] = useState("");
  const [base, setBase] = useState("main");
  const [spec, setSpec] = useState(SAMPLE);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(f: File | undefined) {
    if (f) setSpec(await f.text());
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflowId, repo, base_branch: base, spec }),
    });
    const j = await r.json();
    if (!r.ok) {
      setBusy(false);
      return setErr(j.error);
    }
    router.push(`/runs/${j.id}`);
  }

  return (
    <form onSubmit={submit}>
      <Card className="space-y-5 p-6">
        <Label label="Workflow">
          <Select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} required>
            {workflows.map((w) => <option key={w.id} value={w.id}>{w.name} (v{w.version})</option>)}
          </Select>
        </Label>
        <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
          <Label label="GitHub repository" hint="owner/name">
            <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="your-org/your-repo" required />
          </Label>
          <Label label="Base branch">
            <Input value={base} onChange={(e) => setBase(e.target.value)} required />
          </Label>
        </div>
        <Label label="Markdown spec" hint="what the agents should implement">
          <Textarea value={spec} onChange={(e) => setSpec(e.target.value)} rows={16} required />
        </Label>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="cursor-pointer text-sm text-muted hover:text-text">
            <input type="file" accept=".md,.markdown,.txt,text/markdown" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            ↑ Load a .md file
          </label>
          <Button variant="primary" type="submit" disabled={busy || !workflowId}>
            {busy ? "Starting…" : "Start run"}
          </Button>
        </div>
        {err && <pre className="whitespace-pre-wrap rounded-md bg-err/10 p-3 text-sm text-err">{err}</pre>}
      </Card>
    </form>
  );
}
