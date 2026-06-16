# Examples

Concrete examples of the Karpathy-derived behavioral rules used in this repo. These are for maintainers and reviewers: the goal is to show what bad agent behavior looks like and what a disciplined response looks like instead.

---

## 1. Think Before Coding

### Example: Hidden Assumptions

**User request:** "Add a feature to export user data"

**Bad response**
- Assumes export means all users
- Assumes file output instead of an API or UI download
- Assumes safe fields without checking privacy or volume

**Better response**
```text
Before implementing, I need to clarify:

1. Scope: all users or a filtered subset?
2. Format: API response, file download, or background job?
3. Fields: which fields are required, and are any sensitive?
4. Volume: does this need pagination or batching?

Simplest approach: start with a paginated JSON API once scope is confirmed.
```

### Example: Multiple Interpretations

**User request:** "Make search faster"

**Bad response**
- Silently picks one meaning of "faster"
- Adds caching, indexes, and async code in one pass

**Better response**
```text
"Faster" could mean lower latency, higher throughput, or better perceived UX.
Current behavior should be measured first, then optimize the dimension that matters.
```

---

## 2. Simplicity First

### Example: Over-Abstraction

**User request:** "Add a function to calculate discount"

**Bad response**
- Adds strategy interfaces, config objects, and multiple classes for a single formula

**Better response**
```python
def calculate_discount(amount: float, percent: float) -> float:
    return amount * (percent / 100)
```

Add abstraction later only if multiple discount behaviors actually appear.

### Example: Speculative Features

**User request:** "Save user preferences to the database"

**Bad response**
- Adds merge flags, validation toggles, notifications, and caching

**Better response**
```python
def save_preferences(db, user_id: int, preferences: dict) -> None:
    db.execute(
        "UPDATE users SET preferences = ? WHERE id = ?",
        (json.dumps(preferences), user_id),
    )
```

---

## 3. Surgical Changes

### Example: Drive-By Refactoring

**User request:** "Fix the bug where empty emails crash validation"

**Bad response**
- Fixes the email bug
- Changes comments and quote style
- Adds username validation and new docstrings

**Better response**
- Fix only empty-email handling
- Keep unrelated validation logic unchanged
- Mention adjacent issues separately instead of changing them

### Example: Style Drift

**User request:** "Add logging to this function"

**Bad response**
- Adds logging
- Converts single quotes to double quotes
- Adds type hints and reformats nearby code

**Better response**
- Add only the logging lines
- Match the surrounding code style exactly

---

## 4. Goal-Driven Execution

### Example: Bug Fix

**User request:** "Fix the crash when payload is missing `email`"

**Bad response**
- Edits production code first
- Declares success after manual inspection

**Better response**
```text
1. Write a test that reproduces the crash.
2. Run it and confirm it fails on current code.
3. Fix the root cause.
4. Re-run the new test and relevant existing tests.
```

### Example: Refactor

**User request:** "Refactor the parser"

**Bad response**
- Rewrites the parser without defining what must stay the same

**Better response**
```text
Goal: improve readability while preserving inputs, outputs, and error behavior.
Verify: existing parser tests pass before and after the refactor.
```
