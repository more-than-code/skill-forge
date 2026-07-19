# Skill Forge Repository Instructions

This repository evaluates and evolves agent artifacts (instructions, skills, subagents) on top of a skill-registry substrate; see `docs/DESIGN.md` for goals and architecture. These rules apply only when working inside it; they intentionally do not ship in the composed agent instructions.

## Inventory Skill Handling

- `inventory/skills/*/SKILL.md` are installable repository artifacts, not automatically activated agent skills. Activate one only when the task is to create, review, edit, install, or explicitly use that skill.
- In skill precedence, `inventory/skills/<name>/SKILL.md` sits between project-local skills (this repo vendors its own profile to `.claude/skills/`) and home-profile skills, and only under the condition above.
- Versions live in `registry.json`, never in skill frontmatter.

## Authoring Paths

- Managed agent instructions are composed from `inventory/agents/core.md` plus `inventory/agents/<tool>/` overlays. Runtime files (`~/.codex/AGENTS.md`, `~/.copilot/instructions/agents.instructions.md`, `~/.claude/CLAUDE.md`, `~/.grok/AGENTS.md`) are deployment targets, not the source of truth — edit inventory, then reinstall.
- Tool-specific subagent definitions are authored under `inventory/subagents/<tool>/` and install to each tool's runtime agents directory. Role sets intentionally differ per tool; do not copy definitions between tool directories.
- Keep shared process in `core.md`; put tool/runtime specifics in the matching overlay.

## Change Workflow

After changing `registry.json` or anything under `inventory/`: run `node bin/cli.js lock`, then `node bin/cli.js validate` (a stale lockfile is an error). Then:

- **Skills** propagate pull-based: consumer directories with a `skill-forge.json` (repos and `$HOME`) pick up changes on their next `node bin/cli.js sync`; `sync --check` there detects staleness. Skills are no longer installed to per-tool global directories.
- **Agents, subagents, hooks** stay push-based: reinstall with `node bin/cli.js <agent|subagent|hook> install` and confirm with the read-only `<agent|subagent|hook> diff` commands.
