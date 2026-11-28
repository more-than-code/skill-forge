# Skill Forge — Design

Last updated: 2026-08-30

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
| Hooks | `inventory/hooks/claude-code/`, `inventory/hooks/grok/` | `~/.claude/hooks/skill-forge`, `~/.grok/hooks` | Deterministic usage-stats writer and delegation-mode reminder; Claude Code also gets the git guard and the staleness check. Claude uses a settings snippet, Grok loads a hook JSON directly |

### Composed instruction model

`core.md` (shared process: risk tiers, explore→spec→implement, gates, delegation,
review lenses) + tool overlay, joined with a separator at compose time.
Placeholders like `{{explore_agent}}`/`{{plan_agent}}` resolve per tool
(`researcher`/`planner` for Codex and Copilot, `Explore`/`Plan` for Claude Code,
`explore`/`plan` for Grok), so the deployed file names the right agents with no
mapping prose. `validate` fails on unresolved placeholders and warns on unused vars.

### Delegation model

- **Codex / Copilot CLI:** five maintained roles (`bulk_worker`/`bulk-worker`,
  `researcher`, `validator`, `planner`, `reviewer`). Codex pins sandbox modes,
  current role-specific models, and reasoning efforts; its custom-agent files are
  the source of truth because those values take precedence over inherited defaults.
- **Claude Code:** three maintained roles (`bulk-worker`, `reviewer`, `validator`)
  with pinned model-family aliases, effort levels, and explicit tool allowlists.
  `reviewer` is read-only; `validator` excludes direct edit tools but retains
  `Bash`, so its source-write restriction also relies on instructions and active
  permissions. Exploration and planning use built-in `Explore`/`Plan`, which
  inherit model and effort and are harness-enforced read-only.
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

`npm test` (node:test): registry validation, placeholder resolution
per tool, stats writers (including the no-prompt-content guarantee), site
generation. `validate` + `diff-*` are the standing gates after any inventory change.

**Portability gate (skills).** `validate` rejects two classes of hardcoded path in
any skill file — an absolute home path (`/Users/<name>/…`, `/home/<name>/…`) and a
reference to the skill's *own* vendor location (`.agents/skills/<self>`,
`~/.claude/skills/<self>`, …). Both are wrong the moment the skill is vendored
somewhere else, and a skill is vendored into whichever profile declares it: a repo,
an umbrella, or `$HOME`. The check runs inside `skill write`/`bump` as well, so a
bad path is reported as a partial write rather than reaching the registry.

Observed 2026-09-03: `product-parity` documented its own harness as
`~/.agents/skills/product-parity/scripts/parity-gate.mjs`. Moving the skill from the
`$HOME` profile to a project profile broke all three documented commands, silently,
in the only repo that ran them.

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

### Scope: skills, and opt-in instruction variants

Skills are project-scoped. Since 2026-11-12, managed agent instructions can be
too, opt-in per session root: `instructions.variant` and `instructions.version`
in `skill-forge.json` make `sync` write the variant into marked blocks in the
root's `AGENTS.md` and `CLAUDE.md`, and exclude skf-managed ancestors'
instruction files from Claude Code (`claudeMdExcludes` in the untracked
`.claude/settings.local.json`). The reasons, which reverse part of the
2026-07-19 decision below: a variant can only be compared (evaluated) per
project if the global file is not loaded alongside it; cloud sessions and fresh
clones read only what the repository carries; and Claude Code stacks every
ancestor's `CLAUDE.md`, so an umbrella and its children must each carry their
own copy and skip the others. Sync edits only the text between its markers, so
the rest of those files stays user prose and `sync --check` never reports it.
The global installs below still exist while consumers migrate.

Since 2026-11-24 the `cloud` variant (`requiresClaude`, `maxLines: 150`) is the
compact core for repositories worked by Claude Code cloud sessions, which read
only the repository (`tasks/spec-cloud-sessions.md`).

The rest of this section is the original reasoning, which still holds for
subagents and hooks. Before 2026-11-12, managed agent instructions, subagents,
and hooks all remained global per-tool installs:

- They are runtime configuration, not task-domain dependencies — the process
  (risk tiers, delegation roles, gates) is the same in every repository.
- They do not have the activation-boundary problem: instructions and hooks load
  wholesale, and subagent role sets are always relevant.
- Tools already offer native project-level overrides (repo
  `CLAUDE.md`/`AGENTS.md`, project agents directories) if a repository ever
  needs a delta; Skill Forge edits them only when a profile opts in (marked
  instruction blocks). It does check two of
  them: `skf project instructions` reports, read-only, whether a session root
  has `AGENTS.md` and, with the `claude-code` shim, a `CLAUDE.md` that imports
  it. `skf project scaffold` only creates a missing one from a placeholder
  template and never overwrites an existing file; it also records the role.

Project-scoped subagent or hook profiles can be proposed later if evaluation
shows per-project role variation matters.

### Naming

- `skill-forge.json` is the project manifest. The full name is clearer than
  `skf.config.json` because the file describes project artifact dependencies, not
  just local CLI preferences.
- `skill-forge.lock.json` is the generated project lockfile: exact resolved
  versions, integrity hashes, and registry provenance.
- There is no `.skill-forge/` project directory. Sync writes only committed
  artifacts (manifest, lockfile, vendored skill bodies, managed instruction
  blocks; a repository with `"generated": "ignored"` commits only its own skills
  and a managed `.gitignore` block instead, see the 2026-11-25 decision rows), plus, where managed instructions exclude skf ancestors, one
  machine-local file: Claude Code's own untracked `.claude/settings.local.json`,
  kept out of git through `info/exclude` and recomputed on every sync rather
  than locked.
- Machine-local, per-user state lives in `~/.skill-forge/` (or `$SKILL_FORGE_HOME`), never in a
  project. `hosts.json` there declares the remote machines this machine may delegate to
  (`skf home hosts`). It is hand-written and per machine on purpose: how a host is reached is a
  fact about one machine's network, and `"dedicated": true` is a trust grant that must stay a
  deliberate act by the user. It holds no secrets, no project data and no probe results, and a
  probe can measure a host but never declare it dedicated.

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
  Skills are written once to `.agents/skills/`; a tool-specific dir is a symlink
  to it, never a second copy, so narrowing the tool set can never prune the
  store out from under another tool's reader.
  Today only `claude-code` has a tool-specific dir (`.claude/skills/`); the
  other entries are inert metadata until a tool grows native project-skill
  support. `init` defaults all tools to enabled — narrow with `--tools` or by
  editing the manifest.
- `instructions.role` (`repo`, `umbrella` or `child`) is an optional key written
  by `skf project scaffold` and read only by the `instructions` and `scaffold`
  commands; `sync` and `status` ignore and preserve it. It is not part of the
  lock: the project lock hashes the registry and the resolved skills, never the
  manifest, so recording a role cannot make `sync --check` stale.
- `instructions.variant` and `instructions.version` (written by `skf project
  instructions use`) are different: `sync` acts on them, so a declared variant
  must be well-formed, and the lock records the resolved variant (below). A
  non-object `instructions` still never breaks `sync`.
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
  },
  "instructions": {
    "variant": "full",
    "version": "0.1.0",
    "sha256": { "agents": "sha256-...", "claude": "sha256-..." }
  }
}
```

`instructions` is present only when the manifest declares a variant; `sha256`
hashes the rendered blocks, which is how `sync --check` tells a hand-edited
block from a stale one.

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
All sync outputs are committed, except the untracked `settings.local.json`
exclude entries described under "Scope".

### Revised install flow

The current installer writes selected artifacts directly to a target directory:

```bash
skf install frontend-engineering --type skill --path /tmp/skill-export/frontend-engineering
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
- `skf skill bump` / `set-version` offer to retarget the registry repo's own
  profile and the `$HOME` profile when the new version falls outside a
  declared range (a 0.x minor bump vs `^0.x.y`). `--update-pins` is the
  non-interactive form; other consumer repos still update on their next
  `project add` / hand edit + `sync`.
- `skf sync` resolves the manifest, vendors the skills, and writes or updates
  `skill-forge.lock.json`.
- `skf sync --check` is read-only and exits non-zero when the manifest,
  lockfile, or vendored copies disagree. Because the only machine-local state
  sync produces is the untracked Claude settings file, recomputed from the
  checkout's location, this is a complete check in CI, not just on developer
  machines. A repo with `"generated": "ignored"` keeps its registry copies
  machine-local too: CI runs `skf sync` before `--check`, which also consults
  `$HOME` unless `--no-home` or `SKF_NO_HOME=1` is set.
- `skf project status` is the human-facing view: which skills are active, which
  came from which profile, which are local overrides, and what is stale. It
  absorbs what a separate `diff-project` command would report — two commands
  (`sync --check` for machines, `project status` for humans) instead of
  overlapping ones. A `doctor` that only repeated those checks would be
  redundant, so `skf project doctor` exists only as a composition (below).
- `skf project instructions [--check] [--json]` is the one read-only check that
  is not about the skill profile (its `use` action is the exception: it writes
  the manifest and syncs). It stays a separate command because its
  subject is user-owned prose, not vendored skills: folding it into `sync
  --check` would report permanent false drift on files people edit (the managed
  blocks are different: `sync --check` hashes only the text between their
  markers), and into
  `project status` would mix instructions into a profile view that exits 0. It
  runs only where a `skill-forge.json` exists, since that file already marks a
  session root, so children meant to inherit from their umbrella are never
  flagged.
- `skf project doctor [--check] [--json]` composes the read-only checks behind
  one report and one exit code, so a repository needs a single CI gate: the
  skill-profile check (the `sync --check` logic), the instructions check, and
  layout rules keyed on the recorded `instructions.role`, and (since
  2026-11-12) a managed-instructions section that compares this root's variant
  and version with each skf ancestor's. Apart from that section it adds no check
  of its own to those two and keeps them as separate commands, so each stays
  usable alone. Layout rules: an umbrella needs its `tasks/todo.md` ledger and
  that ledger's absolute path in `AGENTS.md` (issues), and names each child
  repo there (a warning, because the match is a heuristic); a child's
  `AGENTS.md` mentions `SESSION.md` and git ignores its `tasks/` ledger
  (issues, the latter asked of `git check-ignore` so `.gitignore`,
  `.git/info/exclude` and global excludes all count). A root with no recorded
  role has its layout section skipped with a pointer to `skf project scaffold
  --role`, which records the role without creating anything when the files
  already exist. Warnings and notes never fail `--check`; a section that cannot
  run is reported as an issue and the others still appear. A missing or invalid
  manifest, a bad role, or `$HOME` abort with exit 1 before any report.

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
3. Vendored overlay skills resolved by the untracked `skill-forge.local.lock.json`
   (one checkout only; a name is never in both the profile and the overlay).
4. Home-profile skills.
5. Unmanaged tool-neutral or tool-specific global skills.
6. Platform/system skills when relevant.

`skf sync` never overwrites a path it does not own: a name collision with an
undeclared local skill is a hard error naming the path and the fix (declare it
in `skills.local` or rename).

### Evaluation and drift

The configuration fingerprint for a run becomes derivable from checked-in
state: manifest hash, lockfile hash, and vendored content hashes, plus the home
profile's lockfile hash for the session environment. Each evaluation run
records those alongside the synced tool set and exact skill versions —
attribution no longer depends on what happened to be installed on the machine.

The local overlay (below) is the one exception: it is untracked by design, so a
run in a checkout with an overlay must also record `skill-forge.local.lock.json`,
or its skills are invisible to attribution.

### Local overlay (shipped 2026-11-06)

A session rooted in a linked git worktree reads only that worktree's
`.agents/skills`, which the child repo's tracked profile fills. Skills the slice
needs beyond that (an umbrella-only skill) would otherwise have to be committed
into the child repo and merged with its branch, or hand-copied, which the Skill
Location Policy forbids.

`skf project add <skill> --overlay` writes an untracked `skill-forge.local.json`
(registry `skills.dependencies` only). `sync` resolves it separately from the
tracked profile, vendors into the same store, and writes an untracked
`skill-forge.local.lock.json` with `source: "overlay"` entries; the tracked lock
never contains them. Overlay paths are kept out of git by one marked block per
work tree in the repository's shared `info/exclude` (located via
`git rev-parse --git-common-dir`, as `dispatch.sh` does). Because that file is
shared, `sync` in any checkout removes a skill's line from every overlay block as
soon as a tracked profile declares it — an excluded new folder would otherwise be
left out of `git add -A` while `sync --check` passed.

Rejected: a stateless `sync --add` (no record, no staleness check or prune),
declaring in the tracked profile without committing (one `git add -A` merges it),
and `.gitignore` (tracked). Limits: git work trees only, on top of an existing
`skill-forge.json`; `skill bump --update-pins` does not rewrite overlay ranges;
`git worktree remove` runs no skf code, so `skf project overlay --clear` is a
retire step.

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

- Migration off the per-tool global skill directories is complete: nothing
  writes or reads them, and `$HOME` skills live in `~/.agents/skills` and
  `~/.claude/skills` via the home profile.
- `diff-global`'s skill half is superseded (`sync --check` in `$HOME`); its
  agents, subagents, and hooks drift checks remain, since those stay global
  (instructions are also project-delivered as variants since 2026-11-12).
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
  own `<type> diff` commands. Registry `runtimeTarget` has been **dropped from
  skill entries** (it pointed at the retired per-tool global dirs and nothing
  installed skills there); `validate` no longer requires it for skills and
  `skill list/read --json` no longer emit it. Agents, subagents and hooks still
  carry it. `diff-global` filters on that field, so it now lists nothing — it
  remains only to print its deprecation notice, and can be removed outright.
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
| 2026-08-30 | Claude maintained subagents pin model-family aliases and effort; built-in `Explore`/`Plan` remain inherited | Preserve role-specific cost/quality without replacing Claude's harness-managed built-ins |
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
| 2026-07-19 | Managed instructions, subagents, and hooks stay global (instructions: partly reversed 2026-11-12) | Runtime configuration, not task-domain dependencies; tools already offer native project-level overrides |
| 2026-07-19 | CLI converges on noun-verb subcommands (`skf <type> <verb>`); `skf skill` stays authoring-only | Namespaces hold each type's primary operations — skill deployment is project-scoped (`skf project`/`skf sync`); `--type` flags and hyphenated `diff-*` commands retire behind aliases; bare `skf install` remains the picker and escape hatch |
| 2026-07-20 | `skf home` namespace; home profile seeds only `skill-forge-project` | "project" at `$HOME` reads wrong; a minimal home keeps baselines per-repo, so repos stay self-contained and no skill is surfaced twice (home + repo) |
| 2026-07-20 | Sync targets derive from the manifest `tools` map | `.agents/skills/` only when a non-Claude tool is enabled; `.claude/skills/` for Claude Code; narrowing the tool set prunes orphaned copies and husk dirs |
| 2026-10-04 | `skf project instructions`: a read-only check for `AGENTS.md` and `CLAUDE.md` in a session root | The layout was prose only, and 11 child repos had `AGENTS.md` without the `CLAUDE.md` Claude Code reads. Scoped to roots that declare a profile; `CLAUDE.md` required only with the `claude-code` shim; no scaffold or manifest change yet (Phase 2) |
| 2026-10-04 | `skf project scaffold`, and an optional `instructions.role` in the manifest | The check could report missing files but not fix them. Create-only (exclusive create, so symlinks are never written through), placeholder templates, `CLAUDE.md` only with the `claude-code` shim. The role is stored because role-aware layout checks (a later `project doctor` that composes `sync --check`, `instructions` and those rules) need it; the project lock hashes the registry and resolved skills, never the manifest, so the key cannot make `sync --check` stale, and only the instruction commands validate it, so a bad value cannot break `sync` or `status` |
| 2026-11-06 | Local overlay: untracked `skill-forge.local.json` + its own lock, kept out of git by a per-work-tree block in the shared `info/exclude` | Worktree slices need skills their child repo's profile does not declare, without committing them into that repo. Separate locks keep the tracked lock byte-identical; promotion into a tracked profile clears the exclude lines everywhere, because a shared exclude would otherwise hide the new tracked folder from `git add` |
| 2026-10-05 | `skf project doctor`: one read-only gate composing the profile check, `project instructions`, and role-aware layout rules | A repo needed three commands to be sure it was healthy. Composition only, so it reverses the earlier "doctor is redundant" argument without duplicating anything; the two checks stay separate. Severities came from a read-only scan of seven umbrellas (37 children): umbrella ledger 7/7 and absolute path 6/7 pass (issues), unnamed children 4/37 (warning, heuristic match), child SESSION.md hook and git-ignored ledger fail often enough to be real findings (issues, only where a root opts in with a recorded role). The ledger rule asks git itself, so any failure to run git (no binary, a refusal, a timeout) degrades to a warning |
| 2026-11-12 | Managed instructions ship per project as opt-in variants (`instructionVariants`; `skf project instructions use`); partly reverses 2026-07-19 | Comparing instruction variants needs projects that load only their own copy; cloud sessions and Claude Projects threads read only the repository, never `~/.claude`. Delivered as marked blocks in `AGENTS.md`/`CLAUDE.md`, the precedent being the shell-rc block, so user prose stays outside `sync --check`. Claude Code stacks ancestor `CLAUDE.md` files and sandboxing does not change what loads, so sync excludes skf ancestors with `claudeMdExcludes` in the untracked `settings.local.json`; those absolute paths are recomputed per checkout, never put in the tracked lock. `$HOME` never gets a block (it would load in every project). Phase 1 ships `full` (today's text, global files untouched); slim, the eval and global removal follow (`tasks/spec-project-instructions.md`) |
| 2026-11-07 | Enforcement hooks for Claude Code: `git-guard` (PreToolUse/Bash) and `staleness` (SessionStart) | Principle 4: what must happen reliably is a hook, not an instruction. The guard denies commit/push outside the session's project and answers **ask**, not deny, for main/master and for commands it cannot resolve: the harness's own permission prompt is the one thing a relayed peer message can never satisfy, so the hook does not have to judge who approved what. Grok deferred (not in recent use); its docs confirm the same reply format would work. |
| 2026-11-13 | Every consumer root declares the whole `$HOME` skill set (baseline, `umbrella-workspace`, `session-roles`, `role-*`) on top of its stack skills; extends 2026-07-20 | A repo opened in a Claude Project, cloud session or another machine gets only what it commits. Owner: "whole $HOME set to every root". Cost: project-over-home shadowing, bounded by syncing every root after each registry change and widening pins everywhere together (`umbrella-workspace`, `skill-forge-project`) |
| 2026-11-24 | A compact `cloud` instructions variant (`requiresClaude`, `maxLines`) and "skipped is not passed" in the core gate rules | Deploybot's cloud threads saw none of the workflow rules and merged migrations whose database tests had skipped themselves. `full` is ~650 lines with workstation-only parts (the `tasks/` ledger, external workers, podman); a separate short core is easier to follow and to evaluate than flags in one text. Project-scoped subagent vendoring was built and dropped before release: Project threads get subagents from the cloud environment's setup script instead (`tasks/spec-project-thread-setup.md`) |
| 2026-11-25 | Claude Project threads get Skill Forge from the cloud environment's setup script through `bin/skf-cloud.mjs` (install + read-only doctor) and manage their own setup with the `claude-project-steward` skill | Threads load `~/.claude` written by the setup script (tested: rules, skills and agents all load), but no `~/.claude` of the owner's and no repo branch other than the default. One environment layer gives every thread one copy of the workflow rules, subagents and shared skills, independent of any repo branch; repos keep only their facts. The file is dependency-free and fetched pinned from the public registry because a Project may exist only in claude.ai; the owner pastes what claude.ai has no API for, and threads diagnose and fix repos by PR (`tasks/spec-project-thread-setup.md`) |
| 2026-11-25 | A thread's skills come from the repos' `skill-forge.json`: `skf-cloud install` installs each declared registry skill once into `~/.claude/skills` unless `SKF_SKILLS` (the higher level) provides it, at the `SKF_REF` version when it satisfies every declaring range; repos commit the manifest and lock, not copies; `install --top-up` adds skills declared after the snapshot was built | One list instead of two (the setup script's and the repos'), one copy per name in every thread, no committed copies listed again as `<repo>:<name>`. One registry snapshot plus ranges, not each repo's exact lock, so two repos never need two copies of one name. The resolver is designed to take a target, repo dirs and a higher-level set (built so far: repo dirs and the higher-level set; the target is still `~/.claude`), so repo-rooted sessions (target `<repo>/.claude`, `$HOME` higher) and DD jobs (target `<handoff>/.claude`, no higher level) reuse it later (`tasks/spec-manifest-skill-install.md`) |
| 2026-11-25 | A repo can commit only what it owns: `"generated": "ignored"` keeps registry copies out of git through one `.gitignore` block skf maintains (`/.agents/skills/*` plus a `!` line per `skills.local` name), repo skills stay committed at normal depth, and project sync skips skills the `$HOME` profile provides at a satisfying version | Like npm: the manifest and lock are the record, `skf sync` (or the environment's installer) installs. Normal depth because Claude Code does not discover nested skills (probe) and nothing installs repo skills in threads or DD jobs. A per-name exception list for the repo's own skills, written by skf, instead of ignoring the whole folder, which silently swallows a new repo skill; `--check` proves the rules with `git check-ignore`. Opt-in, because flipping the default would rewrite 36 repos with copies still tracked (`tasks/spec-p2-generated-skills.md`) |
| 2026-11-26 | Approved design (not built): a remote Skill Forge MCP server for consumer agents — registry reads, skill checks with the CLI's own rules, and proposals that land only as draft PRs into `dev` ([MCP.md](MCP.md)) | Consumer threads have no `skf` CLI and no GitHub scope on skill-forge, so a lesson that belongs in a skill waits for the owner to open another thread. A connector reaches every Project with no setup-script change; the server keeps no drafts, runs the CLI (plus a new read-only `skf skill check`) in a sandbox without secrets, commits only `proposal/*` branches and that skill's paths under an App-only ruleset, accepts only patch bumps below 1.0 so no consumer range breaks, and never merges. Instructions, subagents and hooks get feedback issues only. Open questions settled on the proposed answers (MCP.md Decisions): Deploybot container, `server/` in this repo, owner-only proposals, GitHub issues for feedback, a secret-free CI workflow before the propose tools, no local `skf mcp`, no executable companions in v1. The setup script stays the static bootstrap (it runs before a thread starts, a connector only after); the server is for dynamic in-thread use: proposing and editing skills on the fly |
| 2026-11-26 | Proposed (not built): Skill Forge as a multi-tenant platform with a web console (the Console) ([PLATFORM.md](PLATFORM.md), [CONSOLE.md](CONSOLE.md)): tenants keep registries in their own git repos and their maintainers merge; SvelteKit Console and an all-Go platform (API, MCP endpoint, dispatcher, committer), with jobs on the Defect Drainer worker (see the rows below; anything executing registry content runs only in a sandbox), Postgres (Supabase) with row-level security per tenant; usage from observed hook events, metadata only; a sandboxed runner checks, proposes and evaluates skills (eval jobs: model API egress only, the tenant's own key, no GitHub key), feeding the Console's eval history | Owner: "This should be a SaaS platform, which means multi-tenants", and a Console to see the inventory, usage and evaluation history. SQLite fits one owner, not several services and tenants. Keeping registries in git preserves principles 1–2 and each tenant's own review; the platform indexes, serves and proposes but never merges |
| 2026-11-26 | Platform back end language, as it moved during the day (history; the current decision is the next row): Go for everything, then all TypeScript on Node 22, then Go for the API, MCP endpoint and committer with a TypeScript worker on Node, then **all Go** once jobs moved to the Defect Drainer worker and Promptfoo and the `skf` CLI became standalone CLIs. Eval framework: Promptfoo (owner confirmed) | Owner: Go for the serving path (performance, code that is easy for agents to write); Node only where its ecosystem is needed, which ended as a runtime for two CLIs in the job sandbox image. The committer stays the only holder of the GitHub App key throughout |
| 2026-11-26 | Proposed: platform jobs (check, propose, eval) run on the **Defect Drainer worker**, made a general-purpose sandboxed runner with bring-your-own-key, instead of a Skill Forge Node worker ([PLATFORM.md](PLATFORM.md#full-stack), [EVALS.md](EVALS.md), DD draft [DD-WORKER-JOBS.md](DD-WORKER-JOBS.md); filed in DD as `DEF-20261126-worker-general-purpose-job-runner-with-b-o0er`). Promptfoo grades in a check step after the agent, run as a standalone CLI from the Go worker, so the whole platform is Go and Node 22 is only a runtime in the job sandbox image for the `skf` and Promptfoo CLIs; suite format, baselines and metrics are proposals | Owner: the DD worker "is already a sandboxed agent tool integrated implementation"; it "should be a general purposed rather than just for fixed jobs"; users should bring their own key. Owner: Promptfoo "is a thin layer", a "CLI library used standalone. So a Golang program can also call it." One runner to harden; Skill Forge keeps its Go dispatcher and committer, so its App key never reaches DD |
| 2026-11-26 | One `review-checklist` skill for every review (rebased head, rerun gates, scope, security, tests, docs and contracts, CI config, visible fixes, project items), and one severity rubric plus a lens verdict in every tool's `reviewer` subagent | Review threads improvised their reviews and lenses ranked severity differently; repos add their own items in their own skills. Consumers opt in by declaring the skill: `core.md`, the cloud variant and the skf-cloud always-installed list (Tier 3 / public contract) are deliberately unchanged |
| 2026-11-27 | The signed-in web app is the **Console**, not a portal ([CONSOLE.md](CONSOLE.md), renamed from PORTAL.md): besides inventory, usage and eval history it runs operations (start evals and checks, re-run jobs, tokens, model keys, members, settings, reporting opt-in), each under the member's role and audited; registry content still changes only through PRs. The public landing site keeps the name Site | Joe, 2026-11-27: the signed-in app is called the Console (consumer projects' skill usage, evaluations and operations). Owner: "console is a better fit since user can see how their consumer projects using the skills, the evaluations … They can control, do some operations" |
| 2026-11-27 | Approved design (not built): the multi-tenant platform ([PLATFORM.md](PLATFORM.md)), the Console ([CONSOLE.md](CONSOLE.md)) and evaluation ([EVALS.md](EVALS.md)). All open questions settled on the recommended answers; evals use the drafted suite format, baselines `none` and `previous` (`previous` skipped for a new skill with no release), 3 repeats with a per-suite cost cap, first suites `coding-discipline` and `security-baseline`, Promptfoo as grader only. Open core is official: the CLI, `skf-cloud`, formats and public catalog are public here; the back end and Console are private | Owner, 2026-11-27: "I see. I agree. Go ahead." The open-core line keeps the CLI usable on its own while the hosted parts stay closed; the public side keeps the CLI `--json` output and the `eval_runs` and ingest schemas stable for the closed side |
| 2026-11-27 | `skf-cloud doctor` covers what the Marketing OS review found it silent on: repo skills that run unpinned remote code, a repo with instructions but no `skill-forge.json`, ignored `.claude/settings.json`, another machine's setup in repo instructions (remotes, commit identity, home paths), and, in a thread, a prompt for the Project instructions, the thread-limits judgment and the session's connectors | Six "No findings" runs that should have flagged something (DD requirements of 2026-11-27, direction approved by the owner). What a script can match reliably is a finding; what needs the session (its Project instructions, its connector list) or judgment (rules only one person or machine can follow) is a prompt for the thread's agent, as for skill suggestions. Doctor JSON stays `version: 1`: new ids only, same shape (spec in the PR) |
| 2026-11-26 | Cloud sessions and Claude Project threads commit and push their own branch without being asked; repository and Project rules about committing and pushing govern shared branches only (`main`, the default branch, the PR base): an own branch is isolated and reaches them only through a PR someone else merges. The owner merges; a separate reviewer thread the Project instructions name may merge reviewed, gate-green PRs into a base that is not `main` or the default branch (Joe, 2026-11-27, decision card: "Yes, into dev only") | Repo `AGENTS.md` files say "do not commit unless asked, do not push" for workstation sessions, while threads are expected to push a branch and open a PR; the cloud rules let stricter repo text win, so the two clashed (Deploybot harness review). One shared rule in the cloud variant's §8 (plus a scoped note in `full` §15 Git operations, which repos also render), which repos point to instead of carrying their own line (PR #2). `skf-cloud doctor` flags common phrasings of a blanket ban in repo prose, with the pointer as the fix, but not Project instructions, which may restrict threads on purpose |
| 2026-11-27 | `skf-cloud install` installs `claude-project-steward` by default, after `SKF_SKILLS`; `SKF_DEFAULT_SKILLS=0` turns it off ([DEFAULT-SKILLS.md](DEFAULT-SKILLS.md)) | Every Project's setup script repeated `SKF_SKILLS="claude-project-steward"`, and no repo declares the steward because it manages the Project's environment, not a repo. The script every setup runs adds it itself; one name hardcoded beside doctor's `ALWAYS_USEFUL_SKILLS` instead of a registry field. `state.json` and doctor JSON keep their shape |
| 2026-11-27 | One `local-to-cloud-migration` skill moves a project's local Claude Code work into cloud sessions and then retires it from the machine: read-only audit, harvest plan, rescue, check from the cloud, delete. The owner confirms the harvest plan before anything moves and the exact delete list before anything is deleted | DD requirement from the Defect Drainer Mac cleanup; owner chose "Yes, one skill as recommended" over a check skill plus a cleanup skill (decision card, 2026-11-27) and asked for confirmation before the migration as well as the delete ("For the migration, user confirm should be invoked"). Any OS; runs in a local session or over Remote Control, since pushes need the owner's git credentials. Rescue pushes go only to `rescue/` branches after a secrets scan of every pushed commit, and no branch is rewritten. Project setup is handed to `claude-project-steward` rather than repeated. Opt-in like every skill: not added to skf-cloud's default list |
| 2026-11-28 | Revises the 2026-11-27 doctor row: with exactly one repo, empty Project instructions (`D-context-missing`) or instructions naming no PR base (`D-context-pr-base`) are a **note** owned by `thread`, whose fix asks the agent to confirm the repo's own instructions name the base; two or more repos (read-only references included) and no repos keep the issue ([#13](https://github.com/more-than-code/skill-forge/issues/13), Joe approved 2026-11-28) | Workflow rules §8 already accept a base the repository's own instructions name, so a one-repo Project's instructions only repeated its `AGENTS.md` (Marketing OS). The repo text is judged by the agent, not parsed: `prBase()` reads English only and Marketing OS names its base in Chinese. Doctor cannot tell read-only repos apart. Doctor JSON keeps `version: 1`: same ids and shape |
