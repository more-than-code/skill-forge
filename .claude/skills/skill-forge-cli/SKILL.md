---
name: skill-forge-cli
description: >
  Manage skill-forge inventory skills via the agent-facing `skf skill` CLI
  (list/read/write/delete/set-version/bump). Activate when creating, updating,
  removing, or versioning skills under inventory/skills, or when an agent would
  otherwise hand-edit registry.json for skill entries. Prefer this over raw
  file edits so lock + validate stay in sync.
---

# Skill Forge CLI (agent-facing)

Use the `skill-forge` / `skf` CLI to mutate inventory skills. Do **not** hand-edit
`registry.json` skill rows or `registry-lock.json` for routine skill create/update/
delete/version work — `write`, `delete`, `set-version`, and `bump` already run
`lock` + `validate`.

**Binary:** `skf` or `node bin/cli.js` from the skill-forge repo root.

Always pass **`--json`** and parse **stdout** even when the exit code is non-zero.

## When to activate

- Create or update a skill under `inventory/skills/<name>/`
- Add/remove companion files (`EXAMPLES.md`, nested refs, etc.)
- Bump or set a skill's registry version after a content change
- Delete a skill from inventory + registry
- An agent is about to hand-edit `registry.json` only to change a skill version

**Do not use this skill for:** managed agents, subagents, hooks, or top-level
`registry.version` — those are still manual + `lock` + `validate`.

## Hard rules

1. **Versions live only in the registry.** Never put `version` in SKILL.md frontmatter.
2. **Frontmatter requires** `name` and `description`; `name` must match the CLI skill name.
3. **Skill names:** must match `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` — start with a letter, then lowercase letters, digits, and hyphen-separated segments (e.g. `my-skill`; not `1-skill` or `-foo`).
4. **Semver is strict `x.y.z`** (no pre-release tags).
5. **Prefer `bump` after content changes**; use `set-version` for exact targets or initial align.
6. **Never hand-edit `registry-lock.json`.**
7. **Do not invent MCP tools** for these ops in-session — shell the CLI.

## Command map

```bash
skf skill list [--all] [--json]
skf skill read <name> [--json]
skf skill write <name> [--set-version <semver>] [--tags a,b] [--installable true|false] \
  [--file <relpath>=<localpath>]... [--remove-file <relpath>]... [--skip-skill-md] [--json]
skf skill set-version <name> <semver> [--json]
skf skill bump <name> [--patch|--minor|--major] [--json]   # default --patch
skf skill delete <name> --yes [--json]
```

### Recipes

**Create (stdin body):**

```bash
skf skill write my-skill --set-version 0.1.0 --tags foo,bar --json <<'EOF'
---
name: my-skill
description: One-line description for activation.
---

# My Skill

Body...
EOF
```

**Create/update with files on disk:**

```bash
skf skill write my-skill --set-version 0.1.0 --json \
  --file SKILL.md=/tmp/my-skill.md \
  --file EXAMPLES.md=/tmp/examples.md \
  --file refs/notes.md=/tmp/notes.md
```

**Update SKILL.md only (keep version):**

```bash
skf skill write my-skill --json < /tmp/my-skill.md
# then usually:
skf skill bump my-skill --json
```

**Companions / tags / version without rewriting SKILL.md:**

```bash
skf skill write my-skill --skip-skill-md --file EXAMPLES.md=/tmp/ex.md --json
skf skill write my-skill --skip-skill-md --remove-file refs/old.md --json
skf skill set-version my-skill 0.2.0 --json
skf skill bump my-skill --minor --json
```

**Read then edit:**

```bash
skf skill read my-skill --json   # body + companions map + metadata
```

**Delete:**

```bash
skf skill delete my-skill --yes --json
```

## JSON contract

Success shapes include `action` and skill metadata. Failures always emit stdout JSON:

```json
{ "error": "..." }
```

After a **durable** mutation (files, registry, and/or lock already changed) when
registry validation then fails — on `write`, `delete`, `set-version`, and `bump`:

```json
{ "error": "...", "errors": ["..."], "warnings": ["..."], "partial": true }
```

`set-version` / `bump` also include `previousVersion` and `version` on that path.
Preflight / input errors (bad name, missing source, TTY stdin, etc.) emit
`{ "error": "..." }` **without** `partial` — nothing durable was committed.

**Rules for agents:**

1. Always `JSON.parse` stdout (do not rely on empty stdout on failure).
2. If `partial === true` after **write**: `skill read` the target (if it still exists), fix inputs, re-issue a full `skill write`. If the failure was registry-wide noise, fix that and run `skf validate`.
3. If `partial === true` after **set-version** / **bump**: the version change **did** land (and lock was rewritten). Do **not** re-issue write unless content is wrong. Fix the validation errors (often an unrelated broken skill), then `skf validate`. Use `previousVersion` / `version` in the payload to know what was applied.
4. If `partial === true` after **delete**: the skill dir/registry row were already removed. Fix remaining validation errors and `skf validate`; do not re-delete.
5. Treat `warnings` as non-fatal (e.g. `--remove-file` missing path).
6. `set-version` to the current version returns `action: "unchanged"`.

## Safety constraints (CLI-enforced)

- Companion paths must be relative (no `..`, no absolute destinations).
- Skill-root `SKILL.md` is reserved case-insensitively (`skill.md` ≡ `SKILL.md`).
- `--remove-file` cannot target `SKILL.md` or directories.
- `--file` and `--remove-file` cannot target the same path in one call.
- Duplicate `--file` / `--remove-file` targets are rejected.
- `read` / `delete` refuse registry paths that are not a strict child of `inventory/skills`.

## Workflow checklist

1. `skill list --json` or `skill read <name> --json` if updating
2. Stage SKILL.md (+ companions) to temp files if not piping stdin
3. `skill write ... --json` (include `--set-version` only when creating or intentionally setting)
4. `skill bump <name> --json` after a meaningful content change if version was not set in write
5. Confirm stdout `action` and that `partial` is absent
6. There is **no install step** in the authoring workflow — skill propagation is
   pull-based. Consumers (each repo with a `skill-forge.json`, and `$HOME`) pick
   up the new version on their next `skf sync`. To make a skill newly active
   somewhere, add it to that profile:

```bash
skf project add <name> && skf sync        # in a consumer repo
skf home add <name> && skf home sync      # machine-wide ($HOME profile)
```

   Per-tool global skill directories (`~/.codex/skills`, `~/.claude/skills`, …)
   are retired; never write skills there.

## Anti-patterns

| Wrong | Right |
|-------|--------|
| Edit `registry.json` skill version by hand | `set-version` / `bump` |
| Put `version:` in SKILL.md frontmatter | Registry only |
| `rm -rf inventory/skills/foo` + manual registry edit | `skill delete foo --yes` |
| `skf install --type skill --path ~/.codex/skills` (retired global dirs) | Consumers declare the skill in their profile and run `skf sync` |
| Ignore non-zero exit without reading stdout | Parse JSON error / `partial` |
| `--remove-file refs` to drop a tree | Remove each file path |
| Create without `--set-version` | Required on create |
| `install ... --yes` without `--path` (non-interactive hang) | Always pass `--path` + `--yes` |

## Related

- Repo README § `skill` subcommand — full prose reference
- `skf skill <cmd> --help` — flag-level detail
- Companion `EXAMPLES.md` — copy-paste command sequences
