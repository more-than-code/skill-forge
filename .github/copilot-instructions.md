# Repository instructions for Copilot

## Build, test, and lint commands

- Install dependencies: `npm install`
- Show CLI help: `node bin/cli.js --help`
- Syntax-check the CLI entrypoint: `node --check bin/cli.js`
- Validate registry metadata, skill frontmatter, managed artifacts, and lock freshness: `node bin/cli.js validate`
- Regenerate the generated lockfile after changing `registry.json` or anything under `inventory/`: `node bin/cli.js lock`
- Read-only drift checks against local runtime targets:
  - `node bin/cli.js diff-global`
  - `node bin/cli.js diff-agents`
  - `node bin/cli.js diff-subagents`
- There is no configured working test suite or lint script. `npm test` is the package placeholder and exits with `Error: no test specified`.
- For a targeted single check, run the smallest command that covers the change, such as `node --check bin/cli.js` for CLI edits, `node bin/cli.js validate` for registry/inventory edits, or a smoke install into a temporary path for installer behavior:
  - `node bin/cli.js add frontend-engineering -d /tmp/skill-forge-install-test`
  - `node bin/cli.js install copilot-cli-agents --type agent --target copilot-cli --path /tmp/agents.instructions.md`

## High-level architecture

Skill Forge is a Node.js ESM CLI and local registry for agent-facing artifacts. `bin/cli.js` is the only executable source file; it reads `registry.json`, validates the inventory, computes SHA-256 integrity entries, installs artifacts, and compares canonical inventory against runtime targets.

`registry.json` is the human-maintained manifest. It tracks installable skills, source-only agent core content, tool-specific managed agent overlays, and tool-specific subagent directories. `registry-lock.json` is generated from `registry.json` plus the contents of referenced inventory paths and should be refreshed with `node bin/cli.js lock` after inventory or manifest changes.

`inventory/skills/<name>/` contains installable skills. Each skill must include `SKILL.md` with YAML frontmatter containing `name` and `description`; versions live only in `registry.json`, not in skill frontmatter.

Managed agent files are composed at install time. `inventory/agents/core.md` is the shared source artifact, and `inventory/agents/<tool>/...` files are tool-specific overlays appended with a markdown separator. Runtime files such as `~/.codex/AGENTS.md`, `~/.copilot/instructions/agents.instructions.md`, and `~/.claude/CLAUDE.md` are deployment targets, not the source of truth.

Managed subagents are stored separately per tool under `inventory/subagents/codex/`, `inventory/subagents/copilot-cli/`, and `inventory/subagents/claude-code/`. Keep tool-specific naming and model conventions in the matching directory instead of copying definitions between tools. Role sets intentionally differ per tool: Claude Code defines only `bulk-worker`, `reviewer`, and `validator` because exploration and planning map to its built-in `Explore` and `Plan` agents; do not "fix" the asymmetry by adding `researcher`/`planner` back to the Claude Code directory.

## Key conventions

- `inventory/skills/` contents are installable repository artifacts, not automatically activated agent skills; activate one only when the task is to create, review, edit, install, or explicitly use it.
- Custom skills use `scope: "custom"` in `registry.json` and are addressed by bare skill name in CLI output and installs. Scoped `custom/<name>` is accepted, but the bare name is the normal user-facing form.
- Keep inventory changes synchronized across the source files, `registry.json`, and `registry-lock.json`. `node bin/cli.js validate` treats a stale lockfile as an error.
- The CLI defaults `add` to the Codex skill target unless `--target` or `--dir` is provided. Use `install` for agents and subagents.
- `diff-*` commands are read-only. `install` and `add` write to runtime targets and prompt before overwriting unless `--yes` is passed. `--yes` does not skip the interactive target-path prompt; non-interactive runs must also pass `--path` (or `--dir` for `add`).
- The repository ignores `tasks/` and `private/`; prior smoke-test outputs may exist under ignored paths and should not be treated as canonical inventory.
- Copilot CLI managed instruction files must use the `.instructions.md` suffix. The canonical Copilot overlay is `inventory/agents/copilot-cli/agents.instructions.md`, and the managed runtime target is `~/.copilot/instructions/agents.instructions.md`.
- Do not put platform-specific behavior in `inventory/agents/core.md` when it belongs in a tool overlay. Keep shared process in core and runtime/tool path details in the relevant overlay.
