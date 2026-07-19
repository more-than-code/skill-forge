---
name: skill-forge-project
description: >
  Drive skill selection for a Skill Forge consumer repository: detect the
  stack, propose a fitting set of registry skills with rationale, wait for
  user confirmation, then apply it via the `skf project`/`skf sync` CLI.
  Activate when the repo contains `skill-forge.json`, or the user asks which
  skills a project should use, add, or drop.
---

# Skill Forge Project Skill Selection

Helps an agent pick which registry skills a repository should depend on, and
apply that choice safely. This is the *fit-analysis* layer on top of the
lower-level `skill-forge-cli` skill (which mutates skill content/versions —
not used here).

## When to activate

- The repo has a `skill-forge.json` (a Skill Forge consumer project).
- The user asks "which skills should this project use", "set up skills
  here", "add a skill for X", or "why is this project's skill set out of
  sync".

**Do not use this skill for:** authoring or versioning registry skills under
`inventory/skills/` (that's `skill-forge-cli`), or installing managed
agents/subagents/hooks (`skf agent|subagent|hook install`).

## Decision workflow

1. **Inspect the repo.** Detect languages, frameworks, test runners, containers/
   Compose, CI config, and whether it's frontend-, backend-, or full-stack. Use
   whatever's fastest and accurate — manifest files (`package.json`,
   `pyproject.toml`, `go.mod`, `Cargo.toml`), `Dockerfile`/`compose.yaml`,
   existing CI workflows, directory shape.
2. **List candidates.** Run `skf skill list --json` (add `--all` only if
   non-installable/tracked skills are relevant to the question). Each entry
   now carries `name`, `version`, `tags`, and `description` — use those to
   match against what step 1 found. Filter client-side; there is no server-side
   `--query`.
3. **Propose a minimal set**, not everything that could plausibly apply:
   - Do not duplicate skills the machine's `$HOME` profile already provides
     (check `~/skill-forge.json`): duplicates get surfaced twice to agents.
     The default home profile is minimal — `skf home init` seeds only
     `skill-forge-project` — so the baseline trio (`security-baseline`,
     `coding-discipline`, `code-quality`) normally belongs in each repo's
     profile; include it unless the home profile already provides it.
   - Add stack-specific skills only where a detected signal maps directly to a
     skill's tags/description (e.g. a `Dockerfile`/compose file →
     `podman-utilization`; a frontend framework → `frontend-engineering` and/or
     `ui-portability-baseline`).
   - One line of rationale per proposed skill, naming the signal that justified it.
4. **Wait for explicit confirmation.** Present the proposed set and rationale,
   then stop. Do not run `project add`/`sync` until the user confirms the set
   (or an adjusted version of it).
5. **Apply the confirmed set:**
   - If `skill-forge.json` doesn't exist yet: `skf project init` (add
     `--tools <list>` only if the user wants to narrow which tools get vendored
     copies; default is all four).
   - `skf project add <name...>` for the confirmed skills (omit names to fall
     back to the CLI's own interactive search instead of picking for the user).
   - `skf sync` to vendor the skills and write `skill-forge.lock.json`.
   - Verify with `skf sync --check` (must exit 0) and `skf project status --json`
     to confirm the resolved `skills` list matches what was proposed.
6. **Report back** the final skill set and sync state.

## Rules

- **Never hand-copy skill directories.** Only `skf sync` writes into
  `.agents/skills/` or `.claude/skills/`; don't `cp -r` from `inventory/skills/`
  or another project.
- **Never write to `~/.<tool>/skills`.** Global per-tool skill installs are
  retired; project skills are repo-scoped via `skill-forge.json` + `sync`. A
  project that wants skills available everywhere should instead be summarized
  to the user as "declare it in the `$HOME` profile" (`skf home add <name>` +
  `skf home sync`), not solved by writing into a tool's global skills
  directory.
- **Respect `skills.local` collisions.** If `sync` fails with "not managed by
  Skill Forge", a pre-existing hand-authored directory is at that vendor path —
  ask the user whether to declare it under `skills.local` or move it aside.
  Never delete it to make sync pass.
- **Commit together.** `skill-forge.json`, `skill-forge.lock.json`, and the
  vendored `.agents/skills/`/`.claude/skills/` directories change as one unit —
  don't split them across commits.

## Command map

```bash
skf skill list --json                 # candidates: name, version, tags, description
skf project init [--tools <list>]      # only if skill-forge.json is missing
skf project add [<name>...]            # confirmed names, or interactive if omitted
skf project status [--json]            # resolved skills, sources, sync state, issues
skf home init|add|status|sync          # same flow for the machine-wide $HOME profile
skf sync                               # vendor + write lockfile
skf sync --check                       # read-only staleness check (exit non-zero on drift)
```

## Anti-patterns

| Wrong | Right |
|-------|-------|
| Decide the skill set and run `project add` + `sync` without confirmation | Propose with rationale, wait for explicit user confirmation |
| `cp -r inventory/skills/foo .agents/skills/foo` | `skf project add foo` then `skf sync` |
| Install a skill to `~/.claude/skills` for "everywhere" access | `skf home add <name>` + `skf home sync` |
| Delete a colliding hand-authored `.agents/skills/<name>` dir to unblock `sync` | Ask the user; use `skills.local` or move it aside |
| Propose every tag-matching skill in the registry | Propose the minimal set that maps to a detected signal |
| Re-declare home-profile skills (e.g. the baseline trio) in the repo manifest | Let `$HOME` provide machine-wide skills; repo declares only what home doesn't cover |

## Related

- `skill-forge-cli` skill — authoring/versioning registry skills (not this workflow)
- `docs/DESIGN.md` § "Project Skill Profiles" — why skills are project-scoped
