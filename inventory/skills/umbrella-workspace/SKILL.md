---
name: umbrella-workspace
description: >
  Cooperation rules for multi-repo (umbrella) workspaces: where docs and tasks live,
  self-contained task entries, pointer stubs in child repos, handoff checklists, and
  plan-vs-status split. Use when working in a multi-repo container directory, starting
  or resuming cross-repo plans, writing umbrella tasks/todo.md, adding pointer stubs,
  or when the user mentions umbrella workspace, cross-repo handoff, or multi-repo
  cooperation. Slash: /umbrella-workspace.
---

# Umbrella workspace cooperation

An **umbrella workspace** is a directory that contains sibling git repos (children) but is usually **not** a git repo itself. Cross-repo work needs one place for plans and live status so agents and sessions can hand off without chat history.

This skill is **portable**. Each workspace keeps a thin project `AGENTS.md` (or equivalent) with: child-repo inventory, absolute path to **that** umbrella’s `tasks/todo.md`, and product-specific examples. Do not put those paths in this skill.

## Where things live

**Per child repo, always:**
- `tasks/` (`todo.md`, `archive.md`, `lessons.md`) — work scoped to that repo only
- `docs/` — that repo’s own architecture, features, contracts

Do **not** put single-repo work in the umbrella `tasks/` or `docs/`.

**Umbrella only for cross-repo concerns:**
- `docs/` — specs/plans whose scope spans **more than one** child repo (service splits, contract migrations, shared schema, multi-repo cutovers)
- `tasks/` (`todo.md`, `archive.md`) — live status for those same efforts (Tier 3 tracking, gates, approvals)

**Rule of thumb:** if the work is fully executable from one repo’s files alone, track it in that repo. If correct planning/execution needs **≥2 repos**, the plan and status live at the umbrella and reference children by path.

## Task entries must be self-contained

Agents and later sessions have **no memory** of the conversation that created a task — only what is written in `tasks/`. Every umbrella (and per-repo) entry must be resumable cold:

1. **Goal** — one sentence, what “done” means
2. **Spec reference** — exact doc path (+ section/heading if needed), not “the plan we discussed”
3. **Key files** — exact paths (and line anchors when useful)
4. **Current status** — not started / in progress / blocked / complete, **dated**; say what’s done and what’s left
5. **Dependencies** — which other tasks/phases must be green first (explicit, not list order)
6. **Gate / acceptance check** — exact commands or manual checks for **this** slice
7. **Blockers, if any** — specific open question; never leave “blocked” without on what

**Multi-phase plans:** one task section per phase/milestone, not one blob for the whole initiative.

## Discoverability: pointer stubs in affected repos

When a cross-repo plan will modify a child repo, add a **pointer stub** to that repo’s `tasks/todo.md` so an agent opened **only** in the child still finds the work:

```markdown
## [Cross-repo] <plan title> — see umbrella tasks/todo.md
**Status:** tracked at umbrella level, not here.
This repo is a participant in a cross-repo plan: `<path to plan doc from umbrella or relative>`.
Live status/phase tracking: `<absolute path to umbrella tasks/todo.md>`.
Do not duplicate status here — update it at the umbrella level only.
```

**Single source of truth:** status lives **only** in umbrella `tasks/todo.md`. Stubs link; they never carry their own status (avoids drift).

## Handoff checklist (end of session on cross-repo work)

- [ ] Umbrella `tasks/todo.md` phase entry matches reality (not stale)
- [ ] Every repo touched has a pointer stub (add once; don’t re-add)
- [ ] Completed phases: status complete + gate evidence, or moved to `tasks/archive.md` with `**Archived:** YYYY-MM-DD`
- [ ] Spec divergences written back into the plan doc, not only in chat

## Cross-repo plan implementer protocol

Plan docs keep **only** plan-specific key files, phase gates, and restricted ops. Cooperation mechanics are this skill + the workspace `AGENTS.md` inventory:

1. **Status** — umbrella `tasks/todo.md`, one section per phase; archive completed phases
2. **Discoverability** — pointer stubs in each affected child
3. **Self-contained entries** — seven fields above
4. **Gates** — project/global gate rules after every implementation batch; evidence in the phase section
5. **Divergence** — stop, update the plan doc, re-approve if material (Tier 3)
6. **Restricted ops** — explicit user confirmation for `git init`, deletes, commit/push, prod deploy, destructive commands

## Scaffold (new umbrella)

```text
umbrella/                 # usually not a git repo
  AGENTS.md               # child inventory + path to this umbrella’s tasks/todo.md
  CLAUDE.md               # @AGENTS.md (if using Claude)
  docs/                   # multi-repo plans only
  tasks/
    todo.md
    archive.md
  child-a/                # each child its own git repo when ready
    AGENTS.md
    tasks/todo.md         # pointer stubs when participating
  child-b/
    ...
```

## Anti-patterns

- Duplicating live status in both umbrella and child `todo.md`
- One giant “in progress” section for a multi-phase plan
- Plan-only docs with no umbrella task tracking for Tier 3 work
- Putting single-repo bugs/features in umbrella `tasks/`
- Assuming the next agent has chat context

## Related

- Global agent process: risk tiers, mandatory gates, `tasks/` format (§13 style) — already in core instructions
- Project skills stay in each child for stack-specific conventions; this skill is only multi-repo cooperation
