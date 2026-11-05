# Agentic Platform (experimental, local)

Build agentic workflows in a web UI and run them durably:

- **Temporal** orchestrates the runs: retries, timeouts, durable waits and the full event history.
- **CrewAI** is the agent layer.
- **Postgres** holds the application state.

First use case: **Markdown spec → PR**. A crew (planner + engineer) implements a markdown spec in a GitHub repo, a human approves the diff, and a pull request opens.

```
Next.js UI + API ──start/signal──► Temporal (docker) ──queues──► Python workers
   ▲  SSE (pg LISTEN/NOTIFY)        wf-interpreter · tools · agents   ├─ interpreter workflow (generic)
   └──────────── App Postgres ◄──── step state, events, tokens, cost ─┤─ git / GitHub activities
                                                                      └─ CrewAI crew activity → Anthropic API
```

Everything runs on your machine. The only outbound calls are to the Anthropic API and GitHub.

## Setup

Requirements: docker, node + pnpm, [uv](https://docs.astral.sh/uv/), and `gh auth login` (or a `GITHUB_TOKEN`).

```bash
cp .env.example .env      # set ANTHROPIC_API_KEY (GITHUB_TOKEN falls back to `gh auth token`)
pnpm setup                # installs deps, starts Postgres + Temporal, migrates, seeds
pnpm dev                  # web on :3000 + worker (all queues)
```

- Studio: http://localhost:3000
- Temporal UI: http://localhost:8080

## How it works

Workflows are assembled from **versioned building blocks** in a registry (the Catalog page):

| Block | What it is | Examples |
|---|---|---|
| `tool:` | One capability with an input schema and the capabilities it needs. Built-in, or **one block per MCP tool**. | `fs.read_file`, `workspace.clone`, `github.open_pr`, `github.pull_request_read` (MCP) |
| `agent:` | Role, goal, model, and the tools it may use | `spec-planner`, `pr-reviewer` |
| `crew:` | Agents (by reference) plus tasks and a process | `implement-spec` |

A workflow (definition `version: 2`) has:
- a **policy**: the capabilities it grants, plus the commands it allows;
- **steps**, where each step has `uses:` (`tool:` = an action, `agent:` / `crew:` = an LLM loop, or `approval`) and `with:` inputs bound with `{{ inputs.x }}` and `{{ steps.<id>.output.y }}`.

```yaml
policy: { capabilities: [github:read, repo:read, repo:write, exec, github:write] }
steps:
  - { id: prepare,   uses: tool:workspace.clone, with: { repo: "{{ inputs.repo }}" } }
  - { id: implement, uses: crew:implement-spec,  with: { spec: "{{ inputs.spec }}", workspace: "{{ steps.prepare.output.workspace }}" } }
  - { id: review,    uses: approval,             with: { workspace: "{{ steps.prepare.output.workspace }}" } }
  - { id: pr,        uses: tool:github.open_pr,  with: { workspace: "...", summary: "{{ steps.implement.output.summary }}" } }
```

- **The `interpreter.v2` workflow** runs any definition. Its first activity compiles the definition:
  - it resolves every reference to a pinned block version, with the specs inlined into the run plan;
  - it **refuses tools whose capabilities aren't granted**.

  The plan lands in Temporal history, so registry edits never affect a running or replaying run. Runs record which versions they used.
- **Capabilities:**
  - built in: `repo:read`, `repo:write`, `exec`, `github:read`, `github:write`;
  - MCP tools get `<provider>:read` or `<provider>:write` from their `readOnlyHint` annotation.

  The editor shows each step's needs and flags any that aren't granted.
- **Durability:**
  - an action is one activity on `tools`;
  - a crew is one heartbeating activity on `agents`; a crash retries it after resetting the workspace to the last checkpoint;
  - an approval is a durable signal wait.
- **MCP providers** are registered from the CLI only, because a provider is a command the worker executes:
  ```bash
  cd workers && uv run mcp-add --name github --env 'GITHUB_PERSONAL_ACCESS_TOKEN=$GITHUB_TOKEN' -- \
    docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server stdio --toolsets repos,issues,pull_requests
  ```
  Env values written as `$NAME` are resolved when a tool is called and never stored. Re-sync from the Catalog → Providers tab.
- **Observability:**
  - `run_events` streams over SSE, carrying tool calls, task output and usage;
  - tokens and cost are recorded per model;
  - the Temporal UI shows the raw history.
- **v1 definitions** (inline crew config, workflow `interpreter`) still run, so runs started before the registry can finish.

Everything listens on 127.0.0.1 only. There is no authentication yet.

## Useful commands

```bash
pnpm test                                   # interpreter + tool tests (needs infra up), lint, typecheck
cd workers && uv run start-sample --repo you/repo --spec spec.md   # start a run without the UI
cd workers && uv run worker --queues agents  # run only one queue (e.g. to kill it mid-run)
pnpm infra:down                             # stop docker services (data is kept in a volume)
```

## Layout

```
infra/            docker compose: postgres 16, temporal auto-setup 1.29, temporal ui
db/migrations/    SQL schema (single source of truth for Python + TS)
workers/          Python 3.12 + uv: Temporal workers, CrewAI crews, tests
apps/web/         Next.js 16: Studio UI + thin API (Temporal client, postgres, SSE)
```
