#!/usr/bin/env node
// SessionStart hook: report a stale Skill Forge profile before any work starts.
//
// Core instruction 11 asks every agent to run `skf sync --check` in a repo with a
// skill-forge.json. An instruction can be forgotten; this makes the check happen. It only
// reads: it never runs `sync`, which changes vendored files the user may not want changed.
//
// Silent when there is no skill-forge.json, no `skf` on PATH, the check times out, or the
// profile is in sync. Self-contained on purpose — consumer machines may not have the
// skill-forge repo.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  let cwd = process.cwd();
  try {
    const given = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').cwd;
    if (typeof given === 'string' && given) cwd = given;
  } catch {
    // Malformed payload: fall back to cwd.
  }
  if (!fs.existsSync(path.join(cwd, 'skill-forge.json'))) process.exit(0);

  const check = spawnSync('skf', ['sync', '--check'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (check.error || check.status === 0 || check.status === null) process.exit(0);

  const detail = `${check.stdout ?? ''}${check.stderr ?? ''}`.trim().split('\n').slice(0, 12).join('\n').slice(0, 1500);
  process.stdout.write(
    JSON.stringify({
      // skf exits 1 for drift and for errors alike (bad manifest, missing registry), so this
      // says "failed" and leaves the reading of the output to the model.
      systemMessage: `skf sync --check failed in ${cwd} (exit ${check.status}): the skill profile is stale or broken.`,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          `skf sync --check exited ${check.status} in ${cwd}:\n${detail}\n` +
          'If this is drift, per core instruction 11 tell the user which skills are affected and how severe that is ' +
          '(skill-forge-project has the triage) before doing the work. Do not run sync unless the user asks.',
      },
    }) + '\n',
  );
  process.exit(0);
});
