# skf-cloud installs the steward skill by default (spec)

Status: approved by Joe 2026-11-27 ("Yes, approve. Go ahead."). Tier 3: it adds a declaration
variable to `bin/skf-cloud.mjs` and changes what `install` writes for every Project.
Tracks Defect Drainer requirement DEF-20261127-skf-cloud-installs-claude-project-stewar-xn7x.

## Goal

Every Project's setup script runs `skf-cloud.mjs install`, and every one of them repeats
`export SKF_SKILLS="claude-project-steward"`. The steward is environment-level (it manages
the Project's setup) and no repo declares it, so `SKF_SKILLS` is its only way in. Joe
(2026-11-27): the script that the setup already runs should install it itself.

After this change a setup block with no `SKF_SKILLS` line still gives every thread
`~/.claude/skills/claude-project-steward/`.

## Changes

### `bin/skf-cloud.mjs install`

- New constant `DEFAULT_SKILLS = ['claude-project-steward']`.
- `readDeclaration` builds the environment-level list as `SKF_SKILLS` followed by
  `DEFAULT_SKILLS`, without duplicates (first spelling wins), unless `SKF_DEFAULT_SKILLS=0`.
  Everything downstream already treats that list as the higher level: each name gets source
  `env`, is installed once at the `SKF_REF` version, wins over a repo that also declares it,
  and a failure is recorded in `failed` like any `SKF_SKILLS` name.
- The log line adds `defaults=<names>` or `defaults=off`, so `~/skf-setup.log` shows where
  the steward came from.
- `install --top-up` is unchanged: it adds only repo-declared skills, and the steward is
  already in `skillSources` from setup.

### `SKF_DEFAULT_SKILLS` (new, optional)

- Unset or any value but `0`: defaults on.
- `0`: no default skills, the behaviour before this change. For a Project that does not want
  the steward in its threads (for example one that uploads it as a claude.ai account skill
  and does not want two copies listed), or as a per-Project rollback.

One switch, not a list: there is one default today, and a list variable would be a second
`SKF_SKILLS`. If more defaults are added later, `0` still turns them all off.

### Back-compat

- A script that still has `SKF_SKILLS="claude-project-steward ..."`: the name is already in
  the list, so one copy, no warning, no doctor finding. Owners can drop it from the script
  whenever they next edit it; nothing requires it.
- A Project pinned to a fixed `SKF_REF` older than this change runs the older
  `skf-cloud.mjs` and keeps its current behaviour; keep listing the steward there.
- A repo `skill-forge.json` that declares the steward: unchanged (the environment level
  already wins today when `SKF_SKILLS` lists it; now it always does).

### `doctor`

- No new finding ids and no change to the output format. `D-skill-unused` already exempts the steward
  (`ALWAYS_USEFUL_SKILLS`), and `D-skill-suggest` lists only skills that are not installed,
  so it never suggests the steward once it is installed. One existing finding now applies
  in more Projects: a repo that commits its own copy of the steward in `.claude/skills` gets
  `D-repo-vendored-skill`, as it already did where `SKF_SKILLS` listed the steward.
- `D-install-failed`'s fix text says "usually a wrong name in SKF_SKILLS"; unchanged, since a
  default can fail only for a network or `SKF_REF` problem, which the same text covers.

### Docs and the steward skill

- `README.md` setup block: drop the `export SKF_SKILLS=...` line; the `SKF_SKILLS` bullet says
  the steward is installed by default and `SKF_DEFAULT_SKILLS=0` turns that off.
- `inventory/skills/claude-project-steward/SKILL.md`: the drafted setup block lists only
  `SKF_SKILLS="<process skills not every repo declares>"` (and drops the line when empty);
  the `SKF_SKILLS` bullet says the same as the README. The note about older pins keeps saying
  "keep listing every skill in `SKF_SKILLS`".
- `inventory/skills/claude-project-steward/diagnose.md` (added by PR #10): `SD-skill-fit`
  says the steward is installed by default, instead of "it goes in `SKF_SKILLS`".
- Steward version bump in `registry.json` (0.2.7 if PR #10's 0.2.6 merges first), then
  `node bin/cli.js lock` and `validate`.
- `bin/skf-cloud.mjs` header comment names `SKF_DEFAULT_SKILLS`.
- `docs/DESIGN.md` decision log: one row for this decision.

## Contract diff

| Interface | Before | After |
|---|---|---|
| Declaration variables | `SKF_REF`, `SKF_BASE`, `SKF_RULES`, `SKF_AGENTS`, `SKF_SKILLS`, `SKF_PROJECT_RULES_FILE`, `SKF_FROM_REPOS`, `SKF_REPOS_DIR`, `SKF_DEADLINE_MS` | same, plus optional `SKF_DEFAULT_SKILLS` (`0` = off) |
| Installed skills | `SKF_SKILLS` ∪ repo-declared | `SKF_SKILLS` ∪ `claude-project-steward` ∪ repo-declared |
| `state.json` | `skills` = `SKF_SKILLS` names | `skills` = environment-level names (`SKF_SKILLS` plus defaults); no new fields, `version` stays 2. Older readers see a normal `env` skill |
| Doctor JSON | — | unchanged, `version` stays 1 |
| `~/.claude` layout | — | unchanged |
| `~/skf-setup.log` | `... skills=<list> from-repos=...` | `skills=` shows the merged list, plus `defaults=<names>` or `defaults=off` |

## Alternatives considered

- Keep listing it in every setup script: what Joe asked to stop.
- A `default: true` field on the skill in `registry.json`: moves the choice into the registry
  and adds a field to its format for one skill; hardcoding one name in the script that
  already knows the steward (`ALWAYS_USEFUL_SKILLS`) is smaller.
- Default all process skills too: out of scope; repos declare those for their stack.
- No opt-out: smaller still, but then a Project has no way to say no short of pinning an old
  `SKF_REF`. One `=== '0'` check, mirroring `SKF_FROM_REPOS=0`, is the cheap way out.

## Acceptance criteria

1. Install with no `SKF_SKILLS` writes `~/.claude/skills/claude-project-steward/` and records
   it in `state.json` `skills` with source `env`.
2. `SKF_SKILLS="claude-project-steward"` gives the same result: one copy, the name once in
   `state.json`.
3. `SKF_DEFAULT_SKILLS=0` with no `SKF_SKILLS` installs no steward (behaviour before).
4. A repo declaring the steward does not make it repo-sourced while defaults are on.
5. Doctor on 1 and 2 reports no `D-skill-unused`, `D-skill-suggest` entry or other finding
   about the steward.
6. Existing tests pass unchanged except where they assert the exact installed skill set or
   `skillSources`; those are updated and named in the PR.

## Tests

In `test/skf-cloud.test.mjs`: one test per acceptance criterion 1 to 5, using the existing
local-mirror fixtures (`SKF_BASE` as an absolute path).

## Verification

`npm test` (pass, fail and skip counts), `node bin/cli.js lock`, `node bin/cli.js validate`.

## Rollout and pin move

No pin move is needed for Projects whose setup block follows `main`: after Joe fast-forwards
`main`, each Project picks it up at its next environment rebuild. Projects pinned to a fixed
sha get it only when that sha moves. Removing the now-redundant `SKF_SKILLS` line from each
setup script is optional and an owner paste; the steward drafts it the next time it touches
a Project's setup.

Rollback: per Project, `export SKF_DEFAULT_SKILLS=0`; globally, revert the commit on `dev`
and `main`.

## Coordination

PR #10 (skf-diagnose folded into the steward) edits the steward's `SKILL.md`, adds
`diagnose.md` and bumps the steward to 0.2.6. This change touches different lines of
`SKILL.md` (the setup block in section 2) plus one line of `diagnose.md`, so it is built on
`dev` after PR #10 merges, with the next version bump.
