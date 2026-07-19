# Skill Forge

Skill Forge evaluates how an agent tool and its artifacts — managed instructions,
skills, subagents — perform together across SDLC lenses (work phase, task type,
cost), and evolves those artifacts based on the evidence. Its substrate is a
local registry and installer for agent-facing artifacts:

- Skills for reusable task guidance.
- Managed agent instruction overlays for Codex, Copilot CLI, Claude Code, and Grok.
- Managed subagent definitions for supported tools.

The repository is the source of truth. Skills are project-scoped: consumer
repositories (and `$HOME` for machine-wide skills) declare a profile in
`skill-forge.json`, and `skf sync` vendors exact copies into the repo. Managed
instructions, subagents, and hooks deploy to per-tool runtime files. All
runtime locations are deployment targets, never the source of truth.

## Features

- Tracks all artifacts in `registry.json`.
- Locks artifact integrity in `registry-lock.json` using package-lock-style
  `packages` entries with SHA-256 integrity hashes.
- Syncs project and `$HOME` skill profiles (manifest + lockfile + vendored
  copies) and installs agents, subagents, and hooks to per-tool runtimes.
- Composes managed agent instructions from `inventory/agents/core.md` plus a
  tool-specific overlay.
- Validates registry metadata, skill frontmatter, managed artifact paths, and
  lock freshness.
- Diffs canonical inventory against runtime targets without writing.
- Prompts before overwriting existing files unless `--yes` is provided.

Architecture, design principles, the evaluation-framework roadmap, and the key
design decisions log live in [docs/DESIGN.md](docs/DESIGN.md).

## Repository Layout

```text
bin/cli.js                 # skill-forge CLI
inventory/
  skills/                  # installable custom skills
  agents/                  # managed global instruction overlays
  subagents/               # managed subagent definitions
  hooks/                   # managed runtime hook scripts (usage stats)
test/                      # node:test CLI suite (npm test)
otel/                      # local observability stack configs (see otel/README.md)
docker-compose.yml         # container stack definition (docker/podman compose)
registry.json              # human-maintained registry manifest
registry-lock.json         # generated integrity lockfile
skill-forge.json           # this repo's own skill profile (it is also a consumer)
skill-forge.lock.json      # generated profile lockfile
.claude/skills/            # vendored profile skills (committed)
```

## Install Dependencies

```bash
npm install
```

Run the CLI from the repository:

```bash
node bin/cli.js --help
```

If installed as a package, the binary names are:

```bash
skill-forge
skf
```

Until the package is published to npm, install it globally straight from git
(registry and inventory travel inside the package), or link a checkout for
development:

```bash
npm install -g git+https://github.com/more-than-code/skill-forge.git   # consumers
npm install && npm link                                                # contributors
```

New-machine bootstrap after install:

```bash
skf home init && skf home sync
```

## Common Commands

List installable skills:

```bash
node bin/cli.js list
```

List all tracked skills:

```bash
node bin/cli.js list --all
```

Validate the registry and lockfile:

```bash
node bin/cli.js validate
```

Regenerate `registry-lock.json` after changing inventory or `registry.json`:

```bash
node bin/cli.js lock
```

Diff canonical artifacts against runtime targets without writing:

```bash
node bin/cli.js agent diff
node bin/cli.js subagent diff
node bin/cli.js hook diff
node bin/cli.js sync --check        # this repo's skill profile
node bin/cli.js home sync --check   # the $HOME profile
```

Run the test suite:

```bash
npm test
```

Generate a static HTML catalog (skills by tag, subagents per tool, composed
agent previews, and local usage stats when present) into `site/`:

```bash
node bin/cli.js site
```

## Skill Profiles (consumer workflow)

Skills are project-scoped. A repository declares its dependencies in
`skill-forge.json`; `skf sync` resolves them against the registry, vendors
exact copies into the repo, and pins versions and integrity hashes in
`skill-forge.lock.json`. Manifest, lockfile, and vendored directories are
committed together.

```bash
skf project init [--tools codex,claude-code,copilot-cli,grok]  # default: all
skf project add [<skill>...]     # interactive search when no names are given
skf sync [--check]               # vendor + lock; --check is the CI drift gate
skf project status [--json]
```

The `tools` map decides the sync targets: `.agents/skills/` when a tool
without native project-skill support (codex, copilot-cli, grok) is enabled,
`.claude/skills/` when `claude-code` is.

`$HOME` is the same mechanism for machine-wide skills, with its own spelling:

```bash
skf home init                    # seeds only skill-forge-project
skf home add <skill>... && skf home sync
skf home status
```

Per-tool global skill directories (`~/.codex/skills`, `~/.claude/skills`, …)
are retired. The legacy `add` command is deprecated, and `skf install` for
skills remains only as a low-level escape hatch that requires an explicit
`--path`.

## Installing Agents, Subagents, Hooks (global)

Managed instructions, subagents, and hooks stay push-based, one namespace per
artifact type:

```bash
node bin/cli.js agent install codex-agents --target codex --path '~/.codex/AGENTS.md' --yes
node bin/cli.js subagent install codex-subagents --target codex
node bin/cli.js hook install claude-code-hooks --target claude-code \
  --path '~/.claude/hooks/skill-forge' --yes
```

Supported target names: `codex`, `copilot-cli`, `claude-code`, `grok`.

`--yes` only skips overwrite confirmation. The CLI still prompts interactively
for the target path, so non-interactive runs (scripts, CI) must also pass
`--path`. Bare `skf install` remains as an interactive picker across all
artifact types.

## Adding Or Updating A Skill

Manually:

1. Add or edit the skill under `inventory/skills/<skill-name>/`.
2. Ensure `SKILL.md` has `name` and `description` frontmatter.
3. Add or update the matching entry in `registry.json`.
4. Regenerate the lockfile:

   ```bash
   node bin/cli.js lock
   ```

5. Validate:

   ```bash
   node bin/cli.js validate
   ```

Versions are tracked in `registry.json`; skill frontmatter should not include a
`version` field.

### `skill` subcommand (agent-facing)

`skf skill` wraps the same steps into single commands intended for programmatic
(agent) use — no interactive prompts, `--json` output on every subcommand, and
`write`/`delete`/`set-version`/`bump` automatically regenerate the lockfile and
re-validate.

```bash
skf skill list [--all] [--json]
skf skill read <name> [--json]
skf skill write <name> [--set-version <semver>] [--tags <a,b,c>] [--installable <true|false>] \
  [--file <relpath>=<localpath>]... [--remove-file <relpath>]... [--skip-skill-md] [--json]
skf skill set-version <name> <semver> [--json]
skf skill bump <name> [--patch|--minor|--major] [--json]
skf skill delete <name> --yes [--json]
```

`write` reads the full `SKILL.md` body (including its `name`/`description`
frontmatter) from stdin and upserts it; `--set-version` is required when
creating a new skill. Companion files (e.g. `EXAMPLES.md`, or nested paths
like `refs/example.md`) are staged from local disk via repeatable
`--file <relative-path>=<local-source-path>` flags; `--file SKILL.md=<path>`
can be used instead of stdin (any case of the skill-root name, e.g.
`skill.md`, is treated as `SKILL.md`). `--remove-file <relative-path>`
(repeatable) deletes a companion file from the skill directory — it cannot
target `SKILL.md` in any case (use `skill delete` to remove the whole skill),
cannot overlap with a `--file` target in the same call, and pruning also
removes any now-empty parent directories under the skill dir. Removing a path
that doesn't exist is a no-op reported as a warning, not an error. All
`--file` and `--remove-file` paths are validated against path traversal (no
`..` segments, no absolute paths). Files not mentioned in a given `write`
call are left untouched. Pass `--skip-skill-md` to leave `SKILL.md`
untouched while changing companions, removals, tags, installable, and/or
version (valid only when updating an existing skill). `read --json` returns
companion contents as a `{ "<relative-path>": "<content>" }` map; both
`read` and `delete` refuse registry paths that are not a strict child of
`inventory/skills`. `set-version` sets the skill's registry version without
rewriting `SKILL.md`. `bump` increments the current registry version by one
step — default `--patch`, or `--minor` / `--major` (mutually exclusive);
minor/major reset lower components to 0. Version commands emit `--json`
with `previousVersion` / `version` (or `action: "unchanged"` when
`set-version` is a no-op). `delete` requires `--yes` explicitly since there
is no interactive confirmation.

`write` validates everything it can — SKILL.md frontmatter, every `--file`
local source's existence (including `SKILL.md=`), every `--remove-file`
target's existence/type, duplicate `--file`/`--remove-file` targets —
*before* touching the filesystem, so a bad input never leaves a partial
write behind: on a new-skill create, if mutation fails before the registry
entry is written, the just-created skill directory is removed. Multi-file
**updates** are not crash-atomic after preflight: a mid-flight I/O error
(after any durable file, removal, registry, or lock change) can leave a
partially updated skill tree. With `--json`, those failures include
`"partial": true` so callers can re-issue a full `skill write`.
`--remove-file` refuses to target a directory (no recursive delete via a
typo) and refuses `SKILL.md`. If registry validation still fails *after* a successful write/delete/
set-version/bump (e.g. an unrelated pre-existing registry problem), that
change is left in place (no automatic rollback at that stage) and the command
exits non-zero with `"partial": true` on `--json` — run `validate` again after
fixing. For version commands the version change already landed; agents should
fix validation errors rather than re-issuing a content write. With `--json`,
failures also emit a JSON object (`{"error": "..."}`, optionally
`"partial": true`, or `{"error", "errors", "warnings", "partial"}` for a
post-mutation validation failure) to stdout instead of leaving it empty, so
callers can always `JSON.parse(stdout)` regardless of exit code.

## Managed Agents

Managed agent artifacts are composed from:

```text
inventory/agents/core.md
inventory/agents/<tool>/<overlay-file>
```

The CLI writes the composed result to the runtime target declared in
`registry.json`. For example, `codex-agents` targets `~/.codex/AGENTS.md`.

Run a read-only drift check before installing:

```bash
node bin/cli.js agent diff
```

## Managed Subagents

Subagent definitions live under:

```text
inventory/subagents/codex/
inventory/subagents/copilot-cli/
inventory/subagents/claude-code/
inventory/subagents/grok/
```

Role sets intentionally differ per tool. Codex and Copilot CLI define five roles
(`bulk_worker`/`bulk-worker`, `researcher`, `validator`, `planner`, `reviewer`).
Claude Code and Grok define only `bulk-worker`, `reviewer`, and `validator`;
exploration and planning map to their built-in agents (`Explore`/`Plan`,
`explore`/`plan`), as documented in each overlay.

Install them with:

```bash
node bin/cli.js subagent install codex-subagents --target codex
```

## Managed Agent Placeholders

`inventory/agents/core.md` may use `{{placeholder}}` tokens (for example
`{{explore_agent}}`, `{{plan_agent}}`) that resolve at compose time from the
`vars` map on each managed agent entry in `registry.json`. This lets shared
process text name the tool-correct subagent (`researcher` for Codex,
`Explore` for Claude Code) without per-tool mapping prose. `validate` fails
on unresolved placeholders and warns on unused vars.

## Usage Stats

`inventory/hooks/claude-code/` provides a deterministic usage recorder for
Claude Code:

```bash
node bin/cli.js hook install claude-code-hooks --target claude-code \
  --path '~/.claude/hooks/skill-forge' --yes
```

Then merge the hooks block from
`~/.claude/hooks/skill-forge/settings-snippet.json` into
`~/.claude/settings.json` (or a project's `.claude/settings.json`). Each
`PostToolUse` on the Agent/Task tool and each `SessionEnd` appends one
metadata-only JSONL record (agent type, model, task description, project,
timestamps — never prompt or transcript content) under
`~/.skill-forge/stats/`. Set `SKILL_FORGE_HOME` to relocate. Other tools can
pipe an equivalent JSON payload to `node bin/cli.js stats record`. The
`site` command renders per-project aggregates from these files.

For whole-session token and cost economics (including main-loop vs subagent
spend), see [otel/README.md](otel/README.md) — a loopback-only container stack
(root `docker-compose.yml`; OTel collector, Prometheus, Grafana — works with
`docker compose` and `podman compose`) consuming Claude Code's native
telemetry, with a provisioned "Claude Code Token Economics" dashboard. The
JSONL stats above complement it with exact custom-subagent names joined on
session ID.

## Safety Notes

- `<type> diff`, `sync --check`, and `project|home status` are read-only.
- `sync` writes only the profile's own targets and never overwrites an
  unmanaged directory (declare hand-authored skills in `skills.local`).
- `agent|subagent|hook install` write to runtime targets; existing files are
  not overwritten without confirmation unless `--yes` is set.
- Runtime files are deployment targets, not the source of truth.
