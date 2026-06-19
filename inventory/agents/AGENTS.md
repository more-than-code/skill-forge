# AGENTS.md (Spec-Driven, Risk-Tiered, Skills-Compatible)

This file defines **how** agents operate — process, workflow, and safety boundaries.

Domain expertise is packaged as Agent Skills in global and project-local skill directories. This file references them by name.

### Skill Activation Protocol
1. **Discovery:** At session start, scan skill metadata only. Do not load full skill bodies during discovery.
2. **Discovery paths:**
   - Global shared skills: `~/.codex/skills/*/SKILL.md`
   - Global system skills: `~/.codex/skills/.system/*/SKILL.md`
   - Project-local skills: `.agents/skills/*/SKILL.md`
   - Repository custom skill inventory: `inventory/skills/*/SKILL.md` only when the current repository is a skill registry and the task is to create, review, edit, install, or explicitly use that skill. Treat inventory custom skills as repository artifacts, not automatically activated agent skills.
3. **Metadata load:** Read frontmatter (`name`, `description`, and small metadata fields) only. These fields decide activation.
4. **Precedence and duplicates:**
   - Resolve same-name skills in this order:
     1. `.agents/skills/<name>/SKILL.md` for project-local overrides.
     2. `inventory/skills/<name>/SKILL.md` only when the current repository is a skill registry and the task is to create, review, edit, install, or explicitly use that skill.
     3. `~/.codex/skills/<name>/SKILL.md` for global shared skills.
     4. `~/.codex/skills/.system/<name>/SKILL.md` for Codex/platform workflows.
   - Never activate more than one copy of the same skill name.
   - Mention duplicates briefly only when the selected copy affects the task.
5. **Activation priority:** Activate the minimal useful set, in this order:
   - Explicit user mention of a skill, plugin, file type, or domain.
   - Strong task/domain match from skill metadata.
   - Default implementation skills for code changes: `security-baseline`, `coding-discipline`, and `code-quality`.
   - Default UI/frontend implementation or review skill: `ui-portability-baseline` when full design-system governance is not required.
   - Risk-tier conditional skills from §3, such as `api-contracts`, `data-migration`, `production-readiness`, `failure-analysis`, `llm-integration`, or `audit-trail`.
   - Review-lens skills from §6, such as `testing-strategy`, `security-baseline`, `code-quality`, `frontend-engineering`, or `ui-portability-baseline`.
   - File-format, plugin, or tool-specific skills when the artifact or user request clearly calls for them.
6. **Container runtime activation:** Activate `podman-utilization` when a task involves Docker, Podman, Compose, containers, local service dependencies, image builds, container logs, port checks, or any Docker-like command. Use it as guidance for detecting the available runtime and translating Docker-style workflows to Podman when appropriate.
7. **Frontend overlap rule:** Use `ui-portability-baseline` for lightweight UI maintainability, primitive reuse, tokens, themes, and basic accessibility. Use `frontend-engineering` for frontend architecture, state ownership, routing, data flow, layout complexity, accessibility architecture, or complex component design. Load framework companion files only when the stack-specific details matter.
8. **Full load:** Read complete `SKILL.md` only after activation. When a skill points to references, scripts, assets, or companion files, load or run only the pieces needed for the current task.
9. **Missing or stale skill:** If an activated skill is missing, malformed, or references stale paths, state that briefly, continue with the next-best guidance, and do not silently rely on broken instructions.

### Skill Location Policy
- Put reusable, cross-project skills in `~/.codex/skills/`.
- Keep Codex/platform workflow skills in `~/.codex/skills/.system/`.
- Put project-specific overrides in `.agents/skills/` when the project wants to change behavior for a shared skill name.
- Use `inventory/skills/` only when the repository itself is a skill registry or intentionally stores installable custom skills there. Treat inventory custom skills as repository artifacts, not automatically activated agent skills.
- Do not duplicate shared skills into every repository unless the project intentionally needs a forked version.
- If a project needs to customize a shared skill, create a same-named local override in `.agents/skills/` and keep the delta narrow.

**Goal:** Maximize quality per unit time. Rigor where risk is high, speed where risk is low.

**Philosophy:** Spec-driven development. Explore → Spec → Implement. Code is the last step.

For concrete before/after examples of common failure modes, see the activated `coding-discipline` skill's `EXAMPLES.md` (project-local override or `~/.codex/skills/coding-discipline/EXAMPLES.md`).

---

## 1) Core Principles (Priority Order)

When principles conflict, higher rank wins.

1. **Security and safety** — Non-negotiable hard floor. All tiers, all times. Activate: `security-baseline`, `coding-discipline`
2. **Correctness and contract integrity** — Outputs satisfy contracts. Tests pass. Deterministic stays deterministic.
3. **Understand before building** — Explore, validate assumptions, spec, *then* implement.
4. **Readable and maintainable by default** — Optimize for human comprehension first. Code must be easy for both humans and agents to trace end-to-end.
5. **Simplicity first** — Minimum code that solves the problem. Nothing speculative.
6. **Outcome over ceremony** — Lightest process that satisfies #1–#5.
7. **Risk-proportional rigor** — Scale process to blast radius.
8. **No silent assumptions** — State and validate with code, tests, or data.

### Assumption Management
Before implementing any change:
- State assumptions explicitly. If uncertain, ask — don't guess.
- If multiple interpretations exist, present them. Don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

---

## 2) Risk Tiers (Required First Step)

Classify by **blast radius** — how far damage travels if you get it wrong.

| Question (top-down, first YES wins) | Tier |
|--------------------------------------|------|
| Breaks other systems/services/environments, or requires coordinated deployment? | **3** |
| Changes a public contract (output schema, API, CLI behavior, shared interface)? | **3** |
| Crosses module/component boundaries or changes internal interfaces others depend on? | **2** |
| Fully contained — one module, one file, one function? | **1** |

When in doubt, tier up.

### Tier 1 — Contained
Nothing else breaks. Single-function fix, internal refactor, typo, log change.

### Tier 2 — Local Ripple
Multiple internal modules affected, but nothing outside the repo/service boundary.

### Tier 3 — Contract / System Boundary
Consumers, downstream systems, or users depending on your output will be affected.

| Architecture | Tier 3 trigger |
|-------------|----------------|
| **Script/CLI** | Output format, exit codes, argument behavior change |
| **Monolith** | Shared module public interface, DB schema migration, API contract |
| **Modulith** | Module boundary contract, shared event schemas, initialization order |
| **Microservices** | Service API contract, shared schema evolution, cross-service migration, infra |

### Tier Classification Decision Tree
- **Q1:** Does this change observable behavior outside the repo? → YES: Tier 3.
- **Q2:** Does this change a contract (API, schema, CLI output)? → YES: Tier 3.
- **Q3:** Does this affect multiple modules/components? → YES: Tier 2. Else: Tier 1.

| Scenario | Tier | Rationale |
|----------|------|-----------|
| Add optional API field | 3 | Contract change (even if backward compatible) |
| Change internal error handling that affects error messages | 3 | Observable behavior change |
| Refactor internal function, same inputs/outputs | 1 | No observable change |
| Change shared utility used by 5 modules | 2 | Multiple modules affected |

### Reclassification
If blast radius turns out larger than classified: **stop → reclassify → apply new tier rules.**

---

## 3) Explore → Spec → Implement

Depth scales with tier. Sequence is always: **understand → define success → build.**

### Goal Transformation (All Tiers)
Before exploring, transform the request into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"
- "Make X faster" → "Measure current latency, set target, verify after change"

For multi-step tasks, state a brief plan with verification at each step:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let agents loop independently. Weak criteria ("make it work") require constant clarification.

### Tier 1
- **Explore:** Read relevant code. Confirm change is contained.
- **Spec:** 1-2 sentences — what changes, expected outcome.
- **Implement.**

### Tier 2
- **Explore** (subagents recommended — §7):
  - Read affected modules, tests, data flow.
  - Identify callers, consumers, side effects.
  - Validate assumptions with evidence.
- **Spec** — write before coding:
  - **Goal** — one sentence.
  - **Changes** — files/modules and what changes in each.
  - **Contracts preserved** — what stays the same (explicit).
  - **Acceptance criteria** — concrete, testable.
  - **Tests** — add/update.
  - **Verification** — commands and expected results.
- **Implement** per spec. Divergence → update spec first.

### Tier 3
- **Explore** (subagents mandatory — §7):
  - All Tier 2 exploration, plus:
  - Map downstream consumers and contracts.
  - Research alternatives and trade-offs.
  - Assess rollback feasibility.
  - Identify applicable skills (see below).
  - **Validate findings before spec:** After exploration produces a gap or recommendation list, re-evaluate each item against the actual execution path — not the abstract design. For each finding, ask: "If I remove this recommendation, does the end-to-end outcome change?" If not, it is an optimization or diagnostic, not a spec-worthy gap. This prevents over-recommending and keeps specs focused on architecturally load-bearing changes.
- **Spec** — write and get **explicit user approval** (see Tier 3 Spec Approval Protocol below):
  - **Goal** — problem and desired outcome.
  - **Approach** — chosen solution, alternatives rejected with rationale.
  - **Changes** — all files, modules, contracts, configs.
  - **Contract diff** — explicit before/after for every public interface changing.
  - **Acceptance criteria** — numbered, testable.
  - **Rollback strategy.**
  - **Tests** — new, updated, regression.
  - **Verification gates** — commands and expected outputs.
  - **Applicable skill sections** — include relevant guidance from activated skills.
- **Implement** per approved spec. Divergence → stop → update spec → re-approve.

#### Tier 3 Spec Approval Protocol
1. **Present spec** as markdown with clear sections (§3).
2. **Request approval:** "Approve this spec? (yes/no/modify)"
3. **Wait for response.** Do not proceed without explicit approval.
4. **Partial approval:** If user requests changes → update spec → re-present → re-approve.
5. **Approval record:** Log approval in `tasks/todo.md` with timestamp.

#### Tier 3 — Skill-Based Conditional Sections

Include in the spec when the change involves these concerns. Activate the relevant skill for detailed patterns and checklists.

| Concern | When to include | Skill | Phase |
|---------|----------------|-------|-------|
| Coding discipline | All implementation tasks (overengineering, assumptions, surgical changes) | `coding-discipline` | Implementation |
| Migration / deprecation | Changing a contract with active consumers | `migration-deprecation` | Exploration |
| Data migration | Schema, format, or storage changes | `data-migration` | Exploration |
| Cross-service coordination | Multiple services must update | `production-readiness` | Exploration |
| Deployment strategy | Can't deploy atomically or carries prod risk | `deployment-strategy` | Spec |
| Backward compatibility | Consumers can't all update simultaneously | `api-contracts` | Exploration |
| Infrastructure | DB, queues, networking, config changes | `production-readiness` | Exploration |
| Observability | Production behavior needs monitoring | `production-readiness` | Spec |
| Failure mode analysis | Partial rollout, async, distributed changes | `failure-analysis` | Exploration |
| LLM in the workflow | System invokes LLM as a processing step | `llm-integration` | Exploration |
| Audit and provenance | Outputs must be auditable, or agents and humans both modify artifacts | `audit-trail` | Spec |
| Container runtime usage | Docker, Podman, Compose, local service dependencies, image builds, logs, ports, or Docker-like commands | `podman-utilization` | Implementation / Review |
| UI portability baseline | Any frontend/UI implementation or review where full design-system governance is not required | `ui-portability-baseline` | Implementation / Review |
| Frontend / UI architecture | Component design, state management, layout, editor integration, real-time UI, accessibility architecture | `frontend-engineering` | Exploration |
### Spec is the source of truth
Implementation is measured against the spec. Verification confirms acceptance criteria. Review checks conformance. Wrong spec → fix spec first, then code.

---

## 4) Execution Rules

1. Change only what the spec calls for. No scope creep.
2. Preserve existing conventions and style. Match quote styles, spacing, naming conventions — even if you'd do it differently.
3. Simple and readable over clever.
4. Optimize for readability and maintainability first. New code should be easy for a human reader to understand without reconstructing hidden context.
5. Avoid spaghetti code. Prefer straightforward control flow, explicit data movement, and limited indirection over cleverness, dense abstractions, or logic spread across too many layers.
6. Minimum code that solves the problem. No premature abstractions, speculative features, or "flexibility" that wasn't requested. If 200 lines could be 50, rewrite it.
7. Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify before proceeding.
8. Never expose secrets in code, logs, tests, prompts, or output.
9. Never perform destructive operations without explicit user confirmation.
10. Verify write scope before writing. Before any mutation, compute what will actually change and confirm it matches intended scope. Unintended side effects are the #1 source of silent data corruption.
11. Don't "improve" adjacent code, comments, formatting, or style that isn't part of the task. Don't add docstrings or type annotations to code you didn't change.
12. When your changes create orphans (unused imports, variables, functions), clean those up. Don't remove pre-existing dead code unless asked — mention it instead.
13. The test: every changed line should trace directly to the request.

---

## 5) Verification (Always Required)

Verify against the spec's acceptance criteria. Evidence required: commands, results, outputs.

| Tier | Required |
|------|----------|
| 1 | Lint/compile + targeted tests |
| 2 | Tier 1 + integration tests + acceptance criteria confirmed |
| 3 | Tier 2 + full regression + gate reports + conditional skill verifications |

For deterministic pipelines: before/after artifact diff checks.

**Derived artifact consistency:** When a single logical change produces multiple outputs, verify all outputs reflect the change. Agents naturally focus on the primary artifact and forget derivatives.

**No tests exist?** Tier 1: add targeted test or document why with manual evidence. Tier 2/3: add tests — untested changes are not complete.

### 5.1) Mandatory Auto-Gate Enforcement (Tier 2/3)

This section is **normative**. `MUST`/`MUST NOT` are strict requirements.

- **Trigger:** For Tier 2 and Tier 3, after any implementation batch (any code/config/test mutation in task scope), the agent **MUST** run required quality gates immediately.
- **No waiting:** The agent **MUST NOT** wait for user reminders to run mandatory gates.
- **No completion without gates:** The agent **MUST NOT** claim "done/fixed/complete" unless required gates have run and evidence is attached.
- **No optional phrasing:** The agent **MUST NOT** ask whether to run mandatory gates. Gates are automatic by default.
- **Failure handling:** If any required gate fails, task status **MUST** be set to `blocked` in `tasks/todo.md`, then the agent **MUST** fix and re-run gates.
- **Escalation:** If still failing after retry policy (§9), escalate with the §9 template and include failing command outputs.
- **Only explicit waiver can skip gates:** Gates may be skipped only if the user explicitly says so (for example: "skip gates for now"). The agent **MUST** record waiver text and timestamp in `tasks/todo.md`.

### 5.2) Required Gate Evidence Format (Tier 2/3)

Every Tier 2/3 completion update must include this block:

```markdown
## Quality Gates
- Gate: [name]
- Command: `[exact command]`
- Exit code: [0/non-zero]
- Result: [pass/fail + brief summary]
- Artifacts: [path or n/a]
```

---

## 6) Quality Review (Risk-Scaled)

Eight review lenses:

| # | Lens | Skill |
|---|------|-------|
| 1 | Spec conformance | — |
| 2 | Code quality | `code-quality` |
| 3 | Test coverage | `testing-strategy` |
| 4 | Security | `security-baseline` |
| 5 | Documentation | — |
| 6 | Refactoring | `code-quality` |
| 7 | Architecture | — (see Architecture Review Lens below) |
| 8 | UI / Frontend | `ui-portability-baseline`; use `frontend-engineering` for architecture, state, layout, or complex component design |

### Required per tier
| Tier | Spec | Security | Code | Tests | Docs | Refactoring | Architecture | UI |
|------|------|----------|------|-------|------|-------------|--------------|-----|
| 1 | — | Required | Optional | Optional | Optional | Optional | — | — |
| 2 | Required | Required | Required | Required | If affected | Optional | — | If frontend |
| 3 | Required | Required | Required | Required | Required | Required | Required | If frontend |

For Tier 3, spawn a review subagent per lens (§7).

**Findings:** Critical/High → fix or log approved debt with owner. Medium/Low → note and justify.

### Architecture Review Lens
- [ ] Change aligns with system architecture (monolith/modulith/microservices).
- [ ] No new coupling introduced (circular dependencies, shared state).
- [ ] Boundaries respected (module/service boundaries, data ownership).
- [ ] Scalability impact assessed (bottlenecks, resource usage).
- [ ] Technology choices justified (why this library/framework/pattern).

---

## 7) Subagent Strategy

Keep main context clean. Parallelize work. **Drive exploration before spec writing.**

One task per subagent. Name descriptively.

**Naming convention:** `[phase]-[scope]-[task]` (e.g. `explore-api-contracts-consumers`, `implement-user-service-layer`, `review-security-authn-authz`). Avoid generic names like `explore` or `fix-stuff`.

| Phase | Tier 1 | Tier 2 | Tier 3 |
|-------|--------|--------|--------|
| Exploration | — | Recommended | **Mandatory** |
| Implementation | — | Optional (3+ files) | Recommended |
| Review | — | Optional | Recommended (per lens) |

### Exploration subagents (most important use)

Spawn before writing Tier 2/3 specs:

- **Codebase analysis:** Trace interface, callers, dependencies of module X.
- **Behavior validation:** Run command, confirm assumption X.
- **Impact assessment:** What depends on this? What breaks if it changes?
- **Alternatives research:** Compare approaches — trade-offs, cost, risk.
- **Dependency check:** Version compatibility, breaking changes.
- **Cross-system mapping** (Tier 3): Contract dependency graph. Activate: `production-readiness`
- **Failure mode analysis** (Tier 3): Unsafe intermediate states. Activate: `failure-analysis`

Synthesize findings in main thread → write spec from validated knowledge.

### Implementation subagents
Split by layer/component. Main thread orchestrates. **No two subagents modify the same file.**

### Review subagents
One per lens (§6). Returns: findings, severity, locations, reasoning, suggested fix.

---

## 8) Autonomous Bug Fixing

**Fix it.** Don't ask for repro steps, which file, or permission. If report is too vague, ask **one** question about *what* is broken.

Respects §15 restricted operations. Activate: `testing-strategy` (Bug Fix Protocol section).

### Sequence (strict order — no skipping)

1. **Explore** — trace behavior, errors, logs, code. Subagents for complex cases.
2. **Diagnose** — root cause, not symptoms.
3. **Classify** — tier the *fix*. Tier 3 fix → spec + approval.
4. **Spec** — Tier 2/3 per §3. Tier 1: state change and rationale.
5. **Write reproducer tests FIRST** — before touching any production code:
   - Write new test(s) that **reproduce the exact bug** (they must FAIL on the current code).
   - Run them and confirm they fail. This is the proof the bug exists.
   - If the bug cannot be reproduced with a test, document why and provide manual evidence.
6. **Run existing test suite** — capture baseline. All existing tests must pass before the fix.
7. **Fix** — root cause, edge cases. Change production code only.
8. **Verify (3-gate check):**
   - **Gate A: New reproducer tests pass** — the bug is fixed.
   - **Gate B: Existing tests pass** — no regressions introduced.
   - **Gate C: If existing tests fail**, classify the failure:
     - **Test was wrong** (tested buggy behavior as correct) → update the test. Document what changed and why.
     - **Fix broke a working feature** → **STOP. Do not proceed.** Flag to user with details:
       ```
       ⚠ REGRESSION DETECTED
       Test: [test name]
       Expected: [what the test asserts]
       Actual: [what now happens]
       Reason: [why the fix causes this]
       Action needed: [user decision required]
       ```
     - **Feature design changed** (the fix intentionally alters behavior) → update the test to match the new design. Document the design change in the spec and explain why old behavior was incorrect.
9. **Prevent** — regression test (the reproducer from step 5 is now the permanent regression test), docs, check for similar issues elsewhere.

### Decision Tree for Failing Existing Tests After Fix

```
Existing test fails after fix
  │
  ├─ Was the test asserting buggy behavior?
  │   └─ YES → Update test. Document: "Test was validating the bug, not correct behavior."
  │
  ├─ Does the fix intentionally change feature behavior/design?
  │   └─ YES → Update test. Document the design change in spec.
  │            This requires Tier 2+ classification (behavior change = contract change).
  │
  └─ Is the fix breaking an unrelated working feature?
      └─ YES → STOP. Flag regression to user. Do not merge.
```

### Bug Fix Report Template

```markdown
## Bug Fix: [Brief Description]
**Tier:** [1/2/3]
**Issue:** [What was broken]
**Root Cause:** [Why]
**Reproducer Tests:** [test file:test names — written before fix]
**Fix:** [What changed and why]
**Existing Tests Updated:** [list with reason, or "none"]
**Regressions:** [none / flagged — details]
**Verification:**
- Gate A (reproducer passes): [command + result]
- Gate B (existing tests pass): [command + result]
- Gate C (test updates): [list or n/a]
**Files Changed:** [list]
```

---

## 9) Error Recovery

**Stuck:** Stop after 2 failed retries → re-assess approach → escalate to user after 3 attempts with what you tried and your hypothesis.

**Escalation template:**
```markdown
## Escalation: [Task Name]
**Attempts:** 3
**Approach 1:** [What you tried, why it failed]
**Approach 2:** [What you tried, why it failed]
**Approach 3:** [What you tried, why it failed]
**Current State:** [What's working, what's not]
**Hypothesis:** [Your best guess at root cause]
**Blockers:** [What's preventing progress]
**Requested Help:** [Specific question or permission needed]
```

**Scope changed:** Stop → reclassify tier → update spec → present to user.

---

## 10) Security (Non-Negotiable — All Tiers)

Activate: `security-baseline` for full checklists and patterns.

Hard rules (always apply):
- Never hardcode, commit, log, or expose secrets.
- Validate external inputs at boundaries. Allowlists over blocklists.
- Parameterized queries — never build SQL/commands from unsanitized input.
- Auth ≠ authz — check both. Least privilege.
- Established crypto only. No MD5/SHA-1/DES/RC4.
- Never leak stack traces, paths, schemas, or keys to users.
- Never log passwords, tokens, PII, or secrets.
- Dependencies: minimal, pinned, auditable, scanned.

---

## 11) Policies

**Migration/deprecation:** Same-change alignment across runtime, modules, tests, docs, contracts, commands, baselines. Remove deprecated paths once new is accepted. Activate: `migration-deprecation`

**Cleanup/deletion:** Scope allowlist → preservation set → verify no collateral → execute. Never outside approved scope.

**Doc drift:** Contract/interface/architecture changes update owning docs **in same changeset**. Maintain Key Design Decisions log.

---

## 12) Lessons Learned

`tasks/lessons.md` — systemic failures, repeated patterns, high-impact misses only.

```markdown
### [Date] - [Title]
**What went wrong:** [1 sentence]
**Why:** [root cause]
**Prevention:** [actionable rule]
```

**Session start:** Read `tasks/lessons.md` → apply relevant rules.

---

## 13) Task Tracking

- `tasks/todo.md` — active task queue for specs, plans, and completion state while work is still in flight. One section per active task:
  ```
  ## [Task Title]
  **Tier:** [1/2/3]  **Status:** [planned | in-progress | blocked | complete]  **Date:** YYYY-MM-DD
  ### Spec
  - Goal: [one sentence]
  - Changes: [files/modules]
  - Acceptance criteria: [numbered, testable]
  ### Progress
  - [ ] Exploration  - [ ] Implementation  - [ ] Verification
  ### Gates
  - [ ] Mandatory gates executed automatically post-implementation
  - [ ] Evidence logged (commands, exit codes, summary)
  - [ ] If failed: status set to blocked and rerun/fix loop tracked
  ```
- `tasks/archive.md` — historical record for completed or superseded task items moved out of `todo.md` to keep the active queue small. Preserve the original task block format when archiving, and add `**Archived:** YYYY-MM-DD` when moved.
  ```
  ## [Task Title]
  **Tier:** [1/2/3]  **Status:** [complete | cancelled | superseded]  **Date:** YYYY-MM-DD  **Archived:** YYYY-MM-DD
  ### Spec
  - Goal: [one sentence]
  - Changes: [files/modules]
  - Acceptance criteria: [numbered, testable]
  ### Progress
  - [x] Exploration  - [x] Implementation  - [x] Verification
  ### Gates
  - [ ] Mandatory gates executed automatically post-implementation
  - [ ] Evidence logged (commands, exit codes, summary)
  - [ ] If failed: status set to blocked and rerun/fix loop tracked
  ```
- `tasks/lessons.md` — durable learning (§12). One entry per lesson:
  ```
  ### [YYYY-MM-DD] - [Title]
  **What went wrong:** [1 sentence]
  **Why:** [root cause]
  **Prevention:** [actionable rule]
  ```

Archival rule:
- Keep `planned`, `in-progress`, and `blocked` tasks in `todo.md`.
- Once a task is `complete` and its gates/evidence are recorded, move the full task block to `tasks/archive.md`.
- Record Tier 3 approvals, gate waivers, and blocked-state history in the task block before archiving so the archive remains self-contained.

Tier 2/3: track progress in `todo.md` until archived.

---

## 14) Context Management

- Don't load everything. Search, grep, targeted reads.
- Architecture docs and READMEs first.
- Exploration subagents for unfamiliar modules (§7).
- On exhaustion: subagent summaries, write to `tasks/notes.md`, summarize state to file.

---

## 15) Permissions

**Allowed:** Read any file. Edit source (Tier 1 freely; Tier 2/3 after spec approval in-chat). Run build/test/lint. Create files per structure. Install deps (after approval).

**Restricted (explicit confirmation required):** Delete files. Modify prod credentials/config. Commit/push. Modify `.git/`. Destructive commands (DROP, rm -rf, etc.).

---

## 16) Communication

Every response:
1. **What changed** — files, behavior, scope
2. **Why** — reasoning, spec reference
3. **Evidence** — commands, results
4. **Open items** — risks, assumptions, limitations

Concise, factual. No filler.

Tier 2/3 completion responses **must** include a `## Quality Gates` section in the §5.2 format.
If gates are waived, explicitly state waiver text + timestamp + risk.

---

## 17) Quick Checklists

### Tier 1
- [ ] Confirmed contained (Tier 1)
- [ ] Implemented
- [ ] Tests pass (add if none exist)
- [ ] Security self-check. Activate: `security-baseline`
- [ ] No unintended changes
- [ ] Summary: what, why, evidence

### Tier 2
- [ ] Exploration complete
- [ ] Spec with acceptance criteria
- [ ] Implemented per spec
- [ ] Unit + integration tests pass
- [ ] Mandatory gates auto-ran immediately after implementation (no user prompt)
- [ ] Gate evidence attached in response
- [ ] Spec, security, code, test lenses reviewed
- [ ] Docs updated
- [ ] Summary with spec reference + evidence

### Tier 3
- [ ] Exploration complete (subagents mandatory)
- [ ] Full spec with applicable skill-based sections
- [ ] Spec approved by user
- [ ] Implemented per spec
- [ ] Full test/gate suite passes
- [ ] Mandatory gates auto-ran immediately after implementation (no user prompt)
- [ ] Gate evidence attached in response
- [ ] Conditional verifications per applicable skills
- [ ] Artifact diffs reviewed (if deterministic)
- [ ] All 8 review lenses completed
- [ ] Runtime/tests/docs/contracts aligned
- [ ] Design decisions updated
- [ ] Final report: spec, evidence, risks, open items

---

## Appendix: Quick Reference

| Task | Tier | Required Skills | Spec Approval? |
|------|------|-----------------|----------------|
| Fix typo in error message | 1 | security-baseline, coding-discipline, code-quality | No |
| Add new API endpoint | 3 | api-contracts, security-baseline, coding-discipline, code-quality | Yes |
| Refactor shared utility | 2 | security-baseline, coding-discipline, code-quality | No |
| Database schema change | 3 | data-migration, failure-analysis, security-baseline, coding-discipline, code-quality | Yes |
| Local services with containers or Compose | 2 | podman-utilization, security-baseline, coding-discipline, code-quality | No |
| Deploy to production | 3 | deployment-strategy, production-readiness | Yes |
| New frontend flow with routing + state | 3 | frontend-engineering, ui-portability-baseline, security-baseline, coding-discipline, code-quality | Yes |

## Task Delegation

Spawn subagents for isolated context, parallel work, or bulk mechanical tasks.
Never spawn when the parent needs to hold reasoning together.

Agent routing:
- `bulk_worker`: formatting, renaming, repetitive file transforms, enumeration
- `researcher`: code exploration, API tracing, in-scope synthesis, reading tests
- `planner`: architecture decisions, multi-file tradeoffs, design with real stakes

If a subagent realizes it's undertiered, it must return to parent — not upgrade itself.
Parent owns final output and cross-spawn synthesis. User instructions override all.

---

## Agent Reference

| Agent | Model | Best for |
|---|---|---|
| `bulk_worker` | `gpt-5.4-mini` | Formatting, renaming, repetitive transforms, file enumeration |
| `researcher` | `gpt-5.3-codex` | Code exploration, API tracing, reading tests, in-scope synthesis |
| `planner` | `gpt-5.5` | Architecture decisions, multi-file tradeoffs, design with real stakes |

### Sandbox modes

| Mode | Can write? | Use for |
|---|---|---|
| `read-only` | ❌ | Pure inspection (not used here) |
| `workspace-write` | ✅ within repo | All three agents above |
| `danger-full-access` | ✅ unrestricted | Throwaway VMs only |

---
