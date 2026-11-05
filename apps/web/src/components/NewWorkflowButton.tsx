"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "./ui";

export function NewWorkflowButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function create() {
    const name = window.prompt("Workflow name", "My workflow");
    if (!name) return;
    setBusy(true);
    const W = "{{ steps.prepare.output.workspace }}";
    const definition = {
      version: 2,
      policy: { capabilities: ["github:read", "repo:read"], allowed_commands: [] },
      steps: [
        { id: "prepare", name: "Clone repo & create branch", uses: "tool:workspace.clone", with: { repo: "{{ inputs.repo }}", base_branch: "{{ inputs.base_branch }}" } },
        { id: "review", name: "Human review", uses: "approval", with: { workspace: W } },
      ],
    };
    const r = await fetch("/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description: "", definition }),
    });
    setBusy(false);
    const j = await r.json();
    if (!r.ok) return alert(j.error);
    router.push(`/workflows/${j.id}`);
  }
  return (
    <Button variant="primary" onClick={create} disabled={busy}>
      + New workflow
    </Button>
  );
}
