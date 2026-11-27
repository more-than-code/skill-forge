# Doctor suggests skills for a repo's stack (spec)

Status: proposed 2026-11-27, awaiting Joe's approval. Tier 3: it adds a field to
`registry.json` skill entries and a finding to `skf-cloud.mjs doctor` JSON.
Tracks Defect Drainer requirement DEF-20261127-doctor-should-suggest-skills-for-the-rep-pytp.

## Goal

A repository whose stack has a matching registry skill, but which neither declares that
skill nor gets it from the environment, gets a note from `skf-cloud.mjs doctor` naming the
skill and the `skill-forge.json` lines that add it. Example: a React + Vite app that calls
the Anthropic SDK and declares only `claude-project-steward` is told about
`frontend-engineering` and `llm-integration`.

Doctor never installs anything. The fix is a pull request in that repository.

## Changes

### 1. `registry.json`: optional `suggestFor` on a skill entry

```json
{ "name": "frontend-engineering", "version": "0.3.1", "...": "...",
  "suggestFor": ["npm:react", "npm:vue", "npm:svelte"] }
```

An array of stack signals. Any one signal matching is enough. Three kinds in v1:

| Signal | Matches when |
|---|---|
| `npm:<package>` | the repo-root `package.json` lists the exact package name in `dependencies`, `devDependencies` or `peerDependencies` |
| `go:<module>` | the repo-root `go.mod` has a `require` for the exact module path (single-line or block form) |
| `file:<path>` | the repo-relative file or directory exists (`file:vercel.json`, `file:supabase/config.toml`, `file:.fvmrc`) |

Signals are matched literally (no globs). The map lives in the registry, so it grows with
the inventory: adding a skill for a stack means adding its signals in the same PR. Other
kinds (`pub:`, `pypi:`, `cargo:`) are added when a registry skill needs them.

`node bin/cli.js validate` checks the field: an array of strings, each `npm:`, `go:` or
`file:` followed by a plain value (`file:` paths must be safe relative paths), and none on a
`workstation-only` skill (it would never install in a thread). `skf` ignores the field
everywhere else.

### 2. Initial signals

Only skills a stack signal clearly calls for. Process skills (`coding-discipline`,
`security-baseline`, `code-quality`, `testing-strategy`) are not stack-specific and get none.

| Skill | Signals |
|---|---|
| `frontend-engineering` | `npm:react`, `npm:vue`, `npm:svelte`, `npm:@angular/core`, `npm:solid-js`, `npm:preact` |
| `llm-integration` | `npm:@anthropic-ai/sdk`, `npm:@anthropic-ai/claude-agent-sdk`, `npm:openai`, `npm:ai`, `npm:@google/genai`, `go:github.com/anthropics/anthropic-sdk-go`, `go:github.com/openai/openai-go` |
| `supabase-postgres` | `file:supabase/config.toml`, `npm:@supabase/supabase-js` |
| `vercel-deploy` | `file:vercel.json`, `npm:vercel` |
| `fvm-flutter` | `file:.fvmrc`, `file:.fvm/fvm_config.json` |

Answer to the requirement's open question: today the registry has `frontend-engineering`
for React/Vite UIs and `llm-integration` for SDK calls; there is no TypeScript, Node or Go
skill, so those stacks get no suggestion until one exists (Go is
DEF-20261126-go-skill-for-go-repos-no-go-specific-ski-qop0). Dev dependencies count,
because `vite`, `typescript` and test tooling usually live there.

### 3. `skf-cloud.mjs doctor`: `D-skill-suggested`

- Reads `registry.json` at the environment's recorded `SKF_REF` (the commit install used,
  so a suggested skill and version are ones `install --top-up` can install). With
  `--offline`, without an install state, or when the fetch fails, the check is skipped; a
  failed fetch adds one `D-skill-suggest-unchecked` note (severity note, owner thread).
- For each cloned repo, collects the skills whose signals match, then drops any that are:
  workstation-only; already installed in `~/.claude/skills`; declared by that repo
  (`skills.dependencies` or `skills.local`); or committed in its `.claude/skills/`.
- One finding per repo that has suggestions:
  - id `D-skill-suggested`, severity `note`, owner `thread-pr`
  - evidence: `<repo> uses a stack with registry skills it does not declare: frontend-engineering (npm:react), llm-integration (npm:@anthropic-ai/sdk)`
  - fix: `PR in <repo>: add to skill-forge.json skills.dependencies: "frontend-engineering": "^0.3.1", "llm-integration": "^0.1.0" (create the file as {"schemaVersion": 2, "skills": {"dependencies": {...}}} if it has none). After merge, run node ~/.claude/skill-forge/skf-cloud.mjs install --top-up; a workstation checkout runs skf sync to update the lock. Skip a skill the repo does not want.`
  - The range is a caret on the version at `SKF_REF`.
- Reading stays within the existing limits: `package.json` through `readRepoJson`, `go.mod`
  through `readText` with the same size cap; symlinks out of the repo are not followed.
- A note never changes `--check`'s exit code.

## Contracts

| Interface | Before | After |
|---|---|---|
| `registry.json` skill entry | no `suggestFor` | optional `suggestFor: string[]`; old readers ignore it |
| doctor JSON | `version: 1`; findings as today | `version: 1` unchanged; two new finding ids, both `note` |
| doctor exit code (`--check`) | issues only | unchanged |
| `skill-forge.json`, locks, `state.json`, `~/.claude` layout, declaration variables | — | unchanged |
| `skf` CLI | — | `validate` checks the new field; nothing else changes |

The steward skill acts on findings by owner and names only some ids, so a new id needs no
doctor JSON version bump. An older `skf-cloud.mjs` ignores `suggestFor`.

## Alternatives considered

- **Match registry `tags`** against the stack. Rejected: tags describe the skill
  (`review-lens`, `tier-3`), not the stack, and a tag like `node` on `vercel-deploy` would
  suggest it to every Node repo.
- **Record the signal map in `state.json` at install**, so doctor works offline. Rejected
  for v1: it changes `state.json`, and doctor already needs the network for `D-ref-behind`.
- **Doctor installs the suggestion** (`--top-up` with suggestions). Rejected: the repo's
  manifest is the declaration; installing undeclared skills makes threads differ from
  local sessions.
- **An opt-out list in `skill-forge.json`** for suggestions a repo rejects. Deferred: it
  changes the manifest format; the note is cheap to ignore. Add it if notes become noise.

## Acceptance criteria

1. A repo with `react` in `devDependencies` and no declaration gets `D-skill-suggested`
   naming `frontend-engineering` with its caret range, owner `thread-pr`, severity `note`.
2. The same repo declaring the skill, or the environment having it installed, or a
   committed `.claude/skills/frontend-engineering/`, gets no suggestion for it.
3. A `go.mod` `require` (single-line and block form) and a `file:` path both match.
4. A workstation-only skill with signals fails `validate`; a malformed signal fails
   `validate`.
5. `--offline` and a missing state skip the check with no finding; a failed fetch gives one
   `D-skill-suggest-unchecked` note.
6. Suggestions never change `--check`'s exit code.
7. Existing doctor tests pass unchanged.

## Tests and verification

- `test/skf-cloud.test.mjs`: doctor cases for criteria 1–3, 5 and 6 against the fixture
  mirror (`SKF_BASE` absolute path) with a fixture registry carrying `suggestFor`.
- `test/cli.test.mjs`: `validate` cases for criterion 4.
- Gates: `npm test` (pass, fail and skip counts), `node bin/cli.js lock`,
  `node bin/cli.js validate`.

## Rollout and rollback

Projects follow `main`, so the doctor change reaches a Project at its next environment
rebuild after `dev` is fast-forwarded to `main`; no pin move is needed. Rollback: revert the
commit; older registries without `suggestFor` simply produce no suggestions.

Docs: README's doctor paragraph mentions suggestions; the `claude-project-steward` skill
gets one line on `D-skill-suggested` (open the repo PR, or tell the owner when the repo
belongs to another Project), with a version bump.
