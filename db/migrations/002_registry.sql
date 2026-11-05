-- Registry of reusable, versioned building blocks: tools, agents, crews.
-- Workflows reference them as "<kind>:<name>[@version]".

CREATE TABLE tool_providers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text UNIQUE NOT NULL,          -- namespace of its tools, e.g. "github"
  kind        text NOT NULL CHECK (kind IN ('builtin', 'mcp')),
  config      jsonb NOT NULL DEFAULT '{}',   -- mcp: {"transport":"stdio","command":..,"args":[..],"env":{NAME: "$SECRET"}}
  status      text NOT NULL DEFAULT 'ok',
  error       text,
  synced_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('tool', 'agent', 'crew')),
  name        text NOT NULL,                 -- tools: "<provider>.<tool>", agents/crews: slug
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner       text NOT NULL DEFAULT 'platform',
  provider_id uuid REFERENCES tool_providers(id) ON DELETE CASCADE,
  archived    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, name)
);

-- Immutable. Runs record exactly which versions they resolved.
CREATE TABLE block_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id    uuid NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  version     int  NOT NULL,
  spec        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (block_id, version)
);

-- What a run actually used (filled by the compile step): {"tool:fs.read_file": 1, ...}
ALTER TABLE runs ADD COLUMN resolved jsonb;
ALTER TABLE run_steps ADD COLUMN uses text;
