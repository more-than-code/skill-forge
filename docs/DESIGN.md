# Skill Forge — Design

Last updated: 2026-07-20

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
| Skills (24) | `inventory/skills/<name>/` | Profile-vendored: `.agents/skills`/`.claude/skills` per consumer repo, `~/.agents/skills`/`~/.claude/skills` via the `$HOME` profile | `name`/`description` frontmatter; versions and `tags` in registry only; see Project Skill Profiles below |
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

## Project Skill Profiles (shipped 2026-07-19)

Status: implemented — `skf project`/`skf home`/`sync` landed 2026-07-19 (CLI
1.2.0) with the home namespace, minimal home seed, and tool-derived sync
targets following 2026-07-20 (CLI 1.3.0). This section is the design of
record; per-tool global skill installs were removed the same day it shipped.

Skill Forge should support a conventional package-manager-style project workflow:
skills are authored and versioned in the Skill Forge registry, while each
repository declares the subset it depends on and vendors exact copies of those
skills into its own tree. The declaration is positive and physical: a skill is
active for a project because its body sits at a project-local discovery path the
harness and activation protocol already read — not because an instruction asks
agents to ignore globally installed alternatives.

### Scope: skills only

Only skills become project-scoped. Managed agent instructions, subagents, and
hooks remain global per-tool installs:

- They are runtime configuration, not task-domain dependencies — the process
  (risk tiers, delegation roles, gates) is the same in every repository.
- They do not have the activation-boundary problem: instructions and hooks load
  wholesale, and subagent role sets are always relevant.
- Tools already offer native project-level overrides (repo
  `CLAUDE.md`/`AGENTS.md`, project agents directories) if a repository ever
  needs a delta; Skill Forge does not need to manage that today.

Project-scoped subagent or hook profiles can be proposed later if evaluation
shows per-project role variation matters.

### Naming

- `skill-forge.json` is the project manifest. The full name is clearer than
  `skf.config.json` because the file describes project artifact dependencies, not
  just local CLI preferences.
- `skill-forge.lock.json` is the generated project lockfile: exact resolved
  versions, integrity hashes, and registry provenance.
- There is no `.skill-forge/` project directory. Sync writes only committed
  artifacts (manifest, lockfile, vendored skill bodies), so no machine-local
  project state exists to store or gitignore.

### Mental model

The model has three layers:

1. **Registry = source and cache.** The skill-forge checkout holds every skill
   body with locked integrity; the CLI resolves from its own inventory. There
   are no per-tool global skill installs to maintain or verify.
2. **Project manifest.** A repository declares the skills it needs, optional
   profile inheritance, and the agent tools whose discovery paths sync writes.
3. **Project sync.** `skf sync` resolves the manifest, vendors the resolved
   skill bodies into the repository, and pins versions and hashes in the
   lockfile.

The activation boundary is physical: in a synced repository, Skill
Forge-managed skills exist only at the project's discovery paths, so the
harness and the activation protocol can only see the declared profile. This is
deterministic in the sense of design principle 4 — no instruction has to tell
agents which globally installed skills to ignore. It also makes skill use
auditable in code review (vendored diffs travel with the change that needed
them) and evaluation runs attributable to the repository tree alone.

### Manifest shape

Minimum useful shape:

```json
{
  "schemaVersion": 1,
  "extends": ["baseline"],
  "skills": {
    "dependencies": {
      "frontend-engineering": "^0.1.0",
      "design-sync-svelte": "^0.1.0"
    },
    "local": {
      "my-override": ".agents/skills/my-override"
    }
  },
  "tools": {
    "codex": true,
    "claude-code": true,
    "copilot-cli": false,
    "grok": false
  }
}
```

Design notes:

- `extends` names profiles defined in a `profiles` section of `registry.json`
  (profile name → skill names/ranges), versioned and integrity-locked like
  every other registry artifact. Merging is a union; if a profile and the
  project declare conflicting ranges, the resolved version must satisfy both or
  sync fails with a diagnostic. `extends: []` gives a fully explicit skill set.
- Semver ranges are compatibility gates, not version selectors. The registry
  holds exactly one version per skill; sync resolves every dependency to that
  version and fails if it falls outside the declared range. Vendoring makes
  this acceptable: the pinned bodies travel with the repository, so reproducing
  an old configuration is a checkout, not a registry lookup. (A version archive
  remains possible future work; see open items.)
- `skills.local` declares hand-authored project skills so sync can tell them
  apart from vendored copies, include them in the fingerprint, and refuse name
  collisions instead of overwriting.
- `tools` records the supported tool set (part of the configuration
  fingerprint) and controls which project-local discovery paths sync writes.
  Today only `claude-code` has a tool-specific dir (`.claude/skills/`); the
  other entries are inert metadata until a tool grows native project-skill
  support. `init` defaults all tools to enabled — narrow with `--tools` or by
  editing the manifest.
- Negative controls such as `deny` remain rare compatibility escapes (for
  example, suppressing one inherited home-profile skill) — not the activation
  mechanism.

Generated lockfile shape:

```json
{
  "schemaVersion": 1,
  "registry": {
    "name": "skill-forge",
    "version": "1.1.0",
    "commit": "782fe3b...",
    "lockIntegrity": "sha256-..."
  },
  "skills": {
    "frontend-engineering": {
      "version": "0.1.0",
      "integrity": "sha256-...",
      "source": "registry"
    },
    "my-override": {
      "path": ".agents/skills/my-override",
      "integrity": "sha256-...",
      "source": "local"
    }
  }
}
```

`registry.commit` anchors provenance to an exact registry state. Registry-side
paths are deliberately absent: the consumer repository never resolves anything
from the registry checkout after sync, so recording its internal layout would
only invite staleness.

### Sync targets

`skf sync` vendors each resolved skill as a plain copy to the dirs the enabled
tool set actually reads:

- `.agents/skills/<name>/` — the tool-neutral path for instruction-protocol
  discovery; written only when a tool *without* native project-skill support
  (codex, copilot-cli, grok) is enabled. A Claude-Code-only profile skips it
  so skills aren't committed twice for a single reader.
- `.claude/skills/<name>/` (when `tools.claude-code` is true) — Claude Code
  surfaces project skills natively from this path, which beats
  instruction-only discovery.

Changing the tool set re-derives the targets: the next `skf sync` prunes
managed copies from dirs that are no longer targets (declared `skills.local`
paths are exempt), and `sync --check` flags them until it runs. A profile with
no tools enabled is an error.

Plain copies over symlinks: relative in-repo symlinks would deduplicate but add
platform caveats, and sync already owns drift detection for every written copy.
All sync outputs are committed.

### Revised install flow

The current installer writes selected artifacts directly to a target directory:

```bash
skf install frontend-engineering --type skill --target codex --path ~/.codex/skills/frontend-engineering
```

That remains available as a low-level escape hatch for bootstrapping and
debugging (bare `skf install` with explicit type and path — see the CLI
disposition below), but for skills the primary workflow becomes manifest-driven:

```bash
skf project init
skf project add frontend-engineering design-sync-svelte
skf sync
```

Behavior:

- `skf project init` writes `skill-forge.json` non-interactively with all tools
  enabled (`--tools` narrows); a four-way prompt to control one behavioral bit
  would be ceremony.
- `skf project add <skills...>` searches the registry, shows matching names,
  versions, tags, and descriptions, then updates `skill-forge.json`.
- `skf sync` resolves the manifest, vendors the skills, and writes or updates
  `skill-forge.lock.json`.
- `skf sync --check` is read-only and exits non-zero when the manifest,
  lockfile, or vendored copies disagree. Because sync produces no machine-local
  state, this is a complete check in CI, not just on developer machines.
- `skf project status` is the human-facing view: which skills are active, which
  came from which profile, which are local overrides, and what is stale. It
  absorbs what separate `doctor` or `diff-project` commands would report — two
  commands (`sync --check` for machines, `project status` for humans) instead
  of four overlapping ones.

This revises the install concept from "write this artifact to this directory" to
"make this repository match its declared Skill Forge profile."

### Home profile (replacing per-tool global skill installs)

The home profile is the same mechanism as a project profile, rooted at the
home directory: a `skill-forge.json` in `$HOME`, synced to `~/.agents/skills`
and the enabled tools' user-level skill directories. "Global install" stops
being a separate mechanism and becomes the home profile — declared, locked,
and drift-checked. The `skf home init|add|status|sync` namespace is the
ergonomic spelling ("`skf project` at `$HOME`" reads wrong); each subcommand
delegates to the project implementation with the root pinned to `$HOME`, so
there is no second code path.

The home profile is deliberately minimal: `skf home init` seeds only
`skill-forge-project` (the bootstrap skill that lets agents drive skill
selection). Process baselines (`security-baseline`, `coding-discipline`,
`code-quality`) belong in each repo's own profile — that keeps repos
self-contained and attributable from their own tree, and avoids the same
skill being surfaced twice (home + repo) to agents.

### Activation strategy

No `link` or `reference` modes. Vendored copies need no indirection at all:
symlinks would tie repository state to machine-local paths, and generated
pointer files would reintroduce the instructional boundary this design removes.

Known limits, stated honestly:

- The physical boundary covers Skill Forge-managed skills. Unmanaged personal
  skills in user-level tool directories are still surfaced by the harness;
  Skill Forge cannot and does not gate those.
- Home-profile skills are visible in project sessions alongside the project
  profile — intended, since baseline skills should be active everywhere. A
  project that must suppress an inherited home-profile skill is back to an
  instructional `deny`; keep the home profile small so this stays rare.

### Agent discovery and precedence

The activation protocol is unchanged: metadata is discovered first, full skill
bodies load only after activation, and project-local skills take precedence
over global skills with the same name. With profiles, same-name precedence
becomes:

1. Hand-authored project skills declared in `skills.local`.
2. Vendored project skills resolved by `skill-forge.lock.json`.
3. Home-profile skills.
4. Unmanaged tool-neutral or tool-specific global skills.
5. Platform/system skills when relevant.

`skf sync` never overwrites a path it does not own: a name collision with an
undeclared local skill is a hard error naming the path and the fix (declare it
in `skills.local` or rename).

### Evaluation and drift

The configuration fingerprint for a run becomes derivable from checked-in
state: manifest hash, lockfile hash, and vendored content hashes, plus the home
profile's lockfile hash for the session environment. Each evaluation run
records those alongside the synced tool set and exact skill versions —
attribution no longer depends on what happened to be installed on the machine.

### Existing CLI disposition

Phase P also converges the CLI on noun-verb subcommands: every artifact type is
a namespace (`skf <type> <verb>`), matching the existing `skf skill …` and
proposed `skf project …` shapes. `--type` flags and the hyphenated `diff-*`
variants retire. A namespace holds its type's *primary* operations: for agents,
subagents, and hooks that is global install and diff; for skills it is
authoring only, because skill deployment is project-scoped and lives in
`skf project`/`skf sync`. With no per-tool global skill installs, the current
commands land as follows:

| Command | Today | Under Phase P |
|---|---|---|
| `skf skill …` (authoring verbs), `skf list`, `skf validate`, `skf lock` | Registry authoring and maintenance | Unchanged |
| `skf install --type agent/subagent` (+hooks) | Primary install path | Renamed `skf agent install`, `skf subagent install`, `skf hook install` — these stay global |
| `skf install` (bare) | Interactive install across types | Kept: interactive picker dispatching to the noun-verb commands, and the one low-level escape hatch (explicit type + path) for any artifact, including skills |
| `skf diff-agents` / `diff-subagents` / `diff-hooks` | Drift gates for global artifacts | Renamed `skf agent diff`, `skf subagent diff`, `skf hook diff` |
| `skf add <skill>` | Copies skills to a tool's global dir (default Codex) | Deprecated: repo use → `skf project add` + `skf sync`; everywhere use → home profile. Also avoids `add` vs `project add` meaning opposite things |
| `skf install --type skill` | Per-tool global skill install | Folded into bare `skf install` as a low-level escape hatch that points at the project workflow; `skf skill` stays authoring-only |
| `skf diff-global` | Skill drift vs. Codex runtime | Retired: skill half superseded by `sync --check`; other artifacts have their own `<type> diff` commands |
| `skf project init/add/status`, `skf sync [--check]` | — | Primary skill workflow |

Deprecation sequencing: ship `project`/`sync` first; `skf add` then warns and
delegates; the noun-verb renames land with hidden aliases from the old
spellings; removal comes only after the home profile and the one-shot global
cleanup exist, so no workflow is ever without a working path.

### Migration

- Once the home profile is synced, delete Skill Forge-managed skills from the
  per-tool global directories (`~/.codex/skills`, `~/.claude/skills`,
  `~/.copilot/skills`, `~/.grok/skills`); `skf` can ship a one-shot cleanup.
- `diff-global`'s skill half is superseded (`sync --check` in `$HOME`); its
  agents, subagents, and hooks drift checks remain, since those stay global.
- The registry repo's change workflow becomes pull-based for skills: after a
  skill edit, the registry-side gates stop at `lock` + `validate`; consumers
  (each project repo and `$HOME`) pick up the new version on their next
  `skf sync`, verified by `sync --check`. Reinstall stays push-style only for
  instructions, subagents, and hooks. AGENTS.md's workflow wording needs the
  matching update when this ships.
- core.md's skill discovery wording shifts from per-tool global directories to
  project paths plus the home profile.

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
| P | **Project skill profiles**: `skill-forge.json` + `skill-forge.lock.json`, `skf project`/`skf home` commands, vendoring `skf sync` + home profile replacing per-tool global skill installs, `sync --check`/`status` drift checks | **Shipped 2026-07-19/20** (CLI 1.3.0) — Phase 0's fingerprint should now derive from profile manifests/lockfiles instead of a separate install manifest |
| A | `phase-judge` skill + rubric companions, judge-metrics schema (phase, tier, task_type, run_id, config fingerprint), verdict wiring into `tasks/todo.md` | After 0 — spec drafted on request |
| B | Monitor hook (EBM + heuristic SAG), monitor JSONL + site rendering | After A |
| C | `efficacy` CLI (PAR, DDR, per-lens and per-configuration comparison), Evaluation site section; SFI stub | After B |

### Other open items

- `diff-global` is retired (hidden, deprecation notice): skills are checked by
  `sync --check`/`home sync --check`; agents, subagents, and hooks have their
  own `<type> diff` commands. Registry `runtimeTarget` on skill entries is now
  vestigial and could be dropped in a future schema pass.
- No registry version archive: only the current version of each skill is
  resolvable. Vendoring shrinks the need (pinned bodies live in consumer repos),
  but re-resolving an older version from the registry would require a
  content-addressed archive.
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
| 2026-07-14 | OTel (collector/Prometheus/Grafana, loopback) for whole-session economics | Native `query_source`/`agent.name` split answers delegation-cost questions |
| 2026-07-14 | Evaluation framework: one phase vocabulary; hook-based Layer 2; tier-scaled judge | Avoid dual taxonomies, unreliable self-audit, and unbounded judge cost |
| 2026-07-18 | Grok first-class: agents overlay, subagents, hooks | Grok has built-in `explore`/`plan` + hooks JSON discovery; role set mirrors Claude Code asymmetry rather than copying Codex |
| 2026-07-19 | Project skill profiles: skills vendor per-project; home profile replaces per-tool global skill installs | A physical activation boundary beats an instructional one; the repo tree alone carries the pinned content, so fingerprints and reproduction come from checkout |
| 2026-07-19 | Managed instructions, subagents, and hooks stay global | Runtime configuration, not task-domain dependencies; tools already offer native project-level overrides |
| 2026-07-19 | CLI converges on noun-verb subcommands (`skf <type> <verb>`); `skf skill` stays authoring-only | Namespaces hold each type's primary operations — skill deployment is project-scoped (`skf project`/`skf sync`); `--type` flags and hyphenated `diff-*` commands retire behind aliases; bare `skf install` remains the picker and escape hatch |
| 2026-07-20 | `skf home` namespace; home profile seeds only `skill-forge-project` | "project" at `$HOME` reads wrong; a minimal home keeps baselines per-repo, so repos stay self-contained and no skill is surfaced twice (home + repo) |
| 2026-07-20 | Sync targets derive from the manifest `tools` map | `.agents/skills/` only when a non-Claude tool is enabled; `.claude/skills/` for Claude Code; narrowing the tool set prunes orphaned copies and husk dirs |
