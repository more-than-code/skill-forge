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
lower-level `skill-forge-authoring` skill (which mutates skill content/versions —
not used here).

## When to activate

- The repo has a `skill-forge.json` (a Skill Forge consumer project).
- The user asks "which skills should this project use", "set up skills
  here", "add a skill for X", or "why is this project's skill set out of
  sync".

**Do not use this skill for:** authoring or versioning registry skills under
`inventory/skills/` (that's `skill-forge-authoring`), or installing managed
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
   - **Declare what the repo needs, whether or not `$HOME` also provides it.**
     A repo's manifest should state its own requirements, so it resolves the
     same way on a machine whose `$HOME` profile is empty. The baseline trio
     (`security-baseline`, `coding-discipline`, `code-quality`) therefore
     belongs in each repo's profile regardless of what the machine happens to
     carry.

     Overlap does **not** double-load. Observed 2026-09-22 on two tools
     independently: names present in both the project and `$HOME` trees
     surfaced exactly once each, resolved project-over-home. The at-rest cost
     of an overlapping name is zero, because only frontmatter is read at
     discovery and that name was already being read.

     The cost that is real is **shadowing**: the project copy wins
     unconditionally, so once the repo's pin lags a `$HOME` bump, the stale
     project copy is what loads — and `sync --check` passes at both levels,
     because each is internally consistent. Keep the pins deliberate and
     re-sync repos you have not touched in a while.
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
     `--shims <list>` only to narrow which compat shims are created; the default
     is all known shims, today just `claude-code`).
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
- **Local skills are declared where they already live.** `sync` does not copy
  `skills.local` entries anywhere — the source dir must already be at a path the
  tool reads. See "Authoring a repo-local skill" below.
- **Commit together.** `skill-forge.json`, `skill-forge.lock.json`, and the
  vendored `.agents/skills/`/`.claude/skills/` directories change as one unit —
  don't split them across commits.

## Authoring a repo-local skill

Some doctrine is true only for one repo — a house pattern, a workaround for a
quirk in that codebase, a convention no other project shares. That belongs in
`skills.local`, not the registry. The registry rule applies in reverse here: if a
line stops being true when pointed at a different product, it must **not** go to
`inventory/skills`.

**The mechanic that surprises people: `sync` does not vendor local skills.** It
copies registry skills into every target dir; for a local skill it only records
`path` + `integrity` in the lockfile. Nothing is moved or copied. So the source
directory has to already sit where the agent tool looks:

```
<repo>/.agents/skills/<name>/SKILL.md      # the source itself, not a copy
```

There is exactly one such path. `.claude/skills` is a symlink onto
`.agents/skills`, so the skill is reachable through it without a second source,
a second link, or a second declaration.

Declare it against that same path:

```json
{ "skills": { "local": { "my-house-rule": ".agents/skills/my-house-rule" } } }
```

Then `skf sync` and confirm `skf sync --check` exits 0.

**What declaring it buys you.** Without the declaration the directory is an
undeclared stranger in a vendor dir: `sync` refuses to run (`exists but is not
managed by Skill Forge`), or prunes it as an orphan. Declaring it exempts the
path from pruning and puts the tree under integrity tracking, so a later edit
shows up as drift in `sync --check` instead of passing silently.

**Constraints the CLI enforces:**

- A name cannot be both a registry dependency and a local skill — `sync` fails
  outright rather than picking one.
- The path must be relative and inside the repo; `..` and absolute paths are
  rejected.
- The path must exist when `sync` runs, or it fails with
  `skills.local["<name>"] path "<p>" does not exist`.

**Constraints the CLI does *not* enforce** — the agent tools do, silently:

- Frontmatter still needs `name` (matching the directory) and `description`.
  A local skill is never validated by `skf validate`; a malformed one simply
  never activates.
- No `version:` in frontmatter. Versions live in the registry, and a local
  skill has no registry row — its lockfile `integrity` hash is its identity.

**Never link a local skill into a tool directory by name.** A tool directory is
already a shim onto `.agents/skills`, so `ln -s … .claude/skills/<name>` writes
the link *inside* the store it points at. One source, declared once, is the whole
arrangement — `sync` writes the shim and `integrity` tracks the real directory.

**One source, one place.** A local skill's source directory lives in exactly one
repo. Copying it to a second location — say, an umbrella mirroring a child's
skill so umbrella-rooted sessions can see it — produces a copy `sync` will never
refresh and `integrity` never covers, because tracking follows the declared path
only. If a skill is needed at both levels, promote it to the registry
(`skill-forge-authoring`) and declare it as a dependency in both profiles.

## Command map

```bash
skf skill list --json                 # candidates: name, version, tags, description
skf project init [--shims <list>]      # only if skill-forge.json is missing
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
| Leave a needed skill out because `$HOME` happens to provide it | Declare what the repo needs; it should resolve the same with an empty `$HOME` |
| Assume an overlapping name double-loads | It dedupes, project-over-home; the hazard is a stale project pin shadowing a newer `$HOME` one |
| Declare `skills.local` and expect `sync` to place the directory for you | Put the source at `.agents/skills/<name>` first, then declare that path |
| Copy a local skill's source into a second repo or level so both see it | One source dir; if both levels need it, promote it to the registry |
| Put a product-specific house rule in `inventory/skills` so it is "reusable" | `skills.local` in the repo it is true for |

## Related

- `skill-forge-authoring` skill — authoring/versioning **registry** skills; it refuses paths
  outside `inventory/skills`, so it cannot touch a consumer repo's `skills.local`
- `docs/DESIGN.md` § "Project Skill Profiles" — why skills are project-scoped
