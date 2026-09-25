---
name: defect-drainer-test-plans
description: Inventory a product's test plan in Defect Drainer and get it carried out — by you in this session, or by a DD test job on the simulator — with screenshot evidence that a human reviews. Covers writing steps an agent can execute and a reviewer can judge, the plan upsert contract (stable keys, created/changed/version), starting a run (execute manual or agent, refs, test-account references), recording results and evidence as an agent session, polling a DD job, and why review and defect filing stay human decisions. Use when asked to write, update, or run a test plan or smoke test for an app Defect Drainer manages; to prove a build works on the simulator with evidence; to start or check a DD test run; or when a test account or password is involved.
---

# Defect Drainer test plans

Turning "check the app still works" into a **plan that outlives the session**, runs that
record what actually happened with screenshots, and a human verdict on each result.

## Scope — read this before adding anything here

Defect Drainer (DD) documents its own API and console (`defect-drainer/backend-go/README.md` →
"Test plans and runs (API)" and "Test-run jobs"). This skill is for an agent working in a
**product repo**, which cannot read those docs: it carries the contract you need and the
discipline around it. It does not cover fixing defects — that is DD's batch-fix loop — or
filing detector output, which is `defect-drainer-intake`.

## 0. Before anything

- DD runs on the operator's machine, by default at `http://127.0.0.1:8788`. If it does not
  answer there, ask the user for the address. Do not start DD yourself.
- Find the app: `GET /api/apps` → `apps[]` with `id`, `name`, `repos`, `repo_entries`, and
  `test_accounts[] {label, username, environment, secret_ref}`. Plans and runs are per app.
- Read what exists first: `GET /api/test-plans?app_id=<id>` and `GET /api/test-plans/<plan-id>`.
  Extend an existing plan rather than creating a near-duplicate under a new key.

## 1. Writing steps

A step is **one action and one observable expected result**. The reader is either an agent that
has only this step and a simulator, or a reviewer looking at one screenshot.

| Field | Rule |
|---|---|
| `key` | Stable id, `^[a-z0-9][a-z0-9._-]{0,63}$`, no `..`. **Never rename a key to reword a step** — a new key is a new step, and it breaks that step's history and retest tracking. |
| `section` | Optional grouping (`launch`, `auth`, `profile`, …). |
| `action` | Imperative, one thing: "Tap Sign in", not "Sign in and check the dashboard". |
| `expected` | What is visible on screen afterwards, specific enough to judge from a screenshot: "Home tab shows the greeting with the account's first name". Not "works" or "no errors". |

- **Prove the environment first.** Start with steps whose expected result shows the build is
  the one you meant: the test-mode banner, the API host in a debug screen, the version string.
  A run that passes against production or a stale build is worse than no run.
- **Sign-in is its own step**, with an expected result that shows which account is signed in.
- Keep steps independent where you can; when one depends on an earlier step, say so in the
  action ("With the cart from `add-to-cart`, tap Checkout").
- No credentials anywhere in a plan: not in `action`, `expected` or `env`. `env` keys matching
  `pass`, `secret` or `token` are rejected by DD anyway.
- Plan `env` is free-form context copied onto each run. The keys DD itself reads are `target`,
  `device`, `api_base`, `flavor` (they go into a filed defect) and `account_label` (the console
  pre-selects that test account when starting a run).

## 2. Inventorying the plan

```
POST /api/test-plans
{ "app_id": "...", "key": "smoke", "title": "Smoke test", "purpose": "...",
  "env": { "target": "ios-simulator", "flavor": "test", "account_label": "qa" },
  "created_by": "<you>",
  "steps": [ { "key": "launch-test-mode", "section": "launch",
               "action": "Launch the app", "expected": "The TEST banner is shown" }, … ] }
```

- It is an **upsert on `(app_id, key)`** with the **full step list**: steps match by `key`, new
  keys are added, **missing keys are removed**, order follows the list. Posting a partial list
  deletes the rest from the plan (runs keep their own copy).
- **201** `{plan, created: true, changed: true}` when new; **200** `{plan, created: false,
  changed}` otherwise. `version` increases only when content changed (title, purpose, env, or
  step keys/order/section/action/expected).
- **There is no server-side dry run.** Before posting to an existing plan, fetch it, diff your
  step list against it by key, and show the user what will be added, reworded and **removed**.
  Post only after that. Then read back `created`, `changed` and `version` and report them —
  `changed: false` means nothing happened, which is correct for a re-run of the same plan.
- A plan with runs is archived, not deleted, by `DELETE`; re-posting its key un-archives it.

## 3. Starting a run

A run **copies the plan's steps at start** and records `plan_version`; later plan edits do not
change it.

```
POST /api/test-runs
{ "app_id": "...", "plan_id": "TPLAN-…", "execute": "manual" | "agent",
  "executor": "agent-session",            // manual only: you record the results
  "executed_by": "<you>", "account_label": "qa",
  "refs": [ { "repo": "mobileapp", "ref": "feature/x" } ], "env": { … } }
```

| `execute` | Who carries it out | Response |
|---|---|---|
| `manual` | You, in this session (`executor: "agent-session"`), or a person (`operator`, the default) | **201** `{run}`, status `in_progress` |
| `agent` | A **DD test job**: a coding agent in its own detached worktree at each requested ref, on the simulator when the app writes to it (one job at a time; others queue) | **201** `{run, job}`; the run is `queued`, then `in_progress` once the job starts |

- `refs` pin what is tested. A repo with no ref uses its saved base branch. DD records the
  resolved commit (`refs[].sha`) on the run — quote it when you report results.
- A run without `plan_id` starts empty (exploratory); steps can be appended with
  `POST /api/test-runs/<id>/steps` and promoted later with `save-as-plan`.
- Start an **agent** run only when the user asked for a DD job. It spends their agent budget
  and holds the simulator.
- Surface a **400** verbatim and stop; do not retry with guesses. Common ones: `test account
  secret env NAME is not set` (the operator must set that variable where DD runs and restart it),
  `<repo>: ref <ref> not found`, `no product repos resolved for worktrees …`.

### Watching a DD job

Poll `GET /api/test-runs/<run-id>` (and `GET /api/batch-jobs/<job_id>` for the job's `status`
and log) every 10–30 s. Done means the run is `awaiting_review`; a job that is `failed` or
`cancelled` leaves the run `in_progress` with whatever was collected. While the job is `queued`
or `running`, **every write to that run is 409** `run is being executed by job <id>` — do not
record results into an agent run. DD never ships anything from a test job: no branch, no PR, no merge.

## 4. Recording results as an agent session

For a `manual` run you execute yourself:

1. Before each step, confirm the precondition; then do the action.
2. Take a **fresh screenshot** of the result (for iOS: `xcrun simctl io booted screenshot
   <new-file>.png`; always a new file name).
3. `PATCH /api/test-runs/<id>/steps/<key>` `{ "status": "pass|fail|blocked|skipped",
   "actual": "<what you saw>" }`. `actual` is what happened, not a restatement of `expected`.
4. `POST /api/test-runs/<id>/steps/<key>/evidence` — multipart, the screenshot **unmodified**
   (png/jpg/jpeg/webp/gif/heic, ≤25 MiB, ≤12 per request). No crops, annotations or composites.
5. When done: `POST /api/test-runs/<id>/finish` → `awaiting_review`.

- **A `pass` with no screenshot becomes `unverified`** at finish. That is DD refusing to take
  your word for it; do not work around it with an old or reused image.
- `blocked` is for "could not reach or perform the step" (precondition failed, environment
  down); `fail` is for "did it, and the result was wrong". `skipped` needs a reason in `actual`.
- Something worth checking that is not in the plan: append an exploratory step rather than
  folding it into another step's `actual`.

## 5. Accounts and passwords

- DD stores test accounts as **references**: `{label, username, environment, secret_ref}`. It
  never stores a password, and `test_accounts` rejects any other key.
- For a **DD job**, `secret_ref: "env:NAME"` makes DD read `NAME` from its own process
  environment and hand it to the job's agent as `DD_TEST_ACCOUNT_PASSWORD`. Names DD or the OS
  use (`PATH`, `HOME`, `CI`, `DD_*`, `GROK_*`, `GIT_*`, …) are refused; use a dedicated name like
  `QA_PASSWORD`.
- In **your own session**, DD gives you no password. Ask the user how they want to provide it.
  Never write it into DD, a plan, a result, a commit, a log or a file.
- **Never screenshot a visible password** and never echo it. DD redacts only the exact value in
  text it controls; a split, encoded or pictured password is not caught.

## 6. Review and defects are human decisions

- `POST /api/test-runs/<id>/review` (`accepted` / `disputed` per step) is the **operator's**
  verdict. Only accepted results count in the plan's history and retest tracking. Do not call it
  on your own results. If the user reviews in chat and asks you to record it, record exactly
  what they said, with their name as `reviewer`.
- `POST …/steps/<key>/file-defect` turns a `fail` or `blocked` step into a DD defect (with the
  step's screenshots copied). Propose it; file it when the user says so. One defect per step.
- `GET /api/test-plans/<id>/grid?runs=N` shows each step against the last N reviewed runs, with
  `needs_retest: true` where a linked defect was resolved and no later accepted pass exists.
  Those steps are the first ones to run next.

## 7. Related

- **`defect-drainer-intake`**: filing machine-detected findings as defects.
- `defect-drainer/backend-go/README.md`: the full contract, for DD's own maintainers.
