# Parallel sessions and git worktrees

Portable process for **two agent sessions (or humans) editing the same child repo without sharing one working directory**. Feature-specific paths stay in the umbrella plan / local `SESSION.md` — not here.

## The layout: `work-*` worktrees inside the umbrella

The **umbrella folder is not a git repo**. Only **child repos** can have git worktrees. A parallel slice gets its own `git worktree` of the child it edits, placed **inside the umbrella** next to the primary checkouts, named `work-<slice>`:

```text
umbrella/                    # Main Dev and the other role sessions run here
  AGENTS.md  tasks/          # the umbrella ledger stays the one status SSOT
  child-be/                  # primary checkout (usually dev)
  child-fe/
  work-billing-be/           # git worktree of child-be, branch feature/billing
  work-billing-fe/           # git worktree of child-fe, same branch name
  work-feedback-p1/          # another slice, another worktree
```

| Thing | What it is | `git worktree remove`? |
|-------|------------|------------------------|
| Umbrella | Sibling-repos folder (usually not git) | n/a |
| Primary checkout | The child repo itself | n/a |
| `work-<slice>/` | `git worktree add` of one child, on the slice's branch | **Yes** |
| Copy | `node_modules`, a deploy tree, generated media inside a worktree | **No** — leftover after worktree remove |

- One worktree per child **per slice**. A slice touching two children gets two worktrees with the **same branch name** (`work-billing-be`, `work-billing-fe` on `feature/billing`).
- Several slices may run on one child at once — each in its own `work-*`.
- The prefix makes worktrees obvious in the umbrella listing and keeps them out of the child list in umbrella `AGENTS.md`.

A **branch** isolates commits after the fact. It does **not** isolate the working tree on disk. Two concurrent editors of the same child need **two working trees**.

Older material may mention a separate "feature umbrella" folder holding the worktrees. That layout is retired; worktrees live inside the umbrella, and the umbrella ledger stays the one status source.

## Create one

```bash
# from the umbrella
git -C child-be fetch
git -C child-be worktree add ../work-billing-be -b feature/billing
# or attach an existing branch:
# git -C child-be worktree add ../work-billing-be feature/billing

# claim it at once — see "Claim it in git"
git -C child-be worktree lock ../work-billing-be \
  --reason "slice=billing session=<slice session id> started-by=<Main Dev session id> 2026-11-07"

git -C child-be worktree list --verbose
```

- Create worktrees **only for children you will edit**.
- Worktrees do **not** share `node_modules`; install in each before tests.
- Worktrees must **not** share gitignored runtime state (SQLite, WAL, uploads, published assets) or **host ports** — see **Runtime state**.
- Run `skf sync` in the new worktree if the child declares skills: the worktree checks out the child's tracked `skill-forge.json`, but vendored folders are only as fresh as that commit.

## Session roots (hard rule)

| Session | Opens as its root |
|---------|-------------------|
| Main Dev and the other role sessions (`session-roles`) | the **umbrella** |
| A slice session | **only** its `work-<slice>/` folder |

Do **not** open a primary checkout and a worktree of the same child in one multi-root workspace and "hope" the agent picks correctly. A session "knows" its tree from its **working directory / git toplevel**, not from a global registry.

The root rule also leaves a record. An app session started with the worktree as its working folder is recorded with that path (and its transcript store is named after it), so "which session works in `work-billing-be`?" has an answer outside anyone's notes. A slice run from an umbrella session, or by an external worker, leaves no such record — which is why the lock note below names the session explicitly.

**A worktree session loads the child's tracked skills plus the home profile** (`~/.agents/skills`, `~/.claude/skills`, from `skf home`) — never the umbrella's own profile. So a skill every session of every product should have (`umbrella-workspace`, the `session-roles` / `role-*` set) belongs in the **home profile**, where worktree sessions get it for free. A skill that is genuinely specific to one umbrella is out of a worktree session's reach. When the slice needs it, give it through the **local overlay** in that worktree — `skf project add <skill> --overlay`, then `skf sync`: vendored and version-locked like any other skill, but untracked and kept out of git, so it is never committed into the child or merged with the branch. Never add it to the child's tracked `skill-forge.json` for one slice, and never hand-copy it. Name the overlay skills in `SESSION.md` too.

## Who owns a worktree: git first, the ledger second

The umbrella ledger is gitignored, and the umbrella is usually not a repository, so `tasks/todo.md` can be lost or go stale. Ownership therefore lives where it cannot drift from the worktree itself:

| Question | Source of truth |
|---|---|
| Which worktrees exist? | `git -C <child> worktree list` for each child — always right |
| Who claimed it, and when? | the **lock note**: `git -C <child> worktree list --verbose` |
| Which session is working in it? | the app's session record for that working folder (see *Session roots*), and the lock note |
| What state is the slice in? | the umbrella `tasks/todo.md` — a **status view** rebuildable from the three above |

### Claim it in git

When Main Dev creates a worktree it locks it with a reason naming the slice, the slice session, the session that started it, and the date:

```bash
git -C child-be worktree lock ../work-billing-be \
  --reason "slice=billing session=<id> started-by=<id> 2026-11-07"
```

The note lives exactly as long as the worktree, covers workers that are not app sessions (an external agent CLI), and blocks `git worktree prune` and a plain `git worktree remove`. **A `work-*` worktree with no lock note is unclaimed: ask the owner before touching it.** At session start Main Dev cross-checks `worktree list --verbose` for each child against the ledger and fixes the ledger, not the other way round.

## `SESSION.md` — the brief a worktree session reads first

A lock note says who; `SESSION.md` says how. It is the brief the session is told to read.

### 1. `SESSION.md` at the worktree root

Written fresh by Main Dev for each slice. It carries **only what git cannot**: the worktree path, branch, primary checkout and sibling worktrees all come from `git worktree list`, so do not repeat them — a copied value goes stale, a git answer does not.

- **Role** — which role this session plays (usually a delegated Main Dev for one slice).
- **Approvals** — what needs the owner's yes **in this session's own chat** (commit, migration, push). A relayed approval from the starting session does not count (`session-roles`).
- **Scope** — the paths it may edit, and the paths that are off-limits.
- **Runtime** — its own ports and the absolute path of its own database file.
- **Plan entry** — the umbrella `tasks/todo.md` section for this slice. The session reports status there (or to Main Dev), never into a copy of the ledger.
- **Hand back** — which session to message, and what "done" means (merged by Main Dev, not by the worker).
- **Overlay skills** — any skills given through `skf project add --overlay`, so the session knows they are there.

It sits inside the worktree, so it is also readable from the umbrella (`work-billing-be/SESSION.md`) when Main Dev checks on a slice.

Keep `SESSION.md` **untracked**: add it to the child's `info/exclude` (`git -C child-be rev-parse --git-path info/exclude`; that file is shared by every worktree of the repo, so one entry covers them all).

**Rewrite it for each new slice.** A `SESSION.md` copied from another worktree describes the wrong branch, scope and cleanup path — and is read with full trust. Observed on one project (2026-11-06): a worktree's `SESSION.md` still described a different slice's branch, scope and worktree path.

### 2. Load hooks — one in the umbrella, one in each child

Instruction files reach a worktree session by different paths per tool:

- **Claude Code** loads `CLAUDE.md` from the session folder **and every parent folder**, not `AGENTS.md` directly. A child with `AGENTS.md` but no `CLAUDE.md` contributes nothing, so a session rooted in `umbrella/work-billing-be` loads the home `CLAUDE.md` and the **umbrella's** `CLAUDE.md` (`@AGENTS.md`) — never the child's hook.
- **Codex, Grok** read the child's `AGENTS.md` at the worktree root.

So put the hook in **both** places. The umbrella hook reaches every in-umbrella worktree session through the parent folder — a benefit of keeping `work-*` inside the umbrella. (Alternatively give each child a `CLAUDE.md` containing `@AGENTS.md`.) Verify once per tool: start a session in a `work-*` folder and ask which instruction files it loaded.

In the **umbrella** `AGENTS.md`:

```markdown
## Worktree sessions

**If this session's root is a `work-*` folder with a `SESSION.md`, read that file at
session start** (or before the first edit). It is the slice brief: role, approvals,
scope, runtime and how to hand back. Ownership is the worktree's lock note
(`git worktree list --verbose`).
```

In each **child** repo's `AGENTS.md` (safe to merge — no-op when the file is absent):

```markdown
## Session ownership (worktree)

**If `SESSION.md` exists at this repo root, read it at session start**
(or before the first edit). It defines session ownership and off-limits paths.
If absent, ignore this section — normal primary-tree work.
```

`SESSION.md` is **not** auto-loaded by git or by the agent. It is read only when:

- AGENTS instructs the agent to open it and the agent complies, or
- the user `@`s it / the agent discovers it.

### 3. Umbrella `tasks/todo.md`

One line per active worktree in the slice's task block: path, branch, owning session id. It is the status view Main Dev and Ops read before restarting shared services or cleaning up — rebuilt from `worktree list --verbose` whenever the two disagree. Do not freeze worktree paths in umbrella `AGENTS.md`.

## Worktree vs copy

`git worktree list` is the only authority for what is a worktree. Nested extras (deploy, vendor, media) are **copies** unless that list names them.

- `git worktree remove` deletes the worktree directory and unregisters it. It does **not** delete copies elsewhere.
- Tool-created detached worktrees (for example under a child's `.claude/worktrees/`) are not slices. Remove them when leftover; do not treat them as a slice's checkout.

## Runtime state (one file, one port set per worktree)

Git isolates **source**. It does not isolate **gitignored** SQLite (or WAL/SHM), uploads, or published assets, and it does nothing about ports. Two trees that point `DB_PATH` (or equivalent) at the primary file share one live database: schema races, remediations stomping rows, WAL lock fights. Two dev servers on one port means one of them is not the tree you think you are testing.

**Rule:** each worktree that opens a local DB gets its **own** file under that worktree, seeded from a checkpointed copy:

```bash
mkdir -p work-billing-be/db_dev
sqlite3 child-be/db_dev/app.db ".backup 'work-billing-be/db_dev/app.db'"
```

Put the **absolute** path in that worktree's `.env` and its `SESSION.md`, together with its ports. A shared remote dev database is a shared environment: announce data-changing tests (`session-roles`). Tests that already use temp DBs stay isolated — leave them alone.

Published / generated content that is gitignored on purpose (packs, images, audio) is **data**, not a merge input. Recreate it on the target. Do not copy it from the worktree unless the user asks.

### What merges later

| Artifact | Merge? | How |
|----------|--------|-----|
| **Source + schema files** | **Yes** | Git-merge the branch (including migration / `init` schema files). After merge, apply pending schema **once** on the target env's database. |
| **Data** (`.db` + WAL, uploads, published assets) | **No** | Not a git merge. Default: discard with worktree remove. |
| **Specific rows you still want on primary** | **Optional, explicit** | Re-run the script/gate on the target DB, or `sqlite3 .backup` **replace** while nothing has the target open. |

## What does not enforce isolation

- Branch name alone
- A worktree with no lock note — nobody has claimed it, whatever the ledger says
- `SESSION.md` without AGENTS (or user) causing a read — or a `SESSION.md` left over from another slice
- Two sessions both opened on the primary checkout
- Assuming a worktree session has the umbrella's skills or ledger
- Two worktrees / processes pointing `DB_PATH` at the **same** SQLite file, or binding the same port
- Assuming "we will merge the databases" (or published assets) when the branch merges

## When you do **not** need a worktree

- Plan/docs only under the umbrella (often not a git repo)
- The other session finished and the primary checkout is free — a branch **in place** is enough
- Single session implementing the feature

## Checklist (seed a slice)

1. [ ] Confirm another session owns the primary checkout(s), or that you need parallel slices
2. [ ] `git worktree add` each child to edit as `umbrella/work-<slice>`; shared branch name; `git worktree lock --reason "slice=… session=… started-by=… <date>"` each one
3. [ ] `skf sync` in each new worktree whose child declares skills; add any umbrella-only skill the slice needs with `skf project add <skill> --overlay` + `skf sync` (untracked)
4. [ ] Own DB file and ports: seed the DB, set the worktree `.env`
5. [ ] Write a **fresh** `SESSION.md` in each worktree (role, approvals, scope, runtime, plan entry, hand back, overlay skills — nothing git already says); confirm it is in `info/exclude`
6. [ ] The "read SESSION.md" hook is in the **umbrella** `AGENTS.md` (reaches Claude Code) and the child `AGENTS.md` (reaches Codex, Grok)
7. [ ] One line per worktree in the umbrella `tasks/todo.md` slice block, matching the lock note
8. [ ] Start the slice session with its root = the `work-<slice>/` folder only, and a brief that points at `SESSION.md`

## Retire on the primary

When the slice is done, work resumes in the umbrella and the primary checkouts.

1. **Hand back** — the slice session reports to Main Dev with what is built, what is not, and its gate evidence. Status lands in the umbrella `tasks/todo.md`.
2. **Stop** the worktree's servers and anything holding its DB.
3. **Merge code** into the primary branch **from the primary checkout** (`git merge feature/…` while on that branch), with the owner's approval in Main Dev's chat. Do **not** check the feature branch out on the primary while a worktree still holds it.
4. **Re-apply data on the target** — schema on the primary database; republish / sync gitignored assets. Do **not** copy worktree SQLite, audio, or published files unless the user asks.
5. **Cleanup** (after anything the worktree still uniquely holds has been recreated on the target). Clear any overlay first — `git worktree remove` runs no skf code, so its block in the shared `info/exclude` would outlive the worktree:

```bash
(cd work-billing-be && skf project overlay --clear)   # only if the slice had an overlay
git -C child-be worktree unlock ../work-billing-be
git -C child-fe worktree unlock ../work-billing-fe
git -C child-be worktree remove ../work-billing-be
git -C child-fe worktree remove ../work-billing-fe
git -C child-be worktree list   # no work-billing paths
```

If `worktree remove` refuses (dirty tree), stop processes and retry; `--force` only after merge when the worktree's data is disposable.

6. **Do not touch** unrelated `work-*` worktrees or other sessions' leftovers you were not asked to remove.
7. **Close out**: remove the worktree lines from the slice's task block, archive the task, and archive the slice session.

Optional: delete the local feature branch after it is merged. Keep it until the merge is on the intended primary branch.
