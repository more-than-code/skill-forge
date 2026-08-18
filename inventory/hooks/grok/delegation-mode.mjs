#!/usr/bin/env node
// UserPromptSubmit hook: re-state the active task's delegation mode each turn.
//
// The conversation in which a user chose an external worker does not survive
// context compaction; the task block in tasks/todo.md does. This re-injects that
// one decision so §7's mode switch cannot silently lapse mid-task.
//
// Self-contained on purpose — consumer machines may not have the skill-forge repo or CLI.
// Reads only tasks/todo.md. The submitted prompt is never read, logged, or echoed.

import fs from 'node:fs';
import path from 'node:path';

const ACTIVE_STATUSES = new Set(['planned', 'in-progress', 'blocked']);

/**
 * True inside a linked worktree, where `.git` is a file holding a gitdir: pointer
 * rather than a directory. Checked without spawning git — this runs every prompt.
 * (A submodule looks the same; suppressing there costs only a reminder.)
 */
function inLinkedWorktree(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      if (fs.statSync(path.join(dir, '.git')).isFile()) return true;
      return false; // a .git directory: this is the main checkout
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }
}

/** Pull `**Field:** value` out of a task block header, tolerating spacing drift. */
function field(block, name) {
  const match = block.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*([^*\\n]+)`, 'i'));
  return match ? match[1].trim().replace(/\s{2,}.*$/, '').toLowerCase() : '';
}

function externalWorkerTasks(todo) {
  return todo
    .split(/^## /m)
    .slice(1)
    .map((block) => ({
      title: block.split('\n', 1)[0].trim(),
      status: field(block, 'Status'),
      delegation: field(block, 'Delegation')
    }))
    .filter((task) => task.delegation === 'external-worker' && ACTIVE_STATUSES.has(task.status));
}

// Only an agent that declares itself the orchestrator hears this. Role is a fact
// about how the process was started, so it arrives as an env var rather than being
// inferred from the directory — no file in the tree reliably reports it.
//
// The default is silence on purpose: an unset variable then costs a reminder, while
// the harmful outcome (a worker told to delegate onward) requires someone to have
// actively claimed the orchestrator role. Set it once in your shell profile;
// dispatch.sh overrides it to `worker` for the processes it spawns.
if (process.env.SKILL_FORGE_AGENT_ROLE !== 'orchestrator') process.exit(0);

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  let cwd = process.cwd();
  try {
    cwd = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').cwd || cwd;
  } catch {
    // Malformed payload: fall back to cwd rather than failing the turn.
  }

  // Claiming orchestrator from inside a worker's worktree is a contradiction: the
  // role was almost certainly inherited from the dispatching shell rather than
  // meant. Suppress. This only ever silences — unlike inferring the role from a
  // file in the tree, it can never promote a worker into an orchestrator, and the
  // worst case is a genuine orchestrator in a worktree losing one reminder.
  if (inLinkedWorktree(cwd)) process.exit(0);

  let todo = '';
  try {
    todo = fs.readFileSync(path.join(cwd, 'tasks', 'todo.md'), 'utf8');
  } catch {
    process.exit(0); // No task file: nothing to say.
  }

  let tasks = [];
  try {
    tasks = externalWorkerTasks(todo);
  } catch {
    process.exit(0);
  }
  if (tasks.length === 0) process.exit(0); // in-harness is the default; stay silent.

  const extra = tasks.length > 1 ? ` (+${tasks.length - 1} more)` : '';
  process.stdout.write(
    `Delegation mode for "${tasks[0].title}"${extra}: external-worker. ` +
    'Per §7, route delegated phases to the worker and do not spawn in-harness helpers; ' +
    'deterministic gates and §6 acceptance stay with you.\n'
  );
  process.exit(0);
});
