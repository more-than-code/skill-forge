# Skill Forge

Skill Forge evaluates how an agent tool and its artifacts — managed instructions,
skills, subagents — perform together across SDLC lenses (work phase, task type,
cost), and evolves those artifacts based on the evidence. Its substrate is a
local registry and installer for agent-facing artifacts:

- Skills for reusable task guidance.
- Managed agent instruction overlays for Codex, Copilot CLI, and Claude Code.
- Managed subagent definitions for supported tools.

The repository is the source of truth. Runtime locations such as `~/.codex/skills`,
`~/.copilot/skills`, and `~/.claude/skills` are deployment targets.

## Features

- Tracks all artifacts in `registry.json`.
- Locks artifact integrity in `registry-lock.json` using package-lock-style
  `packages` entries with SHA-256 integrity hashes.
- Installs skills, agents, and subagents to supported local agent runtimes.
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
node bin/cli.js diff-global
node bin/cli.js diff-agents
node bin/cli.js diff-subagents
node bin/cli.js diff-hooks
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

## Installing Artifacts

Install a skill to Codex's default skill directory:

```bash
node bin/cli.js add podman-utilization --target codex
```

Install a skill to a custom directory:

```bash
node bin/cli.js add podman-utilization --target codex --dir .agents/skills
```

Use the general installer for skills, agents, or subagents:

```bash
node bin/cli.js install podman-utilization --type skill --target codex
node bin/cli.js install codex-agents --type agent --target codex
node bin/cli.js install codex-subagents --type subagent --target codex
```

Supported target names:

- `codex`
- `copilot-cli`
- `claude-code`

Use `--path` to override the default runtime target:

```bash
node bin/cli.js install codex-agents --type agent --target codex --path /tmp/AGENTS.md
```

Use `--yes` only when overwriting existing target files is intended:

```bash
node bin/cli.js install codex-subagents --type subagent --target codex --yes
```

`--yes` only skips overwrite confirmation. The CLI still prompts interactively
for the target path, so non-interactive runs (scripts, CI) must also pass
`--path` (or `--dir` for `add`):

```bash
node bin/cli.js install claude-code-agents --type agent --target claude-code \
  --path '~/.claude/CLAUDE.md' --yes
```

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
typo) and refuses `SKILL.md`. If registry validation still fails *after* a
successful write/delete (e.g. an unrelated pre-existing registry problem),
that change is left in place (no automatic rollback at that stage) and the
command exits non-zero with `"partial": true` on `--json` — run `validate`
again after fixing. With `--json`, failures also emit a JSON object
(`{"error": "..."}`, optionally `"partial": true`, or
`{"error", "errors", "warnings", "partial"}` for a post-write validation
failure) to stdout instead of leaving it empty, so callers can always
`JSON.parse(stdout)` regardless of exit code.

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
node bin/cli.js diff-agents
```

## Managed Subagents

Subagent definitions live under:

```text
inventory/subagents/codex/
inventory/subagents/copilot-cli/
inventory/subagents/claude-code/
```

Role sets intentionally differ per tool. Codex and Copilot CLI define five roles
(`bulk_worker`/`bulk-worker`, `researcher`, `validator`, `planner`, `reviewer`).
Claude Code defines only `bulk-worker`, `reviewer`, and `validator`; exploration
and planning map to Claude Code's built-in `Explore` and `Plan` agents, as
documented in the Claude Code overlay.

Install them with:

```bash
node bin/cli.js install codex-subagents --type subagent --target codex
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
node bin/cli.js install claude-code-hooks --type hook --target claude-code \
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

- `diff-*` commands are read-only.
- `install` and `add` write to runtime target directories.
- Existing files are not overwritten without confirmation unless `--yes` is set.
- Runtime global files are deployment targets, not the source of truth.
