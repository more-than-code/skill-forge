#!/usr/bin/env node
// Claude Code hook: append agent-usage metadata as JSONL.
// Self-contained on purpose — consumer machines may not have the skill-forge repo or CLI.
// Records metadata only; prompt and transcript content are never read or written.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    payload = {};
  }

  const cwd = payload.cwd || process.cwd();
  const toolInput = payload.tool_input || {};
  const record = {
    schema: 1,
    ts: new Date().toISOString(),
    tool: 'claude-code',
    event: payload.hook_event_name || 'unknown',
    session_id: payload.session_id || null,
    project: path.basename(cwd),
    cwd,
    tool_name: payload.tool_name || null,
    agent_type: toolInput.subagent_type || null,
    model: toolInput.model || null,
    description: toolInput.description || null
  };

  const home = process.env.SKILL_FORGE_HOME || path.join(os.homedir(), '.skill-forge');
  const statsDir = path.join(home, 'stats');
  fs.mkdirSync(statsDir, { recursive: true });
  const slug = cwd.replace(/\//g, '-').replace(/^-/, '').replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
  fs.appendFileSync(path.join(statsDir, `${slug}.jsonl`), `${JSON.stringify(record)}\n`);
});
