---
name: coding-discipline
description: >
  Behavioral guardrails against common LLM coding pitfalls: overengineering, hidden
  assumptions, drive-by edits, and vague execution. Activate on all implementation
  tasks alongside security-baseline. Derived from Andrej Karpathy's observations on
  LLM coding failure modes.
---

# Coding Discipline

Behavioral guidelines to reduce common LLM coding mistakes. These address failure modes where the code is not technically wrong but is overcomplicated, assumes too much, or changes more than it should.

Use this skill as part of the default implementation-time skill set in `AGENTS.md`. It should be active before writing code on every implementation task, alongside `security-baseline` and `code-quality`.

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

### During Implementation
- [ ] No features beyond what was asked
- [ ] No abstractions for single-use code
- [ ] No error handling for impossible scenarios
- [ ] Code length proportional to problem complexity
- [ ] Control flow straightforward — easy for a human to trace without jumping across too many layers
- [ ] Every changed line traces to the request

### After Implementation
- [ ] Orphaned imports/variables from YOUR changes cleaned up
- [ ] Pre-existing dead code left alone (mentioned, not deleted)
- [ ] Existing code style matched (quotes, spacing, naming)
- [ ] No drive-by improvements to adjacent code

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

## Verification

- [ ] Diff review: every changed line traces to the request (no drive-by edits)
- [ ] Complexity check: would a senior engineer say this is overcomplicated?
- [ ] Style check: existing conventions preserved (quotes, spacing, patterns)
- [ ] Orphan check: only YOUR orphans cleaned up, pre-existing dead code untouched

## Anti-Patterns

### Over-Abstraction
**Wrong:** Strategy pattern with abstract base class, two concrete implementations, a config dataclass, and a calculator class — for a single discount calculation.
**Right:** One function: `calculate_discount(amount, percent)`. Add complexity when you actually need multiple discount types.

### Speculative Features
**Wrong:** `save_preferences(db, user_id, prefs, merge=True, validate=True, notify=False)` with caching, validation, and notification systems — when the request was "save user preferences."
**Right:** `save_preferences(db, user_id, preferences)` — one function, one job. Add caching when performance matters, validation when bad data appears.

### Drive-By Refactoring
**Wrong:** While fixing an empty-email crash, also add username validation, change comments, add docstrings, and "improve" email validation.
**Right:** Fix only the lines that handle empty emails. Mention other issues separately.

### Style Drift
**Wrong:** While adding logging to a function, also change single quotes to double quotes, add type hints, add a docstring, and reformat boolean returns.
**Right:** Add only the logging lines. Match existing quote style, spacing, and patterns.

### Hidden Assumptions
**Wrong:** "Add a feature to export user data" -> immediately implement JSON + CSV export to local files with hardcoded fields.
**Right:** Ask about scope (all users?), format (file download? API endpoint?), fields (which ones? sensitive data?), and volume (pagination needed?).
