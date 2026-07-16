# Local OTel Stack for Claude Code Token Economics

A loopback-only observability stack for evaluating agent-tool usage: whole-session
token and cost metrics from Claude Code's native OpenTelemetry support, including
the split between main-loop and subagent spend.

## Components

| Service | Port (loopback only) | Purpose |
|---|---|---|
| otel-collector | 4317 (gRPC), 4318 (HTTP) | Receives Claude Code OTLP metrics and events |
| Prometheus | 9090 | Stores metrics, serves PromQL |
| Grafana | 3001 | "Claude Code Token Economics" dashboard (anonymous viewer enabled) |

Events (per-API-request records with `cost_usd`, `duration_ms`, token counts, and
`agent.name`) are additionally retained raw in `otel/data/claude-events.jsonl`
via the collector's file exporter for offline analysis.

## Run

The stack is defined in `docker-compose.yml` at the repository root (project
name `skill-forge-otel`) and works with both `docker compose` and
`podman compose`:

```bash
mkdir -p otel/data
podman compose up -d
podman compose ps
```

Verify: `curl -s http://127.0.0.1:9090/-/ready` and open <http://127.0.0.1:3001>.

Stop with `podman compose down` (add `-v` only if you intend to delete stored
metrics and dashboards state).

## Enable telemetry in Claude Code

Merge the `env` block from `claude-settings-env-snippet.json` into
`~/.claude/settings.json` (or a single project's `.claude/settings.json` to scope
the measurement). New Claude Code sessions then emit:

- `claude_code.token.usage` — by `type` (input/output/cacheRead/cacheCreation), `model`, `query_source` (`main` / `subagent` / `auxiliary`), `agent.name`
- `claude_code.cost.usage` — USD, same attribute split
- `claude_code.api_request` events — per-request `cost_usd`, `duration_ms`, token counts
- session counts, active time, lines of code, and more

Privacy defaults are preserved: prompt and response content logging remain off
(`OTEL_LOG_USER_PROMPTS` / `OTEL_LOG_ASSISTANT_RESPONSES` unset).

## Evaluating delegation economics

- **Delegation split:** the dashboard's "Cost by query source" panel compares
  main-loop vs subagent vs auxiliary spend directly; sessions with no delegation
  show 100% `main`.
- **Per-agent cost:** "Cost by agent" breaks out built-in agents (`Explore`,
  `Plan`, ...) verbatim. **Limitation:** user-defined subagents (`validator`,
  `reviewer`, `bulk-worker`) all report as `agent.name="custom"` in OTel.
- **Exact custom-agent attribution:** join on `session.id` — OTel metrics carry
  `session_id`, and the skill-forge stats hook (`~/.skill-forge/stats/*.jsonl`)
  records which named agents ran in each session with task descriptions. Together
  they answer "what did session X spend, and on which named subagents".

## Notes

- Prometheus metric names gain translation suffixes (for example
  `claude_code_token_usage_tokens_total`) that vary slightly across collector
  versions; the provisioned dashboard queries match by name prefix to stay
  version-tolerant.
- All ports bind 127.0.0.1 — nothing is exposed to the network.
- Image tags are pinned in the root `docker-compose.yml`; bump deliberately.
- `otel/data/` is gitignored (raw event retention).
