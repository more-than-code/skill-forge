---
name: testing-strategy
description: >
  Verify test coverage, test quality, and edge case identification. Activate during
  Tier 2/3 test coverage review lens, when writing specs that define test strategy,
  or when adding tests to code with no existing coverage.
---

# Testing Strategy

## Checklist

### Coverage
- [ ] Happy path tested
- [ ] Edge cases: empty input, null, max/min, boundary conditions
- [ ] Error paths: invalid input, missing resources, timeouts, permission denied
- [ ] Integration points: API calls, DB queries, file I/O, external services
- [ ] Regression test for every bug fix (fails on old code, passes on new)

### Quality
- [ ] Tests independent — no shared mutable state, no order dependency
- [ ] Tests deterministic — same result every run
- [ ] Tests fast — unit <100ms, integration <5s
- [ ] Test names describe scenario and expected outcome
- [ ] Tests verify behavior, not implementation
- [ ] Each test asserts one concept

### Structure
- [ ] Arrange-Act-Assert pattern
- [ ] Test data explicit in the test — no hidden fixtures
- [ ] Mocks only at boundaries (external services, I/O)

## Gotchas

- Mocking the database hides schema drift — if your tests mock DB calls, a column rename or migration can pass tests but break production. Use a real test database for integration tests.
- `assert result is not None` proves nothing. Test that the *value* traces to the source, not just that it exists.
- Flaky tests that "pass on retry" mask real race conditions. Fix or delete — never ignore.
- Time-dependent tests that pass locally fail in CI if the timezone differs. Always use UTC or freeze time.
- Tests that share mutable state via class variables or module globals produce order-dependent results that only fail when run in isolation.

## Patterns

### When tests don't exist
- Tier 1: Add at least one targeted test. If not feasible, document why.
- Tier 2/3: Tests required. No exceptions.

### Trace verification
When outputs derive from sources, test the traceability:
- Every output value should trace back to a source input with evidence
- Test that derived artifacts are consistent with each other
- Regression diff: compare before/after with explicit change counts — not just "tests pass"

## Validation Loop

After writing tests:
1. Run the test suite — confirm new tests pass
2. Intentionally break the code the tests cover — confirm they fail
3. If a test still passes on broken code, it's testing structure not behavior. Rewrite.
4. Restore the code and re-run to confirm green

## Anti-Patterns

- **Testing implementation** — test outputs, not method calls.
- **Giant fixtures** — 50 lines setup, 1 line assertion → break it down.
- **Coverage as a goal** — 100% bad tests < 60% good tests.
- **Shape-only validation** — verifying output structure without checking that values trace to their source. Structurally correct but semantically wrong is the hardest bug to find.
