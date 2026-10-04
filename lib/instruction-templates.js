export const INSTRUCTION_ROLES = ['repo', 'umbrella', 'child'];

export const SCAFFOLD_MARKER = '<!-- skf:scaffold - replace the placeholders below, then delete this line -->';

export const CLAUDE_MD_CONTENT = '@AGENTS.md\n';

// Kept identical to the hook block in the umbrella-workspace skill's PARALLEL-WORKTREES.md; a test pins the two.
const SESSION_HOOK_SECTION = `## Session ownership (worktree)

**If \`SESSION.md\` exists at this repo root, read it at session start**
(or before the first edit). It defines session ownership and off-limits paths.
If absent, ignore this section — normal primary-tree work.
`;

function repoTemplate(name) {
  return `# ${name} agent instructions

${SCAFFOLD_MARKER}

## Overview

What this repository is, in two or three sentences.

## Commands

Build, test and lint commands an agent should run.

## Conventions

Code style, branching and review rules specific to this repository.
`;
}

function umbrellaTemplate(name, root) {
  return `# ${name} workspace

${SCAFFOLD_MARKER}

## Child repos

List each child repository (each directory with its own \`.git\`) and what it owns.

## Paths

- Live task ledger: \`${root}/tasks/todo.md\`
- Plans: \`docs/\` (multi-repo plans only)
`;
}

// A directory name is untrusted text that an agent will later load as instructions: no control
// characters (a newline would inject lines) and no backticks (they would break the code span).
const plainText = (text) => text.replace(/[\u0000-\u001f\u007f`]/g, '?');

/** Placeholder-only AGENTS.md for a role; `root` is the absolute path of the directory being scaffolded. */
export function renderAgentsMd(role, root, name) {
  const safeName = plainText(name);
  if (role === 'umbrella') return umbrellaTemplate(safeName, plainText(root));
  if (role === 'child') return `${repoTemplate(safeName)}\n${SESSION_HOOK_SECTION}`;
  return repoTemplate(safeName);
}
