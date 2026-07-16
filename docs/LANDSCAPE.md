# Landscape & Differentiation

Snapshot date: **2026-07-14** (stars/activity via GitHub API; refresh when revisiting
build-vs-borrow decisions). Companion to [DESIGN.md](DESIGN.md).

## Why this document exists

Every pillar of skill-forge has open-source neighbors. This document keeps two
disciplines alive:

1. **Don't reinvent wheels** — before building a component, check the borrow
   column here first.
2. **Protect the differentiation** — invest effort only where the loop below is
   concerned; treat everything else as replaceable commodity.

## Differentiation thesis

No surveyed project closes this loop:

> **version & integrity-lock artifacts → deploy per-tool → instrument sessions
> deterministically → attribute evaluation results to the exact artifact
> configuration → evolve the artifacts against that evidence.**

- Sync tools stop at deployment (no measurement).
- Observability stacks stop at dashboards (no artifact linkage).
- Eval frameworks judge models/prompts, but have no versioned artifact registry
  to attribute results to or evolve.

Secondary differentiators: **per-tool asymmetry as a first-class design stance**
(sync tools assume lossless conversion; we deliberately author different role
sets and enforcement per tool), and **process instructions co-designed with the
machinery that evaluates them**.

**Anti-goals** (commodity — borrow, never build): generic eval-runner UX,
dashboard/visualization tech, public skill marketplaces, a 30-tool sync matrix.

## Pillar 1 — Cross-tool instruction/config sync

Fragmented space, no dominant winner (all ≤112 stars). Validates that sync alone
is not a product; it is our substrate, not our value.

| Repo | Stars | Last push | Goal / audience | Strengths | Weaknesses | Borrow for us |
|---|---|---|---|---|---|---|
| [block/ai-rules](https://github.com/block/ai-rules) | 112 | 2026-05 | One source → 11 agents' rule files; eng orgs standardizing guidelines (built by Block) | Single Rust binary; `status` sync check; selective `--agents` generation; config-file defaults; MCP config generation | Rules only (no eval, no versioning/lock); flat generation, no compose/overlay model | `status`-style one-screen drift summary across all targets (our `diff-*` output UX); selective per-tool install flags |
| [lbb00/ai-rules-sync](https://github.com/lbb00/ai-rules-sync) | 35 | 2026-03 | Sync rules/skills/commands/subagents across 10+ tools via symlinks; teams sharing standards | Broadest artifact-type coverage; multi-repo composition (company + community + personal sources); supported-tools matrix generated from JSON; local-only privacy config | Symlink model defeats integrity checking (edits propagate silently — the opposite of our lock/diff stance); no versioning | Docs-generated-from-data pattern (render README support tables from `registry.json`); multi-registry composition as a future idea |
| [amtiYo/agents](https://github.com/amtiYo/agents) | 78 | 2026-05 | One `.agents/` source incl. MCP servers across 6 tools | MCP server configs as a synced artifact type | Same no-eval, no-version gaps | MCP server configs as a candidate new artifact type in our registry |
| [yelmuratoff/agent_sync](https://github.com/yelmuratoff/agent_sync) | 10 | 2026-07 | Topic-per-file rules → 14 tools | Per-tool format conversion (.mdc, .instructions.md) | Shell-based; conversion-focused | Little — we intentionally don't convert |
| [spxrogers/agentsync](https://github.com/spxrogers/agentsync) | 4 | 2026-07 | Canonical committable source → 31 agents | Widest tool matrix | Breadth over depth | Tool-target naming survey when we add tools |

## Pillar 2 — Skill/subagent registries & marketplaces

Massive audiences here — this is where distribution lives. We should *publish
into* this ecosystem, not compete with it.

| Repo | Stars | Last push | Goal / audience | Strengths | Weaknesses | Borrow for us |
|---|---|---|---|---|---|---|
| [anthropics/skills](https://github.com/anthropics/skills) | 161,511 | 2026-07 | Official Agent Skills collection; every Claude user | Canonical skill format; installable as plugin marketplace | Curated content, not a management/eval tool | Skill authoring conventions; marketplace packaging as a **distribution channel for our skills** |
| [wshobson/agents](https://github.com/wshobson/agents) | 37,944 | 2026-07 | Multi-harness plugin marketplace (Claude Code, Codex, Cursor, Copilot, …) | Proven multi-tool packaging; huge adoption | Marketplace, not evaluator; no config attribution | Plugin/marketplace packaging format if we ever publish artifacts |
| [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) | 23,377 | 2026-07 | 100+ subagent collection | Role taxonomy breadth | Uncurated quality; no enforcement model | Role ideas to evaluate against our minimal set (our thesis: fewer, measured roles beat 100 unmeasured ones) |
| [majiayu000/claude-skill-registry](https://github.com/majiayu000/claude-skill-registry) | 498 | 2026-07 | Searchable skill index, updated daily | Discovery/search UX | Index only | Search/discovery UX ideas for our `site` |
| [`gh skill`](https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/) (GitHub CLI ≥2.90) | — | 2026-04 | First-party skill install: `gh skill install owner/repo name --agent claude-code --scope user` | Platform-native; likely standardization vector | Install only; no version ledger or eval | **Watchlist**: align our `install` addressing (owner/repo/name, `--scope`) so an export path stays cheap |

## Pillar 3a — Claude Code observability

Validates our OTel design (same shape everywhere); the leading repo is stale,
which justified building our own thin stack rather than adopting.

| Repo | Stars | Last push | Goal / audience | Strengths | Weaknesses | Borrow for us |
|---|---|---|---|---|---|---|
| [ColeMurray/claude-code-otel](https://github.com/ColeMurray/claude-code-otel) | 467 | **2025-06 (stale)** | Collector+Prometheus+Grafana for Claude Code | Early mover; comprehensive dashboards | Unmaintained ~13 months; no artifact/config linkage | Dashboard panel ideas (tool-usage, error views) |
| [acreeger/claude-code-metrics-stack](https://github.com/acreeger/claude-code-metrics-stack) | 10 | 2025-12 | Local Grafana stack incl. productivity metrics | Adds **Loki** for queryable event logs | Small; no attribution | Loki as an upgrade path from our file-exporter JSONL when event querying matters |
| [Grafana dashboard 25052](https://grafana.com/grafana/dashboards/25052-claude-code/) / [25255](https://grafana.com/grafana/dashboards/25255-claude-code-metrics-prometheus/) | — | current | Ready-made Claude Code dashboards | Maintained PromQL for the exact metrics we ingest | Generic; no per-config views | Import alongside ours; mine PromQL for per-model/edit-acceptance panels |

## Pillar 3b — Evaluation frameworks / LLM-as-judge

| Repo | Stars | Last push | Goal / audience | Strengths | Weaknesses | Borrow for us |
|---|---|---|---|---|---|---|
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | 23,311 | 2026-07 | Test prompts/agents/RAG; red teaming; has a [coding-agent guide](https://www.promptfoo.dev/docs/guides/evaluate-coding-agents/) | Mature assertion/eval runner; sandboxed coding-agent evals; tracing | Not artifact-registry-aware; config-as-YAML world; heavy dependency | **Candidate Layer-1 execution engine** — evaluate before hand-building a judge runner (DESIGN.md Phase A decision) |
| [confident-ai/deepeval](https://github.com/confident-ai/deepeval) | 16,887 | 2026-07 | LLM eval framework; custom judges | Judge-metric library; dataset generation; agent tracing | Python platform; model-centric, not artifact-centric | Judge-metric design patterns (rubric → score → reason shape) for our 5-metric framework |
| [mlflow/mlflow](https://github.com/mlflow/mlflow) | 27,051 | 2026-07 | AI engineering platform; experiments, tracing, evals | **Experiment/run comparison semantics** — the closest analog to our config-fingerprint comparisons; built-in judges | Server + platform weight; overkill for a local loop | Borrow the *experiment model semantics* (run, params=config fingerprint, metrics) for the Efficacy Ledger schema — not the platform |
| [Agent-as-a-Judge (research)](https://arxiv.org/pdf/2508.02994) | — | 2025 | Evaluate agent trajectories with agent judges | Matches our two-pass, trajectory-not-just-output design | Research, not tooling | Cite as grounding for Judge layer design choices |

## Standing decision rules

1. **Before building any component, check this file.** If a maintained project
   covers it and doesn't compromise the loop, adopt or wrap it.
2. **Never adopt anything that breaks attribution.** Symlink sync, unversioned
   marketplaces, and content-capturing telemetry all fail this test regardless
   of popularity.
3. **Distribution ≠ differentiation.** Publishing our skills to anthropics/skills
   marketplace format or `gh skill` addressing is fine — the loop, not the
   content, is the moat.
4. **Watchlist** (recheck quarterly): `gh skill` addressing/scope conventions,
   block/ai-rules feature growth, the [agents.md](https://agents.md/) standard,
   promptfoo's coding-agent eval maturity.

## Borrow backlog (mapped to roadmap)

| Roadmap phase | Borrow |
|---|---|
| Phase 0 (fingerprint) | MLflow run/params/metrics semantics for the ledger schema |
| Phase A (judge) | Promptfoo as candidate runner; deepeval rubric shapes; Agent-as-a-Judge two-pass grounding |
| Phase B (monitor) | acreeger's Loki pattern if JSONL querying gets painful |
| Phase C (efficacy/site) | Grafana 25052/25255 PromQL; claude-skill-registry discovery UX |
| CLI polish | block/ai-rules `status` UX; `gh skill`-compatible addressing |
| Docs | lbb00's generated-from-data support tables |
