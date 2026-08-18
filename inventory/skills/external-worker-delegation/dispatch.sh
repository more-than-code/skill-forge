#!/usr/bin/env sh
# Dispatch an external worker: isolated worktree, verified brief, role marked.
#
#   dispatch.sh <task-slug> -- <worker-cli> [args...]
#
# First run scaffolds the worktree and stops so you can write the brief.
# Second run verifies the brief and execs the worker with its role set.
#
# The role marker exists because both ends run the same shared instructions and a
# worker cannot otherwise tell which end of the delegation it is on. Setting it
# here rather than by hand is the point: a flag you must remember is a flag you
# will forget.

set -eu

usage() {
  echo "usage: dispatch.sh <task-slug> -- <worker-cli> [args...]" >&2
  exit 64
}

[ $# -ge 1 ] || usage
slug=$1
shift
case $slug in -*|'') usage ;; esac
[ "${1:-}" = "--" ] || usage
shift
[ $# -ge 1 ] || usage

root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "dispatch.sh: not a git repository" >&2
  exit 69
}
# A linked worktree means this is already a worker checkout; dispatching from one
# would nest delegations, which the no-recursion rule forbids.
if [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ]; then
  echo "dispatch.sh: refusing to dispatch from a linked worktree ($root)" >&2
  exit 69
fi

tree="$root/../work-$slug"
branch="worker/$slug"

if [ ! -d "$tree" ]; then
  git worktree add "$tree" -b "$branch"
  echo
  echo "Worktree ready: $tree"
  echo "Write $tree/BRIEF.md, then re-run this command to dispatch."
  echo "Required first section: '## Role' — the worker executes this brief and does not delegate onward."
  exit 0
fi

brief="$tree/BRIEF.md"
[ -f "$brief" ] || {
  echo "dispatch.sh: $brief is missing; the worker starts cold and needs it" >&2
  exit 66
}
# The Role section is the guarantee the env var only makes machine-readable.
grep -qi '^#\{1,\}[[:space:]]*Role\b' "$brief" || {
  echo "dispatch.sh: $brief has no '## Role' section; add it before dispatching" >&2
  exit 65
}

cd "$tree"
SKILL_FORGE_AGENT_ROLE=worker
export SKILL_FORGE_AGENT_ROLE
exec "$@"
