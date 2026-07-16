import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'cli.js');
const HOOK = path.join(REPO_ROOT, 'inventory', 'hooks', 'claude-code', 'skill-forge-stats.mjs');

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('validate passes on the canonical registry', async () => {
  const { stdout } = await run('node', [CLI, 'validate'], { cwd: REPO_ROOT });
  assert.match(stdout, /Registry validation passed/);
});

test('composed claude-code agents resolve placeholders to built-in agent names', async () => {
  const dir = await tempDir('skf-compose-');
  const target = path.join(dir, 'CLAUDE.md');
  await run('node', [CLI, 'install', 'claude-code-agents', '--type', 'agent', '--target', 'claude-code', '--path', target, '--yes'], { cwd: REPO_ROOT });
  const composed = await fs.readFile(target, 'utf8');
  assert.match(composed, /`Explore`, `Plan`, or `reviewer`/);
  assert.doesNotMatch(composed, /\{\{[a-z0-9_]+\}\}/);
});

test('composed codex agents resolve placeholders to codex subagent names', async () => {
  const dir = await tempDir('skf-compose-codex-');
  const target = path.join(dir, 'AGENTS.md');
  await run('node', [CLI, 'install', 'codex-agents', '--type', 'agent', '--target', 'codex', '--path', target, '--yes'], { cwd: REPO_ROOT });
  const composed = await fs.readFile(target, 'utf8');
  assert.match(composed, /`researcher`, `planner`, or `reviewer`/);
  assert.doesNotMatch(composed, /\{\{[a-z0-9_]+\}\}/);
});

test('stats hook script appends metadata-only JSONL records', async () => {
  const home = await tempDir('skf-stats-');
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: 'test-session',
    cwd: '/tmp/example-project',
    tool_name: 'Agent',
    prompt: 'SECRET PROMPT CONTENT MUST NOT BE RECORDED',
    tool_input: { subagent_type: 'Explore', model: 'sonnet', description: 'trace flow', prompt: 'ALSO SECRET' }
  });
  const child = run('node', [HOOK], { env: { ...process.env, SKILL_FORGE_HOME: home } });
  child.child.stdin.end(payload);
  await child;

  const files = await fs.readdir(path.join(home, 'stats'));
  assert.equal(files.length, 1);
  const line = (await fs.readFile(path.join(home, 'stats', files[0]), 'utf8')).trim();
  const record = JSON.parse(line);
  assert.equal(record.schema, 1);
  assert.equal(record.event, 'PostToolUse');
  assert.equal(record.agent_type, 'Explore');
  assert.equal(record.model, 'sonnet');
  assert.equal(record.project, 'example-project');
  assert.doesNotMatch(line, /SECRET/);
});

test('stats record subcommand appends a record from stdin', async () => {
  const home = await tempDir('skf-stats-cli-');
  const payload = JSON.stringify({ tool: 'codex', event: 'subagent_stop', cwd: '/tmp/other-project', agent_type: 'researcher' });
  const child = run('node', [CLI, 'stats', 'record'], { cwd: REPO_ROOT, env: { ...process.env, SKILL_FORGE_HOME: home } });
  child.child.stdin.end(payload);
  const { stdout } = await child;
  assert.match(stdout, /Recorded subagent_stop for other-project/);
  const files = await fs.readdir(path.join(home, 'stats'));
  const record = JSON.parse((await fs.readFile(path.join(home, 'stats', files[0]), 'utf8')).trim());
  assert.equal(record.tool, 'codex');
  assert.equal(record.agent_type, 'researcher');
});

test('site command generates a catalog with all sections and stats aggregation', async () => {
  const home = await tempDir('skf-site-stats-');
  await fs.mkdir(path.join(home, 'stats'), { recursive: true });
  await fs.writeFile(
    path.join(home, 'stats', 'proj.jsonl'),
    `${JSON.stringify({ schema: 1, ts: '2026-07-14T00:00:00Z', project: 'proj', event: 'PostToolUse', agent_type: 'Explore', model: 'sonnet' })}\n`
  );
  const out = await tempDir('skf-site-out-');
  await run('node', [CLI, 'site', '--out', out], { cwd: REPO_ROOT, env: { ...process.env, SKILL_FORGE_HOME: home } });
  const html = await fs.readFile(path.join(out, 'index.html'), 'utf8');
  for (const heading of ['Skills (16)', 'Managed Agents', 'Managed Subagents', 'Managed Hooks', 'Usage Stats']) {
    assert.ok(html.includes(heading), `missing section: ${heading}`);
  }
  assert.match(html, /Explore \(1\)/);
  assert.doesNotMatch(html, /\{\{[a-z0-9_]+\}\}/);
});
