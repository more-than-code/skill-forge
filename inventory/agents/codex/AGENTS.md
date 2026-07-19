# Codex AGENTS.md Overlay

This overlay extends the shared core instructions with Codex-specific behavior.

## Codex Skill Paths

Codex-specific skill discovery extends the core skill activation protocol with:

- Global system skills: `~/.codex/skills/.system/*/SKILL.md` for Codex/platform workflows only.

`~/.codex/skills/` is retired as a shared-skill location — do not place or expect Skill Forge skills there. Codex reads project skills from `.agents/skills/` and home-profile skills from `~/.agents/skills/` per the core protocol; `.system` platform skills rank after both.

For concrete before/after examples of common failure modes, also check the activated `coding-discipline` skill's `EXAMPLES.md` companion.

## Codex Task Delegation

Use subagents or helper tasks for isolated context, parallel work, or bulk mechanical tasks when the active coding tool supports them. Never delegate when the parent needs to hold reasoning together.

The named agent routes below are Codex-specific. Other tools should map these roles to their nearest available mechanism, or do the work in the main context if no equivalent exists.

Maintained Codex subagent definitions are installed at `~/.codex/agents/`.

Agent routing:

- `bulk_worker`: formatting, renaming, repetitive file transforms, enumeration
- `researcher`: code exploration, API tracing, in-scope synthesis, reading tests
- `validator`: command execution, checks, and reusable evidence capture
- `planner`: architecture decisions, multi-file tradeoffs, design with real stakes
- `reviewer`: one review lens at a time with severity-tagged findings

Codex subagent rule: if a subagent realizes it's undertiered, it must return to parent, not upgrade itself.

## Codex Agent Reference

Codex model assignments use OpenAI model identifiers because Codex only supports OpenAI model selection. Do not copy non-OpenAI model choices from Copilot CLI or Claude Code into Codex agent definitions.

| Agent | Model | Best for |
|---|---|---|
| `bulk_worker` | `gpt-5.4-mini` | Formatting, renaming, repetitive transforms, file enumeration |
| `researcher` | `gpt-5.3-codex` | Code exploration, API tracing, reading tests, in-scope synthesis |
| `validator` | `gpt-5.3-codex` | Command execution, checks, and reusable evidence capture |
| `planner` | `gpt-5.5` | Architecture decisions, multi-file tradeoffs, design with real stakes |
| `reviewer` | `gpt-5.3-codex` | One review lens at a time with severity-tagged findings |

## Codex Sandbox Modes

| Mode | Can write? | Use for |
|---|---|---|
| `read-only` | no | Pure inspection |
| `workspace-write` | yes, within repo/workspace roots | Normal implementation work |
| `danger-full-access` | yes, unrestricted | Throwaway VMs only |

Codex sandbox assignment: `planner`, `researcher`, and `reviewer` are read-only; `validator` may use `workspace-write` for normal command-generated artifacts; `bulk_worker` uses `workspace-write` for explicitly assigned mechanical edits.

## Codex Target Notes

- Runtime target: `~/.codex/AGENTS.md`.
- Project-specific overrides should live in the repository `AGENTS.md` file.
- Keep this overlay focused on Codex-specific behavior. Shared process belongs in the core instructions.
