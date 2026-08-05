---
name: coding-discipline
description: >
  Behavioral guardrails against common LLM coding pitfalls: overengineering, hidden
  assumptions, drive-by edits, vague execution, and post-hoc documentation. Activate on
  all implementation tasks alongside security-baseline. Derived from Andrej Karpathy's
  observations on LLM coding failure modes.
---

# Coding Discipline

Behavioral guidelines to reduce common LLM coding mistakes. These address failure modes where the code is not technically wrong but is overcomplicated, assumes too much, changes more than it should, or leaves product/API docs to a later commit.

Use this skill as part of the default implementation-time skill set defined in the core agent instructions. It should be active before writing code on every implementation task, alongside `security-baseline` and `code-quality`.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks (typo fixes, obvious one-liners), use judgment.

## Related Skills

- `code-quality` — Default maintainability and readability guardrails used during implementation and review
- `testing-strategy` — Test-first verification patterns
- `EXAMPLES.md` — Before/after examples kept beside this skill so they travel with the copied package

## Checklist

### Before Writing Code
- [ ] Assumptions stated explicitly — nothing guessed silently
- [ ] Ambiguous requests clarified — multiple interpretations presented, not picked silently
- [ ] Simplest viable approach identified — pushed back if a simpler way exists
- [ ] Success criteria defined and verifiable — not "make it work"
- [ ] **Owning docs identified** when the change will alter contracts, UX flows, tool surfaces, or architecture (repo `docs/`, API contract, glossary, skill-facing narrative) — or explicitly N/A for pure internals

### During Implementation
- [ ] Every changed line traces to the request
- [ ] Artifact-level simplicity, complexity, and readability checks applied from `code-quality` (activated alongside this skill)
- [ ] **Docs co-authored with code** when owning docs apply — edit narrative in the same work batch as the implementation, not after the user asks "did you update docs?"

### After Implementation (before claiming done or committing)
- [ ] Orphaned imports/variables from YOUR changes cleaned up
- [ ] Pre-existing dead code left alone (mentioned, not deleted)
- [ ] Existing code style matched (quotes, spacing, naming)
- [ ] No drive-by improvements to adjacent code
- [ ] **Doc co-delivery check** (below) — required docs are already in the working tree with the code

### Before Any User-Requested Commit
- [ ] If the change set required docs, **those doc files are staged with the code** in the same per-intent commit
- [ ] Commit message covers behavior **and** doc surface when both changed
- [ ] No "code commit now, docs later" split for the same intent

## Documentation co-delivery (HARD)

Owning documentation is part of the implementation unit whenever behavior is load-bearing for humans or other agents.

### When docs are required (non-exhaustive)

- Public or chat-facing **contracts** (API fields, tool result shapes, CLI)
- User-visible **flows** (composer panels, inventoring, recap, nav)
- Agent/tool **harness** narrative (`agentic-chat`, skills that describe tools)
- Cross-repo **glossary / naming** when terms or inventory units change
- Architecture or design decisions that future agents must not re-discover from code alone

### When docs are N/A

- Pure internal refactors with identical external behavior
- Typos, log lines, private helpers with no contract/UX change
- State N/A briefly if asked; do not invent doc churn

### Rules

1. **Same work batch as code.** Update owning docs while implementing (or in the same continuous session before "done"), not as a follow-up commit after the user notices drift.
2. **Same commit as code** when the user asks to commit that intent. Do not land code-only commits and a later docs-only commit for the same feature/fix unless the user explicitly asks to split.
3. **Identify owners first.** Prefer the repo's documented SSOT (e.g. `docs/agentic-chat.md`, API contract, `docs/README.md` index, umbrella glossary). Touch only docs that must stay true.
4. **No ceremony dumps.** Short, surgical doc edits that match the code delta. No unsolicited README novels.
5. **Multi-repo:** each child repo that changes contracts/UX updates its own docs in that repo's commit; umbrella glossary only when shared naming/behavior changes.
6. **Commit gate:** if docs were required and are missing from the staged set, **stop**, add them, then commit. Never answer "I'll document next" after a code commit for the same intent.

## Patterns

### Assumption Surfacing

When a request is ambiguous, surface assumptions before implementing:

```
Before implementing, I need to clarify:

1. **Scope**: [what's unclear about scope]
2. **Format**: [what's unclear about approach]
3. **Constraints**: [what's unclear about boundaries]

Simplest approach: [your recommendation]
What's your preference?
```

### Goal Transformation

Transform vague requests into verifiable goals:

| Instead of... | Transform to... |
|--------------|-----------------|
| "Add validation" | "Write tests for invalid inputs, then make them pass" |
| "Fix the bug" | "Write a test that reproduces it, then make it pass" |
| "Refactor X" | "Ensure tests pass before and after" |
| "Make it faster" | "Measure current perf, set target, verify after change" |

### Incremental Verification

For multi-step tasks, verify at each step:

```
1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
3. [Step] -> verify: [check]
```

Each step is independently verifiable. Don't batch all verification to the end.

### Docs-with-code batch

```
1. Implement behavior + tests
2. Update owning docs in the same tree (same session)
3. Only then claim complete / accept "commit" for that intent
```

## Verification

- [ ] Diff review: every changed line traces to the request (no drive-by edits)
- [ ] Complexity check: would a senior engineer say this is overcomplicated?
- [ ] Style check: existing conventions preserved (quotes, spacing, patterns)
- [ ] Orphan check: only YOUR orphans cleaned up, pre-existing dead code untouched
- [ ] Doc co-delivery: required docs present with code (or N/A stated)

## Anti-Patterns

Artifact-level anti-patterns (over-abstraction, speculative features, over-parameterization) are owned by `code-quality`. Worked before/after examples for all of them live in `EXAMPLES.md` beside this skill.

### Drive-By Refactoring
**Wrong:** While fixing an empty-email crash, also add username validation, change comments, add docstrings, and "improve" email validation.
**Right:** Fix only the lines that handle empty emails. Mention other issues separately.

### Style Drift
**Wrong:** While adding logging to a function, also change single quotes to double quotes, add type hints, add a docstring, and reformat boolean returns.
**Right:** Add only the logging lines. Match existing quote style, spacing, and patterns.

### Hidden Assumptions
**Wrong:** "Add a feature to export user data" -> immediately implement JSON + CSV export to local files with hardcoded fields.
**Right:** Ask about scope (all users?), format (file download? API endpoint?), fields (which ones? sensitive data?), and volume (pagination needed?).

### Post-Commit Documentation
**Wrong:** Ship code + tests, commit when asked, then update docs only after the user asks "did you update the docs?"
**Right:** Treat owning docs as part of the implementation unit; stage them with the code in the same intent commit.
