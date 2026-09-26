---
name: aws-toolkit-skills
description: >
  Fetch an AWS Agent Toolkit skill into the current project's `.agents/skills`
  when a task needs it. Activate when the user asks to add, install, fetch, or
  update an AWS skill for a project, or when an AWS task has no matching skill
  in that project yet. Covers catalog search, per-file download, and declaring
  the result as a Skill Forge local skill. The home-directory installers
  `aws configure agent-toolkit` and `aws agent-toolkit add-skill` are the wrong
  tool for this.
---

# AWS skills for one project

Install only the skill the current task needs, into that project's
`.agents/skills/<skill-name>/`. One directory. Leave every other project and
every home-directory skills folder untouched.

## Pick the skill

Search the catalog, then install the one match the task needs:

```bash
aws agent-toolkit search-skills --search-query "<text>" --region us-east-1
```

Pass `--profile <name>` on every `aws agent-toolkit` command when a named
profile is already configured. Do not ask for access keys. The Agent Toolkit
API accepts only `us-east-1`, whatever region the profile uses for other
calls. If the command fails because credentials are missing or expired, stop
and sign in with `aws login` for that profile.

If `<repo>/.agents/skills/<skill-name>/SKILL.md` is already present, use it.
Replace the directory only when the user asks to update that skill.

## Download into the project

```bash
aws agent-toolkit get-skill-metadata \
  --skill-name <skill-name> --region us-east-1
```

For each `files[].path`:

- Keep the path only when it is relative, uses forward slashes, and contains
  no empty, absolute, or `..` segment. The destination file must stay inside
  `<repo>/.agents/skills/<skill-name>/`.
- Fetch that file and write its stdout bytes to the destination. The command
  prints the file body, not a JSON envelope. `--output json` does not wrap it.
  A non-zero exit means write nothing.

```bash
aws agent-toolkit get-skill-file \
  --skill-name <skill-name> --file-path <path> --region us-east-1
```

Then confirm `SKILL.md` exists and its frontmatter `name` equals `<skill-name>`.

## Declare it so sync keeps it

AWS skills are not Skill Forge registry skills. `skf sync` vendors only
registry skills, and it prunes or refuses an undeclared directory under
`.agents/skills/`. When the repo has `skill-forge.json`, merge one local
entry (do not replace other keys):

```json
"<skill-name>": ".agents/skills/<skill-name>"
```

under `skills.local`, then run `skf sync` and `skf sync --check`.

If sync reports that the name is both a registry dependency and a local
skill, stop and ask. Do not delete either copy.

If the repo has no `skill-forge.json`, leave the downloaded directory in
place and do not run `skf project init` unless the user asked to make the
repo a Skill Forge consumer. Say that the directory is undeclared, so the
first `skf sync` there will refuse or prune it until it is declared.

`.claude/skills` is a symlink to `.agents/skills` on a synced project. Do
not add a second copy or a per-skill link under `.claude/skills`.

A second project that needs the same skill fetches its own copy. Do not
copy this directory across repos.

## Home installers

`aws configure agent-toolkit` and `aws agent-toolkit add-skill` (every
`--agent` value, including `universal`) install into the home skills
directories of detected agents. Observed 2026-09-26: one run wrote the
default catalog into each detected agent, with a separate tree per agent
except where one agent's skills directory was already a symlink onto
another's.

`list-installed-skills`, `remove-skill`, and `update-skill` follow those
home installs. An empty `list-installed-skills` result does not mean the
project lacks the skill. Do not run them to inspect, refresh, or delete a
project copy.

Installing a skill does not configure the AWS MCP server. Do not run
`aws configure agent-toolkit` to obtain a skill.
