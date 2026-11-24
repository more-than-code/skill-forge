## Claude Code in this repository

- Explore with the built-in `Explore` agent and plan with `Plan` (both read-only); give each a self-contained prompt and the output shape you need.
- Subagents: `validator` runs assigned commands and returns gate evidence; `reviewer` runs one review lens on a diff and returns severity-tagged findings. Spawn one `reviewer` per required lens (§7). If they are not available, run the lens in a separate `general-purpose` agent given only the diff and the lens, and say so.
- Skills in `.claude/skills/` load by description; read a skill in full only when its description matches the task.
- Project threads ignore `.claude/settings.json` (permissions, hooks, env), so no hook may be enforcing these rules. Treat every rule here as binding anyway.
