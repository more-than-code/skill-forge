# Grok AGENTS.md Overlay

This overlay extends the shared core instructions with Grok-specific behavior.

## Grok Skill Paths

Grok-specific skill discovery extends the core skill activation protocol with:

- Grok shared skills: `~/.grok/skills/*/SKILL.md`
- Project Grok skills: `.grok/skills/*/SKILL.md`
- Bundled skills: Grok platform skills (only when relevant to the requested workflow)

Grok-specific precedence after tool-neutral shared skills:

1. `~/.grok/skills/<name>/SKILL.md` for Grok global shared skills.
2. Bundled / platform skills only when they are relevant to the requested workflow.

Put Grok-specific skills in `~/.grok/skills/` only when they rely on Grok behavior.
Grok also scans Claude and Cursor skill directories when compatibility is enabled;
prefer `~/.agents/skills/` or `~/.grok/skills/` for skill-forge managed skills.

For concrete before/after examples of common failure modes, also check
`~/.grok/skills/coding-discipline/EXAMPLES.md` or
`~/.agents/skills/coding-discipline/EXAMPLES.md` when that skill is selected.

## Grok Delegation

Grok exposes subagents via `spawn_subagent`. When delegation is unavailable,
perform the same exploration and review steps in the main context and say so briefly.

Maintained Grok subagent definitions are installed at `~/.grok/agents/`.

- For exploration (§7), use the built-in `explore` agent. For planning, use the
  built-in `plan` agent. Both are read-only (no file edits). Include the required
  output shape (findings with file references, or spec-shaped plans with acceptance
  criteria and verification gates) in the task prompt.
- Use the maintained `validator`, `reviewer`, and `bulk-worker` subagents for their
  §7 roles.
- Use `.grok/rules/` or project-local `AGENTS.md` for narrower file/path-specific
  guidance instead of expanding this file.
- Personas (`.grok/personas/` or `~/.grok/personas/`) shape tone/format only; do not
  use them as a substitute for the maintained role agents above.

## Grok Agent Reference

Prefer `model: inherit` in maintained agent definitions so children follow the
parent session model unless the task explicitly needs a different model.

| Agent | Source | Model | Best for |
|---|---|---|---|
| `explore` | built-in | inherit | Code exploration, API tracing, reading tests, in-scope synthesis |
| `plan` | built-in | inherit | Architecture decisions, multi-file tradeoffs, design with real stakes |
| `general-purpose` | built-in | inherit | Catch-all for multi-step delegated tasks when no maintained role or built-in above fits |
| `bulk-worker` | maintained | inherit | Formatting, renaming, repetitive transforms, file enumeration |
| `validator` | maintained | inherit | Command execution, checks, and reusable evidence capture |
| `reviewer` | maintained | inherit | One review lens at a time with severity-tagged findings |

## Grok Capability Modes

Use `capability_mode` on `spawn_subagent` when the role's defaults are not enough:

| Mode | Read | Write | Execute | Use for |
|---|---|---|---|---|
| `read-only` | yes | no | no | Pure inspection (`explore`, `plan`, `reviewer`) |
| `read-write` | yes | yes | no | File edits without shell |
| `execute` | yes | no | yes | Command evidence (`validator`) without file edits |
| `all` | yes | yes | yes | Full toolset (`bulk-worker`, `general-purpose`) |

Grok agent files do not pin Codex-style `sandbox_mode`. Enforcement is layered:

- Built-in `explore` and `plan` are read-only (no file editing tools).
- Maintained `reviewer` is read-only by body contract; prefer `capability_mode: read-only` when spawning.
- Maintained `validator` may run commands; do not intentionally edit source. Prefer `capability_mode: execute`.
- `bulk-worker` inherits full tools; its limit to explicitly assigned files is a behavioral contract — use isolation/`worktree` or session permissions when available.

## Grok Target Notes

- Runtime target: use the composed content as `AGENTS.md` for Grok global rules.
- Managed global target: `~/.grok/AGENTS.md`.
- Project-specific overrides should live in the repository `AGENTS.md` (or `Agents.md`) file.
- Grok also loads `CLAUDE.md` / Claude compatibility paths when enabled; do not rely on
  Claude-only installs for Grok-managed process — install the Grok agents artifact.
- Keep this overlay focused on Grok-specific behavior. Shared process belongs in the core instructions.
