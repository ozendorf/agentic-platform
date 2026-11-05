import "server-only";
import { sql } from "./db";
import type { WorkflowDef } from "./types";

export interface WorkflowRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  owner: string;
  updated_at: string;
  version: number;
  version_id: string;
  definition: WorkflowDef;
  runs: number;
  last_run_status: string | null;
}

export async function listWorkflows(): Promise<WorkflowRow[]> {
  return sql<WorkflowRow[]>`
    SELECT w.*, v.version, v.id AS version_id, v.definition,
      (SELECT count(*)::int FROM runs r JOIN workflow_versions vv ON vv.id=r.workflow_version_id WHERE vv.workflow_id=w.id) AS runs,
      (SELECT r.status FROM runs r JOIN workflow_versions vv ON vv.id=r.workflow_version_id WHERE vv.workflow_id=w.id ORDER BY r.created_at DESC LIMIT 1) AS last_run_status
    FROM workflows w
    JOIN LATERAL (SELECT * FROM workflow_versions WHERE workflow_id=w.id ORDER BY version DESC LIMIT 1) v ON true
    ORDER BY w.updated_at DESC`;
}

export async function getWorkflow(id: string): Promise<WorkflowRow | null> {
  const rows = await sql<WorkflowRow[]>`
    SELECT w.*, v.version, v.id AS version_id, v.definition, 0 AS runs, NULL AS last_run_status
    FROM workflows w
    JOIN LATERAL (SELECT * FROM workflow_versions WHERE workflow_id=w.id ORDER BY version DESC LIMIT 1) v ON true
    WHERE w.id=${id}`;
  return rows[0] ?? null;
}

export interface RunRow {
  id: string;
  status: string;
  inputs: { repo: string; base_branch: string; spec: string };
  pr_url: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  temporal_workflow_id: string;
  workflow_id: string;
  workflow_name: string;
  version: number;
  definition: WorkflowDef;
  cost_usd: string;
  tokens_in: string;
  tokens_out: string;
}

const RUN_SELECT = sql`
  SELECT r.*, w.id AS workflow_id, w.name AS workflow_name, v.version, v.definition,
    COALESCE((SELECT sum(cost_usd) FROM llm_usage u WHERE u.run_id=r.id), 0) AS cost_usd,
    COALESCE((SELECT sum(tokens_in) FROM llm_usage u WHERE u.run_id=r.id), 0) AS tokens_in,
    COALESCE((SELECT sum(tokens_out) FROM llm_usage u WHERE u.run_id=r.id), 0) AS tokens_out
  FROM runs r JOIN workflow_versions v ON v.id=r.workflow_version_id JOIN workflows w ON w.id=v.workflow_id`;

export async function listRuns(limit = 50): Promise<RunRow[]> {
  return sql<RunRow[]>`${RUN_SELECT} ORDER BY r.created_at DESC LIMIT ${limit}`;
}

export async function getRunDetail(id: string) {
  const [run] = await sql<RunRow[]>`${RUN_SELECT} WHERE r.id=${id}`;
  if (!run) return null;
  const steps = await sql`SELECT step_id, step_type, uses, position, status, attempt, output, error, tokens_in, tokens_out,
      cost_usd, started_at, finished_at FROM run_steps WHERE run_id=${id} ORDER BY position`;
  const usage = await sql`SELECT model, sum(tokens_in)::bigint AS tokens_in, sum(tokens_out)::bigint AS tokens_out,
      sum(cost_usd) AS cost_usd FROM llm_usage WHERE run_id=${id} GROUP BY model ORDER BY model`;
  return { run, steps, usage };
}
