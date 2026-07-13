# Skill Forge

Skill Forge is a local registry and installer for agent-facing artifacts:

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

## Repository Layout

```text
bin/cli.js                 # skill-forge CLI
inventory/
  skills/                  # installable custom skills
  agents/                  # managed global instruction overlays
  subagents/               # managed subagent definitions
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

## Safety Notes

- `diff-*` commands are read-only.
- `install` and `add` write to runtime target directories.
- Existing files are not overwritten without confirmation unless `--yes` is set.
- Runtime global files are deployment targets, not the source of truth.
