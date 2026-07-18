#!/usr/bin/env node
// Grok hook: append agent-usage metadata as JSONL.
// Self-contained on purpose — consumer machines may not have the skill-forge repo or CLI.
// Records metadata only; prompt and transcript content are never read or written.
// Accepts both Grok camelCase payloads and Claude-style snake_case for compatibility.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function pick(obj, ...keys) {
  for (const key of keys) {
    if (obj && obj[key] != null && obj[key] !== '') return obj[key];
  }
  return null;
}

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    payload = {};
  }

  const cwd = pick(payload, 'cwd', 'workspaceRoot') || process.cwd();
  const toolInput = pick(payload, 'toolInput', 'tool_input') || {};
  const record = {
    schema: 1,
    ts: new Date().toISOString(),
    tool: 'grok',
    event: pick(payload, 'hookEventName', 'hook_event_name') || 'unknown',
    session_id: pick(payload, 'sessionId', 'session_id') || process.env.GROK_SESSION_ID || null,
    project: path.basename(cwd),
    cwd,
    tool_name: pick(payload, 'toolName', 'tool_name') || null,
    agent_type:
      pick(toolInput, 'subagent_type', 'subagentType', 'agent_type', 'agentType') ||
      pick(payload, 'subagent_type', 'subagentType', 'agent_type', 'agentType') ||
      null,
    model: pick(toolInput, 'model') || pick(payload, 'model') || null,
    description: pick(toolInput, 'description') || pick(payload, 'description') || null
  };

  const home = process.env.SKILL_FORGE_HOME || path.join(os.homedir(), '.skill-forge');
  const statsDir = path.join(home, 'stats');
  fs.mkdirSync(statsDir, { recursive: true });
  const slug = cwd.replace(/\//g, '-').replace(/^-/, '').replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
  fs.appendFileSync(path.join(statsDir, `${slug}.jsonl`), `${JSON.stringify(record)}\n`);
});
