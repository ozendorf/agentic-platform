CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text UNIQUE NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner       text NOT NULL DEFAULT 'local',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Immutable snapshots. A run always points at one version.
CREATE TABLE workflow_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version     int  NOT NULL,
  definition  jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);

CREATE TABLE runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_version_id   uuid NOT NULL REFERENCES workflow_versions(id),
  temporal_workflow_id  text UNIQUE NOT NULL,
  status                text NOT NULL DEFAULT 'pending', -- pending|running|waiting_approval|succeeded|failed|rejected
  inputs                jsonb NOT NULL,
  pr_url                text,
  error                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz,
  finished_at           timestamptz
);

CREATE TABLE run_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id     text NOT NULL,
  step_type   text NOT NULL,
  position    int  NOT NULL,
  status      text NOT NULL DEFAULT 'pending', -- pending|running|waiting|succeeded|failed|skipped
  attempt     int  NOT NULL DEFAULT 0,
  output      jsonb,
  error       text,
  tokens_in   bigint NOT NULL DEFAULT 0,
  tokens_out  bigint NOT NULL DEFAULT 0,
  cost_usd    numeric(12,6) NOT NULL DEFAULT 0,
  started_at  timestamptz,
  finished_at timestamptz,
  UNIQUE (run_id, step_id)
);

-- Per-model usage for the cost strip ("cost by model").
CREATE TABLE llm_usage (
  id          bigserial PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id     text NOT NULL,
  model       text NOT NULL,
  tokens_in   bigint NOT NULL,
  tokens_out  bigint NOT NULL,
  cost_usd    numeric(12,6) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Timeline + SSE replay. Everything the UI streams is a row here.
CREATE TABLE run_events (
  id          bigserial PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id     text,
  kind        text NOT NULL,   -- run.status|step.status|agent.thought|agent.tool|agent.task|log|diff|pr
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_events_run_idx ON run_events (run_id, id);

-- Large artifacts (diffs, crew outputs) kept out of Temporal payloads.
CREATE TABLE artifacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id     text NOT NULL,
  kind        text NOT NULL,   -- diff|crew_output|spec
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION notify_run_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('run_events', json_build_object('run_id', NEW.run_id, 'id', NEW.id)::text);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER run_events_notify AFTER INSERT ON run_events
  FOR EACH ROW EXECUTE FUNCTION notify_run_event();
