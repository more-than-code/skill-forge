---
name: claude-project-steward
description: Set up, check and repair how a Claude Project's threads get their instructions, skills and subagents from Skill Forge — the cloud environment's setup script, the topic line, the Project instructions and each repository's CLAUDE.md/AGENTS.md. Activate when the owner asks to set up Skill Forge for a Project, to check a Project's setup or context, why threads miss rules or skills, or why rules load twice; also when a thread notices its workflow rules, skills or subagents missing or duplicated.
---

# Claude Project steward

A Claude Project thread loads, at start and only at start:

| Layer | Holds | Who changes it |
|---|---|---|
| Topic line (Project settings > General) | What the Project is, 1–2 sentences | Owner pastes |
| Project instructions (Project settings > Memory, ≤16,000 chars) | How this Project works across repos: repo ownership, one item per thread, PR base branch, contract numbering, who approves and merges | Owner pastes |
| `~/.claude` from the environment's setup script | Workflow rules (`rules/skill-forge.md`), Project rules (`rules/project.md`), subagents, every registry skill the repos' `skill-forge.json` declare (once each) plus `SKF_SKILLS` extras | Owner pastes the declaration; repos declare skills by PR |
| Each repo's `CLAUDE.md` (= `@AGENTS.md`) on its **default branch** | That repo's facts and its own gates | Threads, by PR |
| Account connectors, plugins, claude.ai skills | Tools | Owner, in claude.ai |

Every line belongs in exactly one layer. Facts behind this table (tested 2026-11-24/25):
- A repo with `AGENTS.md` but no `CLAUDE.md` loads **nothing**. `CLAUDE.md` = `@AGENTS.md` fixes it.
- Every repo's `CLAUDE.md` loads in every thread, whichever repo the task is in: repo text must name its repo and stay short.
- Repos declare registry skills in `skill-forge.json` (with its lock) and commit no copies; the setup script installs each declared name once. A copy committed anyway is listed again as `<repo>:<name>` (the environment copy runs). Skills a repo writes itself (`skills.local`) stay committed.
- A subagent in both: the repo copy wins.
- Path-scoped rules (`paths:` frontmatter) do not load in threads. Put area detail in `AGENTS.md`.
- Threads start from each repo's default branch; the PR tool has no default base, so the Project instructions must name it.
- Nothing you change reaches the **current** thread, with one exception: `install --top-up` adds a missing skill that becomes usable in this thread after a moment. Pasted settings, a changed setup script and merged PRs reach **new** threads; the environment snapshot is rebuilt when the setup script changes or about weekly, so a skill a repo declares after that needs the top-up until then.

You cannot edit Project settings, the environment or the account. You draft the exact text and the owner pastes it. You never merge.

## 1. Diagnose

```bash
DOCTOR=~/.claude/skill-forge/skf-cloud.mjs
if [ ! -f "$DOCTOR" ]; then
  # No setup yet: fetch doctor at a pinned commit, never from a moving branch.
  REF=$(git ls-remote https://github.com/more-than-code/skill-forge refs/heads/main | cut -f1)
  curl -fsSL "https://raw.githubusercontent.com/more-than-code/skill-forge/$REF/bin/skf-cloud.mjs" -o /tmp/skf-cloud.mjs \
    && DOCTOR=/tmp/skf-cloud.mjs
fi
node "$DOCTOR" doctor
```

`doctor` is read-only. It checks the installed setup against what it recorded, every repo under
`/home/user` (missing `CLAUDE.md`, managed Skill Forge blocks, duplicated sections, size,
workstation-only rules, skills and agents that duplicate or shadow the environment's) and the
skills the repo profiles declare, and whether the pinned `SKF_REF` is behind the registry.
If `git ls-remote` is blocked, ask the owner for the current skill-forge commit sha.

Branch drift is checked by hand: threads load each repo's default branch, so compare it with
the integration branch the Project instructions name, for example
`git fetch origin dev && git diff --stat origin/main origin/dev -- CLAUDE.md AGENTS.md`.
Instruction changes waiting on the integration branch reach threads only at the next release.

Two layers are not on disk. Write what you received at start into a file and check it too:
1. The Project instructions text, verbatim, to `/tmp/project-instructions.txt`, then
   `node "$DOCTOR" doctor --context /tmp/project-instructions.txt`.
2. Your own tool list: count tools per connector, and list connectors this Project's work never
   uses. Report them to the owner as account choices (switching one off affects all their chats).

Report findings grouped by who fixes them, with the exact fix.

Findings owned by `thread` you fix now. `D-skill-missing` (a repo declared a skill after the
environment was built):

```bash
node ~/.claude/skill-forge/skf-cloud.mjs install --top-up
```

It adds only missing skills, at the pinned `SKF_REF`, and replaces nothing. Run doctor again to
confirm the finding is gone, and tell the owner the next environment rebuild makes it permanent
for every thread. If it exits non-zero, report the `FAILED` lines from `~/skf-setup.log`
(usually the network or the `SKF_REF`) instead of retrying.

`D-skill-range` has two causes. A repo wants a version the pinned `SKF_REF` does not have: the
owner's fix, so draft a newer `SKF_REF`, or a PR that changes the repo's range. A name that is
not in the registry (a typo, or a skill newer than the pin): a PR that corrects or drops it,
or a newer `SKF_REF`.

## 2. Draft what the owner pastes

**Setup-script declaration** (Project settings > Environment > setup script). Keep any lines the
owner already has (databases, toolchains); add or replace only the marked block:

```bash
# >>> skill-forge >>>
cat > /tmp/skf-project-rules.md <<'SKF_EOF'
<Project rules that threads need but the coordinator does not; often empty>
SKF_EOF
export SKF_REF=<40-char skill-forge commit sha> SKF_RULES=cloud SKF_AGENTS=claude-code
export SKF_SKILLS="claude-project-steward <process skills not every repo declares>"
export SKF_PROJECT_RULES_FILE=/tmp/skf-project-rules.md
curl -fsSL "https://raw.githubusercontent.com/more-than-code/skill-forge/$SKF_REF/bin/skf-cloud.mjs" -o /tmp/skf-cloud.mjs \
  && node /tmp/skf-cloud.mjs install || true
# <<< skill-forge <<<
```

- `SKF_REF`: the commit `~/.claude/skill-forge/state.json` records, or the latest `main`
  (`git ls-remote https://github.com/more-than-code/skill-forge refs/heads/main`). If neither
  is available, ask the owner for the sha. Never a branch name. Installing repo-declared skills
  needs a `skf-cloud.mjs` that knows `install --top-up` (check the file at that sha with
  `grep -c -- --top-up`); an older pin installs only `SKF_SKILLS`, so with an older pin either
  move it to the latest `main` or keep listing every skill in `SKF_SKILLS`.
- `SKF_SKILLS`: environment extras only. Every registry skill a repo's `skill-forge.json`
  declares is installed from it automatically, once, at the version `SKF_REF` pins (it must
  satisfy every declaring repo's range). Add this skill, plus any of the four process skills
  (`coding-discipline security-baseline code-quality testing-strategy`) that not every repo
  declares. `SKF_FROM_REPOS=0` turns the repo reading off (the old explicit-list behaviour).
  Shrink `SKF_SKILLS` in the same paste that moves `SKF_REF`, never before it.
- Drop the project-rules lines when there is nothing to put there.

**Topic line:** one or two sentences: what the Project is and which repo owns what.

**Project instructions:** Project-level rules only, about 10–15 lines. Always name the PR base
("Pull requests go into `dev`"), even when it is the default branch. Never restate engineering
workflow rules (tiers, gates, review, git hygiene): the environment carries them.

## 3. Fix repositories by PR

One PR per repo, into the base the Project instructions name, on your own branch:
- add `CLAUDE.md` = `@AGENTS.md` where missing;
- remove a Skill Forge managed block (`<!-- >>> skill-forge instructions … -->` to
  `<!-- <<< skill-forge instructions <<< -->`) and workflow rules the environment carries, and
  remove the `instructions.variant`/`version` keys from that repo's `skill-forge.json` in the
  same PR, or a workstation `skf sync` puts the block back (tell the owner a workstation
  checkout may keep stale `claudeMdExcludes` entries until its next `skf sync`);
- move Project-wide sections out of repos (into the Project-instructions draft); keep one copy;
- shorten each repo's always-loaded text to its own facts, naming the repo;
- remove `.claude/agents/<name>.md` that shadow the environment's subagents;
- stop committing registry skill copies, but only for names doctor reports as
  `D-repo-vendored-skill` (installed by the environment): delete `.claude/skills/<name>/` and
  `.agents/skills/<name>/`, and add those paths to `.gitignore` (a workstation `skf sync` still
  writes them, now ignored). A name doctor reports as skipped (`D-skill-range`,
  `D-skill-workstation-only`) keeps its copy until that is resolved. Keep `skill-forge.json`,
  `skill-forge.lock.json` and every `skills.local` skill. When `.claude/skills` is a committed
  symlink (the `skf sync` claude-code shim, usually to `../.agents/skills`), doctor reports it
  once per repo: remove the link and the registry copies behind it and ignore both, or, if the
  repo has its own `skills.local` skills there, keep the link and remove only the registry copies.
  Say in the PR that a workstation checkout runs `skf sync` once after pulling it.

Never edit a `skill-forge.lock.json` by hand.

When a release flow means fixes reach the default branch only at release, say which findings
stay open until then. A missing `CLAUDE.md` is worth a PR straight into the default branch:
open it and ask the owner to merge it promptly. Never push to the default branch yourself.

## 4. Verify

Tell the owner to start a **new** thread (after pasting or merging) and run step 1 there.
Done when doctor shows no issues and the thread reports one rules file, each skill name once,
the subagents present, and Project instructions naming the PR base.
