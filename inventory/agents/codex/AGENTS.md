# Codex AGENTS.md Overlay

This overlay is appended to `inventory/agents/core.md` when installing Codex agents.

## Codex Skill Paths

Codex-specific skill discovery extends the core skill activation protocol with:

- Global shared skills: `~/.codex/skills/*/SKILL.md`
- Global system skills: `~/.codex/skills/.system/*/SKILL.md` for Codex/platform workflows only

Codex-specific precedence after tool-neutral shared skills:

1. `~/.codex/skills/<name>/SKILL.md` for Codex global shared skills.
2. `~/.codex/skills/.system/<name>/SKILL.md` for Codex/platform workflows.

Put reusable, cross-project skills in `~/.codex/skills/` only when they are intended for Codex. Keep Codex/platform workflow skills in `~/.codex/skills/.system/`.

For concrete before/after examples of common failure modes, also check `~/.codex/skills/coding-discipline/EXAMPLES.md` when that skill is selected from Codex global skills.

## Codex Task Delegation

Use subagents or helper tasks for isolated context, parallel work, or bulk mechanical tasks when the active coding tool supports them. Never delegate when the parent needs to hold reasoning together.

The named agent routes below are Codex-specific. Other tools should map these roles to their nearest available mechanism, or do the work in the main context if no equivalent exists.

Maintained Codex subagent definitions live in `inventory/subagents/codex/` and install to `~/.codex/agents/`.

Agent routing:

- `bulk_worker`: formatting, renaming, repetitive file transforms, enumeration
- `researcher`: code exploration, API tracing, in-scope synthesis, reading tests
- `planner`: architecture decisions, multi-file tradeoffs, design with real stakes

Codex subagent rule: if a subagent realizes it's undertiered, it must return to parent, not upgrade itself.

## Codex Agent Reference

| Agent | Model | Best for |
|---|---|---|
| `bulk_worker` | `gpt-5.4-mini` | Formatting, renaming, repetitive transforms, file enumeration |
| `researcher` | `gpt-5.3-codex` | Code exploration, API tracing, reading tests, in-scope synthesis |
| `planner` | `gpt-5.5` | Architecture decisions, multi-file tradeoffs, design with real stakes |

## Codex Sandbox Modes

| Mode | Can write? | Use for |
|---|---|---|
| `read-only` | no | Pure inspection |
| `workspace-write` | yes, within repo/workspace roots | Normal implementation work |
| `danger-full-access` | yes, unrestricted | Throwaway VMs only |

## Codex Target Notes

- Runtime target: `~/.codex/AGENTS.md`.
- Project-specific overrides should live in the repository `AGENTS.md` file.
- Keep this overlay focused on Codex-specific behavior. Shared process belongs in `inventory/agents/core.md`.
