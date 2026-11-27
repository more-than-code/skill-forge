# Skill Forge evaluation — design

Status: **approved by the owner (2026-11-27), not built.** Design only, part of the
[platform](PLATFORM.md) design. It answers the Defect Drainer requirement "Eval: show whether
a skill or rule change actually helps agents" and feeds the Console's Evaluation page
([CONSOLE.md](CONSOLE.md#evaluation-results)). The jobs run on the Defect Drainer worker, extended
as drafted in [DD-WORKER-JOBS.md](DD-WORKER-JOBS.md).

Owner decisions: the eval framework is Promptfoo, as the grader only, and evals run on the
existing Defect Drainer worker rather than a worker of our own (2026-11-26); the suite format,
baselines, metrics, repeats, budget and first suites below (2026-11-27).

## Workflow

1. **Author a suite** next to the artifact in its registry, reviewed like any skill change.
2. **Trigger** a run: from the Console, on a proposal PR (proposal against its base), or before a
   release. The Go API checks the tenant's eval budget and writes one `eval` job row per run.
3. **Dispatch**: the Go dispatcher hands the job to a Defect Drainer worker through DD's job API,
   with the artifact bundle, the suite, the caps and a reference to the tenant's model key (never
   the key itself).
4. **Run**, on the worker, once per task and per configuration (the candidate and each baseline),
   `repeats` times:
   - a fresh job directory with an **empty Claude configuration** (`CLAUDE_CONFIG_DIR` per job);
     the artifact under test is installed into it, nothing else;
   - the task's fixture files copied into a scratch workspace (no git clone, no GitHub token);
   - Claude Code runs the task headless in the worker's existing sandbox, with turn, time and cost
     caps and the agent's network limited to nothing (or the hosts the suite names);
   - the **grader** runs afterwards in a separate sandbox, outside the agent's reach: Promptfoo
     assertions over the final workspace, the agent's output and its tool-call trace.
5. **Report**: the worker returns one structured record per task run (the `eval_runs` schema in
   CONSOLE.md) plus a grader summary of at most 500 bytes. Transcripts stay on the worker and are
   deleted with the job.
6. **Compare and show**: the API stores the records under the tenant; the Console compares the
   candidate with each baseline only when suite, task set and model match, and posts the summary
   to the proposal PR when the run came from one.

## Parts

| Part | What it is | Where it runs |
|---|---|---|
| Suite | `evals/<artifact>/suite.json` plus fixture files, in the tenant's registry | Git |
| Go API and dispatcher | Budget check, job row, hand-off to DD, result intake | Skill Forge |
| Defect Drainer control plane | Job API, encrypted model keys (bring your own key), worker scheduling | DD |
| DD worker (`dd-worker`, Go) | Sandboxed job runner: per-job directories, Claude Code's bwrap sandbox, cgroup limits, secret redaction | The worker host (self-hosted Linux, a Raspberry Pi today) |
| Claude Code CLI | The agent under test, run headless (`claude -p … --output-format stream-json`) | Worker host |
| Promptfoo | Grader: deterministic assertions (file contents, commands, regex, JSON), `llm-rubric` judges, and its result format. A thin layer, used as a standalone CLI: the Go worker runs `promptfoo eval -c <generated config> -o results.json` and parses the JSON | Worker, in the check sandbox; Node 22 is a runtime in the job sandbox image, and Promptfoo's npm package is pinned there. Skill Forge writes no Node code |
| Model API | Anthropic API with the tenant's own key | External |
| Postgres | `eval_runs`, budgets | Skill Forge (Supabase) |

Why Promptfoo only grades: the DD worker already runs Claude Code with a sandbox, caps and cost
capture, so having Promptfoo drive the agent too would duplicate it and put a large npm tree in
the agent's path. Promptfoo's providers (including the Claude Agent SDK) are how any Agent SDK use would come in
later, for suites that test prompts rather than whole agent runs; otherwise it is deferred.

## Suite format

```json
{
  "schema": 1,
  "artifact": "skill:coding-discipline",
  "model": "<pinned model id>",
  "repeats": 3,
  "caps": { "turns": 30, "wall_sec": 600, "cost_usd": 0.5 },
  "network": [],
  "baselines": ["none", "previous"],
  "tasks": [
    {
      "id": "no-drive-by-refactor",
      "fixture": "fixtures/no-drive-by-refactor/",
      "prompt": "Fix the off-by-one in pager.js. Do not change anything else.",
      "assert": [
        { "type": "command", "run": "npm test", "expect_exit": 0 },
        { "type": "diff-files-max", "value": 1 },
        { "type": "llm-rubric", "value": "The change touches only the faulty loop bound." }
      ]
    }
  ]
}
```

`assert` entries map one-to-one onto Promptfoo assertions, so the grader config is generated from
the suite and the suite stays ours if the framework changes.

## Baselines

Each candidate runs against:

- **`none`**: the same tasks with no artifact installed. Answers "does this skill help at all".
- **`previous`**: the last released version of the artifact. Answers "did this change help".
  Skipped for a new skill with no release.

Both run in the same job, on the same model and worker, interleaved, so drift in the model or
the host affects both sides alike.

## Metrics

Per task and configuration, over `repeats` runs:

| Metric | Source |
|---|---|
| Pass rate (all assertions pass) | Grader |
| Per-assertion pass rate (rule followed, tests pass, forbidden step absent) | Grader |
| Turns, input and output tokens, cost (USD) | Claude Code's `result` event, as DD already captures |
| Wall time | Worker timestamps (DD does not capture `duration_ms` yet) |
| Stability | Spread of pass rate across repeats |

Per suite: the pass-rate difference against each baseline with a simple interval, and cost and
turns differences. A verdict is shown only when the interval excludes zero; otherwise
"no measurable difference". Layer 1–3 metrics in DESIGN.md (judge scores, efficacy ledger) post
into the same records when they ship.

## Isolation

- **No GitHub credentials** in an eval job: fixtures come as job inputs, not a clone, and the job
  type asks for no git token.
- **The model key** is the tenant's, referenced by id, delivered to that job only, held in memory,
  added to the worker's exact-value redaction and never written into the job directory (see
  DD-WORKER-JOBS.md).
- **Network**: the agent's tools reach nothing unless the suite names hosts. The Claude CLI
  itself reaches the model API from outside the agent's sandbox, so "model API only" holds for
  the agent's tools, not as a host firewall; a host egress rule is a follow-up on the DD side.
- **Tenants**: see DD-WORKER-JOBS.md, "Tenancy". Until per-job VMs exist, a worker runs jobs for
  one tenant only.

## Decided questions

Settled by the owner on 2026-11-27.

1. **Suite format, baselines and metrics**: as above.
2. **Repeats and budget**: 3 repeats per task, and a per-suite cost cap set in the suite.
3. **First suites**: `coding-discipline` and `security-baseline`.
4. **Promptfoo**: grader only; Claude Code on the DD worker drives the agent.
