# Skill Forge — Design

Last updated: 2026-07-14

Skill Forge exists for two goals:

1. **Evaluate** — measure how the agent tool and its artifacts (managed
   instructions, skills, subagents) perform *together*, sliced by SDLC lenses:
   work phase (exploration/planning, implementation, verification, review) and
   task type (UI, backend, integration, e2e testing), plus risk tier and cost.
2. **Evolve** — revise those artifacts based on the evaluation evidence, and
   verify that each revision actually improved outcomes.

The registry/installer is the substrate that makes both possible: it versions
every artifact, locks its integrity, and deploys it reproducibly — so a
"configuration under test" is a precise, hashable thing, and performance deltas
can be attributed to specific artifact changes. This document records the current
architecture, the design principles, the target evaluation framework, and the
roadmap.

## Design Principles

1. **The repository is the source of truth.** Runtime files (`~/.claude/CLAUDE.md`,
   `~/.codex/AGENTS.md`, `~/.copilot/instructions/agents.instructions.md`,
   `~/.grok/AGENTS.md`, skill and agent directories) are deployment targets. Edit
   inventory, then reinstall; `diff-*` commands detect drift.
2. **Integrity is locked.** `registry.json` is the human-maintained manifest;
   `registry-lock.json` carries SHA-256 integrity per artifact file. A stale lockfile
   is a validation error.
3. **Minimal always-loaded context.** Shared process lives in `core.md`; tool
   specifics live in overlays; occasional-use material (templates, rubrics) lives in
   skills that load on demand. Registry-repo-only rules live in repo-local
   instruction files, not in the composed output.
4. **Deterministic instrumentation over instructed self-reporting.** Anything that
   must happen reliably (usage stats, monitoring, telemetry) is implemented as
   harness hooks or OTel — never as an instruction the model may forget.
5. **Per-tool asymmetry is intentional.** Role sets and enforcement differ by tool
   capability; definitions are never copied between tool directories.
6. **Privacy by default.** Instrumentation records metadata only — agent names,
   models, token counts, costs, durations. Prompt and response content is never
   captured (OTel content flags stay off; the stats hook strips them).

## Current Architecture

### Artifact types (registry-tracked, installable via CLI)

| Type | Inventory | Runtime target | Notes |
|---|---|---|---|
| Skills (16) | `inventory/skills/<name>/` | `~/.codex/skills`, `~/.claude/skills`, `~/.copilot/skills`, `~/.grok/skills` | `name`/`description` frontmatter; versions and `tags` in registry only |
| Managed agents | `inventory/agents/core.md` + `<tool>/` overlay | Tool instruction file | Composed at install; `{{placeholder}}` tokens resolved from per-tool `vars` |
| Subagents | `inventory/subagents/<tool>/` | Tool agents dir | Role sets differ per tool (see below) |
| Hooks | `inventory/hooks/claude-code/`, `inventory/hooks/grok/` | `~/.claude/hooks/skill-forge`, `~/.grok/hooks` | Deterministic usage-stats writer; Claude uses a settings snippet, Grok loads a hook JSON directly |

### Composed instruction model

`core.md` (shared process: risk tiers, explore→spec→implement, gates, delegation,
review lenses) + tool overlay, joined with a separator at compose time.
Placeholders like `{{explore_agent}}`/`{{plan_agent}}` resolve per tool
(`researcher`/`planner` for Codex and Copilot, `Explore`/`Plan` for Claude Code,
`explore`/`plan` for Grok), so the deployed file names the right agents with no
mapping prose. `validate` fails on unresolved placeholders and warns on unused vars.

### Delegation model

- **Codex / Copilot CLI:** five maintained roles (`bulk_worker`/`bulk-worker`,
  `researcher`, `validator`, `planner`, `reviewer`); Codex pins sandbox modes.
- **Claude Code:** three maintained roles (`bulk-worker`, `reviewer`, `validator` —
  the latter two with enforcing `tools:` allowlists); exploration and planning use
  the built-in `Explore`/`Plan` agents, which are harness-enforced read-only.
- **Grok:** three maintained roles (`bulk-worker`, `reviewer`, `validator`);
  exploration and planning use the built-in `explore`/`plan` agents (read-only).
  `reviewer` uses `permission_mode: plan`; parent may pass `capability_mode` on
  `spawn_subagent` for tighter tool filters.

### Observability (current)

- **Stats hook** (`skill-forge-stats.mjs`): Claude Code `PostToolUse`(Agent/Task) and
  `SessionEnd` events, and Grok `PostToolUse`(spawn_subagent), `SubagentStop`, and
  `SessionEnd` events, append schema-versioned JSONL to `~/.skill-forge/stats/` —
  exact agent names (including custom subagents), task descriptions, session IDs.
- **OTel stack** (root `docker-compose.yml`, project `skill-forge-otel`, loopback
  only): collector (4317/4318) → Prometheus (9090) → Grafana (3001) with the
  provisioned "Claude Code Token Economics" dashboard. Claude Code native telemetry
  splits token/cost by `query_source` (main/subagent/auxiliary) and `agent.name`.
  Raw per-request events retained to `otel/data/claude-events.jsonl`.
- **Known limitation:** user-defined subagents report as `agent.name="custom"` in
  OTel; exact attribution comes from joining the stats JSONL on `session.id`.
- **Catalog site** (`skill-forge site`): self-contained static HTML — skills by tag,
  subagents per tool, composed-agent previews, stats aggregates.

### Verification

`npm test` (node:test, 6 e2e cases): registry validation, placeholder resolution
per tool, stats writers (including the no-prompt-content guarantee), site
generation. `validate` + `diff-*` are the standing gates after any inventory change.

## Evaluation Model

**Unit of evaluation:** (agent tool × artifact configuration × task). The artifact
configuration is identified by the installed artifact versions — ultimately the
registry-lock integrity state — so results attach to exact versions, not to "the
current setup".

**Lenses (slicing dimensions):**

| Lens | Values | Source |
|---|---|---|
| Work phase | explore/plan, implement, verify, review | judge phase, task records |
| Task type | ui, backend, integration, e2e-testing, ... | run metadata; skill `tags` provide the default taxonomy |
| Risk tier | 1 / 2 / 3 | task records (`tasks/todo.md` blocks) |
| Delegation | main vs subagent, per agent name | OTel `query_source`/`agent.name` + stats JSONL |
| Economics | tokens, cost, duration | OTel |
| Configuration | artifact versions / lock hash | install manifest (planned) |

**Metric families:** output quality (Judge layer), runtime behaviour (Monitoring
layer), longitudinal reliability (Efficacy layer), and economics (OTel) — a
configuration is only "better" if quality holds or improves at acceptable cost.

## The Evolution Loop

Evaluation exists to drive artifact revision, closed-loop:

1. **Evaluate** — run real tasks; collect judge verdicts, monitor signals,
   efficacy metrics, and costs, sliced by the lenses above.
2. **Attribute** — findings map to specific artifacts and versions (a low PAR on
   implementation-phase UI tasks implicates the frontend skills or the
   implementing agent's instructions, at the versions recorded for those runs).
3. **Revise** — change **one artifact at a time** where practical; bump its
   version in `registry.json`; re-lock; reinstall. The version bump is the
   experiment boundary.
4. **Re-evaluate** — compare metrics across configuration versions (PAR/DDR/cost
   per version). Keep the change if quality holds or improves at acceptable cost;
   revert otherwise.
5. **Record** — outcomes land in the Key Design Decisions log below and
   `tasks/lessons.md`; systemic findings become new skills or checklist entries.

This loop has run informally already (e.g. the 2026-07-13 subagent consolidation
followed a review-driven evaluation); the framework below makes it measured
instead of judgment-only.

## Target: Three-Layer Evaluation Framework

Evaluates output quality, runtime behaviour, and longitudinal reliability across
the phases of core.md's pipeline (Explore → Spec → Implement → Verify → Review —
one vocabulary; judge phases alias onto these names).

### Layer 1 — Judge (post-phase quality gates)

- A single `phase-judge` skill with per-phase rubric companion files (5 metrics,
  each with WHY / UNIT / HOW), invoked as `/phase-judge <phase> <run-id>`.
- Two-pass protocol mapped onto existing delegation: Pass 1 re-derives the expected
  baseline from sources (built-in `Explore`, read-only); Pass 2 audits output
  against it (`reviewer` subagent, severity-tagged findings). Every deduction cites
  a source file.
- Verdict CLEARED / SOFT PASS / BLOCKED; BLOCKED writes `blocked` status into
  `tasks/todo.md` (reuses §5.1 gate semantics — no new state machine).
- Each run writes `judge-metrics.json` to `~/.skill-forge/judge/<project>/` against
  a schema versioned in this repo.
- **Tier-scaled:** mandatory two-pass for Tier 3; single-pass or opt-in below.

### Layer 2 — Monitoring (real-time, deterministic)

- Design amendment vs. the original framework: **hook-based, not embedded
  self-audit.** A second managed hook tracks per-session reads/writes/searches in
  `~/.skill-forge/monitor/` and fires soft annotations through the hook protocol
  (agent sees the warning, continues).
- **EBM** (Execution Budget Monitor): tool-call volume without progress signals,
  cross-referenced with near-real-time OTel cost.
- **SAG** (Specification Anchor Guard): runtime version is heuristic only
  (same-file edit churn, edits with no spec/test touched); the semantic judgment —
  "correcting output instead of the spec" — belongs to the Judge layer post-hoc.
- Log is JSONL (schema-versioned); `agent-monitor-log.md` is a rendered view, not
  the source format. Claude Code only; other tools degrade honestly (documented).

### Layer 3 — Efficacy (longitudinal)

- `skill-forge efficacy [project]` computes, from the Efficacy Ledger (a join of
  stats JSONL + judge-metrics + OTel session costs, keyed by session and stamped
  with the configuration fingerprint), sliceable by every lens above:
  - **PAR** — first-attempt judge pass rate per agent/phase.
  - **DDR** — do SOFT PASS warnings predict downstream BLOCKED verdicts? Needs a
    small Defect Attribution Map schema linking warnings to later defects.
  - **SFI** — specification fidelity / context drift; advisory only, built last.
- Rendered in the catalog site's Evaluation section; optionally a Grafana panel.
- Run identity: ledger schema defines `run_id` (project slug + timestamp); the
  judge stamps it into every artifact it writes.

## Related Work

See [LANDSCAPE.md](LANDSCAPE.md) for the surveyed open-source neighbors per
pillar, the differentiation thesis, standing build-vs-borrow decision rules, and
the borrow backlog mapped to the roadmap phases below. Check it before building
any new component.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | **Configuration fingerprint**: `install` writes an install manifest (`~/.skill-forge/installed.json`: artifact versions + lock hash); the stats hook stamps it into session records. **Task-type dimension**: `task_type` field in the stats/judge schemas, defaulting from the skill-tag taxonomy | Next — enables attribution for everything below |
| A | `phase-judge` skill + rubric companions, judge-metrics schema (phase, tier, task_type, run_id, config fingerprint), verdict wiring into `tasks/todo.md` | After 0 — spec drafted on request |
| B | Monitor hook (EBM + heuristic SAG), monitor JSONL + site rendering | After A |
| C | `efficacy` CLI (PAR, DDR, per-lens and per-configuration comparison), Evaluation site section; SFI stub | After B |

### Other open items

- `diff-global` checks skill drift against the Codex runtime only; the Claude Code
  and Copilot skill copies are not drift-checked (registry `runtimeTarget` is
  single-valued). Fix: per-tool runtime targets or iterate `TOOL_SKILL_TARGETS`.
- `~/.agents/skills/` (tool-neutral shared path named in core.md discovery) is not
  an install target; either add it or drop the preference wording.
- `install --yes` still prompts interactively for the target path; `--yes` should
  imply the default path for scripted use.
- Codex/Copilot equivalents for the stats hook (no hook support today — revisit as
  those tools grow event mechanisms). Grok has a first-class stats hook.
- Template extraction follow-ups: §8/§9/§13 are done; audit remaining always-loaded
  content periodically.

## Key Design Decisions

| Date | Decision | Rationale |
|---|---|---|
| 2026-07-13 | Claude Code drops `researcher`/`planner` for built-in `Explore`/`Plan`; `reviewer`/`validator` get `tools:` allowlists | Harness enforcement beats prose contracts; less maintenance |
| 2026-07-13 | Dedupe `coding-discipline` (process) vs `code-quality` (artifact) | Both always co-activate; duplicated rules are paid context |
| 2026-07-13 | Bug Fix Report Template moved into `testing-strategy` | §8 already mandates activating that skill — guaranteed load without always-on cost |
| 2026-07-14 | Registry-only rules extracted to repo-local `CLAUDE.md`/`AGENTS.md` | Consumer projects shouldn't carry registry-repo instructions |
| 2026-07-14 | Compose-time `{{placeholder}}` substitution with per-tool `vars` | Deployed files name tool-correct agents; validate enforces resolution |
| 2026-07-14 | Usage stats via deterministic hooks, JSONL, metadata-only | Instructed self-reporting is unreliable; content capture is off-limits |
| 2026-07-18 | Grok first-class: agents overlay, subagents, hooks | Grok has built-in `explore`/`plan` + hooks JSON discovery; role set mirrors Claude Code asymmetry rather than copying Codex |
| 2026-07-14 | OTel (collector/Prometheus/Grafana, loopback) for whole-session economics | Native `query_source`/`agent.name` split answers delegation-cost questions |
| 2026-07-14 | Evaluation framework: one phase vocabulary; hook-based Layer 2; tier-scaled judge | Avoid dual taxonomies, unreliable self-audit, and unbounded judge cost |
