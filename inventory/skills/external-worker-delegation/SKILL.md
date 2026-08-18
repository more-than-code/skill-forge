---
name: external-worker-delegation
description: >
  Run an external agent CLI as the worker for most of a task — planning, implementation,
  validation, review — while the primary agent shrinks to orchestrator and reviewer of record.
  Covers the cost asymmetry that motivates it, the mode switch off in-harness subagents, worktree
  isolation, per-phase brief structure, the acceptance ladder, independent review in a fresh
  worker session, and dual-budget accounting. Activate when delegating bulk work to a cheaper or
  faster external agent, when the primary's token budget is the binding constraint, when deciding
  what an orchestrator must keep versus hand off, or when reviewing work the primary did not watch
  get written.
---

# External Worker Delegation

An **external worker** is a separate agent process — its own context, its own sandbox, its own
budget. This skill is the method for making it do the bulk of a task while the primary agent stays
thin. Process mechanics (spawning, streaming, resuming, sandbox limits) belong to the worker CLI's
transport skill, e.g. `grok-build-harness`.

**When it pays:** the worker is materially cheaper or faster than the primary, *and* the primary's
own spend is a binding constraint. Absent the asymmetry, in-harness subagents are simpler and
strictly better — they share the filesystem, permission model, and context.

**When it does not:** tasks whose cost is dominated by judgment rather than production —
architecture decisions, ambiguous requirements, security-sensitive design. Those are what the
primary's intelligence is for; delegating them spends the cheap budget to produce work the
expensive budget must redo.

## The economics decide the architecture

The temptation is to delegate the labor and then have the primary read all of it. That spends
premium tokens on the highest-volume activity in the task and cancels the arbitrage. **Primary
tokens go to decisions, never to volume — including the volume of reading.**

Two consequences run through everything below:

1. The **brief** is where premium intelligence is worth full price. It is short, and a good one
   collapses worker iterations. Front-load it.
2. **Acceptance is a funnel**, ordered cheapest-first, and the primary is its last and narrowest
   stage.

## Mode switch

While an external worker is engaged, delegate every phase to it — exploration, planning,
implementation, validation, review. **Do not also spawn in-harness subagents for that work.**
In-harness helpers bill to the primary's wallet; routing review to a "cheap" in-harness reviewer
spends exactly the budget the pattern protects.

Two things stay with the orchestrator:

| Stays | Why |
|-------|-----|
| Deterministic gates (§5) | The evidence block must be reproducible in the orchestrator's own shell. A worker gate run is triage, not evidence. |
| Acceptance (§6 lenses) | The orchestrator is reviewer of record even when a worker session ran the lens. |

## Isolate the worker's writes

The worker's intermediate steps are unobservable, so bound what it can touch:

```bash
git worktree add ../work-<task> -b worker/<task>
```

Dispatch with that as cwd. The orchestrator reviews the branch and merges. This satisfies the
verify-write-scope rule without needing to watch the worker, and makes rejection free — delete the
branch.

Pre-build the environment before dispatch (dependencies installed, toolchains verified). Worker
sandboxes commonly cannot write to package caches, and a worker that burns its run fighting a
scaffolder produces nothing. The transport skill covers the specifics.

## Briefs, per phase

Every brief is a **file in the working directory**, never a prompt argument. The worker starts
cold: no shared conversation, no prior turns. Reference nothing it cannot read.

Universal sections:

1. **Facts** — what the system actually is.
2. **Decisions already made** — a table, marked do-not-relitigate.
3. **Environment** — what is pre-installed, what it must not run or re-scaffold.
4. **Deliverables** — concrete and checkable.
5. **Honesty constraints** — what it must not invent. Agents fill gaps with plausible fabrication
   unless forbidden.
6. **`NOTES.md` requirement** — decisions made, departures and why, what it could not verify, what
   a human must do next.

What each phase adds, and what it must return:

| Phase | Brief adds | Returns |
|-------|-----------|---------|
| Explore | The specific questions; scope boundaries | Findings with file:line references, no recommendations |
| Plan | Constraints and rejected options | Spec shape: goal, changes, contracts preserved, numbered acceptance criteria, verification gates |
| Implement | The approved spec verbatim | Working tree on its branch + `NOTES.md` |
| Validate | Exact commands and cwd | Command, exit code, output excerpts — as **triage** |
| Review | The diff, one lens, the severity scale | Findings: severity, location, reasoning, suggested fix |

One lens per session. A brief asking for "a review" returns a summary; a brief naming the lens and
the severity scale returns findings the orchestrator can act on without re-reading the diff.

## Independent review

**A session that authored work cannot review it.** It shares the author's blind spots and defends
its own claims. Start a fresh worker session — no conversation resume — and give it the diff and
the lens, not the authoring context. Independence is preserved and the cost stays off the primary.

## The acceptance ladder

Run in order. Each rung rejects work before a more expensive rung reads it.

1. **Deterministic gates** — build, test, lint, artifact diffs. Zero tokens. Rejects most bad work
   before any model reads anything. Failures go straight back to the worker with the output.
2. **`NOTES.md` + diffstat** — a cheap read. Departures from the brief, unverified claims, and an
   implausible diff size are all visible here. This is the highest signal per token in the loop.
3. **Worker-run lens passes** — §6 lenses, fresh sessions, on the worker's budget.
4. **Primary adjudication** — spec conformance, architecture, and disputed or critical findings
   only.

Rung 4 is the floor on primary spend. If it keeps growing, the brief was underspecified — fix the
brief, not the review.

**Verification never fully delegates.** A worker's gate run tells you where to look; the §5.2
evidence block is produced by the orchestrator re-running the gates in its own shell.

## Cost accounting

Track both sides, per task:

- **Worker** — accumulate the per-run cost the transport reports across all iterations, including
  rejected ones.
- **Primary** — tokens spent on brief, adjudication, and re-dispatch.

The metric that matters is **primary tokens per accepted artifact**. Worker cost falling while
primary cost rises means the funnel is leaking: work is being redone at the top.

Unattended driver loops are where budget disappears — a cheap worker going the wrong direction for
25 minutes is still 25 minutes of spend and a rejected branch. Loop break conditions must test
artifacts on disk, never the worker's claim of completion.

## Anti-patterns

| Wrong | Right |
|-------|-------|
| Delegate labor, then have the primary read all output | Acceptance ladder; primary reads findings, not diffs |
| Spawn in-harness reviewers "because they're cheap" | They bill to the primary; use fresh worker sessions |
| Same session writes and reviews | Fresh session, diff + lens only |
| Worker writes to the primary working tree | Dedicated worktree/branch the orchestrator merges |
| Accept the worker's verification as §5 evidence | Re-run gates in the orchestrator's shell |
| A brief that references prior conversation | Self-contained file in the working directory |
| Thin brief, iterate to converge | Front-load the brief; iteration costs primary tokens |
| Delegate architecture and ambiguous requirements | Keep judgment work; delegate production work |
| Loop until the worker says it is done | Loop until artifacts exist and gates pass |
