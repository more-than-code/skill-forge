# Parallel sessions and git worktrees

Portable process for **two agent sessions (or humans) editing the same child repo without sharing one working directory**. Feature-specific paths stay in the umbrella plan / local `SESSION.md` — not here.

## Problem

| Layer | Same folder, two sessions |
|-------|---------------------------|
| Git **branch** | Isolates commits after the fact |
| **Working tree** (files on disk) | Shared — both rewrite the same files; checkout/pull races |

**A branch alone is not session isolation.** Two concurrent editors need **two working trees**.

## Prefer worktrees over a second full umbrella clone

```bash
# From the primary child checkout (e.g. umbrella/child-a)
git fetch
git worktree add /path/to/sibling-worktree -b feature/my-slice
# or attach an existing branch:
# git worktree add /path/to/sibling-worktree feature/my-slice

git worktree list
# remove when done:
# git worktree remove /path/to/sibling-worktree
```

- Create worktrees **only for children you will edit** (not every sibling under the umbrella).
- Place them as **siblings of the umbrella** or another clear path — not nested inside the primary checkout.
- Use the **same branch name** across related children (e.g. backend + webapp both `feature/…`) for handoff clarity.
- Worktrees do **not** share `node_modules`; run install in each tree before tests.

## Session roots (hard rule)

| Session role | Open as workspace |
|--------------|-------------------|
| General / other feature | Primary umbrella (and its in-tree children) |
| Parallel feature | **Only** that feature’s worktree path(s) |

Do **not** open both the primary child path and the worktree for the same feature in one multi-root workspace and “hope” the agent picks correctly.

A session “knows” its tree from **workspace CWD / git toplevel**, not from a global registry.

## Markers and AGENTS hooks (soft enforcement)

Nothing locks a folder. Soft signals only:

### 1. `SESSION.md` at worktree root (recommended)

Local ownership note: owner session purpose, branch, primary paths that are off-limits, sibling worktrees, plan SSOT path, cleanup command.

Optional: add `SESSION.md` to that repo’s **`.git/info/exclude`** (shared by all worktrees of the repo) so the marker stays **untracked** and never commits.

### 2. Child `AGENTS.md` load hook

In each child repo’s `AGENTS.md` (safe to merge — no-op when the file is absent):

```markdown
## Session ownership (worktree)

**If `SESSION.md` exists at this repo root, read it at session start**
(or before the first edit). It defines session ownership and off-limits paths.
If absent, ignore this section — normal primary-tree work.
```

`SESSION.md` is **not** auto-loaded by git. It is read only when:

- AGENTS instructs the agent to open it and the agent complies, or  
- the user `@`s it / the agent discovers it.

### 3. Umbrella `AGENTS.md` pointer

Thin project note: “parallel sessions use this skill § worktrees; feature-specific paths live in the relevant plan / `SESSION.md`.” Do **not** paste long process here or freeze ephemeral worktree paths in AGENTS forever.

### 4. Feature plan (optional)

Concrete absolute paths and branch names for **this** initiative — ephemeral until cleaned up.

## What does not enforce isolation

- Branch name alone  
- `SESSION.md` without AGENTS (or user) causing a read  
- Two sessions both opened on the umbrella primary trees  
- Assuming agents see sibling worktrees automatically  

## When you do **not** need a worktree

- Plan/docs only under the umbrella (often not a git repo)  
- Other session finished; primary tree is free — branch **in place** is enough  
- Single session implementing the feature  

## Checklist (seed a parallel feature)

1. [ ] Confirm other session owns the primary child checkout(s)  
2. [ ] `git worktree add` for each child to edit; shared branch name  
3. [ ] Write worktree `SESSION.md`; optional `.git/info/exclude`  
4. [ ] Ensure child `AGENTS.md` has the “if SESSION.md exists, read it” hook  
5. [ ] Open the **new session** with workspace root(s) = worktree path(s) only  
6. [ ] Record concrete paths in the feature plan if useful  
7. [ ] When done: merge branch as usual; `git worktree remove`  
