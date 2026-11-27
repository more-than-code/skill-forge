# Installing a repo's declared skills on any machine (proposed, not built)

Status: **spec awaiting the owner's approval** (Tier 3: it adds an `skf-cloud.mjs`
command, a repo-local state file and doctor behaviour). Tracked in Defect Drainer as
`DEF-20261127-local-windows-friendly-install-of-a-repo-kf8u`.

## Goal

`skill-forge.json` is tracked like `package.json`; the skills it declares are installed
per machine, like `node_modules`. Cloud threads get them from the environment's setup
script (`skf-cloud.mjs install`). A collaborator on local Claude Code (any OS, no `skf`,
possibly non-technical) gets nothing today, so the repo's declared skills never load.

This adds one platform-agnostic way to make a checkout's declared skills present: it
finds them where the agent already looks, keeps any copy at or above the declared version,
warns loudly about an older one, installs only what is missing into the repo, changes no
tracked file, and runs on its own when a session starts.

It finishes a design already in the decision log (2026-11-25): the installer's resolver
"is designed to take a target, repo dirs and a higher-level set", with "repo-rooted
sessions (target `<repo>/.claude`, `$HOME` higher)" named as later work.

Generic, not Windows-specific: the core is tool-neutral and OS-neutral; Claude Code is the
first (and today only) trigger.

**The steward owns it** (Joe, 2026-11-27, DD note): the bootstrap is the existing
`claude-project-steward` skill, not a new skill or a repo script. Skill Forge publishes one
copy-ready `AGENTS.md` line that points at the steward and carries the pinned one-line
command that gets the steward onto a machine that lacks it; the steward then installs the
declared skills that are missing. The SessionStart hook stays the deterministic trigger,
so nothing depends on the agent reading the line. A repo's instruction line points at the
steward, never at another skill or a repo-specific script. (This supersedes the item's
earlier "the repo will not carry an instruction line".)

Three pieces, one mechanism: the **`ensure` command** (section 1) does the finding,
comparing and installing; the **steward** (section 4) is the agent-facing entry point and
runs `ensure`; the **hook** (section 5) runs the same command without the agent.

## Non-goals

- No change to `skf sync`, `skill-forge.json`, `skill-forge.lock.json` or their formats.
- No workflow rules, subagents or other default skills (the steward is the one exception,
  section 2); no scan of sibling repos.
- No install logic in skill prose: the steward runs `ensure`, it does not re-describe it.
- No global install of `skf`, no npm package, no symlinks.
- Project threads: unchanged. They ignore `.claude/settings.json`, so the environment's
  `install` keeps doing the work there.

## Design

### 1. Core: `skf-cloud.mjs ensure [--repo <dir>] [--check] [--json] [--hook]`

A new subcommand of the existing single-file installer (Node 18+, built-ins only).

1. **Repo and manifest.** The repo is `--repo`, else the git top level of the working
   directory, else the working directory. It reads `skill-forge.json`
   `skills.dependencies` (registry skills only; `skills.local` names are the repo's own).
   No manifest or no dependencies: nothing to do, silent.
2. **Defer to skf sync.** If `<repo>/.claude/skills` is a symlink (the `skf sync`
   layout), `ensure` changes nothing and says once that `skf sync` manages this repo.
3. **Discover before install** (the point of the feature: never reinstall or duplicate
   a skill that is already there). For each declared name it records every copy at
   `<dir>/.claude/skills/<name>/SKILL.md` for every folder from the working directory up
   to the filesystem root, and `~/.claude/skills/<name>/SKILL.md`, and labels each:
   - **repo**: inside this repo (the working directory up to the repo root);
   - **parent**: in a folder above the repo root, such as an umbrella workspace;
   - **user**: `~/.claude/skills`.

   Claude Code reads project skills from the session's start folder and its parents up
   to the repository root, and ranks personal (user-level) skills above project skills
   ([docs](https://code.claude.com/docs/en/skills.md)). So a **user** copy always wins;
   a **parent** copy loads when the session starts in that parent folder (the umbrella
   case), not when it starts inside the repo.
   - Any copy found counts as present: `ensure` installs nothing for that name, so there
     is never a second copy. A **parent**-only copy is reported once ("found in <dir>;
     it loads when a session starts there") and not duplicated into the repo.
     `--include-parent-copies=no` (open item) would install a repo copy instead.
   - More than one copy already (for example repo and user): reported as a duplicate,
     naming which one wins; `ensure` removes nothing it did not install.
4. **Version of a found copy.** Versions are never in frontmatter (AGENTS.md), so they
   come from installer state: `~/.claude/skill-forge/state.json` (`versions`) for a
   user-level copy, the repo state file (below) for a repo copy, and the repo's
   `skill-forge.lock.json` for a copy `skf sync` committed. A copy no state knows
   (hand-installed, third-party) counts as present and is never touched.
5. **Decide per name: the installed copy is respected unless it is older than declared**
   (Joe, 2026-11-27: "the version pinning should be respected if the declared version is
   higher than the installed version; there should be a shout-out or an error; otherwise
   it should be respected". Read here as: an installed copy older than the declared
   version gets a loud warning; one at or above it is kept as is and never reinstalled.
   Correct this reading if it is wrong.)
   - **At or above the declared minimum** (the version in the range, `^0.2.0` -> 0.2.0):
     kept, nothing installed. That includes a copy newer than the range's upper bound
     (0.3.0 against `^0.2.0`): it is reported once as "newer than declared, kept", not
     replaced.
   - **Unknown version** (no state knows the copy): kept, reported as "version unknown".
   - **Older than declared**, the copy that wins (user, or the repo/parent copy when there
     is no user copy): a **warning that names the copy, its version, the declared range
     and which copy wins**, shown to the user every session until fixed (hook
     `systemMessage`, and the steward repeats it); `--check` exits 1 for it. It is never
     silently replaced: a user-level copy is the user's, and a repo copy cannot override it.
     The one exception is a repo copy `ensure` itself installed: that one is reinstalled
     at the pinned version, and the line says so.
   - **Missing**, or a copy `ensure` owns with files missing on disk: install into
     `<repo>/.claude/skills/<name>/`.
6. **Which version.** The registry commit in `skill-forge.lock.json`
   (`registry.commit`) when the repo has a lock, else the commit the script itself was
   fetched at (`--ref`, written into the hook). Same rule as `install`: install only if
   that version satisfies the range, else report a skip.
7. **Ownership and writes.** Reuses `planInstall`/`applyInstall` with the target as a
   parameter (the resolver's "target"), so the existing rules hold: verify each file
   against `registry-lock.json`, never write through a symlink, adopt identical bytes,
   keep a file edited since install, leave anything not recorded alone. Other folders in
   `.claude/skills` are untouched.
8. **Repo state.** `<repo>/.claude/skill-forge/state.json`, the same shape as the
   environment's state (`version`, `ref`, `versions`, `files`, `skillSources`,
   `skipped`, `failed`), `files` keys limited to `<repo>/.claude/skills/`.
9. **Nothing tracked changes.** Ignore rules go in `.git/info/exclude` (local, untracked:
   the same file the local overlay already uses), one managed block listing each
   installed `/.claude/skills/<name>/` and `/.claude/skill-forge/`. A path git already
   ignores is not added. A tracked path is never written.
10. **Disk, not only state.** A name is present only if its `SKILL.md` exists on disk.
    The same fix goes into `install --top-up`: a recorded repo skill whose folder was
    deleted is treated as missing and added again.

11. **`--check`** (read-only, writes nothing, fetches nothing): prints the discovery for
    every declared name: each copy found, its level and version, whether it is older than declared,
    which copy wins, duplicates, and what `ensure` would install. `--json` gives the same
    as JSON (a new, versioned shape: `{"version": 1, "skills": [...]}`). The steward runs
    this first, so it can tell the user what is already installed before anything is.

### 2. Getting the steward too

`ensure` also installs `claude-project-steward` into `<repo>/.claude/skills/` when no
copy is found at the levels above (same finding and version rules, range: any version at
the pinned commit), whether or not the repo declares it. That is the "get steward itself
onto the machine" step; `SKF_DEFAULT_SKILLS=0` turns it off, as for `install`.

### 3. Output and exit

- Nothing missing: silent, exit 0.
- Installed: one line, `skill-forge: installed <names> into .claude/skills (<ref short>)`.
- Warnings (out-of-range user copy, skip, offline, fetch failure): one line each, at most
  three, then exit 0 under `--hook`, 1 otherwise.
- `--hook`: output is Claude Code hook JSON (`systemMessage`, plus `reloadSkills: true`
  when it installed something, so the skills load in the same session); it never blocks
  and exits 0 on any failure.
- `CLAUDE_CODE_REMOTE=true` (cloud sessions): `--hook` exits 0 at once.
- Deadline: the existing 90 s fetch deadline, with the hook's own `timeout` as the outer
  bound.

### 4. The steward: one published line, and a local-session section

**The published line.** The steward's README section and the skill itself carry one
copy-ready line for a repo's `AGENTS.md` (pinned to the sha of the release that publishes
it):

> Skills: this repo declares skills in `skill-forge.json`. In a local session, use the
> `claude-project-steward` skill to check they are installed; if that skill is missing,
> first run `node -e '<bootstrap, pinned to <sha>>'` from the repo root.

The bootstrap is the same one-line command as the hook's (section 5) without `--hook`, so
it prints its one line to the terminal. Doctor's existing checks treat this line as
repository text: it is not workstation-only (any machine can follow it), and its `node -e`
fetch is pinned to a full sha, so it is not an unpinned remote runner.

**The steward's new section** ("Local sessions: install a repo's declared skills"), used
when `CLAUDE_CODE_REMOTE` is not `true`:
1. run discovery first: `ensure --check --json` from the installed copy
   (`node .claude/skill-forge/skf-cloud-<sha>.mjs`, or the published line's command when
   none is there), and tell the user what is already installed and where (repo, parent
   folder, user level), which copy wins, any duplicates and anything older than declared (a warning);
2. only if something is missing, run `ensure` and report in one line what it installed;
   never suggest reinstalling a skill that discovery found;
3. after an install, the new skills are picked up within the session; if not, tell the
   user to run `/reload-skills`.
The steward's description gains "or when a local session finds a repo's declared skills
missing", and its version goes up (a minor bump). In threads the steward behaves as
today; `ensure` is never its fix there (the environment's `install` and `--top-up` are).

**Where the line goes.** The steward skill's own section 3 ("Fix repositories by PR") adds: a repo
with `skill-forge.json` dependencies and collaborators on local sessions gets the line in
its `AGENTS.md` and the hook in `.claude/settings.json`, in one PR.

### 5. Trigger: a SessionStart hook in the repo

A hook, not an instruction line, so it runs before the agent reads anything. The repo
commits one entry in `.claude/settings.json`:

```json
{ "hooks": { "SessionStart": [ { "matcher": "startup|resume", "hooks": [
  { "type": "command", "timeout": 60, "command": "node -e '<bootstrap, pinned to <sha>>'" }
] } ] } }
```

The bootstrap is a one-line Node program: if
`<repo>/.claude/skill-forge/skf-cloud-<sha>.mjs` is missing it fetches
`bin/skf-cloud.mjs` at the full commit sha over HTTPS into that ignored folder, then runs
it with `ensure --hook --ref <sha>`. Written so the same text works in Git Bash and
PowerShell (the shells Claude Code uses for hooks on Windows): one outer pair of single
quotes, no quotes or `$` inside. A fetch failure warns once and exits 0.

Who writes it: `skf-cloud.mjs ensure --write-hook [--repo <dir>]` merges the entry into
`.claude/settings.json` (creates the file if absent, keeps every other key, replaces only
the entry it recognises by its marker, pins the sha it runs at). A thread runs it and
opens the PR; the steward skill's checklist gains one line for repos with collaborators
on local Claude Code. `skf project init` is unchanged (it refuses existing manifests, so
it cannot serve existing repos).

### 6. Doctor

- `D-repo-settings-ignored`: a `.claude/settings.json` whose only content is this hook is
  not reported (the hook is meant for local sessions; threads ignoring it is correct).
- New note `D-repo-local-hook-pin`: the hook's sha is older than the environment's
  `SKF_REF`; fix: re-run `ensure --write-hook` in a PR.
- Doctor JSON gains only finding ids; its `version` does not change.

### Not folded in

`staleness.mjs` stays as is. It serves workstations that have `skf` and the
`.agents/skills` link, which `ensure` defers to; folding it in would mix two layouts.

## Choice: an older copy at user level or in a parent folder

When the winning copy is older than the repo declares, there are three options:

- **A. Warn, and offer an upgrade of the shared copy in place** (recommended). No repo
  duplicate. `ensure` warns (section 1, step 5); the steward offers to upgrade the
  older copy where it is, and does it only on the user's yes, through
  `ensure --upgrade <name>`. Before offering, it checks that the new version still fits
  every range it can see for that name: this repo's `skill-forge.json`, the parent
  folder's own `skill-forge.json` when there is one, and the ranges recorded in
  `~/.claude/skill-forge/state.json`. If one of those would break, it says which and
  offers nothing. It upgrades only a copy that Skill Forge installed (recorded in a
  state file) and not edited since. A hand-installed copy gets instructions, not a write.
- **B. Install the declared version into the repo as well.** This makes a duplicate. For
  a user-level copy it does not even help: Claude Code ranks personal skills above
  project ones ([docs](https://code.claude.com/docs/en/skills.md)), so the older user
  copy still runs. For a parent copy it helps only in sessions started inside the repo.
- **C. Upgrade the shared copy silently.** Other repos on the machine may rely on that
  copy, so it can break them without a word.

A is recommended because it never makes a copy that cannot win, and never changes a
shared copy without the user's yes. It adds `--upgrade <name>` to the contract diff.

A note on parent folders: Claude Code reads project skills from the session's start
folder up to the repository root. A copy in a folder above the repo root therefore
loads only in sessions started in that folder, not in sessions started inside the repo.

## Open items for the owner

- Older shared copy: option A above (recommended), B or C.

- A copy only in a **parent** folder: report it and install nothing (default here, no
  duplicates), or install a repo copy so a session started inside the repo has it too?
- Name of the command (`ensure`).
- `.git/info/exclude` instead of the `.gitignore` block.

## Contract diff

| Surface | Before | After |
|---|---|---|
| `skf-cloud.mjs` commands | `install`, `install --top-up`, `doctor` | adds `ensure [--repo] [--ref] [--check] [--json] [--hook] [--write-hook]` |
| `ensure --upgrade <name>` | — | upgrades a user-level or parent copy Skill Forge installed, in place, only when the steward asks after the user's yes (option A) |
| `ensure --check --json` | — | new versioned JSON shape (`version: 1`), a public contract from release |
| `install --top-up` | trusts `state.json`; a deleted folder is "nothing to add" | a recorded skill with no `SKILL.md` on disk is added again |
| `~/.claude` layout, `state.json` | unchanged | unchanged |
| Repo files | none written by skf-cloud | ignored `<repo>/.claude/skills/<name>/`, `<repo>/.claude/skill-forge/{state.json,skf-cloud-<sha>.mjs}`; a block in `.git/info/exclude` |
| Committed repo files | — | `.claude/settings.json` hook entry, only via `--write-hook` and a PR |
| Doctor JSON | — | `D-repo-settings-ignored` skips a hook-only settings file; new `D-repo-local-hook-pin`; `version` unchanged |
| `claude-project-steward` skill | threads only | adds the local-session section, the published line and the PR step; minor version bump |
| Repo `AGENTS.md` | — | may carry the one published steward line (by PR) |
| `skill-forge.json`, locks, `skf` CLI | — | unchanged |

All additive: an older `SKF_REF` ignores the new command; nothing that exists today
changes meaning except top-up's disk check, which only adds back what is missing.

## Alternatives considered

- **`install` with `HOME=<repo>`** (the Marketing OS prototype): works, but installs the
  defaults path, writes `~/skf-setup.log` into the repo and has no version check.
- **A Claude Code plugin carrying the hook**: each collaborator has to add the
  marketplace and install the plugin first, so it is not deterministic; the pin follows
  the plugin's version, not a commit. Possible later as a second trigger.
- **`npx github:more-than-code/skill-forge#<sha>`**: pinned, but installs the whole CLI
  and its dependencies on every cold start, needs git, and doctor flags `npx` runners.
- **Repo copies in `.agents/skills/`**: without a symlink Claude Code does not read it.
  `ensure` writes `.claude/skills/` and keeps the target a parameter for other tools.
- **Writing the `.gitignore` block**: changes a tracked file on every local install.

## Rollback

Remove the hook entry from `.claude/settings.json` (a PR). Installed copies are ignored
files; deleting `<repo>/.claude/skills/<name>/`, `<repo>/.claude/skill-forge/` and the
`info/exclude` block returns the checkout to today. Reverting the skf-cloud commit leaves
older pins unaffected.

## Acceptance criteria

0. Discovery finds a declared skill at each level (repo, parent folder, user) and
   `--check --json` lists every copy, its level, version, range result and which one
   wins; with copies at two levels it reports the duplicate and removes nothing.
1. Every declared skill present at user level in range: `ensure` writes nothing, prints
   nothing, exits 0.
2. Some missing: only those land in `<repo>/.claude/skills/`, verified; `git status`
   shows no change.
3. A repo copy deleted on disk (state still lists it): the next run installs it again;
   same for `install --top-up`.
4. User-level copy older than declared: one warning naming copy, version, range and
   which copy wins; nothing installed for it; `--check` exits 1. A copy newer than the
   range's upper bound: kept, one "newer than declared" note, exit 0.
5. Repo with skf's `.claude/skills` symlink: nothing written, one line.
6. Third-party folder in `.claude/skills`: untouched; a file edited since install: kept.
7. `CLAUDE_CODE_REMOTE=true` with `--hook`: exit 0, no output, no writes.
8. Offline or HTTP error: one warning, exit 0 under `--hook`.
9. `--write-hook`: creates or merges `.claude/settings.json`, idempotent, other keys kept.
10. The bootstrap text runs unchanged under bash and PowerShell (`pwsh -Command`).
11. A machine with no steward and nothing installed: the published line's command
    installs the steward and the declared skills; a second run prints nothing.
12. The steward, in a local session with a skill missing, runs `ensure` and reports it;
    in a thread (`CLAUDE_CODE_REMOTE=true`) it does not run `ensure`.
13. Paths built with `path.join` throughout; tests cover a Windows-style home via
    `path.win32` where the code splits paths.

## Tests and verification

- `npm test`, with new cases in `test/skf-cloud.test.mjs` using the existing local-mirror
  fixtures (`SKF_BASE=/abs/mirror`): criteria 1–9 and top-up's disk check.
- Bootstrap: a test that runs the hook command through `bash -c`, and through `pwsh -c`
  when `pwsh` is on PATH (reported as skipped otherwise; this environment has no `pwsh`).
- Windows and macOS end to end: not runnable here; the owner or a collaborator runs the
  hook once in a fresh clone on each.
- `node bin/cli.js lock` and `validate`: the steward skill changes, so both run, after
  `node bin/cli.js skill bump claude-project-steward --minor` (or `set-version`).

## After merge

- Pin move: optional. Threads do not use `ensure`; the steward's new text reaches a
  Project's threads only when its setup script moves to the new `SKF_REF`. A repo that
  wants the line and the hook gets both by PR from a thread at the new sha.
- Workstation: nothing.
