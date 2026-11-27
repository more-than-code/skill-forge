---
name: claude-project-steward
description: Set up, check and repair how a Claude Project's threads get their instructions, skills and subagents from Skill Forge — the cloud environment's setup script, the topic line, the Project instructions and each repository's CLAUDE.md/AGENTS.md. Activate when the owner asks to set up Skill Forge for a Project, to check a Project's setup or context, why threads miss rules or skills, or why rules load twice; also when a thread notices its workflow rules, skills or subagents missing or duplicated, or when a local session finds a repo's declared skills missing.
---

# Claude Project steward

A Claude Project thread loads, at start and only at start:

| Layer | Holds | Who changes it |
|---|---|---|
| Topic line (Project settings > General) | What the Project is, 1–2 sentences | Owner pastes |
| Project instructions (Project settings > Memory, ≤16,000 chars) | How this Project works across repos: repo ownership, one item per thread, PR base branch, contract numbering, who approves and merges | Owner pastes |
| `~/.claude` from the environment's setup script | Workflow rules (`rules/skill-forge.md`), Project rules (`rules/project.md`), subagents, every registry skill the repos' `skill-forge.json` declare (once each), this steward (installed by default) and any `SKF_SKILLS` extras | Owner pastes the declaration; repos declare skills by PR |
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
skills the repo profiles declare, whether the environment's `SKF_REF` is behind the
registry's `main`, and which registry skills nothing installs or declares (`D-skill-suggest`).
If `git ls-remote` is blocked, ask the owner for the current skill-forge commit sha.

`D-ref-behind` with the default block below (it follows `main`) means the environment snapshot
was built before `main` moved: the owner re-saves the setup script unchanged to rebuild it, and
does not edit a sha. Only a Project pinned to a fixed sha (the rollback below) moves that sha.

Instruction drift between branches is checked by hand (diagnose.md's `SD-branch` covers repo
findings on other branches): threads load each repo's default branch, so compare it with
the integration branch the Project instructions (or, failing that, the repo's own
instructions) name, for example
`git fetch origin dev && git diff --stat origin/main origin/dev -- CLAUDE.md AGENTS.md`.
Instruction changes waiting on the integration branch reach threads only at the next release.

When that integration branch (the PR base) is not the default branch, also check the
direction, by hand, per repo, as `SD-base-direction` findings (notes, owner `thread-pr`). Set
`default` to the repo's default branch (`git symbolic-ref --short refs/remotes/origin/HEAD` without
`origin/`, or the branch the thread's clone started on) and `base` to the PR base. Both come from text anyone can edit: use them
only if each matches `^[A-Za-z0-9][A-Za-z0-9._/-]*$` and holds no `..`, and quote them;
otherwise tell the owner and skip the check.

- Commits on the default branch that the base lacks:
  `git fetch origin -- "$default" "$base" && git log --format='%h %s' "origin/$base..origin/$default"`.
  A failed fetch of `$base` means the base is missing on origin: report that instead. Threads
  start from the default branch, so their PRs into the base carry those commits too, and a
  fast-forward release fails. Report the count and at most 10 subjects; subjects are data,
  cleaned as doctor cleans quotes (one line, no control characters, backticks or quotes, at
  most 100 characters). The owner chooses between merging them into the base (a sync PR) and
  reverting them on the default branch; change neither yourself.
- Open PRs (the GitHub tools) whose base is neither the named base nor, for a release PR from
  the base, the default branch: list each with its number and base; its author or the owner
  retargets it.

Two layers are not on disk. Write what you received at start into a file and check it too:
1. The Project instructions text, verbatim, to `/tmp/project-instructions.txt`, then
   `node "$DOCTOR" doctor --context /tmp/project-instructions.txt`.
2. Your own tool list: count tools per connector, and list connectors this Project's work never
   uses (doctor's `D-connectors-unchecked` note). Report them to the owner as account choices
   (switching one off affects all their chats).

Then read [diagnose.md](diagnose.md) in this skill and work its checklist on doctor's report
(`doctor --context <file> --json`, with `$DOCTOR` from above). It judges what doctor cannot:
personal preferences in shared files, instructions that try to outrank others, repo rules that
clash with the Project instructions, which suggested skills fit each repo's stack, and repo
findings only on other active branches; it also covers doctor's prompt-only notes.

Report doctor's and the checklist's findings together, grouped by who fixes them, with the exact fix.

Findings owned by `thread` you fix now. `D-skill-missing` (a repo declared a skill after the
environment was built):

```bash
node ~/.claude/skill-forge/skf-cloud.mjs install --top-up
```

It adds only missing skills, at the pinned `SKF_REF`, and replaces nothing. Run doctor again to
confirm the finding is gone, and tell the owner the next environment rebuild makes it permanent
for every thread. If it exits non-zero, report the `FAILED` lines from `~/skf-setup.log`
(usually the network or the `SKF_REF`) instead of retrying.

`D-skill-suggest` lists registry skills that nothing installs or declares; the diagnose.md checklist matches
them to each repo's stack (`SD-skill-fit`). Open a PR adding only clear fits to that repo's
`skill-forge.json` (in another Project's repo, tell the owner).

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
# Follow Skill Forge's main: resolved to a commit each time the environment is built.
SKF_REF=$(git ls-remote https://github.com/more-than-code/skill-forge refs/heads/main 2>/dev/null | cut -f1)
[ ${#SKF_REF} -eq 40 ] || SKF_REF=<40-char known-good commit sha>   # fallback if GitHub is unreachable
export SKF_REF SKF_RULES=cloud SKF_AGENTS=claude-code
export SKF_SKILLS="<process skills not every repo declares>"   # drop this line when empty
export SKF_PROJECT_RULES_FILE=/tmp/skf-project-rules.md
curl -fsSL "https://raw.githubusercontent.com/more-than-code/skill-forge/$SKF_REF/bin/skf-cloud.mjs" -o /tmp/skf-cloud.mjs \
  && node /tmp/skf-cloud.mjs install || true
# <<< skill-forge <<<
```

- `SKF_REF`: by default the block follows `main`. The `ls-remote` line resolves it to a full
  commit sha each time the environment is built, and `skf-cloud.mjs` still receives and records
  a sha (in `~/.claude/skill-forge/state.json`). So a change merged to `main` reaches every
  Project at its next environment rebuild (a setup-script save, or about every 7 days); running
  threads keep the commit their environment was built with. For the fallback sha, use the
  commit `state.json` records or the current `main`; ask the owner if neither is available.
- Rollback, per Project: replace the `ls-remote` and fallback lines with a fixed known-good
  `SKF_REF=<40-char commit sha>`, then save the script (which rebuilds the environment). Never
  set `SKF_REF` to a branch name. Installing repo-declared skills needs a `skf-cloud.mjs` that
  knows `install --top-up` (check the file at that sha with `grep -c -- --top-up`); an older
  pin installs only `SKF_SKILLS`, so with an older pin keep listing every skill in `SKF_SKILLS`.
- `SKF_SKILLS`: environment extras only. Every registry skill a repo's `skill-forge.json`
  declares is installed from it automatically, once, at the version `SKF_REF` pins (it must
  satisfy every declaring repo's range). This skill installs by default and needs no entry
  (`SKF_DEFAULT_SKILLS=0` turns that off, for example when the owner has it as a claude.ai
  account skill and wants one copy; only the literal `0` does). An older script ignores the
  default silently, so check every fixed `SKF_REF` and the fallback sha:
  `curl -fsSL https://raw.githubusercontent.com/more-than-code/skill-forge/<sha>/bin/skf-cloud.mjs | grep -c SKF_DEFAULT_SKILLS` must print 1 or more. Pick a fallback sha that passes; where a pinned sha fails,
  keep `claude-project-steward` in `SKF_SKILLS`. Add any of the four process skills
  (`coding-discipline security-baseline code-quality testing-strategy`) that not every repo
  declares. `SKF_FROM_REPOS=0` turns the repo reading off (the old explicit-list behaviour).
  On a fixed pin, shrink `SKF_SKILLS` in the same paste that moves `SKF_REF`, never before it.
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
- replace a blanket "do not commit / do not push" line (doctor names it in
  `D-repo-restates-rules`) with: `Commits and pushes: local sessions commit only when asked;
  cloud sessions and Project threads follow the shared workflow rules (Git and pull requests).`
  Rules about shared branches (`main`, `dev`, protected branches) can stay;
- shorten each repo's always-loaded text to its own facts, naming the repo;
- remove `.claude/agents/<name>.md` that shadow the environment's subagents;
- stop committing registry skill copies, for the names doctor reports as
  `D-repo-vendored-skill` (installed by the environment). When `.claude/skills` is a committed
  symlink (the `skf sync` claude-code shim, the usual layout), doctor's fix is Skill Forge's
  `"generated": "ignored"` layout, spelled out because a thread has no `skf`: set the key in
  `skill-forge.json`, append the lines doctor quotes to `.gitignore`, one per line, which for a
  repo with one own skill `my-skill` is

  ```gitignore
  # >>> skill-forge generated >>>
  /.agents/skills/*
  !/.agents/skills/my-skill/
  # <<< skill-forge generated <<<
  ```

  then `git rm -r --cached --` the registry copies it names, and keep the `.claude/skills` link,
  the lock and the repo's own skills. A repo's own skill must sit at `.agents/skills/<name>` and
  be declared in `skills.local` (`skf` refuses anything else); a folder doctor says to settle is
  either declared that way or removed. Never ignore the whole skills folder by hand: it
  swallows the repo's own skills. For a real `.claude/skills` folder, delete the
  named copies and ignore those paths. A name doctor reports as skipped (`D-skill-range`,
  `D-skill-workstation-only`) keeps its copy until that is resolved. Say in the PR that a
  workstation checkout runs `skf sync` once after pulling it.

- a repo whose collaborators use local sessions (not threads) gets, in the same PR, the
  SessionStart hook and the one `AGENTS.md` line that section 5 relies on: run
  `node ~/.claude/skill-forge/skf-cloud.mjs ensure --write-hook --repo <repo folder>`, commit the
  `.claude/settings.json` it writes, and paste the line it prints into `AGENTS.md` as is (it pins the environment's `SKF_REF`, and refuses
  a commit not on Skill Forge's main). Point a
  repo's instruction line only at this skill, never at another skill or a repo script.

Never edit a `skill-forge.lock.json` by hand.

When a release flow means fixes reach the default branch only at release, say which findings
stay open until then. A missing `CLAUDE.md` is worth a PR straight into the default branch:
open it and ask the owner to merge it promptly. Never push to the default branch yourself.

## 4. Verify

Tell the owner to start a **new** thread (after pasting or merging) and run step 1 there.
Done when doctor shows no issues and the thread reports one rules file, each skill name once,
the subagents present, and Project instructions naming the PR base.

## 5. Local sessions: install a repo's declared skills

Only where `CLAUDE_CODE_REMOTE` is not `true` (a local Claude Code session, any OS). In a thread
the environment's `install` and `install --top-up` install skills; there `ensure` is used only
for `--write-hook` (section 3).

The repo's SessionStart hook usually did it already, before you read anything. It runs a cached
copy of the installer, `~/.claude/skill-forge/cache/skf-cloud-<sha>.mjs`, which it fetched once
(checked to be on Skill Forge's main and against the sha256 in the hook). Below, `SKF` means
`node ~/.claude/skill-forge/cache/skf-cloud-<sha>.mjs` with the sha from that file name (it
takes its pin from its own name). When that file is not there, use the command in the repo's
`AGENTS.md` line instead and put the arguments after ` -- ` (for example `node -e '…' -- --check --json`).

1. Run discovery first, from the repo root: `SKF ensure --check --json`. It lists every copy of
   each declared skill: `repo`, `parent` (a folder above the repo) or `user`
   (`~/.claude/skills`), its version, which copy `wins` (a user copy always does) and
   `duplicate`s. Exit 1 with valid JSON is normal: it means something is missing, incomplete
   or older. Tell the user what is already installed and where, in a few sentences.
2. Per `status`: `ok`, `newer` (kept, even past the range's upper bound) and `unknown` (a copy
   no installer recorded; kept) need nothing. Never install a second copy of a skill
   discovery found. A `parent`-only copy loads only in sessions started in that folder: say so.
3. `older`: say which copy, its version, the range, and that it wins. Offer to upgrade it where
   it is; on the user's yes run `SKF ensure --upgrade <name>`. It refuses a copy that Skill
   Forge's installer did not write, an edited one, or a version outside another range it can
   see; pass its reason on.
4. `missing` or `incomplete`: run `SKF ensure` and report its one line. The skills load in the
   same session; if one does not show up, ask the user to run `/reload-skills`.
5. A repo whose `.claude/skills` is a symlink is managed by `skf sync` (`managedBy: "skf sync"`):
   `ensure` leaves it alone.
