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
finds them where the agent already looks, installs only what is missing or out of range
into the repo, changes no tracked file, and runs on its own when a session starts.

It finishes a design already in the decision log (2026-11-25): the installer's resolver
"is designed to take a target, repo dirs and a higher-level set", with "repo-rooted
sessions (target `<repo>/.claude`, `$HOME` higher)" named as later work.

Generic, not Windows-specific: the core is tool-neutral and OS-neutral; Claude Code is the
first (and today only) trigger.

## Non-goals

- No change to `skf sync`, `skill-forge.json`, `skill-forge.lock.json` or their formats.
- No workflow rules, subagents or default skills; no scan of sibling repos.
- No global install of `skf`, no npm package, no symlinks.
- Project threads: unchanged. They ignore `.claude/settings.json`, so the environment's
  `install` keeps doing the work there.

## Design

### 1. Core: `skf-cloud.mjs ensure [--repo <dir>] [--hook]`

A new subcommand of the existing single-file installer (Node 18+, built-ins only).

1. **Repo and manifest.** The repo is `--repo`, else the git top level of the working
   directory, else the working directory. It reads `skill-forge.json`
   `skills.dependencies` (registry skills only; `skills.local` names are the repo's own).
   No manifest or no dependencies: nothing to do, silent.
2. **Defer to skf sync.** If `<repo>/.claude/skills` is a symlink (the `skf sync`
   layout), `ensure` changes nothing and says once that `skf sync` manages this repo.
3. **Find before install.** For each name it looks where Claude Code resolves skills:
   `<dir>/.claude/skills/<name>/SKILL.md` for every folder from the working directory up
   to the repo root, and `~/.claude/skills/<name>/SKILL.md`. Claude Code ranks personal
   (user-level) skills above project skills
   ([docs](https://code.claude.com/docs/en/skills.md)), so a user-level copy decides.
4. **Version of a found copy.** Versions are never in frontmatter (AGENTS.md), so they
   come from installer state: `~/.claude/skill-forge/state.json` (`versions`) for a
   user-level copy, the repo state file (below) for a repo copy, and the repo's
   `skill-forge.lock.json` for a copy `skf sync` committed. A copy no state knows
   (hand-installed, third-party) counts as present and is never touched.
5. **Decide per name.**
   - present in range, or present with unknown version: nothing;
   - user-level copy out of range: **warn only** (a repo copy would not win), naming the
     copy, its version and the range;
   - missing, or a repo copy `ensure` owns that is out of range or has files missing on
     disk: install into `<repo>/.claude/skills/<name>/`.
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

### 2. Output and exit

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

### 3. Trigger: a SessionStart hook in the repo

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

### 4. Doctor

- `D-repo-settings-ignored`: a `.claude/settings.json` whose only content is this hook is
  not reported (the hook is meant for local sessions; threads ignoring it is correct).
- New note `D-repo-local-hook-pin`: the hook's sha is older than the environment's
  `SKF_REF`; fix: re-run `ensure --write-hook` in a PR.
- Doctor JSON gains only finding ids; its `version` does not change.

### Not folded in

`staleness.mjs` stays as is. It serves workstations that have `skf` and the
`.agents/skills` link, which `ensure` defers to; folding it in would mix two layouts.

## Contract diff

| Surface | Before | After |
|---|---|---|
| `skf-cloud.mjs` commands | `install`, `install --top-up`, `doctor` | adds `ensure [--repo] [--ref] [--hook] [--write-hook]` |
| `install --top-up` | trusts `state.json`; a deleted folder is "nothing to add" | a recorded skill with no `SKILL.md` on disk is added again |
| `~/.claude` layout, `state.json` | unchanged | unchanged |
| Repo files | none written by skf-cloud | ignored `<repo>/.claude/skills/<name>/`, `<repo>/.claude/skill-forge/{state.json,skf-cloud-<sha>.mjs}`; a block in `.git/info/exclude` |
| Committed repo files | — | `.claude/settings.json` hook entry, only via `--write-hook` and a PR |
| Doctor JSON | — | `D-repo-settings-ignored` skips a hook-only settings file; new `D-repo-local-hook-pin`; `version` unchanged |
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

1. Every declared skill present at user level in range: `ensure` writes nothing, prints
   nothing, exits 0.
2. Some missing: only those land in `<repo>/.claude/skills/`, verified; `git status`
   shows no change.
3. A repo copy deleted on disk (state still lists it): the next run installs it again;
   same for `install --top-up`.
4. User-level copy out of range: one warning naming copy, version and range; nothing
   installed for it.
5. Repo with skf's `.claude/skills` symlink: nothing written, one line.
6. Third-party folder in `.claude/skills`: untouched; a file edited since install: kept.
7. `CLAUDE_CODE_REMOTE=true` with `--hook`: exit 0, no output, no writes.
8. Offline or HTTP error: one warning, exit 0 under `--hook`.
9. `--write-hook`: creates or merges `.claude/settings.json`, idempotent, other keys kept.
10. The bootstrap text runs unchanged under bash and PowerShell (`pwsh -Command`).
11. Paths built with `path.join` throughout; tests cover a Windows-style home via
    `path.win32` where the code splits paths.

## Tests and verification

- `npm test`, with new cases in `test/skf-cloud.test.mjs` using the existing local-mirror
  fixtures (`SKF_BASE=/abs/mirror`): criteria 1–9 and top-up's disk check.
- Bootstrap: a test that runs the hook command through `bash -c`, and through `pwsh -c`
  when `pwsh` is on PATH (reported as skipped otherwise; this environment has no `pwsh`).
- Windows and macOS end to end: not runnable here; the owner or a collaborator runs the
  hook once in a fresh clone on each.
- `node bin/cli.js lock` and `validate` only if registry or inventory change (the steward
  skill's checklist line does; bump its version).

## After merge

- Pin move: none needed for existing Projects (threads do not use `ensure`). A repo that
  wants the hook runs `ensure --write-hook` from a thread at the new sha and opens a PR.
- Workstation: nothing.
