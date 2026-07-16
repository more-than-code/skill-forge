# Copilot CLI Instructions Overlay

This overlay extends the shared core instructions with Copilot CLI-specific behavior.

## Copilot CLI Skill Paths

Copilot CLI-specific skill discovery extends the core skill activation protocol with:

- Copilot CLI shared skills: `~/.copilot/skills/*/SKILL.md`

Copilot CLI-specific precedence after tool-neutral shared skills:

1. `~/.copilot/skills/<name>/SKILL.md` for Copilot CLI global shared skills.

Put Copilot-specific skills in `~/.copilot/skills/` only when they rely on Copilot behavior.

For concrete before/after examples of common failure modes, also check `~/.copilot/skills/coding-discipline/EXAMPLES.md` when that skill is selected from Copilot CLI global skills.

## Copilot CLI Delegation

Copilot CLI may expose custom agents or helper workflows. When delegation is unavailable, perform the same exploration and review steps in the main context and say so briefly.

Maintained Copilot custom agent definitions are installed at `~/.copilot/agents/`.

- Do not use Codex subagent names (`bulk_worker`, `researcher`, `planner`) unless a Copilot custom agent with the same behavior exists.
- Use Copilot custom agents only when available and selected for the task.
- Otherwise run exploration, implementation, and review sequentially in the main Copilot CLI context.

## Copilot CLI Agent Reference

Copilot CLI model assignments use Copilot's own model inventory, which may include both OpenAI and Anthropic models. These values do not need to match Codex exactly when another provider is a better fit for the role.

| Agent | Model | Best for |
|---|---|---|
| `bulk-worker` | `gpt-5.4-mini` | Formatting, renaming, repetitive transforms, file enumeration |
| `researcher` | `gpt-5.3-codex` | Code exploration, API tracing, reading tests, in-scope synthesis |
| `validator` | `gpt-5.3-codex` | Command execution, checks, and reusable evidence capture |
| `planner` | `claude-fable-5` | Architecture decisions, multi-file tradeoffs, design with real stakes |
| `reviewer` | `gpt-5.3-codex` | One review lens at a time with severity-tagged findings |

## Copilot CLI Permission Model

Copilot custom agent files do not pin Codex-style `sandbox_mode`. Treat read/write limits in each agent body as behavioral contracts, and use active Copilot CLI session or tool permission controls to enforce them when available.

For `planner`, `researcher`, and `reviewer`, prefer read-only or no-edit permissions. For `validator`, allow command execution and normal command-generated artifacts only. For `bulk-worker`, allow writes only to explicitly assigned files.

## Copilot CLI Target Notes

- Runtime target: install the composed content as a Markdown file matching `~/.copilot/instructions/**/*.instructions.md`.
- Managed global target: `~/.copilot/instructions/agents.instructions.md`.
- The important suffix is `.instructions.md`; examples include `~/.copilot/instructions/agents.instructions.md`, `~/.copilot/instructions/frontend/react.instructions.md`, and `~/.copilot/instructions/backend/api.instructions.md`.
- Files such as `~/.copilot/instructions/AGENTS.md`, `~/.copilot/instructions/agents.md`, and `~/.copilot/instructions/frontend/react.md` do not match Copilot CLI's documented instructions glob.
- Local user instructions may also live at `$HOME/.copilot/copilot-instructions.md`; avoid duplicating conflicting policy between that file and this one.
- Keep this overlay focused on always-on Copilot CLI behavior. Put task-specific reusable workflows in Copilot prompt, agent, or skill files.
