# Copilot CLI Instructions Overlay

This overlay is appended to `inventory/agents/core.md` when installing Copilot CLI agents.

## Copilot CLI Skill Paths

Copilot CLI-specific skill discovery extends the core skill activation protocol with:

- Copilot CLI shared skills: `~/.copilot/skills/*/SKILL.md`

Copilot CLI-specific precedence after tool-neutral shared skills:

1. `~/.copilot/skills/<name>/SKILL.md` for Copilot CLI global shared skills.

Put Copilot-specific skills in `~/.copilot/skills/` only when they rely on Copilot behavior.

For concrete before/after examples of common failure modes, also check `~/.copilot/skills/coding-discipline/EXAMPLES.md` when that skill is selected from Copilot CLI global skills.

## Copilot CLI Delegation

Copilot CLI may expose custom agents or helper workflows. When delegation is unavailable, perform the same exploration and review steps in the main context and say so briefly.

Maintained Copilot custom agent definitions live in `inventory/subagents/copilot-cli/` and install to `~/.copilot/agents/`.

- Do not use Codex subagent names (`bulk_worker`, `researcher`, `planner`) unless a Copilot custom agent with the same behavior exists.
- Use Copilot custom agents only when available and selected for the task.
- Otherwise run exploration, implementation, and review sequentially in the main Copilot CLI context.

## Copilot CLI Target Notes

- Runtime target: install the composed content as a Markdown file matching `~/.copilot/instructions/**/*.instructions.md`.
- Managed global target: `~/.copilot/instructions/agents.instructions.md`.
- The important suffix is `.instructions.md`; examples include `~/.copilot/instructions/agents.instructions.md`, `~/.copilot/instructions/frontend/react.instructions.md`, and `~/.copilot/instructions/backend/api.instructions.md`.
- Files such as `~/.copilot/instructions/AGENTS.md`, `~/.copilot/instructions/agents.md`, and `~/.copilot/instructions/frontend/react.md` do not match Copilot CLI's documented instructions glob.
- Local user instructions may also live at `$HOME/.copilot/copilot-instructions.md`; avoid duplicating conflicting policy between that file and this one.
- Keep this overlay focused on always-on Copilot CLI behavior. Put task-specific reusable workflows in Copilot prompt, agent, or skill files.
