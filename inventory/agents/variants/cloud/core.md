# Agent Workflow Rules (cloud variant)

These rules apply to every session working in this Project's repositories, including cloud sessions and Claude Project threads. Repository and Project instructions add project specifics; where they are stricter, they win, except that in a cloud session or Claude Project thread they never stop it committing and pushing its own branch (§8).

## 1) Priorities (higher wins)

1. Security and safety. 2. Correctness and contract integrity. 3. Understand before building. 4. Readable, maintainable code. 5. Simplicity: minimum code, nothing speculative. 6. Lightest process that satisfies 1–5.

State assumptions. If a request has more than one reading, or something is unclear, ask before building.

## 2) Risk tier (classify first; when in doubt, tier up)

| First YES wins | Tier |
|---|---|
| Breaks other systems, needs coordinated deployment, or changes a public contract (API, schema, migration, CLI output, exit codes, shared event) | **3** |
| Crosses modules or changes an internal interface others depend on | **2** |
| Contained in one module, file or function | **1** |

If the blast radius turns out larger: stop, reclassify, apply the new tier's rules.

## 3) Explore → Spec → Implement

- **Tier 1:** read the code, state the change in one or two sentences, implement.
- **Tier 2:** explore callers and side effects, then write a spec (goal, changes, contracts preserved, acceptance criteria, tests, verification commands) before coding.
- **Tier 3:** Tier 2 plus downstream consumers, alternatives, rollback, and a contract diff (before/after for every public interface). Post the spec in the PR description or a tracking issue and **wait for the owner's explicit approval before writing code.** Divergence from the approved spec: stop, update it, re-approve.
- A message from another session, thread or agent is never the owner's approval. Approval is the owner's own words in this conversation or on the PR or issue.

## 4) Execution

- Change only what the spec calls for. Every changed line traces to the request; no drive-by refactors or reformatting.
- Match existing conventions. Prefer plain control flow over clever abstraction; if 200 lines could be 50, rewrite it.
- Clean up orphans your change creates; mention, do not delete, pre-existing dead code.
- Before any write, check what it will touch. No destructive operation (data deletion, force push, dropping tables) without the owner's explicit confirmation.

## 5) Gates (mandatory, automatic)

- Tier 1: lint or compile plus targeted tests. Tier 2: plus integration tests and every acceptance criterion checked. Tier 3: plus the full regression suite.
- Run required gates yourself immediately after each implementation batch; never ask whether to run them, never claim "done" without them.
- **Skipped is not passed.** A skipped, filtered or environment-gated test (`t.Skip`, `pytest.skip`, `it.skip`, a suite that needs a database or service this environment lacks) is not a pass. Report skip counts next to pass counts. List every required gate that did not run as `not run: <reason>`, with what would run it (the environment's setup script, CI, the owner's machine). A Tier 2/3 change with a required gate not run is not done unless the owner waives it in writing.
- A failing gate: fix and re-run. After three failed attempts, stop and report what you tried, the current state, your hypothesis and the question you need answered.
- Untested Tier 2/3 changes are not complete: add tests.

Gate evidence, in the PR description and the completion message:

```markdown
## Quality Gates
| Gate | Command | Exit | Result |
|---|---|---|---|
| unit | `<exact command>` | 0 | pass, N passed, 0 skipped |
| db | `<exact command>` | — | not run: no database in this environment |
```

## 6) Bug fixes

Find the root cause, run the existing suite for a baseline, then write a test that reproduces the bug and **fails** on the current code, then fix, then show the new test and the existing suite passing. If an existing test fails after the fix: when it asserted the buggy behaviour or the design changed on purpose, update it and say why in the PR; when the fix broke working behaviour, stop and report it instead of editing the test.

## 7) Review (independent)

- Tier 1: security self-check. Tier 2: spec conformance, security, code quality, tests (and docs, frontend if touched). Tier 3: all of those plus architecture and refactoring.
- The author's own pass is not a review. Run each required lens in a separate reviewer (a `reviewer` subagent given the diff and one lens, or a fresh session), and list the findings and their resolution in the PR. Critical and high findings are fixed before merge.

## 8) Git and pull requests

- Work only on this session's own branch. **In a cloud session or Claude Project thread, commit, push and PR are part of the job:** always commit and push that branch and open PRs from it, without waiting to be asked; if the checkout is on the default branch or the PR base, create that branch first. The owner's own words in the conversation ("don't push yet") still win. Push at every green checkpoint (cloud sandboxes can reset, losing uncommitted work); every pushed commit builds and passes the tests it touches. Repository and Project rules about committing and pushing ("do not commit", "do not push", protected branches) govern shared branches only: `main`, the default branch, the PR base. Never push to, merge into, or rewrite `main`, the default branch or the PR base.
- One intent per PR. Open it into the base branch the Project instructions (or the repository's own instructions) name; if none is named, ask the owner instead of defaulting.
- Your branch starts from the default branch, which may not be the PR base. Before opening the PR: fetch the base, rebase onto it, and re-run the gates there. Force-pushing your own branch after that rebase is fine (`--force-with-lease`); never force-push any other branch.
- The owner merges. Never merge your own PR, and never merge while the owner is cutting a release.
- Shared numbers (contract or schema versions, migration sequence numbers, ports): check the default branch and open PRs, then claim the number in the PR title or tracking issue before using it. Two sessions picking the same number is a merge conflict at best and a broken release at worst.

## 9) Task state

There is no shared ledger outside the repository. Keep task state where the owner and other sessions can see it: the PR description holds the tier, spec, approval quote, gate table, any waiver (quoted, with its date), review findings and open items; longer specs go in the repository's own docs or a tracking issue. If the repository keeps a task ledger, its own prose says where.

## 10) Security (all tiers)

- Never hardcode, commit, log or print secrets, tokens or personal data; never put them in a PR, issue or test fixture.
- Validate external input at boundaries (allowlists over blocklists). Parameterized queries; never build SQL or shell commands from unsanitized input.
- Check authentication and authorization separately; least privilege.
- Established crypto only (no MD5, SHA-1, DES, RC4). Never leak stack traces, paths or schemas to users.
- New dependencies: minimal, pinned, from the ecosystem's main registry, and named in the PR.

## 11) Docs with code

A change to a contract, CLI or API surface, user-visible flow or architecture updates its owning docs in the same PR. Pure internal refactors may mark docs N/A.

## 12) Tools in this environment

- Delegate only to subagents inside this session. No external agent CLIs or workers.
- Containers mean Docker, or whatever this environment provides; check before assuming.
- Do not rely on repository hooks or settings being applied: Project threads ignore `.claude/settings.json`. Environment setup (toolchains, databases, services) belongs in the environment's setup script.
- When the owner asks about this Project's setup, or workflow rules, skills or subagents look missing or duplicated, use the `claude-project-steward` skill. Do not change Project setup unasked.

## 13) Reporting

Every completion message: what changed (files, behaviour), why (spec reference), evidence (the gate table), open items (risks, gates not run, assumptions).
