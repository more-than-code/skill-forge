# Draft for Defect Drainer: a general-purpose worker with bring-your-own-key

Status: **draft for the Defect Drainer project, not a Skill Forge change.** Nothing here edits
the DD repositories. It records what Skill Forge needs from the DD worker so that the DD project
can spec, review and build it in its own repos and PRs. Owner's direction (2026-11-26): the DD
worker should become a general-purpose sandboxed agent runner, not one for fix jobs only, and
users should bring their own model key from the console.

Read against `more-than-code/defect-drainer-worker` at `7d910b7`: `docs/contracts/worker-protocol-v1.md`,
`docs/adr/0001-job-isolation-without-containers.md`, `exec/spec.go`, `internal/worker/offer.go`,
`agentadapter/claude/claude.go`.

## What the worker already has

- Outbound WebSocket to the control plane; `offer` → spec fetch with a per-job token → policy
  check → accept; lease renewed by `progress` frames; additive capabilities per feature.
- Per-job directories, a per-job empty `CLAUDE_CONFIG_DIR` (API-key mode), Claude Code's bwrap
  sandbox via a per-job `--settings` file (`failIfUnavailable`, no unsandboxed commands, deny
  lists, agent egress limited to an allowlist), cgroup limits (`job_limits.v1`).
- Caps on turns, wall time and cost, and capture of turns, cost and tokens per model.
- Short-lived GitHub tokens minted per job (`gittoken.v1`), memory only, never given to the
  agent; exact-value redaction of secrets in every event.

## What blocks other job types today

- Only two kinds, `batch_fix` and `test_run`; `validateSpec` rejects others, requires worktrees
  and branch rules; scheduling matches on repos.
- The model key is per host (`/etc/dd-worker/secrets.env` → `ANTHROPIC_API_KEY`), so cost and
  data cannot be attributed to a user or org key.
- Results are fixed event kinds; no generic structured-result event; blobs accept images and
  text only.
- A worker belongs to one DD org and all jobs share one system user; the ADR itself says mutually
  untrusted orgs on one host need microVMs.

## Proposal 1: a generic job contract (`jobs.v2` capability)

A job spec carries, for every kind:

| Field | Meaning |
|---|---|
| `kind` | Registered job type, e.g. `dd.batch_fix`, `dd.test_run`, `sf.check`, `sf.propose`, `sf.eval` |
| `inputs` | Typed inputs: repo refs (optional, only kinds that need them), blob refs (bundles, fixtures), parameters |
| `sandbox` | Level (`read-only`, `strict`, `workspace`), agent egress allowlist (default none), cgroup limits |
| `agent` | Adapter (`claude`), model, caps (turns, wall time, cost), extra config to install into the job's empty config dir (skills, rules) |
| `credentials` | References only: `model_key` (a key id, see Proposal 2) and `git` (`none`, `read`, `write`) |
| `steps` | The kind's run steps; for agent kinds, an optional post-agent **check step** run in the verify sandbox, out of the agent's reach |
| `result` | Result schema id and version; the worker returns `result` events validated against it, plus `application/json` blobs |

Each kind is a small handler on the worker (validate inputs, prepare workspace, run, collect)
registered against this contract; `batch_fix` and `test_run` become the first two handlers with
their current behaviour, so existing jobs do not change. Scheduling matches on
`kind` and the worker policy's allowed kinds, and on repos only for kinds that take repos.

Skill Forge job kinds on this contract:

| Kind | Inputs | Agent | Network | Git | Result |
|---|---|---|---|---|---|
| `sf.check` | Registry snapshot blob, artifact name | none (runs `skf skill check` and `validate`) | none | none | Findings |
| `sf.propose` | Registry snapshot blob, proposal files | none (`skill write`, `bump`, `lock`, `validate`) | none | none | (path, bytes) list for Skill Forge's committer |
| `sf.eval` | Artifact bundle, suite, fixtures | Claude Code, artifact installed into the empty config | none unless the suite names hosts | none | One record per task run (`eval_runs` schema) |

Skill Forge's committer (Go, in Skill Forge) stays the only holder of the GitHub App key for
registry writes; no Skill Forge job asks DD for a git token.

## Proposal 2: bring your own key

- **Storing**: a user or org adds a model API key in the DD console (or through the API, for a
  service account such as Skill Forge's). The control plane stores it with envelope encryption
  (a per-org data key wrapped by a KMS key), shows only the last four characters, records who
  added it and when it was last used, and lets it be revoked. Keys never appear in exports, logs
  or MCP output.
- **Choosing**: a job's `credentials.model_key` names a key id the job's owner may use. Org
  policy decides whether jobs without one may fall back to the host key (default: no, once BYOK
  ships).
- **Delivering**: like `gittoken.v1`, the worker fetches the key at job start over the job's
  token-authenticated channel, keeps it in memory, adds it to exact-value redaction, and passes it
  only in the Claude CLI process's environment (`ANTHROPIC_API_KEY`), with
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` so the agent's tools never see it. It is never written to
  the job directory, the CLI config, the spool or a frame, and is dropped when the job ends.
- **Accounting**: cost per job is attributed to the key and its owner, from the cost the worker
  already captures.
- **Skill Forge**: each Skill Forge tenant's key is stored in DD as a key owned by that tenant's
  service identity (Skill Forge never keeps a second copy), and Skill Forge's `sf.eval` jobs
  reference it by id. A tenant that already uses DD can point Skill Forge at its own DD key.

## Proposal 3: tenancy for shared workers

A worker today trusts every job it runs as much as its owner. Running jobs from several Skill
Forge tenants on one host is the "mutually untrusted orgs" case in DD's own ADR. Proposed order:

1. **Tenant-owned workers**: a tenant enrols its own DD worker on its own hardware; only its jobs
   go there. Strong isolation, no shared host. This is enough for the owner's own tenant.
2. **Platform workers with per-job microVMs** (Firecracker or similar), as the ADR suggests,
   before open sign-up. Until then, platform-operated workers take jobs for one tenant only.

## Smaller items

- A generic `result` event and `application/json` blobs (Proposal 1).
- Capture `duration_ms` and cache tokens from Claude Code's `result` event.
- A host egress rule so the Claude CLI process itself can reach only the model API.
- **A Node 22 runtime for jobs**, in the job sandbox image or declared per job type, with a
  pinned Promptfoo for `sf.eval` grading and the `skf` CLI for `sf.check` and `sf.propose`. The
  Go worker starts both as standalone CLIs (`promptfoo eval -c <config> -o results.json`,
  `node bin/cli.js … --json`) in the verify sandbox with no network and parses their JSON; no
  Node code is written for the worker or for Skill Forge.

## Open questions for the DD project

1. `jobs.v2` as a new capability alongside v1, with `batch_fix` and `test_run` ported onto it?
2. Where Skill Forge authenticates to DD's job API: a DD service account per Skill Forge
   deployment, acting for tenants mapped to DD orgs?
3. Host-key fallback once BYOK ships: off by default?
