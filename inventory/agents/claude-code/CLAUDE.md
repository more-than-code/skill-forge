# Claude Code CLAUDE.md Overlay

This overlay extends the shared core instructions with Claude Code-specific behavior.

## Claude Code Skill Paths

Claude Code-specific skill discovery extends the core skill activation protocol with:

- Claude Code shared skills: `~/.claude/skills/*/SKILL.md`

Claude Code-specific precedence after tool-neutral shared skills:

1. `~/.claude/skills/<name>/SKILL.md` for Claude Code global shared skills.

Put Claude-specific skills in `~/.claude/skills/` only when they rely on Claude Code behavior.

For concrete before/after examples of common failure modes, also check `~/.claude/skills/coding-discipline/EXAMPLES.md` when that skill is selected from Claude Code global skills.

## Claude Code Delegation

Claude Code may expose subagents or helper workflows. When delegation is unavailable, perform the same exploration and review steps in the main context and say so briefly.

Maintained Claude Code subagent definitions are installed at `~/.claude/agents/`.

- For exploration (§7), use the built-in `Explore` agent. For planning, use the built-in `Plan` agent. Both are harness-enforced read-only. Include the required output shape (findings with file references, or spec-shaped plans with acceptance criteria and verification gates) in the task prompt.
- Use the maintained `validator`, `reviewer`, and `bulk-worker` subagents for their §7 roles.
- Use `.claude/rules/` or project-local Claude configuration for narrower file/path-specific guidance instead of expanding this file.
- Claude-specific auto memory may record learnings separately. Do not treat auto memory as a substitute for explicit safety, verification, or permission rules in the composed file.

## Claude Code Agent Reference

Claude Code model assignments use Claude model aliases because Claude Code does not select OpenAI models for subagents. Prefer aliases over pinned Anthropic model IDs so Claude Code can resolve them to the user's configured provider defaults.

| Agent | Source | Model | Best for |
|---|---|---|---|
| `Explore` | built-in | default | Code exploration, API tracing, reading tests, in-scope synthesis |
| `Plan` | built-in | default | Architecture decisions, multi-file tradeoffs, design with real stakes (pass a `model` override such as `opus` for high-stakes design) |
| `general-purpose` | built-in | default | Catch-all for multi-step delegated tasks when no maintained role or built-in above fits |
| `bulk-worker` | maintained | `haiku` | Formatting, renaming, repetitive transforms, file enumeration |
| `validator` | maintained | `sonnet` | Command execution, checks, and reusable evidence capture |
| `reviewer` | maintained | `sonnet` | One review lens at a time with severity-tagged findings |

Other built-in utility agents (for example `claude-code-guide`, `statusline-setup`) vary by Claude Code version and surface; use them for their stated purpose, not for §7 delegation roles.

## Claude Code Built-In Commands

- `/verify` supplements §5 verification by exercising the changed flow end-to-end. Use it as additional evidence; it does not replace the required gate commands and evidence format.
- `/code-review` and `/simplify` supplement the §6 review lenses. Per §7, they do not replace lens reviews unless they produce the required severity-tagged per-lens output.

## Claude Code Permission Model

Claude Code subagent files do not pin Codex-style `sandbox_mode`. Enforcement is layered:

- Built-in `Explore` and `Plan` are harness-enforced read-only.
- `reviewer` and `validator` declare a `tools` allowlist in frontmatter (`reviewer` is read-only; `validator` can run commands but cannot edit files).
- `bulk-worker` inherits full tools; its limit to explicitly assigned files is a behavioral contract — use active session or tool permission controls to enforce it when available.

## Claude Code Target Notes

- Runtime target: use the composed content as `CLAUDE.md` for Claude Code user/global or project memory.
- Managed global target: `~/.claude/CLAUDE.md`.
- Project-specific overrides should live in the repository `CLAUDE.md` file.
- Keep instructions concise. Claude Code loads `CLAUDE.md` as persistent context, not as an enforced policy engine.
- Keep this overlay focused on Claude Code-specific behavior. Shared process belongs in the core instructions.
