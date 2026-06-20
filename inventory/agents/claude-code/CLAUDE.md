# Claude Code CLAUDE.md Overlay

This overlay is appended to `inventory/agents/core.md` when installing Claude Code agents.

## Claude Code Skill Paths

Claude Code-specific skill discovery extends the core skill activation protocol with:

- Claude Code shared skills: `~/.claude/skills/*/SKILL.md`

Claude Code-specific precedence after tool-neutral shared skills:

1. `~/.claude/skills/<name>/SKILL.md` for Claude Code global shared skills.

Put Claude-specific skills in `~/.claude/skills/` only when they rely on Claude Code behavior.

For concrete before/after examples of common failure modes, also check `~/.claude/skills/coding-discipline/EXAMPLES.md` when that skill is selected from Claude Code global skills.

## Claude Code Delegation

Claude Code may expose subagents or helper workflows. When delegation is unavailable, perform the same exploration and review steps in the main context and say so briefly.

Maintained Claude Code subagent definitions live in `inventory/subagents/claude-code/` and install to `~/.claude/agents/`.

- Do not use Codex subagent names (`bulk_worker`, `researcher`, `planner`). Use Claude Code subagents only when they are configured for the current project or user profile.
- Use `.claude/rules/` or project-local Claude configuration for narrower file/path-specific guidance instead of expanding this file.
- Claude-specific auto memory may record learnings separately. Do not treat auto memory as a substitute for explicit safety, verification, or permission rules in the composed file.

## Claude Code Agent Reference

Claude Code model assignments use Claude model aliases because Claude Code does not select OpenAI models for subagents. Prefer aliases over pinned Anthropic model IDs so Claude Code can resolve them to the user's configured provider defaults.

| Agent | Model | Best for |
|---|---|---|
| `bulk-worker` | `haiku` | Formatting, renaming, repetitive transforms, file enumeration |
| `researcher` | `sonnet` | Code exploration, API tracing, reading tests, in-scope synthesis |
| `validator` | `sonnet` | Command execution, checks, and reusable evidence capture |
| `planner` | `opus` | Architecture decisions, multi-file tradeoffs, design with real stakes |
| `reviewer` | `sonnet` | One review lens at a time with severity-tagged findings |

## Claude Code Permission Model

Claude Code subagent files do not pin Codex-style `sandbox_mode`. Treat read/write limits in each agent body as behavioral contracts, and use active Claude Code session or tool permission controls to enforce them when available.

For `planner`, `researcher`, and `reviewer`, prefer read-only or no-edit permissions. For `validator`, allow command execution and normal command-generated artifacts only. For `bulk-worker`, allow writes only to explicitly assigned files.

## Claude Code Target Notes

- Runtime target: use the composed content as `CLAUDE.md` for Claude Code user/global or project memory.
- Managed global target: `~/.claude/CLAUDE.md`.
- Project-specific overrides should live in the repository `CLAUDE.md` file.
- Keep instructions concise. Claude Code loads `CLAUDE.md` as persistent context, not as an enforced policy engine.
- Keep this overlay focused on Claude Code-specific behavior. Shared process belongs in `inventory/agents/core.md`.
