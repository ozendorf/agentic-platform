import "server-only";
import { sql } from "./db";

export type BlockKind = "tool" | "agent" | "crew";

export interface ToolSpec {
  provider: "builtin" | "mcp";
  impl: string;
  description: string;
  capabilities: string[];
  modes: ("agent" | "action")[];
  input_schema: { type?: string; properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
  annotations?: Record<string, unknown>;
}
export interface AgentSpec {
  role: string;
  goal: string;
  backstory?: string;
  model?: string;
  tools: string[];
  max_iter?: number;
}
export interface CrewSpec {
  process: "sequential" | "hierarchical";
  manager_model?: string;
  agents: { key: string; ref: string }[];
  tasks: { key: string; agent: string; description: string; expected_output: string; context?: string[] }[];
}

export interface Block<S = unknown> {
  kind: BlockKind;
  name: string;
  title: string;
  description: string;
  owner: string;
  archived: boolean;
  version: number;
  versions: number[];
  spec: S;
  updated_at: string;
  provider: string | null;
}

export async function listBlocks(kind?: BlockKind): Promise<Block[]> {
  const rows = await sql<Block[]>`
    SELECT b.kind, b.name, b.title, b.description, b.owner, b.archived, b.updated_at, p.name AS provider,
           v.version, v.spec,
           (SELECT array_agg(version ORDER BY version) FROM block_versions WHERE block_id=b.id) AS versions
    FROM blocks b
    LEFT JOIN tool_providers p ON p.id=b.provider_id
    JOIN LATERAL (SELECT version, spec FROM block_versions WHERE block_id=b.id ORDER BY version DESC LIMIT 1) v ON true
    WHERE ${kind ? sql`b.kind=${kind}` : sql`true`}
    ORDER BY b.kind, b.name`;
  return rows;
}

export async function getBlock(kind: BlockKind, name: string, version?: number): Promise<Block | null> {
  const [b] = await sql<Block[]>`
    SELECT b.kind, b.name, b.title, b.description, b.owner, b.archived, b.updated_at, p.name AS provider,
           v.version, v.spec,
           (SELECT array_agg(version ORDER BY version) FROM block_versions WHERE block_id=b.id) AS versions
    FROM blocks b
    LEFT JOIN tool_providers p ON p.id=b.provider_id
    JOIN block_versions v ON v.block_id=b.id
    WHERE b.kind=${kind} AND b.name=${name} ${version ? sql`AND v.version=${version}` : sql``}
    ORDER BY v.version DESC LIMIT 1`;
  return b ?? null;
}

/** Add a new immutable version (creating the block if needed). Tools are synced, not edited here. */
export async function saveBlock(kind: "agent" | "crew", name: string, title: string, description: string, spec: unknown, owner = "local") {
  return sql.begin(async (tx) => {
    const [b] = await tx`INSERT INTO blocks (kind, name, title, description, owner) VALUES (${kind}, ${name}, ${title}, ${description}, ${owner})
      ON CONFLICT (kind, name) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, updated_at=now(), archived=false
      RETURNING id`;
    const [cur] = await tx`SELECT max(version) AS v FROM block_versions WHERE block_id=${b.id}`;
    const next = Number(cur?.v ?? 0) + 1;
    await tx`INSERT INTO block_versions (block_id, version, spec) VALUES (${b.id}, ${next}, ${tx.json(spec as never)})`;
    return next;
  });
}

export async function listProviders() {
  return sql`SELECT p.id, p.name, p.kind, p.config, p.status, p.error, p.synced_at,
      (SELECT count(*)::int FROM blocks b WHERE b.provider_id=p.id AND NOT b.archived) AS tools
    FROM tool_providers p ORDER BY p.kind, p.name`;
}

/** Which workflows' latest versions reference a block (for "used by" in the catalog). */
export async function usage(): Promise<Record<string, string[]>> {
  const rows = await sql`SELECT w.name, v.definition FROM workflows w
    JOIN LATERAL (SELECT definition FROM workflow_versions WHERE workflow_id=w.id ORDER BY version DESC LIMIT 1) v ON true`;
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    for (const s of r.definition?.steps ?? []) {
      const ref = String(s.uses ?? "").replace(/@\d+$/, "");
      if (!ref || ref === "approval") continue;
      const list = (out[ref] ??= []);
      if (!list.includes(r.name)) list.push(r.name);
    }
  }
  return out;
}
