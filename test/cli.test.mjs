import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPathWithinInventorySkills,
  assertSafeRelativePath,
  assertSkillMdStdinAvailable,
  bumpSemver,
  canonicalizeSkillRelPath,
  isSkillMdRelPath,
  parseSemver
} from '../lib/skill-helpers.js';

const run = promisify(execFile);
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'cli.js');
const HOOK = path.join(REPO_ROOT, 'inventory', 'hooks', 'claude-code', 'skill-forge-stats.mjs');
const CODEX_AGENT_PINS = {
  'bulk_worker.toml': ['bulk_worker', 'gpt-5.6-luna', 'medium', 'workspace-write', 'Only modify files explicitly assigned to this task.'],
  'planner.toml': ['planner', 'gpt-5.6-sol', 'high', 'read-only', 'Do not edit files or run validation commands.'],
  'researcher.toml': ['researcher', 'gpt-5.6-terra', 'medium', 'read-only', 'Do not implement changes.'],
  'reviewer.toml': ['reviewer', 'gpt-5.6-sol', 'high', 'read-only', 'Do not implement fixes.'],
  'validator.toml': ['validator', 'gpt-5.6-luna', 'medium', 'workspace-write', 'Do not edit source, config, tests, docs, or lockfiles intentionally.']
};
const CLAUDE_AGENT_PINS = {
  'bulk-worker.md': ['bulk-worker', 'haiku', 'medium', 'Read, Edit, Write, Grep, Glob, Bash', 'Only modify files explicitly assigned to this task.'],
  'reviewer.md': ['reviewer', 'sonnet', 'high', 'Read, Grep, Glob', 'Do not implement fixes.'],
  'validator.md': ['validator', 'sonnet', 'medium', 'Bash, Read, Grep, Glob', 'Do not edit source, config, tests, docs, or lockfiles intentionally.']
};

const tempDirs = [];

async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
});

function runWithStdin(args, options, input) {
  const child = run('node', args, options);
  child.child.stdin.end(input);
  return child;
}

function tomlStringValue(content, key, file) {
  const assignments = content.split('\n').filter((line) => new RegExp('^\\s*' + key + '\\s*=').test(line));
  assert.equal(assignments.length, 1, file + ' must define exactly one ' + key);
  const match = assignments[0].match(new RegExp('^\\s*' + key + '\\s*=\\s*"([^"]*)"\\s*$'));
  assert.ok(match, file + ' must define ' + key + ' as a double-quoted string without trailing content');
  return match[1];
}

function yamlFrontmatterValue(content, key, file) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  assert.ok(frontmatter, file + ' must start with YAML frontmatter');
  const allowedKeys = new Set(['name', 'description', 'model', 'effort', 'tools']);
  const seenKeys = new Set();
  for (const line of frontmatter[1].split('\n')) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*.+$/);
    assert.ok(match, file + ' must use one-line key/value frontmatter entries');
    assert.ok(allowedKeys.has(match[1]), file + ' has unsupported frontmatter field ' + match[1]);
    assert.ok(!seenKeys.has(match[1]), file + ' repeats frontmatter field ' + match[1]);
    seenKeys.add(match[1]);
  }
  const assignments = frontmatter[1].split('\n').filter((line) => new RegExp('^' + key + ':').test(line));
  assert.equal(assignments.length, 1, file + ' must define exactly one ' + key);
  return assignments[0].slice(assignments[0].indexOf(':') + 1).trim().replace(/^"|"$/g, '');
}

/** Isolated registry+inventory tree so skill mutator tests never touch the checkout. */
async function skillForgeFixture() {
  const root = await tempDir('skf-root-');
  await fs.mkdir(path.join(root, 'inventory', 'skills'), { recursive: true });
  const registry = {
    name: 'skill-forge-test',
    version: '0.0.0',
    schemaVersion: 1,
    skills: [],
    managedAgents: [],
    managedSubagents: [],
    managedHooks: []
  };
  await fs.writeFile(path.join(root, 'registry.json'), `${JSON.stringify(registry, null, 2)}\n`);
  const env = { ...process.env, SKILL_FORGE_ROOT: root };
  return {
    root,
    env,
    skillDir(name) {
      return path.join(root, 'inventory', 'skills', name);
    },
    run(args, opts = {}) {
      return run('node', [CLI, ...args], { cwd: root, env, ...opts });
    },
    runWithStdin(args, input, opts = {}) {
      return runWithStdin([CLI, ...args], { cwd: root, env, ...opts }, input);
    },
    async readRegistry() {
      return JSON.parse(await fs.readFile(path.join(root, 'registry.json'), 'utf8'));
    },
    async writeRegistry(next) {
      await fs.writeFile(path.join(root, 'registry.json'), `${JSON.stringify(next, null, 2)}\n`);
    }
  };
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
  for (const [name, model, effort] of Object.values(CLAUDE_AGENT_PINS)) {
    assert.ok(composed.includes('| `' + name + '` | maintained | `' + model + '` | `' + effort + '` |'), name);
  }
  assert.match(composed, /\| `Explore` \| built-in \| inherited \| inherited \|/);
  assert.match(composed, /environment, invocation, and organization-policy precedence can still override or substitute/);
  assert.match(composed, /`Bash` can still write/);
  assert.doesNotMatch(composed, /\{\{[a-z0-9_]+\}\}/);
});

test('claude-code subagents pin the approved model and effort', async () => {
  const sourceDir = path.join(REPO_ROOT, 'inventory', 'subagents', 'claude-code');
  const installedDir = path.join(await tempDir('skf-claude-code-subagents-'), 'agents');
  await run('node', [CLI, 'subagent', 'install', 'claude-code-subagents', '--target', 'claude-code', '--path', installedDir, '--yes'], { cwd: REPO_ROOT });

  const sourceFiles = (await fs.readdir(sourceDir)).filter((file) => file.endsWith('.md')).sort();
  const installedFiles = (await fs.readdir(installedDir)).filter((file) => file.endsWith('.md')).sort();
  assert.deepEqual(sourceFiles, Object.keys(CLAUDE_AGENT_PINS));
  assert.deepEqual(installedFiles, sourceFiles);

  for (const file of sourceFiles) {
    const content = await fs.readFile(path.join(sourceDir, file), 'utf8');
    const installedContent = await fs.readFile(path.join(installedDir, file), 'utf8');
    const [name, model, effort, tools, contractMarker] = CLAUDE_AGENT_PINS[file];
    assert.equal(installedContent, content, file + ' must install byte-for-byte');
    assert.equal(yamlFrontmatterValue(content, 'name', file), name);
    assert.equal(yamlFrontmatterValue(content, 'model', file), model);
    assert.equal(yamlFrontmatterValue(content, 'effort', file), effort);
    assert.equal(yamlFrontmatterValue(content, 'tools', file), tools);
    assert.ok(['haiku', 'sonnet', 'opus', 'fable'].includes(model), file);
    assert.ok(['low', 'medium', 'high', 'xhigh', 'max'].includes(effort), file);
    assert.ok(content.includes(contractMarker), file);
  }
});

test('composed codex agents resolve placeholders to codex subagent names', async () => {
  const dir = await tempDir('skf-compose-codex-');
  const target = path.join(dir, 'AGENTS.md');
  await run('node', [CLI, 'install', 'codex-agents', '--type', 'agent', '--target', 'codex', '--path', target, '--yes'], { cwd: REPO_ROOT });
  const composed = await fs.readFile(target, 'utf8');
  assert.match(composed, /`researcher`, `planner`, or `reviewer`/);
  assert.match(composed, /Regardless of inherited context, every delegated prompt must be self-contained/);
  assert.match(composed, /For parallel batches, identify which results are required/);
  assert.match(composed, /Wait for every required result before synthesis/);
  assert.match(composed, /If an agent fails or remains incomplete, report that state and decide explicitly whether the remaining evidence is sufficient to proceed/);
  for (const [name, model, effort] of Object.values(CODEX_AGENT_PINS)) {
    assert.ok(composed.includes('| `' + name + '` | `' + model + '` | `' + effort + '` |'), name);
  }
  assert.doesNotMatch(composed, /\{\{[a-z0-9_]+\}\}/);
});

test('codex subagents pin the approved model and reasoning effort', async () => {
  const sourceDir = path.join(REPO_ROOT, 'inventory', 'subagents', 'codex');
  const installedDir = path.join(await tempDir('skf-codex-subagents-'), 'agents');
  await run('node', [CLI, 'subagent', 'install', 'codex-subagents', '--target', 'codex', '--path', installedDir, '--yes'], { cwd: REPO_ROOT });

  for (const dir of [sourceDir, installedDir]) {
    const files = (await fs.readdir(dir)).filter((file) => file.endsWith('.toml'));
    assert.deepEqual(files.sort(), Object.keys(CODEX_AGENT_PINS));

    for (const file of files) {
      const content = await fs.readFile(path.join(dir, file), 'utf8');
      const [name, model, effort, sandboxMode, contractMarker] = CODEX_AGENT_PINS[file];
      assert.equal(tomlStringValue(content, 'name', file), name);
      assert.equal(tomlStringValue(content, 'model', file), model);
      assert.equal(tomlStringValue(content, 'model_reasoning_effort', file), effort);
      assert.equal(tomlStringValue(content, 'sandbox_mode', file), sandboxMode);
      assert.doesNotMatch(content, /gpt-5\.(?:2|3-codex|4(?:-mini)?)/, file);
      assert.ok(content.includes(contractMarker), file);
    }
  }
});

test('composed grok agents resolve placeholders to built-in agent names', async () => {
  const dir = await tempDir('skf-compose-grok-');
  const target = path.join(dir, 'AGENTS.md');
  await run('node', [CLI, 'install', 'grok-agents', '--type', 'agent', '--target', 'grok', '--path', target, '--yes'], { cwd: REPO_ROOT });
  const composed = await fs.readFile(target, 'utf8');
  assert.match(composed, /`explore`, `plan`, or `reviewer`/);
  assert.doesNotMatch(composed, /\{\{[a-z0-9_]+\}\}/);
});

test('grok stats hook script accepts camelCase payloads and records metadata only', async () => {
  const home = await tempDir('skf-stats-grok-');
  const hook = path.join(REPO_ROOT, 'inventory', 'hooks', 'grok', 'skill-forge-stats.mjs');
  const payload = JSON.stringify({
    hookEventName: 'PostToolUse',
    sessionId: 'grok-session',
    cwd: '/tmp/grok-project',
    toolName: 'spawn_subagent',
    prompt: 'SECRET GROK PROMPT MUST NOT BE RECORDED',
    toolInput: { subagent_type: 'explore', model: 'grok-4.5', description: 'trace flow', prompt: 'ALSO SECRET' }
  });
  const child = run('node', [hook], { env: { ...process.env, SKILL_FORGE_HOME: home } });
  child.child.stdin.end(payload);
  await child;

  const files = await fs.readdir(path.join(home, 'stats'));
  assert.equal(files.length, 1);
  const line = (await fs.readFile(path.join(home, 'stats', files[0]), 'utf8')).trim();
  const record = JSON.parse(line);
  assert.equal(record.schema, 1);
  assert.equal(record.tool, 'grok');
  assert.equal(record.event, 'PostToolUse');
  assert.equal(record.agent_type, 'explore');
  assert.equal(record.model, 'grok-4.5');
  assert.equal(record.project, 'grok-project');
  assert.doesNotMatch(line, /SECRET/);
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

test('delegation-mode hook speaks only for active external-worker tasks', async () => {
  const hook = path.join(REPO_ROOT, 'inventory', 'hooks', 'claude-code', 'delegation-mode.mjs');
  const project = await tempDir('skf-delegation-');
  await fs.mkdir(path.join(project, 'tasks'), { recursive: true });

  const fire = async (payload, env) => {
    const child = run('node', [hook], env ? { env: { ...process.env, ...env } } : undefined);
    child.child.stdin.end(payload);
    return (await child).stdout;
  };
  const writeTodo = (body) => fs.writeFile(path.join(project, 'tasks', 'todo.md'), body);
  const payload = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    cwd: project,
    prompt: 'SECRET PROMPT CONTENT MUST NOT BE ECHOED'
  });

  const asOrchestrator = { SKILL_FORGE_AGENT_ROLE: 'orchestrator' };

  // Missing task file, and the in-harness default, must both stay silent: this
  // runs on every prompt in every workspace.
  assert.equal(await fire(payload, asOrchestrator), '');
  await writeTodo('## Refactor cache\n**Tier:** 2  **Status:** in-progress  **Delegation:** in-harness  **Date:** 2026-08-18\n');
  assert.equal(await fire(payload, asOrchestrator), '');

  // A completed external-worker task is not active; the in-progress one is.
  await writeTodo(
    '## Refactor cache\n**Tier:** 2  **Status:** complete  **Delegation:** external-worker  **Date:** 2026-08-18\n' +
    '## Port billing screens\n**Tier:** 3  **Status:** in-progress  **Delegation:** external-worker  **Date:** 2026-08-18\n'
  );
  const out = await fire(payload, asOrchestrator);
  assert.match(out, /Port billing screens/);
  assert.doesNotMatch(out, /Refactor cache/);
  assert.doesNotMatch(out, /SECRET/);
  assert.equal(out.trim().split('\n').length, 1);

  // Task blocks predating the Delegation field must not trigger it.
  await writeTodo('## Old task\n**Tier:** 2  **Status:** in-progress  **Date:** 2026-08-18\n');
  assert.equal(await fire(payload, asOrchestrator), '');

  // Role comes from the spawn, never from the directory. Silence is the default so a
  // missing marker costs a reminder instead of telling a worker to delegate onward.
  await writeTodo('## Port billing screens\n**Tier:** 3  **Status:** in-progress  **Delegation:** external-worker  **Date:** 2026-08-18\n');
  assert.match(await fire(payload, asOrchestrator), /Port billing screens/);
  assert.equal(await fire(payload, { SKILL_FORGE_AGENT_ROLE: 'worker' }), '');
  assert.equal(await fire(payload, { SKILL_FORGE_AGENT_ROLE: '' }), '');
  // A stray brief in the tree changes nothing either way: role is not inferred.
  await fs.writeFile(path.join(project, 'BRIEF.md'), '# Brief\n');
  assert.match(await fire(payload, asOrchestrator), /Port billing screens/);
  await fs.rm(path.join(project, 'BRIEF.md'));

  // A malformed payload must never fail the turn.
  assert.equal(await fire('not json', asOrchestrator), '');

  // A worker inherits `orchestrator` from the dispatching shell unless something
  // overrides it. Inside a linked worktree that claim is a contradiction, so the
  // hook suppresses rather than tell a worker to delegate onward. Suppression-only:
  // it can never promote a worker into an orchestrator.
  const repo = await tempDir('skf-delegation-wt-');
  const linked = path.join(repo, 'linked');
  await fs.mkdir(path.join(repo, 'main', 'tasks'), { recursive: true });
  const main = path.join(repo, 'main');
  const todoBody = '## Port billing screens\n**Tier:** 3  **Status:** in-progress  **Delegation:** external-worker  **Date:** 2026-08-18\n';
  await fs.writeFile(path.join(main, 'tasks', 'todo.md'), todoBody);
  await run('git', ['init', '-q'], { cwd: main });
  await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main });
  await run('git', ['add', '-A'], { cwd: main });
  await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'todo'], { cwd: main });
  await run('git', ['worktree', 'add', '-q', linked, '-b', 'worker/demo'], { cwd: main });

  const atMain = JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: main });
  const atLinked = JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: linked });
  assert.match(await fire(atMain, asOrchestrator), /Port billing screens/);
  assert.equal(await fire(atLinked, asOrchestrator), '');
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

test('skill write/read/list/delete manage an inventory skill end-to-end', async () => {
  const fx = await skillForgeFixture();
  const name = 'test-cli-skill';
  const skillDir = fx.skillDir(name);
  const frontmatter = (description) => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody content.\n`;

  const created = await fx.runWithStdin(
    ['skill', 'write', name, '--set-version', '0.1.0', '--tags', 'foo,bar', '--json'],
    frontmatter('First version.')
  );
  const createdPayload = JSON.parse(created.stdout);
  assert.equal(createdPayload.action, 'created');
  assert.deepEqual(createdPayload.skill.tags, ['foo', 'bar']);
  assert.equal(createdPayload.skill.version, '0.1.0');

  const read = await fx.run(['skill', 'read', name, '--json']);
  const readPayload = JSON.parse(read.stdout);
  assert.match(readPayload.body, /First version\./);
  assert.deepEqual(readPayload.companions, {});

  const list = await fx.run(['skill', 'list', '--all', '--json']);
  const listPayload = JSON.parse(list.stdout);
  const listedSkill = listPayload.find((skill) => skill.name === name);
  assert.ok(listedSkill);
  assert.equal(listedSkill.description, 'First version.');

  const updated = await fx.runWithStdin(['skill', 'write', name, '--json'], frontmatter('Second version.'));
  const updatedPayload = JSON.parse(updated.stdout);
  assert.equal(updatedPayload.action, 'updated');
  assert.equal(updatedPayload.skill.version, '0.1.0');

  await assert.rejects(fx.run(['skill', 'delete', name]));

  const deleted = await fx.run(['skill', 'delete', name, '--yes', '--json']);
  assert.deepEqual(JSON.parse(deleted.stdout), { action: 'deleted', name, warnings: [] });
  assert.equal(await fs.access(skillDir).then(() => true, () => false), false);

  const { stdout } = await fx.run(['validate']);
  assert.match(stdout, /Registry validation passed/);
});

test('skill authoring pipeline rejects hardcoded absolute home and self-vendor paths', async () => {
  const fx = await skillForgeFixture();
  const name = 'test-hardcoded-path-skill';
  const body = (line) => `---\nname: ${name}\ndescription: Fixture.\n---\n\n# Fixture\n\n${line}\n`;

  await fx.runWithStdin(['skill', 'write', name, '--set-version', '0.1.0', '--json'], body('Nothing to see.'));
  assert.match((await fx.run(['validate'])).stdout, /Registry validation passed/);

  // The gate runs inside `skill write` (which locks + validates), so a bad path
  // is reported as a partial write rather than passing through to the registry.
  const abs = await fx.runWithStdin(['skill', 'write', name, '--json'], body('See `/Users/someone/tools/x.mjs`.')).catch((error) => error);
  const absPayload = JSON.parse(abs.stdout);
  assert.equal(absPayload.partial, true);
  assert.ok(absPayload.errors.some((e) => /hardcodes an absolute home path/.test(e)));

  const self = await fx.runWithStdin(['skill', 'write', name, '--json'], body(`See \`~/.agents/skills/${name}/scripts/x.mjs\`.`)).catch((error) => error);
  const selfPayload = JSON.parse(self.stdout);
  assert.equal(selfPayload.partial, true);
  assert.ok(selfPayload.errors.some((e) => /hardcodes this skill's own vendor location/.test(e)));

  await fx.runWithStdin(['skill', 'write', name, '--json'], body('Clean again.'));
  await fx.run(['skill', 'delete', name, '--yes', '--json']);
  assert.match((await fx.run(['validate'])).stdout, /Registry validation passed/);
});

test('skill write manages companion files and rejects path traversal via --file', async () => {
  const fx = await skillForgeFixture();
  const name = 'test-companion-skill';
  const skillDir = fx.skillDir(name);
  const staging = await tempDir('skf-companion-');
  const examplesPath = path.join(staging, 'EXAMPLES.md');
  const nestedPath = path.join(staging, 'nested.md');
  await fs.writeFile(examplesPath, 'Example content.\n');
  await fs.writeFile(nestedPath, 'Nested content.\n');

  const created = await fx.runWithStdin(
    ['skill', 'write', name, '--set-version', '0.1.0', '--file', `EXAMPLES.md=${examplesPath}`, '--file', `refs/nested.md=${nestedPath}`, '--json'],
    `---\nname: ${name}\ndescription: Companion file test.\n---\n\nBody.\n`
  );
  assert.equal(JSON.parse(created.stdout).action, 'created');

  const read = await fx.run(['skill', 'read', name, '--json']);
  const readPayload = JSON.parse(read.stdout);
  assert.deepEqual(readPayload.companions, {
    'EXAMPLES.md': 'Example content.\n',
    'refs/nested.md': 'Nested content.\n'
  });

  await assert.rejects(
    fx.run(['skill', 'write', name, '--file', `../escaped.md=${nestedPath}`]),
    /must not escape the skill directory/
  );

  const removed = await fx.run(['skill', 'write', name, '--skip-skill-md', '--remove-file', 'refs/nested.md', '--json']);
  const removedPayload = JSON.parse(removed.stdout);
  assert.deepEqual(removedPayload.removedFiles, ['refs/nested.md']);
  assert.equal(await fs.access(path.join(skillDir, 'refs')).then(() => true, () => false), false);

  const removeMissing = await fx.run(['skill', 'write', name, '--skip-skill-md', '--remove-file', 'nope.md', '--json']);
  const removeMissingPayload = JSON.parse(removeMissing.stdout);
  assert.deepEqual(removeMissingPayload.removedFiles, []);
  assert.match(removeMissingPayload.warnings[0], /not found; nothing removed/);

  await assert.rejects(
    fx.run(['skill', 'write', name, '--skip-skill-md', '--remove-file', 'SKILL.md']),
    /Cannot remove "SKILL.md"/
  );
  await assert.rejects(
    fx.run(['skill', 'write', name, '--skip-skill-md', '--file', `EXAMPLES.md=${examplesPath}`, '--remove-file', 'EXAMPLES.md']),
    /that's ambiguous/
  );
  await assert.rejects(
    fx.run(['skill', 'write', 'brand-new-skill', '--skip-skill-md', '--set-version', '0.1.0']),
    /cannot be used when creating a new skill/
  );
});

test('skill write/read/delete --json failures emit a JSON error object on stdout instead of empty stdout', async () => {
  const fx = await skillForgeFixture();
  const failedWrite = await fx.run(['skill', 'write', 'does-not-exist-yet', '--json']).catch((error) => error);
  assert.ok(failedWrite instanceof Error);
  assert.deepEqual(JSON.parse(failedWrite.stdout), { error: 'Error writing skill: --set-version is required when creating a new skill.' });

  const failedRead = await fx.run(['skill', 'read', 'does-not-exist-at-all', '--json']).catch((error) => error);
  assert.ok(failedRead instanceof Error);
  assert.deepEqual(JSON.parse(failedRead.stdout), { error: 'Error reading skill: Skill "does-not-exist-at-all" not found.' });

  const failedDelete = await fx.run(['skill', 'delete', 'does-not-exist-at-all', '--yes', '--json']).catch((error) => error);
  assert.ok(failedDelete instanceof Error);
  assert.deepEqual(JSON.parse(failedDelete.stdout), { error: 'Error deleting skill: Skill "does-not-exist-at-all" not found.' });
});

test('skill delete post-validation failure JSON includes partial: true', async () => {
  const fx = await skillForgeFixture();
  const name = 'to-delete';
  await fx.runWithStdin(
    ['skill', 'write', name, '--set-version', '0.1.0', '--json'],
    `---\nname: ${name}\ndescription: Will be deleted.\n---\n\nBody.\n`
  );

  // Sibling skill exists on disk (so lock can hash it) but has invalid frontmatter,
  // so validate fails after a durable delete without writeLock throwing first.
  const brokenDir = fx.skillDir('broken-sibling');
  await fs.mkdir(brokenDir, { recursive: true });
  await fs.writeFile(path.join(brokenDir, 'SKILL.md'), 'no frontmatter here\n');
  const registry = await fx.readRegistry();
  registry.skills.push({
    type: 'skill',
    name: 'broken-sibling',
    version: '0.1.0',
    scope: 'custom',
    path: 'inventory/skills/broken-sibling',
    installable: true,
    tags: []
  });
  await fx.writeRegistry(registry);

  const failed = await fx.run(['skill', 'delete', name, '--yes', '--json']).catch((error) => error);
  assert.ok(failed instanceof Error);
  const payload = JSON.parse(failed.stdout);
  assert.equal(payload.partial, true);
  assert.match(payload.error, /was deleted but registry validation failed/);
  assert.ok(Array.isArray(payload.errors) && payload.errors.length > 0);
  assert.equal(await fs.access(fx.skillDir(name)).then(() => true, () => false), false, 'delete must still remove the skill dir');
});

test('skill set-version/bump post-validation failure JSON includes partial: true', async () => {
  const fx = await skillForgeFixture();
  const name = 'version-partial';
  await fx.runWithStdin(
    ['skill', 'write', name, '--set-version', '0.1.0', '--json'],
    `---\nname: ${name}\ndescription: Version partial test.\n---\n\nBody.\n`
  );

  const brokenDir = fx.skillDir('broken-sibling');
  await fs.mkdir(brokenDir, { recursive: true });
  await fs.writeFile(path.join(brokenDir, 'SKILL.md'), 'no frontmatter here\n');
  const registry = await fx.readRegistry();
  registry.skills.push({
    type: 'skill',
    name: 'broken-sibling',
    version: '0.1.0',
    scope: 'custom',
    path: 'inventory/skills/broken-sibling',
    installable: true,
    tags: []
  });
  await fx.writeRegistry(registry);

  const failedSet = await fx.run(['skill', 'set-version', name, '0.2.0', '--json']).catch((error) => error);
  assert.ok(failedSet instanceof Error);
  const setPayload = JSON.parse(failedSet.stdout);
  assert.equal(setPayload.partial, true);
  assert.equal(setPayload.previousVersion, '0.1.0');
  assert.equal(setPayload.version, '0.2.0');
  assert.match(setPayload.error, /version was set to 0\.2\.0 but registry validation failed/);
  assert.equal((await fx.readRegistry()).skills.find((s) => s.name === name).version, '0.2.0');

  const failedBump = await fx.run(['skill', 'bump', name, '--json']).catch((error) => error);
  assert.ok(failedBump instanceof Error);
  const bumpPayload = JSON.parse(failedBump.stdout);
  assert.equal(bumpPayload.partial, true);
  assert.equal(bumpPayload.previousVersion, '0.2.0');
  assert.equal(bumpPayload.version, '0.2.1');
  assert.equal((await fx.readRegistry()).skills.find((s) => s.name === name).version, '0.2.1');
});

test('skill write rejects a frontmatter/name mismatch and an unsafe name, leaving no orphaned directory', async () => {
  const fx = await skillForgeFixture();
  const skillDir = fx.skillDir('name-mismatch');
  await assert.rejects(
    fx.runWithStdin(
      ['skill', 'write', 'name-mismatch', '--set-version', '0.1.0'],
      '---\nname: something-else\ndescription: x.\n---\n\nBody.\n'
    ),
    /does not match/
  );
  assert.equal(await fs.access(skillDir).then(() => true, () => false), false, 'failed create must not leave a directory behind');

  await assert.rejects(
    fx.run(['skill', 'write', '../evil', '--set-version', '0.1.0']),
    /Invalid skill name/
  );
});

test('skill write rejects absolute paths in --file and --remove-file', async () => {
  const fx = await skillForgeFixture();
  await assert.rejects(
    fx.run(['skill', 'write', 'abs-path', '--set-version', '0.1.0', '--file', '/etc/passwd=/tmp/whatever.md']),
    /must be relative/
  );
  await assert.rejects(
    fx.run(['skill', 'write', 'abs-path', '--skip-skill-md', '--remove-file', '/etc/passwd']),
    /must be relative/
  );
});

test('skill write rejects duplicate --file/--remove-file targets and directory removal, and does not leave a partial write on companion failure', async () => {
  const fx = await skillForgeFixture();
  const name = 'hardening-skill';
  const skillDir = fx.skillDir(name);
  const staging = await tempDir('skf-hardening-');
  const goodPath = path.join(staging, 'good.md');
  await fs.writeFile(goodPath, 'good\n');

  await assert.rejects(
    fx.run(['skill', 'write', name, '--set-version', '0.1.0', '--file', `EXAMPLES.md=${goodPath}`, '--file', `EXAMPLES.md=${goodPath}`]),
    /Duplicate --file target/
  );

  const created = await fx.runWithStdin(
    ['skill', 'write', name, '--set-version', '0.1.0', '--file', `refs/a.md=${goodPath}`, '--json'],
    `---\nname: ${name}\ndescription: Hardening test.\n---\n\nOriginal body.\n`
  );
  assert.equal(JSON.parse(created.stdout).action, 'created');

  await assert.rejects(
    fx.run(['skill', 'write', name, '--skip-skill-md', '--remove-file', 'refs']),
    /is a directory; refusing to remove it recursively/
  );
  assert.equal(await fs.access(path.join(skillDir, 'refs', 'a.md')).then(() => true, () => false), true, 'directory removal guard must leave the companion tree intact');

  const beforeSkillMd = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
  await assert.rejects(
    fx.runWithStdin(
      ['skill', 'write', name, '--file', `refs/b.md=${path.join(staging, 'missing.md')}`],
      `---\nname: ${name}\ndescription: Should not persist.\n---\n\nShould not persist.\n`
    ),
    /local source not found/
  );
  const afterSkillMd = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.equal(afterSkillMd, beforeSkillMd, 'SKILL.md must not change when a companion source is missing');

  const { stdout } = await fx.run(['validate']);
  assert.match(stdout, /Registry validation passed/);
});

test('skill write rejects a --file source that is the destination itself, before mutating', async () => {
  const fx = await skillForgeFixture();
  const name = 'self-source-skill';
  const skillDir = fx.skillDir(name);
  const staging = await tempDir('skf-self-source-');
  const companionPath = path.join(staging, 'EXAMPLES.md');
  await fs.writeFile(companionPath, 'staged companion\n');

  const created = await fx.runWithStdin(
    ['skill', 'write', name, '--set-version', '0.1.0', '--file', `EXAMPLES.md=${companionPath}`, '--json'],
    `---\nname: ${name}\ndescription: Self source test.\n---\n\nOriginal body.\n`
  );
  assert.equal(JSON.parse(created.stdout).action, 'created');

  const beforeSkillMd = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
  const inPlaceCompanion = path.join(skillDir, 'EXAMPLES.md');

  const rejected = await fx.runWithStdin(
    ['skill', 'write', name, '--file', `EXAMPLES.md=${inPlaceCompanion}`, '--json'],
    `---\nname: ${name}\ndescription: Self source test.\n---\n\nShould not persist.\n`
  ).then(
    (ok) => ok,
    (err) => err
  );
  const payload = JSON.parse(rejected.stdout);
  assert.match(payload.error, /is the skill's own "EXAMPLES.md"/);
  assert.equal(payload.partial, undefined, 'a same-path --file is an input error; nothing durable was written');

  const afterSkillMd = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.equal(afterSkillMd, beforeSkillMd, 'SKILL.md must not change when --file points at its own destination');
  assert.equal(await fs.readFile(inPlaceCompanion, 'utf8'), 'staged companion\n');

  const { stdout } = await fx.run(['validate']);
  assert.match(stdout, /Registry validation passed/);
});

test('skill delete and read refuse registry paths that escape inventory/skills', async () => {
  const fx = await skillForgeFixture();
  const outside = await tempDir('skf-outside-');
  const marker = path.join(outside, 'do-not-delete.txt');
  await fs.writeFile(marker, 'safe\n');
  // Sibling skill dir that must survive a boundary-path delete attempt
  const keepDir = fx.skillDir('keep-me');
  await fs.mkdir(keepDir, { recursive: true });
  await fs.writeFile(path.join(keepDir, 'SKILL.md'), '---\nname: keep-me\ndescription: x.\n---\n\nKeep.\n');

  const registry = await fx.readRegistry();
  registry.skills.push(
    {
      type: 'skill',
      name: 'abs-escape',
      version: '0.1.0',
      scope: 'custom',
      path: outside,
      installable: true,
      tags: []
    },
    {
      type: 'skill',
      name: 'rel-escape',
      version: '0.1.0',
      scope: 'custom',
      path: 'inventory/skills/../../../tmp-should-not-delete',
      installable: true,
      tags: []
    },
    {
      type: 'skill',
      name: 'boundary-escape',
      version: '0.1.0',
      scope: 'custom',
      path: 'inventory/skills',
      installable: true,
      tags: []
    },
    {
      type: 'skill',
      name: 'keep-me',
      version: '0.1.0',
      scope: 'custom',
      path: 'inventory/skills/keep-me',
      installable: true,
      tags: []
    }
  );
  await fx.writeRegistry(registry);

  const absFail = await fx.run(['skill', 'delete', 'abs-escape', '--yes', '--json']).catch((error) => error);
  assert.ok(absFail instanceof Error);
  assert.match(JSON.parse(absFail.stdout).error, /absolute path/);
  assert.equal(await fs.readFile(marker, 'utf8'), 'safe\n');

  const relFail = await fx.run(['skill', 'delete', 'rel-escape', '--yes', '--json']).catch((error) => error);
  assert.ok(relFail instanceof Error);
  assert.match(JSON.parse(relFail.stdout).error, /escapes inventory\/skills/);

  const boundaryFail = await fx.run(['skill', 'delete', 'boundary-escape', '--yes', '--json']).catch((error) => error);
  assert.ok(boundaryFail instanceof Error);
  assert.match(JSON.parse(boundaryFail.stdout).error, /escapes inventory\/skills/);
  assert.equal(await fs.readFile(path.join(keepDir, 'SKILL.md'), 'utf8').then((t) => t.includes('Keep')), true);

  const readAbs = await fx.run(['skill', 'read', 'abs-escape', '--json']).catch((error) => error);
  assert.ok(readAbs instanceof Error);
  assert.match(JSON.parse(readAbs.stdout).error, /absolute path/);

  const still = await fx.readRegistry();
  assert.equal(still.skills.length, 4, 'refused deletes must not remove registry entries');
});

test('skill write treats skill.md case-insensitively as SKILL.md and rejects removing it', async () => {
  const fx = await skillForgeFixture();
  const name = 'case-skill';
  const staging = await tempDir('skf-case-');
  const skillMdPath = path.join(staging, 'body.md');
  await fs.writeFile(
    skillMdPath,
    `---\nname: ${name}\ndescription: Case test.\n---\n\nFrom skill.md flag.\n`
  );

  const created = await fx.run([
    'skill', 'write', name, '--set-version', '0.1.0',
    '--file', `skill.md=${skillMdPath}`,
    '--json'
  ]);
  assert.equal(JSON.parse(created.stdout).action, 'created');
  assert.match(await fs.readFile(path.join(fx.skillDir(name), 'SKILL.md'), 'utf8'), /From skill\.md flag/);

  await assert.rejects(
    fx.run(['skill', 'write', name, '--skip-skill-md', '--remove-file', 'Skill.md']),
    /Cannot remove "SKILL.md"/
  );
  await assert.rejects(
    fx.run(['skill', 'write', name, '--skip-skill-md', '--file', `skill.md=${skillMdPath}`]),
    /mutually exclusive/
  );
  await assert.rejects(
    fx.run([
      'skill', 'write', name, '--set-version', '0.1.0',
      '--file', `SKILL.md=${skillMdPath}`,
      '--file', `skill.md=${skillMdPath}`
    ]),
    /Duplicate --file target/
  );

  // Missing SKILL.md local source uses the same structured message as companions
  const missing = await fx.run([
    'skill', 'write', name,
    '--file', `SKILL.md=${path.join(staging, 'nope.md')}`,
    '--json'
  ]).catch((error) => error);
  assert.ok(missing instanceof Error);
  assert.match(JSON.parse(missing.stdout).error, /local source not found/);
});

test('skill helpers reject unsafe paths and TTY stdin for SKILL.md', () => {
  assert.equal(assertSafeRelativePath('refs/a.md'), path.normalize('refs/a.md'));
  assert.throws(() => assertSafeRelativePath('/tmp/x', '--file path'), /must be relative/);
  assert.throws(() => assertSafeRelativePath('../x', '--file path'), /must not escape/);

  const root = '/tmp/repo-root';
  assert.equal(
    assertPathWithinInventorySkills('inventory/skills/foo', root),
    path.resolve(root, 'inventory/skills/foo')
  );
  assert.throws(() => assertPathWithinInventorySkills('/tmp/evil', root), /absolute path/);
  assert.throws(() => assertPathWithinInventorySkills('inventory/skills/../../../etc', root), /escapes inventory\/skills/);
  assert.throws(() => assertPathWithinInventorySkills('inventory/skills', root), /escapes inventory\/skills/);

  assert.equal(isSkillMdRelPath('SKILL.md'), true);
  assert.equal(isSkillMdRelPath('skill.md'), true);
  assert.equal(isSkillMdRelPath('Skill.md'), true);
  assert.equal(isSkillMdRelPath('refs/skill.md'), false);
  assert.equal(canonicalizeSkillRelPath('skill.md'), 'SKILL.md');
  assert.equal(canonicalizeSkillRelPath('refs/a.md'), 'refs/a.md');

  assert.throws(() => assertSkillMdStdinAvailable(true), /stdin is a TTY/);
  assert.doesNotThrow(() => assertSkillMdStdinAvailable(false));

  assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.throws(() => parseSemver('1.2'), /Invalid version/);
  assert.equal(bumpSemver('1.2.3', 'patch'), '1.2.4');
  assert.equal(bumpSemver('1.2.3', 'minor'), '1.3.0');
  assert.equal(bumpSemver('1.2.3', 'major'), '2.0.0');
  assert.throws(() => bumpSemver('1.2.3', 'weird'), /Invalid bump level/);
});

test('skill set-version and bump update registry versions without touching SKILL.md', async () => {
  const fx = await skillForgeFixture();
  const name = 'versioned-skill';
  const body = `---\nname: ${name}\ndescription: Version command test.\n---\n\nOriginal body.\n`;
  await fx.runWithStdin(['skill', 'write', name, '--set-version', '0.1.0', '--json'], body);

  const skillMdBefore = await fs.readFile(path.join(fx.skillDir(name), 'SKILL.md'), 'utf8');

  const set = await fx.run(['skill', 'set-version', name, '0.2.0', '--json']);
  const setPayload = JSON.parse(set.stdout);
  assert.equal(setPayload.action, 'set-version');
  assert.equal(setPayload.previousVersion, '0.1.0');
  assert.equal(setPayload.version, '0.2.0');
  assert.equal(setPayload.skill.version, '0.2.0');

  const patch = await fx.run(['skill', 'bump', name, '--json']);
  const patchPayload = JSON.parse(patch.stdout);
  assert.equal(patchPayload.action, 'bump');
  assert.equal(patchPayload.previousVersion, '0.2.0');
  assert.equal(patchPayload.version, '0.2.1');

  const minor = await fx.run(['skill', 'bump', name, '--minor', '--json']);
  assert.equal(JSON.parse(minor.stdout).version, '0.3.0');

  const major = await fx.run(['skill', 'bump', name, '--major', '--json']);
  assert.equal(JSON.parse(major.stdout).version, '1.0.0');

  const unchanged = await fx.run(['skill', 'set-version', name, '1.0.0', '--json']);
  assert.equal(JSON.parse(unchanged.stdout).action, 'unchanged');

  assert.equal(await fs.readFile(path.join(fx.skillDir(name), 'SKILL.md'), 'utf8'), skillMdBefore);

  await assert.rejects(fx.run(['skill', 'set-version', name, 'not-semver']), /Invalid version|semver/);
  await assert.rejects(fx.run(['skill', 'bump', name, '--major', '--minor']), /only one of/);
  await assert.rejects(fx.run(['skill', 'bump', 'missing-skill']), /not found/);

  const { stdout } = await fx.run(['validate']);
  assert.match(stdout, /Registry validation passed/);
});

test('skill bump reports and optionally rewrites local profile pins that the new version breaks', async () => {
  const fx = await projectFixture();
  await fx.run(['project', 'init', '--shims', 'claude-code']);
  await fx.run(['project', 'add', 'demo-skill']);

  const fakeHome = await tempDir('skf-pin-home-');
  const env = { ...fx.env, HOME: fakeHome };
  await fs.writeFile(
    path.join(fakeHome, 'skill-forge.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      extends: [],
      skills: { dependencies: { 'demo-skill': '^0.1.0' }, shims: ['claude-code'] }
    }, null, 2)}\n`
  );

  const readRootManifest = async () => JSON.parse(await fs.readFile(path.join(fx.root, 'skill-forge.json'), 'utf8'));
  const readHomeManifest = async () => JSON.parse(await fs.readFile(path.join(fakeHome, 'skill-forge.json'), 'utf8'));
  const bump = (args) => run('node', [CLI, 'skill', 'bump', 'demo-skill', ...args], { cwd: fx.root, env });

  const patch = JSON.parse((await bump(['--json'])).stdout);
  assert.equal(patch.version, '0.1.1');
  assert.deepEqual(patch.stalePins, []);
  assert.deepEqual(patch.updatedPins, []);
  assert.equal((await readRootManifest()).skills.dependencies['demo-skill'], '^0.1.0');
  assert.equal((await readHomeManifest()).skills.dependencies['demo-skill'], '^0.1.0');

  const minor = JSON.parse((await bump(['--minor', '--json'])).stdout);
  assert.equal(minor.version, '0.2.0');
  assert.deepEqual(minor.updatedPins, []);
  assert.equal(minor.stalePins.length, 2);
  assert.deepEqual(minor.stalePins.map((pin) => pin.kind).sort(), ['home', 'project']);
  for (const pin of minor.stalePins) {
    assert.equal(pin.range, '^0.1.0');
    assert.ok(pin.root);
  }
  assert.ok(minor.warnings.some((warning) => /does not satisfy/.test(warning)));
  assert.equal((await readRootManifest()).skills.dependencies['demo-skill'], '^0.1.0');
  assert.equal((await readHomeManifest()).skills.dependencies['demo-skill'], '^0.1.0');

  const updated = JSON.parse((await bump(['--minor', '--update-pins', '--json'])).stdout);
  assert.equal(updated.version, '0.3.0');
  assert.deepEqual(updated.stalePins, []);
  assert.equal(updated.updatedPins.length, 2);
  for (const pin of updated.updatedPins) {
    assert.equal(pin.from, '^0.1.0');
    assert.equal(pin.to, '^0.3.0');
  }
  assert.equal((await readRootManifest()).skills.dependencies['demo-skill'], '^0.3.0');
  assert.equal((await readHomeManifest()).skills.dependencies['demo-skill'], '^0.3.0');

  // A bump that skipped --update-pins must stay repairable: re-running
  // set-version at the current version still reports and rewrites stale pins.
  await bump(['--major', '--json']);
  const setVersion = (args) => run('node', [CLI, 'skill', 'set-version', 'demo-skill', '1.0.0', ...args], { cwd: fx.root, env });
  const reported = JSON.parse((await setVersion(['--json'])).stdout);
  assert.equal(reported.action, 'unchanged');
  assert.equal(reported.stalePins.length, 2);
  assert.ok(reported.warnings.some((warning) => /does not satisfy/.test(warning)));

  const repaired = JSON.parse((await setVersion(['--update-pins', '--json'])).stdout);
  assert.equal(repaired.action, 'unchanged');
  assert.deepEqual(repaired.stalePins, []);
  assert.equal(repaired.updatedPins.length, 2);
  assert.equal((await readRootManifest()).skills.dependencies['demo-skill'], '^1.0.0');
  assert.equal((await readHomeManifest()).skills.dependencies['demo-skill'], '^1.0.0');
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
  const registry = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'registry.json'), 'utf8'));
  for (const heading of [`Skills (${registry.skills.length})`, 'Managed Agents', 'Managed Subagents', 'Managed Hooks', 'Usage Stats']) {
    assert.ok(html.includes(heading), `missing section: ${heading}`);
  }
  assert.match(html, /Explore \(1\)/);
  assert.doesNotMatch(html, /\{\{[a-z0-9_]+\}\}/);
});

// --- Project skill profiles ---

const DEMO_SKILL_MD = '---\nname: demo-skill\ndescription: Demo skill for project profile tests.\n---\n\n# Demo\n';

/** Registry fixture with one installable skill plus an empty consumer project dir. */
async function projectFixture() {
  const fx = await skillForgeFixture();
  await fx.runWithStdin(['skill', 'write', 'demo-skill', '--set-version', '0.1.0', '--tags', 'demo'], DEMO_SKILL_MD);
  const projectRoot = await tempDir('skf-project-');
  return {
    ...fx,
    projectRoot,
    runInProject(args, opts = {}) {
      return run('node', [CLI, ...args], { cwd: projectRoot, env: fx.env, ...opts });
    },
    async readManifest() {
      return JSON.parse(await fs.readFile(path.join(projectRoot, 'skill-forge.json'), 'utf8'));
    },
    async writeManifest(manifest) {
      await fs.writeFile(path.join(projectRoot, 'skill-forge.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    },
    async readProjectLock() {
      return JSON.parse(await fs.readFile(path.join(projectRoot, 'skill-forge.lock.json'), 'utf8'));
    }
  };
}

test('satisfiesRange follows npm exact/tilde/caret semantics', async () => {
  const { satisfiesRange } = await import('../lib/skill-helpers.js');
  assert.equal(satisfiesRange('0.1.0', '0.1.0'), true);
  assert.equal(satisfiesRange('0.1.1', '0.1.0'), false);
  assert.equal(satisfiesRange('0.1.5', '~0.1.0'), true);
  assert.equal(satisfiesRange('0.2.0', '~0.1.0'), false);
  assert.equal(satisfiesRange('0.1.9', '^0.1.0'), true);
  assert.equal(satisfiesRange('0.2.0', '^0.1.0'), false);
  assert.equal(satisfiesRange('1.9.9', '^1.2.0'), true);
  assert.equal(satisfiesRange('2.0.0', '^1.2.0'), false);
  assert.equal(satisfiesRange('1.1.0', '^1.2.0'), false);
  assert.equal(satisfiesRange('0.0.3', '^0.0.3'), true);
  assert.equal(satisfiesRange('0.0.4', '^0.0.3'), false);
  assert.throws(() => satisfiesRange('1.0.0', '>=1.0.0'), /Invalid range/);
});

test('project init + add + sync vendors skills and writes a reproducible lockfile', async () => {
  const fx = await projectFixture();

  await fx.runInProject(['project', 'init']);
  const manifest = await fx.readManifest();
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.skills.shims, ['claude-code']);
  assert.equal(manifest.tools, undefined, 'the tools map is gone in schemaVersion 2');

  const { stdout: addOut } = await fx.runInProject(['project', 'add', 'demo-skill']);
  assert.match(addOut, /\+ demo-skill \^0\.1\.0/);
  assert.equal((await fx.readManifest()).skills.dependencies['demo-skill'], '^0.1.0');
  await assert.rejects(fx.runInProject(['project', 'add', 'missing-skill']), /not an installable registry skill/);
  await assert.rejects(fx.runInProject(['project', 'add']), /interactive search needs a terminal/);
  await assert.rejects(fx.runInProject(['project', 'init']), /already exists/);

  await fx.runInProject(['sync']);
  for (const dir of ['.agents/skills', '.claude/skills']) {
    const body = await fs.readFile(path.join(fx.projectRoot, dir, 'demo-skill', 'SKILL.md'), 'utf8');
    assert.equal(body, DEMO_SKILL_MD);
  }
  const lock = await fx.readProjectLock();
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.registry.name, 'skill-forge-test');
  assert.match(lock.registry.lockIntegrity, /^sha256-/);
  assert.deepEqual(Object.keys(lock.skills), ['demo-skill']);
  assert.equal(lock.skills['demo-skill'].version, '0.1.0');
  assert.equal(lock.skills['demo-skill'].source, 'registry');
  assert.match(lock.skills['demo-skill'].integrity, /^sha256-/);

  const { stdout: checkOut } = await fx.runInProject(['sync', '--check']);
  assert.match(checkOut, /in sync/);
  const { stdout: statusOut } = await fx.runInProject(['project', 'status']);
  assert.match(statusOut, /demo-skill@0\.1\.0 \(registry\)/);
  assert.match(statusOut, /In sync\./);

  const { stdout: statusJsonOut } = await fx.runInProject(['project', 'status', '--json']);
  const statusJson = JSON.parse(statusJsonOut);
  assert.deepEqual(statusJson.shims, ['claude-code']);
  assert.deepEqual(statusJson.targets, ['.agents/skills', '.claude/skills']);
  assert.deepEqual(statusJson.extends, []);
  assert.deepEqual(statusJson.skills, [{ name: 'demo-skill', version: '0.1.0', source: 'registry', state: 'clean' }]);
  assert.deepEqual(statusJson.staleNames, []);
  assert.deepEqual(statusJson.issues, []);
});

test('sync --check flags vendored drift, manifest drift, and registry bumps; sync repairs', async () => {
  const fx = await projectFixture();
  await fx.runInProject(['project', 'init']);
  await fx.runInProject(['project', 'add', 'demo-skill']);
  await fx.runInProject(['sync']);

  const vendoredPath = path.join(fx.projectRoot, '.agents', 'skills', 'demo-skill', 'SKILL.md');
  await fs.appendFile(vendoredPath, 'tampered\n');
  await assert.rejects(fx.runInProject(['sync', '--check']), /differs from the resolved skill/);

  const { stdout: driftedStatusOut } = await fx.runInProject(['project', 'status', '--json']);
  const driftedStatus = JSON.parse(driftedStatusOut);
  assert.deepEqual(driftedStatus.skills, [{ name: 'demo-skill', version: '0.1.0', source: 'registry', state: 'differs' }]);
  assert.ok(driftedStatus.issues.some((issue) => issue.includes('differs from the resolved skill')));

  await fx.runInProject(['sync']);
  assert.equal(await fs.readFile(vendoredPath, 'utf8'), DEMO_SKILL_MD);
  await fx.runInProject(['sync', '--check']);

  // Compatible registry bump: lockfile is now stale until the next sync.
  await fx.run(['skill', 'bump', 'demo-skill']);
  await assert.rejects(fx.runInProject(['sync', '--check']), /stale/);
  await fx.runInProject(['sync']);
  assert.equal((await fx.readProjectLock()).skills['demo-skill'].version, '0.1.1');

  // Incompatible bump: resolution fails the declared range.
  await fx.run(['skill', 'set-version', 'demo-skill', '1.0.0']);
  await assert.rejects(fx.runInProject(['sync']), /does not satisfy range "\^0\.1\.0"/);
});

test('sync refuses undeclared collisions, prunes removed deps, and records local skills', async () => {
  const fx = await projectFixture();
  await fx.runInProject(['project', 'init']);
  const noShims = await fx.readManifest();
  noShims.skills.shims = [];
  await fx.writeManifest(noShims);

  // Undeclared pre-existing dir at the vendor path is a hard error.
  await fx.runInProject(['project', 'add', 'demo-skill']);
  const collisionDir = path.join(fx.projectRoot, '.agents', 'skills', 'demo-skill');
  await fs.mkdir(collisionDir, { recursive: true });
  await fs.writeFile(path.join(collisionDir, 'SKILL.md'), 'hand-authored\n');
  await assert.rejects(fx.runInProject(['sync']), /not managed by Skill Forge/);
  await fs.rm(collisionDir, { recursive: true });

  // Local skills are locked with integrity but never copied.
  const localDir = path.join(fx.projectRoot, 'local-skills', 'my-override');
  await fs.mkdir(localDir, { recursive: true });
  await fs.writeFile(path.join(localDir, 'SKILL.md'), '---\nname: my-override\ndescription: Local.\n---\n');
  const manifest = await fx.readManifest();
  manifest.skills.local = { 'my-override': 'local-skills/my-override' };
  await fx.writeManifest(manifest);

  await fx.runInProject(['sync']);
  let lock = await fx.readProjectLock();
  assert.equal(lock.skills['my-override'].source, 'local');
  assert.equal(lock.skills['my-override'].path, 'local-skills/my-override');
  assert.equal(await fs.access(path.join(fx.projectRoot, '.claude')).then(() => true, () => false), false);

  // Removing the dependency prunes the vendored copy on the next sync.
  const trimmed = await fx.readManifest();
  delete trimmed.skills.dependencies['demo-skill'];
  await fx.writeManifest(trimmed);
  await assert.rejects(fx.runInProject(['sync', '--check']), /no longer in the profile/);
  await fx.runInProject(['sync']);
  assert.equal(await fs.access(collisionDir).then(() => true, () => false), false);
  lock = await fx.readProjectLock();
  assert.deepEqual(Object.keys(lock.skills), ['my-override']);
});

test('extends resolves registry profiles and enforces their ranges', async () => {
  const fx = await projectFixture();
  const registry = await fx.readRegistry();
  registry.profiles = { baseline: { 'demo-skill': '^0.1.0' } };
  await fx.writeRegistry(registry);
  await fx.run(['lock']);

  await fx.runInProject(['project', 'init']);
  const manifest = await fx.readManifest();
  manifest.extends = ['baseline'];
  await fx.writeManifest(manifest);

  await fx.runInProject(['sync']);
  assert.equal((await fx.readProjectLock()).skills['demo-skill'].version, '0.1.0');

  manifest.extends = ['nope'];
  await fx.writeManifest(manifest);
  await assert.rejects(fx.runInProject(['sync']), /Unknown profile "nope"/);
});

test('noun-verb namespaces install and diff; legacy spellings warn', async () => {
  const dir = await tempDir('skf-nounverb-');
  const target = path.join(dir, 'CLAUDE.md');
  await run('node', [CLI, 'agent', 'install', 'claude-code-agents', '--target', 'claude-code', '--path', target, '--yes'], { cwd: REPO_ROOT });
  const composed = await fs.readFile(target, 'utf8');
  assert.doesNotMatch(composed, /\{\{[a-z0-9_]+\}\}/);

  const { stdout: diffOut } = await run('node', [CLI, 'subagent', 'diff'], { cwd: REPO_ROOT });
  assert.match(diffOut, /- .+: (clean|differs|missing)/);

  const { stdout: legacyOut } = await run('node', [CLI, 'diff-subagents'], { cwd: REPO_ROOT });
  assert.match(legacyOut, /deprecated; use "subagent diff"/);

  const fx = await projectFixture();
  const addDir = await tempDir('skf-deprecated-add-');
  const { stdout: addOut } = await fx.run(['add', 'demo-skill', '--dir', addDir, '--yes']);
  assert.match(addOut, /"add" is deprecated/);
  assert.match(addOut, /skills are project-scoped/);
});

// Bounded: on a regression these invocations block on an inquirer prompt rather
// than exiting, so the test must fail on time rather than hang the suite.
test('install is non-interactive under --yes and refuses to prompt on closed stdin', { timeout: 30_000 }, async () => {
  const dir = await tempDir('skf-noninteractive-');
  const target = path.join(dir, 'AGENTS.md');

  // --yes supplies the artifact selection; --path is still explicit here.
  await run('node', [CLI, 'agent', 'install', '--target', 'codex', '--path', target, '--yes'], { cwd: REPO_ROOT });
  assert.match(await fs.readFile(target, 'utf8'), /Delegation Strategy/);

  // Every prompt the install flow can reach fails with an actionable message
  // rather than an inquirer ERR_USE_AFTER_CLOSE stack.
  await assert.rejects(
    run('node', [CLI, 'agent', 'install'], { cwd: REPO_ROOT }),
    (error) => /needs a terminal; pass --target <tool>/.test(error.stdout + error.stderr)
  );
  await assert.rejects(
    run('node', [CLI, 'install', '--type', 'skill', '--target', 'codex', '--yes'], { cwd: REPO_ROOT }),
    (error) => /needs a terminal; pass --path <path>/.test(error.stdout + error.stderr)
  );
});

test('home env prints the role line and installs an idempotent, replaceable rc block', async () => {
  const dir = await tempDir('skf-homeenv-');
  const rc = path.join(dir, 'rc');
  const env = ['home', 'env'];

  // Print mode is side-effect free and eval-able.
  const { stdout: printed } = await run('node', [CLI, ...env], { cwd: REPO_ROOT });
  assert.equal(printed.trim(), 'export SKILL_FORGE_AGENT_ROLE=orchestrator');
  assert.equal(await fs.access(rc).then(() => true, () => false), false);

  const { stdout: fishOut } = await run('node', [CLI, ...env, '--shell', 'fish'], { cwd: REPO_ROOT });
  assert.equal(fishOut.trim(), 'set -gx SKILL_FORGE_AGENT_ROLE orchestrator');

  await assert.rejects(run('node', [CLI, ...env, '--role', 'nope'], { cwd: REPO_ROOT }));

  // Existing rc content is preserved, and re-installing must not stack blocks.
  await fs.writeFile(rc, 'export FOO=1\n');
  await run('node', [CLI, ...env, '--install', '--rc', rc], { cwd: REPO_ROOT });
  await run('node', [CLI, ...env, '--install', '--rc', rc], { cwd: REPO_ROOT });
  let body = await fs.readFile(rc, 'utf8');
  assert.match(body, /export FOO=1/);
  assert.equal(body.match(/# >>> skill-forge >>>/g).length, 1);
  assert.match(body, /export SKILL_FORGE_AGENT_ROLE=orchestrator/);

  // Changing the role rewrites the managed block in place.
  await run('node', [CLI, ...env, '--install', '--rc', rc, '--role', 'worker'], { cwd: REPO_ROOT });
  body = await fs.readFile(rc, 'utf8');
  assert.equal(body.match(/# >>> skill-forge >>>/g).length, 1);
  assert.match(body, /export SKILL_FORGE_AGENT_ROLE=worker/);
  assert.doesNotMatch(body, /ROLE=orchestrator/);
});

test('home namespace seeds skill-forge-project and syncs the $HOME profile from any cwd', async () => {
  const fx = await skillForgeFixture();
  await fx.runWithStdin(
    ['skill', 'write', 'skill-forge-project', '--set-version', '0.1.0'],
    '---\nname: skill-forge-project\ndescription: Meta skill for home profile tests.\n---\n\n# Meta\n'
  );
  const fakeHome = await tempDir('skf-home-');
  const env = { ...fx.env, HOME: fakeHome };

  const { stdout: initOut } = await run('node', [CLI, 'home', 'init'], { cwd: fx.root, env });
  assert.match(initOut, /Seeded: skill-forge-project \^0\.1\.0/);
  const manifest = JSON.parse(await fs.readFile(path.join(fakeHome, 'skill-forge.json'), 'utf8'));
  assert.deepEqual(manifest.skills.dependencies, { 'skill-forge-project': '^0.1.0' });

  await run('node', [CLI, 'home', 'sync'], { cwd: fx.root, env });
  await fs.access(path.join(fakeHome, '.agents', 'skills', 'skill-forge-project', 'SKILL.md'));
  await fs.access(path.join(fakeHome, '.claude', 'skills', 'skill-forge-project', 'SKILL.md'));

  const { stdout: checkOut } = await run('node', [CLI, 'home', 'sync', '--check'], { cwd: fx.root, env });
  assert.match(checkOut, /in sync/);
  const { stdout: statusOut } = await run('node', [CLI, 'home', 'status', '--json'], { cwd: fx.root, env });
  const status = JSON.parse(statusOut);
  assert.deepEqual(status.skills.map((entry) => entry.name), ['skill-forge-project']);
  await assert.rejects(run('node', [CLI, 'home', 'init'], { cwd: fx.root, env }), /already exists/);
});

test('skills are stored once in .agents/skills; tool dirs are symlinks to it', async () => {
  const fx = await projectFixture();
  await fx.runInProject(['project', 'init', '--shims', 'claude-code']);
  await fx.runInProject(['project', 'add', 'demo-skill']);
  await fx.runInProject(['sync']);

  // The real copy lives in the neutral dir even for a claude-code-only profile.
  await fs.access(path.join(fx.projectRoot, '.agents', 'skills', 'demo-skill', 'SKILL.md'));
  const linkPath = path.join(fx.projectRoot, '.claude', 'skills');
  assert.equal((await fs.lstat(linkPath)).isSymbolicLink(), true, '.claude/skills must be a symlink');
  assert.equal(await fs.readlink(linkPath), path.join('..', '.agents', 'skills'));
  // ...and the skill is readable through the link.
  await fs.access(path.join(linkPath, 'demo-skill', 'SKILL.md'));
  await fx.runInProject(['sync', '--check']);

  // One stored copy, not two.
  const viaReal = await fs.stat(path.join(fx.projectRoot, '.agents', 'skills', 'demo-skill', 'SKILL.md'));
  const viaLink = await fs.stat(path.join(linkPath, 'demo-skill', 'SKILL.md'));
  assert.equal(viaReal.ino, viaLink.ino, 'both paths must resolve to the same file');

  // Dropping the shim removes the link and never prunes through it. An empty
  // shim list is a valid end state, not an error: the store still exists.
  const manifest = await fx.readManifest();
  manifest.skills.shims = [];
  await fx.writeManifest(manifest);
  await assert.rejects(fx.runInProject(['sync', '--check']), /not a declared shim/);
  await fx.runInProject(['sync']);
  assert.equal(await fs.lstat(linkPath).then(() => true, () => false), false, 'the link is removed');
  await fs.access(path.join(fx.projectRoot, '.agents', 'skills', 'demo-skill', 'SKILL.md'));
  await fx.runInProject(['sync', '--check']);
});

test('a schemaVersion 1 manifest migrates: tools become shims, no-op tools are dropped', async () => {
  const fx = await projectFixture();
  await fx.runInProject(['project', 'init']);
  await fx.runInProject(['project', 'add', 'demo-skill']);

  // Hand-write the old shape, including tools that never had a shim.
  await fx.writeManifest({
    schemaVersion: 1,
    extends: [],
    skills: { dependencies: { 'demo-skill': '^0.1.0' } },
    tools: { codex: true, 'claude-code': true, grok: true }
  });
  await fx.runInProject(['sync']);

  const migrated = await fx.readManifest();
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(migrated.skills.shims, ['claude-code'], 'only tools with a shim survive');
  assert.equal(migrated.tools, undefined);
  assert.equal((await fs.lstat(path.join(fx.projectRoot, '.claude', 'skills'))).isSymbolicLink(), true);
  await fx.runInProject(['sync', '--check']);
});

test('sync migrates an existing real tool directory to a symlink, but not over foreign files', async () => {
  const fx = await projectFixture();
  await fx.runInProject(['project', 'init', '--shims', 'claude-code']);
  await fx.runInProject(['project', 'add', 'demo-skill']);
  await fx.runInProject(['sync']);

  const linkPath = path.join(fx.projectRoot, '.claude', 'skills');

  // Recreate the old copy layout, then let sync migrate it.
  await fs.rm(linkPath, { force: true });
  await fs.mkdir(path.join(linkPath, 'demo-skill'), { recursive: true });
  await fs.writeFile(path.join(linkPath, 'demo-skill', 'SKILL.md'), 'stale copy\n');
  await assert.rejects(fx.runInProject(['sync', '--check']), /should be a symlink/);
  await fx.runInProject(['sync']);
  assert.equal((await fs.lstat(linkPath)).isSymbolicLink(), true);

  // A hand-placed directory is never swallowed by the migration.
  await fs.rm(linkPath, { force: true });
  await fs.mkdir(path.join(linkPath, 'someones-own-skill'), { recursive: true });
  await fs.writeFile(path.join(linkPath, 'someones-own-skill', 'SKILL.md'), 'mine\n');
  await assert.rejects(fx.runInProject(['sync']), /does not manage \(someones-own-skill\)/);
  await fs.access(path.join(linkPath, 'someones-own-skill', 'SKILL.md'));
});

// --- project instructions (AGENTS.md / CLAUDE.md check) ---

let instructionsEnv;
async function instructionsBaseEnv() {
  instructionsEnv ??= (await skillForgeFixture()).env;
  return instructionsEnv;
}

/** A session root: skill-forge.json declaring `shims`, plus whichever instruction files the test names. */
async function instructionsRoot(files = {}, { shims = ['claude-code'] } = {}) {
  const root = await tempDir('skf-instr-');
  const manifest = { schemaVersion: 2, extends: [], skills: { dependencies: {}, shims } };
  await fs.writeFile(path.join(root, 'skill-forge.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content);
  return root;
}

async function runInstructions(root, args = [], extraEnv = {}) {
  return run('node', [CLI, 'project', 'instructions', ...args], {
    cwd: root,
    env: { ...(await instructionsBaseEnv()), ...extraEnv }
  });
}

async function snapshotTree(dir) {
  const out = {};
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) {
        out[`${rel}/`] = 'dir';
        await walk(full);
      } else if (entry.isSymbolicLink()) out[rel] = `link:${await fs.readlink(full)}`;
      else out[rel] = `${(await fs.stat(full)).mtimeMs}:${(await fs.readFile(full)).toString('base64')}`;
    }
  }
  await walk(dir);
  return out;
}

const fileState = (report, name) => report.files.find((file) => file.path === name)?.state;

test('project instructions passes a complete session root in every mode', async () => {
  const root = await instructionsRoot({ 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '@AGENTS.md\n' });
  const { stdout } = await runInstructions(root);
  assert.match(stdout, /AGENTS\.md\s+ok/);
  assert.match(stdout, /CLAUDE\.md\s+ok/);
  await runInstructions(root, ['--check']);
  const report = JSON.parse((await runInstructions(root, ['--json'])).stdout);
  assert.deepEqual(report.issues, []);
  assert.equal(report.claudeMdRequired, true);
  assert.equal(fileState(report, 'AGENTS.md'), 'ok');
  assert.equal(fileState(report, 'CLAUDE.md'), 'ok');
});

test('project instructions reports a missing or empty AGENTS.md; --check turns it into exit 1', async () => {
  const missing = await instructionsRoot({ 'CLAUDE.md': '@AGENTS.md\n' });
  const { stdout } = await runInstructions(missing);
  assert.match(stdout, /! AGENTS\.md is missing\./, 'default mode reports and exits 0');
  await assert.rejects(runInstructions(missing, ['--check']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /! AGENTS\.md is missing\./);
    return true;
  });
  const missingJson = JSON.parse((await runInstructions(missing, ['--json'])).stdout);
  assert.equal(fileState(missingJson, 'AGENTS.md'), 'missing');
  assert.equal(missingJson.issues.length, 1);

  const empty = await instructionsRoot({ 'AGENTS.md': ' \n\n', 'CLAUDE.md': '@AGENTS.md\n' });
  const emptyJson = JSON.parse((await runInstructions(empty, ['--json'])).stdout);
  assert.equal(fileState(emptyJson, 'AGENTS.md'), 'empty');
  await assert.rejects(runInstructions(empty, ['--check']), /! AGENTS\.md is empty\./);
});

test('project instructions refuses an AGENTS.md that is not a regular file', async () => {
  const root = await instructionsRoot({ 'CLAUDE.md': '@AGENTS.md\n' });
  await fs.mkdir(path.join(root, 'AGENTS.md'));
  const report = JSON.parse((await runInstructions(root, ['--json'])).stdout);
  assert.equal(fileState(report, 'AGENTS.md'), 'not-a-file');
  await assert.rejects(runInstructions(root, ['--check']), /! AGENTS\.md is not a regular file\./);
});

test('project instructions requires CLAUDE.md only when the claude-code shim is declared', async () => {
  const withShim = await instructionsRoot({ 'AGENTS.md': '# Rules\n' });
  await assert.rejects(runInstructions(withShim, ['--check']), /! CLAUDE\.md is missing \(the claude-code shim is enabled\)\./);

  const withoutShim = await instructionsRoot({ 'AGENTS.md': '# Rules\n' }, { shims: [] });
  await runInstructions(withoutShim, ['--check']);
  const report = JSON.parse((await runInstructions(withoutShim, ['--json'])).stdout);
  assert.equal(report.claudeMdRequired, false);
  assert.equal(fileState(report, 'CLAUDE.md'), 'missing');
  assert.deepEqual(report.issues, []);
});

test('project instructions tolerates CRLF, trailing spaces and extra content around the import', async () => {
  const root = await instructionsRoot({
    'AGENTS.md': '# Rules\n',
    'CLAUDE.md': '# Claude notes\r\n\r\n  @AGENTS.md   \r\n\r\nMore project notes.\r\n'
  });
  await runInstructions(root, ['--check']);
  assert.equal(fileState(JSON.parse((await runInstructions(root, ['--json'])).stdout), 'CLAUDE.md'), 'ok');
});

test('project instructions flags a CLAUDE.md with no import, and only notes an import of another path', async () => {
  const bare = await instructionsRoot({ 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '# Standalone rules\n' });
  await assert.rejects(runInstructions(bare, ['--check']), /! CLAUDE\.md does not import AGENTS\.md/);
  assert.equal(fileState(JSON.parse((await runInstructions(bare, ['--json'])).stdout), 'CLAUDE.md'), 'no-import');

  const indirect = await instructionsRoot({ 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '@.claude/CLAUDE.md\n' });
  await runInstructions(indirect, ['--check']);
  const report = JSON.parse((await runInstructions(indirect, ['--json'])).stdout);
  assert.equal(fileState(report, 'CLAUDE.md'), 'indirect-import');
  assert.deepEqual(report.issues, []);
  assert.equal(report.notes.length, 1);
  assert.match(report.notes[0], /\.claude\/CLAUDE\.md/);
});

test('project instructions accepts a CLAUDE.md symlinked to AGENTS.md', async () => {
  const root = await instructionsRoot({ 'AGENTS.md': '# Rules\n' });
  await fs.symlink('AGENTS.md', path.join(root, 'CLAUDE.md'));
  await runInstructions(root, ['--check']);
  assert.equal(fileState(JSON.parse((await runInstructions(root, ['--json'])).stdout), 'CLAUDE.md'), 'ok');
});

test('project instructions needs a skill-forge.json and refuses to run in $HOME', async () => {
  const bare = await tempDir('skf-instr-bare-');
  await assert.rejects(runInstructions(bare), /No skill-forge\.json/);

  const home = await instructionsRoot({ 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '@AGENTS.md\n' });
  await assert.rejects(runInstructions(home, [], { HOME: home }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /agent install/);
    return true;
  });
});

test('project instructions writes nothing in any mode', async () => {
  const root = await instructionsRoot({ 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '# Standalone\n' });
  const before = await snapshotTree(root);
  await runInstructions(root);
  await runInstructions(root, ['--json']);
  await assert.rejects(runInstructions(root, ['--check']));
  assert.deepEqual(await snapshotTree(root), before);
});

test('project instructions only treats a bare path-like token as an import, outside code fences', async () => {
  const cases = [
    ['@todo tidy this up\n', 'no-import'],
    ['@todo\n', 'no-import'],
    ['@AGENTS.md please\n', 'no-import'],
    ['```\n@AGENTS.md\n```\n', 'no-import'],
    ['~~~\n@AGENTS.md\n~~~\n@AGENTS.md\n', 'ok'],
    ['@AGENTS.md.bak\n', 'indirect-import']
  ];
  for (const [content, expected] of cases) {
    const root = await instructionsRoot({ 'AGENTS.md': '# Rules\n', 'CLAUDE.md': content });
    const report = JSON.parse((await runInstructions(root, ['--json'])).stdout);
    assert.equal(fileState(report, 'CLAUDE.md'), expected, JSON.stringify(content));
    assert.equal(report.issues.length, expected === 'no-import' ? 1 : 0, JSON.stringify(content));
  }
});

test('project instructions never echoes control characters or free text from CLAUDE.md', async () => {
  const root = await instructionsRoot({ 'AGENTS.md': '# Rules\n', 'CLAUDE.md': `@docs/\u001b[31mred${'x'.repeat(300)}\n` });
  const report = JSON.parse((await runInstructions(root, ['--json'])).stdout);
  assert.equal(report.notes.length, 1);
  assert.doesNotMatch(report.notes[0], /\u001b/);
  assert.ok(report.notes[0].length < 200, 'the echoed target is capped');
});

test('project instructions judges CLAUDE.md only when the claude-code shim is declared', async () => {
  const root = await instructionsRoot({ 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '# Standalone rules\n' }, { shims: [] });
  await runInstructions(root, ['--check']);
  const report = JSON.parse((await runInstructions(root, ['--json'])).stdout);
  assert.equal(fileState(report, 'CLAUDE.md'), 'no-import', 'the state is still reported');
  assert.deepEqual(report.issues, []);

  const asDirectory = await instructionsRoot({ 'AGENTS.md': '# Rules\n' }, { shims: [] });
  await fs.mkdir(path.join(asDirectory, 'CLAUDE.md'));
  await runInstructions(asDirectory, ['--check']);
  const shimmed = await instructionsRoot({ 'AGENTS.md': '# Rules\n' });
  await fs.mkdir(path.join(shimmed, 'CLAUDE.md'));
  await assert.rejects(runInstructions(shimmed, ['--check']), /! CLAUDE\.md is not a regular file\./);
});

test('project instructions reports a looping symlink or unreadable file as an issue instead of crashing', async () => {
  const looping = await instructionsRoot({ 'AGENTS.md': '# Rules\n' });
  await fs.symlink('CLAUDE.md', path.join(looping, 'CLAUDE.md'));
  const loopReport = JSON.parse((await runInstructions(looping, ['--json'])).stdout);
  assert.equal(fileState(loopReport, 'CLAUDE.md'), 'not-a-file');
  await assert.rejects(runInstructions(looping, ['--check']), /! CLAUDE\.md is not a regular file\./);

  if (process.getuid?.() === 0) return;
  const locked = await instructionsRoot({ 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '@AGENTS.md\n' });
  await fs.chmod(path.join(locked, 'AGENTS.md'), 0o000);
  try {
    const report = JSON.parse((await runInstructions(locked, ['--json'])).stdout);
    assert.equal(fileState(report, 'AGENTS.md'), 'unreadable');
    await assert.rejects(runInstructions(locked, ['--check']), /! AGENTS\.md is not readable\./);
  } finally {
    await fs.chmod(path.join(locked, 'AGENTS.md'), 0o644);
  }
});

test('project instructions keeps its output contract: --check with --json, stdout/stderr split, JSON errors', async () => {
  const broken = await instructionsRoot({ 'CLAUDE.md': '@AGENTS.md\n' });

  const { stdout, stderr } = await runInstructions(broken);
  assert.match(stdout, /! AGENTS\.md is missing\./);
  assert.equal(stderr, '', 'default mode keeps issues off stderr');

  await assert.rejects(runInstructions(broken, ['--check', '--json']), (error) => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    assert.deepEqual(Object.keys(report).sort(), ['claudeMdRequired', 'files', 'issues', 'notes', 'root']);
    assert.deepEqual(report.issues, ['AGENTS.md is missing.']);
    return true;
  });
  await assert.rejects(runInstructions(broken, ['--check']), (error) => {
    assert.equal(error.code, 1);
    assert.doesNotMatch(error.stdout, /^! /m, '--check keeps issues off stdout');
    return true;
  });

  const bare = await tempDir('skf-instr-bare-');
  await assert.rejects(runInstructions(bare, ['--json']), (error) => {
    assert.equal(error.code, 1);
    assert.match(JSON.parse(error.stdout).error, /No skill-forge\.json/);
    return true;
  });
  await assert.rejects(runInstructions(bare), (error) => {
    assert.equal(error.code, 1);
    return true;
  });
  await assert.rejects(runInstructions(broken, ['--json'], { HOME: broken }), (error) => {
    assert.equal(error.code, 1);
    assert.match(JSON.parse(error.stdout).error, /agent install/);
    return true;
  });
});

test('project instructions still runs when HOME points at a directory that does not exist', async () => {
  const root = await instructionsRoot({ 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '@AGENTS.md\n' });
  await runInstructions(root, ['--check'], { HOME: path.join(root, 'no-such-home') });
});

// --- project scaffold (create AGENTS.md / CLAUDE.md, record the role) ---

async function runScaffold(root, args = [], extraEnv = {}) {
  return run('node', [CLI, 'project', 'scaffold', ...args], {
    cwd: root,
    env: { ...(await instructionsBaseEnv()), ...extraEnv }
  });
}

const readIfExists = (file) => fs.readFile(file, 'utf8').catch(() => null);
const readRoleFrom = async (root) => JSON.parse(await fs.readFile(path.join(root, 'skill-forge.json'), 'utf8')).instructions?.role;

test('project scaffold creates both files for a fresh root, records the role, and passes the check', async () => {
  const root = await instructionsRoot();
  const { stdout } = await runScaffold(root);
  assert.match(stdout, /AGENTS\.md/);
  assert.equal(await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  const agents = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(agents.trim().length > 0);
  assert.match(agents, /skf:scaffold/);
  assert.equal(await readRoleFrom(root), 'repo');

  const report = JSON.parse((await runInstructions(root, ['--json'])).stdout);
  assert.deepEqual(report.issues, []);
  assert.equal(report.notes.length, 1, 'the placeholder marker is a note');
  assert.match(report.notes[0], /scaffold marker/);
  await runInstructions(root, ['--check']);
});

test('project scaffold templates: umbrella carries the absolute ledger path, child carries the verbatim SESSION.md hook', async () => {
  const umbrella = await instructionsRoot();
  await runScaffold(umbrella, ['--role', 'umbrella']);
  const umbrellaAgents = await fs.readFile(path.join(umbrella, 'AGENTS.md'), 'utf8');
  const realRoot = await fs.realpath(umbrella);
  assert.ok(umbrellaAgents.includes(`${realRoot}/tasks/todo.md`), 'absolute path of this root\'s tasks/todo.md');
  assert.match(umbrellaAgents, new RegExp(`^# ${path.basename(realRoot)} workspace$`, 'm'));
  assert.match(umbrellaAgents, /^## Child repos$/m);
  assert.equal(await readRoleFrom(umbrella), 'umbrella');

  const child = await instructionsRoot();
  await runScaffold(child, ['--role', 'child']);
  const childAgents = await fs.readFile(path.join(child, 'AGENTS.md'), 'utf8');
  const guide = await fs.readFile(path.join(REPO_ROOT, 'inventory', 'skills', 'umbrella-workspace', 'PARALLEL-WORKTREES.md'), 'utf8');
  const hook = guide.match(/```markdown\n(## Session ownership \(worktree\)[\s\S]*?)\n```/);
  assert.ok(hook, 'the hook block exists in PARALLEL-WORKTREES.md');
  assert.ok(childAgents.includes(hook[1].trim()), 'the child template embeds the guide\'s hook verbatim');
  assert.equal(await readRoleFrom(child), 'child');

  const plain = await instructionsRoot();
  await runScaffold(plain);
  assert.doesNotMatch(await fs.readFile(path.join(plain, 'AGENTS.md'), 'utf8'), /Session ownership/);
});

test('project scaffold never touches an existing file and creates only what is missing', async () => {
  const root = await instructionsRoot({ 'AGENTS.md': '# Mine\n' });
  const before = (await snapshotTree(root))['AGENTS.md'];
  const report = JSON.parse((await runScaffold(root, ['--json'])).stdout);
  assert.deepEqual(report.created, ['CLAUDE.md']);
  assert.deepEqual(report.skipped, [{ path: 'AGENTS.md', reason: 'exists' }]);
  assert.equal((await snapshotTree(root))['AGENTS.md'], before, 'bytes and mtime unchanged');

  const standalone = await instructionsRoot({ 'AGENTS.md': '# Mine\n', 'CLAUDE.md': '# Standalone\n' });
  const beforeStandalone = await snapshotTree(standalone);
  const second = JSON.parse((await runScaffold(standalone, ['--json'])).stdout);
  assert.deepEqual(second.created, []);
  assert.equal(second.issues.length, 1);
  assert.match(second.issues[0], /does not import AGENTS\.md/);
  const afterStandalone = await snapshotTree(standalone);
  assert.equal(afterStandalone['AGENTS.md'], beforeStandalone['AGENTS.md']);
  assert.equal(afterStandalone['CLAUDE.md'], beforeStandalone['CLAUDE.md']);
});

test('project scaffold skips CLAUDE.md without the shim, and a second run creates nothing', async () => {
  const root = await instructionsRoot({}, { shims: [] });
  const first = JSON.parse((await runScaffold(root, ['--json'])).stdout);
  assert.deepEqual(first.created, ['AGENTS.md']);
  assert.deepEqual(first.skipped, [{ path: 'CLAUDE.md', reason: 'shim-not-declared' }]);
  assert.equal(await readIfExists(path.join(root, 'CLAUDE.md')), null);

  const again = JSON.parse((await runScaffold(root, ['--json'])).stdout);
  assert.deepEqual(again.created, []);
  assert.equal(again.roleRecorded, false);
});

test('project scaffold --dry-run writes nothing, not even the manifest', async () => {
  const root = await instructionsRoot();
  const before = await snapshotTree(root);
  const report = JSON.parse((await runScaffold(root, ['--dry-run', '--json'])).stdout);
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.created, ['AGENTS.md', 'CLAUDE.md'], 'created lists what would be created');
  assert.equal(report.roleRecorded, false);
  assert.deepEqual(await snapshotTree(root), before);
  const { stdout } = await runScaffold(root, ['--dry-run']);
  assert.match(stdout, /would create/i);
});

test('project scaffold skips symlinks, dangling symlinks and directories without writing through them', async () => {
  const root = await instructionsRoot();
  const outside = await tempDir('skf-outside-');
  await fs.symlink(path.join(outside, 'target.md'), path.join(root, 'AGENTS.md'));
  await fs.mkdir(path.join(root, 'CLAUDE.md'));
  const report = JSON.parse((await runScaffold(root, ['--json'])).stdout);
  assert.deepEqual(report.created, []);
  assert.deepEqual(report.skipped.map((entry) => `${entry.path}:${entry.reason}`).sort(), ['AGENTS.md:not-a-file', 'CLAUDE.md:not-a-file']);
  assert.equal(await readIfExists(path.join(outside, 'target.md')), null, 'nothing was created through the dangling link');

  const linked = await instructionsRoot({ 'real.md': '# Real\n' });
  await fs.symlink('real.md', path.join(linked, 'AGENTS.md'));
  const linkedReport = JSON.parse((await runScaffold(linked, ['--json'])).stdout);
  assert.ok(linkedReport.skipped.some((entry) => entry.path === 'AGENTS.md' && entry.reason === 'not-a-file'));
  assert.equal(await fs.readFile(path.join(linked, 'real.md'), 'utf8'), '# Real\n');
});

test('project scaffold needs a manifest, refuses $HOME, and rejects an unknown role', async () => {
  const bare = await tempDir('skf-instr-bare-');
  await assert.rejects(runScaffold(bare), /No skill-forge\.json/);

  const home = await instructionsRoot();
  await assert.rejects(runScaffold(home, [], { HOME: home }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /agent install/);
    return true;
  });

  const root = await instructionsRoot();
  const before = await snapshotTree(root);
  await assert.rejects(runScaffold(root, ['--role', 'monorepo']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /repo, umbrella, child/);
    return true;
  });
  assert.deepEqual(await snapshotTree(root), before);
});

test('project scaffold records the role without losing other manifest keys, even when nothing is created', async () => {
  const root = await instructionsRoot({ 'AGENTS.md': '# Mine\n', 'CLAUDE.md': '@AGENTS.md\n' });
  const manifestPath = path.join(root, 'skill-forge.json');
  const original = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  original.somethingElse = { keep: true };
  await fs.writeFile(manifestPath, JSON.stringify(original, null, 2));

  const report = JSON.parse((await runScaffold(root, ['--role', 'umbrella', '--json'])).stdout);
  assert.deepEqual(report.created, []);
  assert.equal(report.roleRecorded, true);
  const after = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.deepEqual(after, { ...original, instructions: { role: 'umbrella' } });
});

test('project scaffold uses the stored role, and a different --role is an error that writes nothing', async () => {
  const root = await instructionsRoot();
  await runScaffold(root, ['--role', 'umbrella']);
  await fs.rm(path.join(root, 'AGENTS.md'));
  const report = JSON.parse((await runScaffold(root, ['--json'])).stdout);
  assert.equal(report.role, 'umbrella', 'the stored role wins over the default');
  assert.match(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), /^## Child repos$/m);

  const before = await snapshotTree(root);
  await assert.rejects(runScaffold(root, ['--role', 'child']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /already records role "umbrella"/);
    return true;
  });
  assert.deepEqual(await snapshotTree(root), before);
});

test('the recorded role survives project add and sync, and sync --check stays clean', async () => {
  const fx = await projectFixture();
  await fx.runInProject(['project', 'init']);
  await fx.runInProject(['project', 'scaffold', '--role', 'umbrella']);
  assert.equal((await fx.readManifest()).instructions.role, 'umbrella');

  await fx.runInProject(['project', 'add', 'demo-skill']);
  assert.equal((await fx.readManifest()).instructions.role, 'umbrella', 'project add preserves it');
  await fx.runInProject(['sync']);
  assert.equal((await fx.readManifest()).instructions.role, 'umbrella', 'sync preserves it');
  await fx.runInProject(['sync', '--check']);
});

test('a bad instructions value breaks instructions and scaffold but not status or sync', async () => {
  const fx = await projectFixture();
  await fx.runInProject(['project', 'init']);
  const manifest = await fx.readManifest();
  manifest.instructions = { role: 'bogus' };
  await fx.writeManifest(manifest);

  await fx.runInProject(['project', 'status']);
  await assert.rejects(fx.runInProject(['project', 'instructions']), /instructions\.role.*repo, umbrella, child/);
  await assert.rejects(fx.runInProject(['project', 'scaffold']), /instructions\.role.*repo, umbrella, child/);

  manifest.instructions = 'nope';
  await fx.writeManifest(manifest);
  await fx.runInProject(['project', 'status']);
  await assert.rejects(fx.runInProject(['project', 'instructions']), /"instructions" must be an object/);
});

test('project scaffold reports a write failure as an error with what was created', async () => {
  if (process.getuid?.() === 0) return;
  const root = await instructionsRoot();
  await fs.chmod(root, 0o555);
  try {
    await assert.rejects(runScaffold(root, ['--json']), (error) => {
      assert.equal(error.code, 1);
      const payload = JSON.parse(error.stdout);
      assert.match(payload.error, /AGENTS\.md/);
      assert.deepEqual(payload.created, []);
      return true;
    });
  } finally {
    await fs.chmod(root, 0o755);
  }
});

test('project scaffold records the role before creating files, so a manifest failure creates nothing', async () => {
  if (process.getuid?.() === 0) return;
  const root = await instructionsRoot();
  const manifestPath = path.join(root, 'skill-forge.json');
  await fs.chmod(manifestPath, 0o444);
  try {
    await assert.rejects(runScaffold(root, ['--role', 'umbrella', '--json']), (error) => {
      assert.equal(error.code, 1);
      const payload = JSON.parse(error.stdout);
      assert.match(payload.error, /could not record the role/);
      assert.deepEqual(payload.created, []);
      return true;
    });
    assert.equal(await readIfExists(path.join(root, 'AGENTS.md')), null);
    assert.equal(await readIfExists(path.join(root, 'CLAUDE.md')), null);
  } finally {
    await fs.chmod(manifestPath, 0o644);
  }
});

test('project scaffold refuses to rewrite a schemaVersion 1 manifest, but a dry run still works', async () => {
  const root = await tempDir('skf-instr-v1-');
  await fs.writeFile(path.join(root, 'skill-forge.json'), `${JSON.stringify({ schemaVersion: 1, tools: { 'claude-code': true }, skills: { dependencies: {} } }, null, 2)}\n`);
  const before = await snapshotTree(root);
  await assert.rejects(runScaffold(root), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /schemaVersion 1; run "skf sync"/);
    return true;
  });
  assert.deepEqual(await snapshotTree(root), before, 'nothing was written');
  const plan = JSON.parse((await runScaffold(root, ['--dry-run', '--json'])).stdout);
  assert.deepEqual(plan.created, ['AGENTS.md', 'CLAUDE.md']);
  assert.deepEqual(await snapshotTree(root), before);
});

test('project scaffold validates --role strictly, including an empty value, and handles a role equal to the stored one', async () => {
  const root = await instructionsRoot();
  await assert.rejects(runScaffold(root, ['--role', '']), /Unknown role ""/);

  await runScaffold(root, ['--role', 'child']);
  const same = JSON.parse((await runScaffold(root, ['--role', 'child', '--json'])).stdout);
  assert.equal(same.roleRecorded, false);
  assert.equal(same.role, 'child');

  const before = await snapshotTree(root);
  const dry = JSON.parse((await runScaffold(root, ['--dry-run', '--json'])).stdout);
  assert.equal(dry.role, 'child', 'a dry run uses the stored role');
  await assert.rejects(runScaffold(root, ['--dry-run', '--role', 'umbrella']), /already records role "child"/);
  assert.deepEqual(await snapshotTree(root), before);
});

test('project scaffold keeps other keys inside instructions, and a non-object instructions fails without a write', async () => {
  const root = await instructionsRoot();
  const manifestPath = path.join(root, 'skill-forge.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.instructions = { note: 'keep me' };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await runScaffold(root, ['--role', 'umbrella']);
  assert.deepEqual(JSON.parse(await fs.readFile(manifestPath, 'utf8')).instructions, { note: 'keep me', role: 'umbrella' });

  const broken = await instructionsRoot();
  const brokenPath = path.join(broken, 'skill-forge.json');
  const brokenManifest = JSON.parse(await fs.readFile(brokenPath, 'utf8'));
  brokenManifest.instructions = 'nope';
  await fs.writeFile(brokenPath, JSON.stringify(brokenManifest, null, 2));
  const before = await snapshotTree(broken);
  await assert.rejects(runScaffold(broken), /"instructions" must be an object/);
  assert.deepEqual(await snapshotTree(broken), before);
});

test('project scaffold leaves a CLAUDE.md symlink alone, dangling or not, and never changes its target', async () => {
  const dangling = await instructionsRoot({ 'AGENTS.md': '# Mine\n' });
  const outside = await tempDir('skf-outside-');
  await fs.symlink(path.join(outside, 'gone.md'), path.join(dangling, 'CLAUDE.md'));
  const danglingReport = JSON.parse((await runScaffold(dangling, ['--json'])).stdout);
  assert.deepEqual(danglingReport.skipped, [
    { path: 'AGENTS.md', reason: 'exists' },
    { path: 'CLAUDE.md', reason: 'not-a-file' }
  ]);
  assert.equal(await readIfExists(path.join(outside, 'gone.md')), null);

  const linked = await instructionsRoot({ 'AGENTS.md': '# Mine\n', 'precious.md': 'do not touch\n' });
  await fs.symlink('precious.md', path.join(linked, 'CLAUDE.md'));
  await runScaffold(linked);
  assert.equal(await fs.readFile(path.join(linked, 'precious.md'), 'utf8'), 'do not touch\n');
});

test('project scaffold neutralises backticks and newlines in the directory name', async () => {
  const base = await tempDir('skf-instr-odd-');
  const root = path.join(base, 'odd`name\n## Injected rules');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'skill-forge.json'), `${JSON.stringify({ schemaVersion: 2, extends: [], skills: { dependencies: {}, shims: [] } })}\n`);
  await runScaffold(root, ['--role', 'umbrella']);
  const agents = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(agents, /^## Injected rules$/m, 'a newline in the name cannot start a heading');
  assert.match(agents, /^# odd\?name\?## Injected rules workspace$/m);
  assert.doesNotMatch(agents.split('## Paths')[1], /odd`name/, 'no raw backtick from the name inside the code span');
});

test('the scaffold marker note appears only while the marker line remains, CRLF included', async () => {
  const root = await instructionsRoot();
  await runScaffold(root);
  const notesOf = async () => JSON.parse((await runInstructions(root, ['--json'])).stdout).notes;
  assert.equal((await notesOf()).length, 1);

  const agentsPath = path.join(root, 'AGENTS.md');
  const original = await fs.readFile(agentsPath, 'utf8');
  await fs.writeFile(agentsPath, original.replace(/\n/g, '\r\n'));
  assert.equal((await notesOf()).length, 1, 'CRLF endings still match');

  await fs.writeFile(agentsPath, original.split('\n').filter((line) => !line.includes('skf:scaffold')).join('\n'));
  assert.deepEqual(await notesOf(), [], 'deleting the marker clears the note');
});

test('project scaffold keeps its JSON key set, and a refused $HOME run writes nothing', async () => {
  const root = await instructionsRoot();
  const report = JSON.parse((await runScaffold(root, ['--json'])).stdout);
  assert.deepEqual(Object.keys(report).sort(), ['created', 'dryRun', 'issues', 'role', 'roleRecorded', 'root', 'skipped']);
  assert.equal(report.roleRecorded, true);

  const home = await instructionsRoot();
  const before = await snapshotTree(home);
  await assert.rejects(runScaffold(home, ['--json'], { HOME: home }), (error) => {
    assert.equal(error.code, 1);
    assert.match(JSON.parse(error.stdout).error, /agent install/);
    return true;
  });
  assert.deepEqual(await snapshotTree(home), before);

  const bare = await tempDir('skf-instr-bare-');
  await assert.rejects(runScaffold(bare), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /No skill-forge\.json/);
    return true;
  });
});

// --- project doctor (profile + instructions + role-aware layout) ---

// process.execPath rather than 'node', so a test can replace PATH without losing node; git config is
// pinned so a developer's global excludes cannot change what "not ignored" means.
async function runDoctor(root, args = [], extraEnv = {}, baseEnv) {
  return run(process.execPath, [CLI, 'project', 'doctor', ...args], {
    cwd: root,
    env: { ...(baseEnv ?? await instructionsBaseEnv()), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extraEnv }
  });
}

/** A session root declaring `role` in its manifest; no lockfile, so only the layout and instructions sections are meaningful. */
async function layoutRoot(role, files = {}, { shims = ['claude-code'] } = {}) {
  const root = await instructionsRoot(files, { shims });
  if (role) {
    const manifestPath = path.join(root, 'skill-forge.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.instructions = { role };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return root;
}

const gitInit = (dir) => run('git', ['init', '-q'], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
const doctorJson = async (root, args = [], env = {}) => JSON.parse((await runDoctor(root, ['--json', ...args], env)).stdout);
const messages = (list) => list.map((entry) => entry.message);

/** A fully synced profile (so the Profile section is clean) with the instruction files in place. */
async function syncedDoctorProject({ role } = {}) {
  const fx = await projectFixture();
  await fx.runInProject(['project', 'init']);
  if (role) {
    await fx.runInProject(['project', 'scaffold', '--role', role]);
  } else {
    await fs.writeFile(path.join(fx.projectRoot, 'AGENTS.md'), '# Rules\n');
    await fs.writeFile(path.join(fx.projectRoot, 'CLAUDE.md'), '@AGENTS.md\n');
  }
  await fx.runInProject(['project', 'add', 'demo-skill']);
  await fx.runInProject(['sync']);
  return fx;
}

test('project doctor passes a healthy root, and its instructions section equals instructions --json', async () => {
  const fx = await syncedDoctorProject({ role: 'repo' });
  const { stdout } = await fx.runInProject(['project', 'doctor', '--check']);
  assert.match(stdout, /Profile/);
  const report = JSON.parse((await fx.runInProject(['project', 'doctor', '--json'])).stdout);
  assert.equal(report.ok, true);
  assert.equal(report.role, 'repo');
  assert.deepEqual(report.issues, []);
  assert.equal(report.sections.layout.applicable, false);
  assert.deepEqual(report.sections.profile.issues, []);

  const instructions = JSON.parse((await fx.runInProject(['project', 'instructions', '--json'])).stdout);
  const { root, ...expected } = instructions;
  assert.deepEqual(report.sections.instructions, expected);
});

test('project doctor reports a profile problem with the same messages as sync --check', async () => {
  const fx = await syncedDoctorProject({ role: 'repo' });
  await fs.rm(path.join(fx.projectRoot, '.agents', 'skills', 'demo-skill'), { recursive: true });

  const syncIssues = await fx.runInProject(['sync', '--check']).then(
    () => assert.fail('sync --check should fail'),
    (error) => error.stderr.split('\n').filter((line) => line.startsWith('! ')).map((line) => line.slice(2))
  );
  assert.ok(syncIssues.length > 0);
  const report = JSON.parse((await fx.runInProject(['project', 'doctor', '--json'])).stdout);
  assert.deepEqual(report.sections.profile.issues, syncIssues);
  assert.equal(report.ok, false);
  await assert.rejects(fx.runInProject(['project', 'doctor', '--check']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /! profile: .*demo-skill/);
    return true;
  });
  await fx.runInProject(['project', 'doctor']);
});

test('project doctor skips the layout section, without an issue, when no role is recorded', async () => {
  const fx = await syncedDoctorProject();
  await fx.runInProject(['project', 'doctor', '--check']);
  const report = JSON.parse((await fx.runInProject(['project', 'doctor', '--json'])).stdout);
  assert.equal(report.role, null);
  assert.equal(report.sections.layout.applicable, false);
  assert.deepEqual(report.sections.layout.issues, []);
  assert.match(report.sections.layout.notes.join(' '), /skf project scaffold --role/);
});

test('project doctor umbrella rules: ledger and path are issues, an unnamed child is only a warning', async () => {
  const fx = await syncedDoctorProject({ role: 'umbrella' });
  const root = fx.projectRoot;
  const layoutOf = async () => JSON.parse((await fx.runInProject(['project', 'doctor', '--json'])).stdout).sections.layout;

  assert.match((await layoutOf()).issues.join(' '), /tasks\/todo\.md is missing or not a regular file/, 'U1: no ledger yet');
  await fs.mkdir(path.join(root, 'tasks'));
  await fs.writeFile(path.join(root, 'tasks', 'todo.md'), '# Tasks\n');
  assert.deepEqual((await layoutOf()).issues, [], 'the scaffolded AGENTS.md carries the absolute path');

  const agentsPath = path.join(root, 'AGENTS.md');
  const scaffolded = await fs.readFile(agentsPath, 'utf8');
  await fs.writeFile(agentsPath, '# Rules without the ledger path\n');
  assert.match((await layoutOf()).issues.join(' '), /does not contain this root's tasks\/todo\.md path/, 'U2');
  await fs.writeFile(agentsPath, scaffolded);

  await fs.mkdir(path.join(root, 'api', '.git'), { recursive: true });
  await fs.mkdir(path.join(root, 'web'));
  await fs.writeFile(path.join(root, 'web', '.git'), 'gitdir: elsewhere\n');
  await fs.mkdir(path.join(root, 'notes'));
  await fs.writeFile(agentsPath, `${scaffolded}\nChildren: api\n`);
  const layout = await layoutOf();
  assert.deepEqual(layout.issues, []);
  assert.equal(layout.warnings.length, 1, 'only the unnamed child with a .git file is flagged');
  assert.match(layout.warnings[0], /"web"/);
  await fx.runInProject(['project', 'doctor', '--check']);
});

test('project doctor child rules: SESSION.md hook and a git-ignored ledger', async () => {
  const root = await layoutRoot('child', { 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '@AGENTS.md\n' });
  await gitInit(root);
  const layoutOf = async (env = {}) => (await doctorJson(root, [], env)).sections.layout;

  const first = await layoutOf();
  assert.match(first.issues.join('\n'), /does not mention SESSION\.md/);
  assert.match(first.issues.join('\n'), /ledger is not ignored by git/);

  await fs.writeFile(path.join(root, 'AGENTS.md'), '# Rules\n\nIf `SESSION.md` exists, read it first.\n');
  await fs.writeFile(path.join(root, '.gitignore'), '/tasks/*\n!/tasks/todo.md\n');
  assert.deepEqual((await layoutOf()).issues, [], 'ignored through .gitignore');

  await fs.rm(path.join(root, '.gitignore'));
  assert.equal((await layoutOf()).issues.length, 1);
  await fs.appendFile(path.join(root, '.git', 'info', 'exclude'), '/tasks/\n');
  assert.deepEqual((await layoutOf()).issues, [], 'ignored through .git/info/exclude');

  const noGit = await layoutRoot('child', { 'AGENTS.md': 'Read `SESSION.md` if present.\n', 'CLAUDE.md': '@AGENTS.md\n' });
  const plain = (await doctorJson(noGit)).sections.layout;
  assert.deepEqual(plain.issues, []);
  assert.match(plain.notes.join(' '), /not a git repository/);

  await fs.rm(path.join(root, '.git', 'info', 'exclude'));
  const unavailable = await layoutOf({ PATH: '/nonexistent-skf-path' });
  assert.equal(unavailable.issues.length, 0, 'a missing git binary is a warning, not an issue');
  assert.match(unavailable.warnings.join(' '), /could not run git/);
});

test('project doctor reports one failing section and still shows the others', async () => {
  const root = await layoutRoot('umbrella', { 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '@AGENTS.md\n' });
  const emptyRegistry = await tempDir('skf-empty-registry-');
  const report = await doctorJson(root, [], { SKILL_FORGE_ROOT: emptyRegistry });
  assert.match(messages(report.issues).join('\n'), /profile could not be checked: .+/, 'the underlying error text is kept');
  assert.deepEqual(report.sections.instructions.issues, []);
  assert.equal(report.sections.layout.applicable, true, 'the layout section still ran');
  assert.match(report.sections.layout.issues.join(' '), /tasks\/todo\.md is missing or not a regular file/);
  assert.equal(report.ok, false);
  await assert.rejects(runDoctor(root, ['--check'], { SKILL_FORGE_ROOT: emptyRegistry }), (error) => {
    assert.equal(error.code, 1);
    return true;
  });
});

test('project doctor fails on a missing manifest, a bad role, a non-object instructions, and $HOME', async () => {
  const bare = await tempDir('skf-instr-bare-');
  await assert.rejects(runDoctor(bare, ['--json']), (error) => {
    assert.equal(error.code, 1);
    assert.match(JSON.parse(error.stdout).error, /No skill-forge\.json/);
    return true;
  });
  await assert.rejects(runDoctor(bare), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '', 'an abort prints no report');
    return true;
  });

  const bad = await layoutRoot('bogus');
  await assert.rejects(runDoctor(bad), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /instructions\.role.*repo, umbrella, child/);
    return true;
  });

  const nonObject = await instructionsRoot();
  const manifestPath = path.join(nonObject, 'skill-forge.json');
  await fs.writeFile(manifestPath, JSON.stringify({ ...JSON.parse(await fs.readFile(manifestPath, 'utf8')), instructions: 'nope' }));
  await assert.rejects(runDoctor(nonObject), /"instructions" must be an object/);

  const home = await layoutRoot('repo');
  await assert.rejects(runDoctor(home, [], { HOME: home }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /home sync --check/);
    return true;
  });
  await assert.rejects(runDoctor(home, ['--json'], { HOME: home }), (error) => {
    assert.equal(error.code, 1);
    assert.match(JSON.parse(error.stdout).error, /home sync --check/);
    return true;
  });
});

test('project doctor writes nothing in any mode, .git and empty directories included', async () => {
  const child = await layoutRoot('child', { 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '@AGENTS.md\n' });
  await gitInit(child);
  const umbrella = await layoutRoot('umbrella', { 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '@AGENTS.md\n' });
  await fs.mkdir(path.join(umbrella, 'api', '.git'), { recursive: true });

  for (const root of [child, umbrella]) {
    const before = await snapshotTree(root);
    await runDoctor(root);
    await runDoctor(root, ['--json']);
    await assert.rejects(runDoctor(root, ['--check']), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /^! layout: /m);
      return true;
    });
    assert.deepEqual(await snapshotTree(root), before);
  }
});

test('project doctor keeps its JSON contract and exits 1 under --check --json with JSON on stdout', async () => {
  const root = await layoutRoot('umbrella', { 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '@AGENTS.md\n' });
  const report = await doctorJson(root);
  assert.deepEqual(Object.keys(report).sort(), ['issues', 'ok', 'role', 'root', 'sections', 'warnings']);
  assert.deepEqual(Object.keys(report.sections).sort(), ['instructions', 'layout', 'profile']);
  assert.deepEqual(Object.keys(report.sections.profile), ['issues']);
  assert.deepEqual(Object.keys(report.sections.instructions).sort(), ['claudeMdRequired', 'files', 'issues', 'notes']);
  assert.deepEqual(Object.keys(report.sections.layout).sort(), ['applicable', 'issues', 'notes', 'warnings']);
  assert.ok(report.issues.every((entry) => typeof entry.section === 'string' && typeof entry.message === 'string'));
  assert.ok(report.issues.some((entry) => entry.section === 'layout'));

  await assert.rejects(runDoctor(root, ['--check', '--json']), (error) => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).ok, false);
    return true;
  });
  const { stderr } = await runDoctor(root, ['--json']);
  assert.equal(stderr, '', 'report mode keeps stderr empty');
});

test('project doctor plain output: issues on stdout in report mode, on stderr under --check, "No issues." when healthy', async () => {
  const fx = await syncedDoctorProject({ role: 'repo' });
  assert.match((await fx.runInProject(['project', 'doctor'])).stdout, /No issues\./);

  const root = await layoutRoot('umbrella', { 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '@AGENTS.md\n' });
  const report = await runDoctor(root);
  assert.match(report.stdout, /^! layout: tasks\/todo\.md is missing/m);
  assert.equal(report.stderr, '', 'report mode keeps issues off stderr');
  await assert.rejects(runDoctor(root, ['--check']), (error) => {
    assert.equal(error.code, 1);
    assert.doesNotMatch(error.stdout, /^! /m, '--check keeps issue lines off stdout');
    assert.match(error.stderr, /^! layout: tasks\/todo\.md is missing/m);
    return true;
  });
});

test('project doctor umbrella edge cases: a directory as the ledger, no AGENTS.md, whole-token names, symlinked child, dangling .git', async () => {
  const asDirectory = await layoutRoot('umbrella');
  await fs.mkdir(path.join(asDirectory, 'tasks', 'todo.md'), { recursive: true });
  assert.match((await doctorJson(asDirectory)).sections.layout.issues.join(' '), /tasks\/todo\.md is missing or not a regular file/);

  const noAgents = await layoutRoot('umbrella');
  await fs.mkdir(path.join(noAgents, 'tasks'));
  await fs.writeFile(path.join(noAgents, 'tasks', 'todo.md'), '# Tasks\n');
  await fs.mkdir(path.join(noAgents, 'api', '.git'), { recursive: true });
  const bare = (await doctorJson(noAgents)).sections.layout;
  assert.deepEqual(bare.issues, [], 'with no AGENTS.md the path and child rules are skipped, and the instructions section reports it');
  assert.deepEqual(bare.warnings, []);

  const root = await layoutRoot('umbrella', { 'AGENTS.md': 'Capital website notes.\n' });
  await fs.mkdir(path.join(root, 'tasks'));
  await fs.writeFile(path.join(root, 'tasks', 'todo.md'), '# Tasks\n');
  await fs.mkdir(path.join(root, 'a', '.git'), { recursive: true });
  await fs.mkdir(path.join(root, 'web', '.git'), { recursive: true });
  const realChild = await tempDir('skf-real-child-');
  await fs.mkdir(path.join(realChild, '.git'));
  await fs.symlink(realChild, path.join(root, 'linked'));
  await fs.mkdir(path.join(root, 'dangling'));
  await fs.symlink('nowhere', path.join(root, 'dangling', '.git'));
  await fs.mkdir(path.join(root, 'x\u001b[31my', '.git'), { recursive: true });
  await fs.mkdir(path.join(root, 'plain-dir'));

  const report = await doctorJson(root);
  const expected = ['a', 'dangling', 'linked', 'web', 'x?[31my'].map((name) => `child repo "${name}" is not named in AGENTS.md.`);
  assert.deepEqual([...report.sections.layout.warnings].sort(), expected, '"a" and "web" appear only inside other words');
  assert.deepEqual([...messages(report.warnings)].sort(), expected);
  assert.ok(report.warnings.every((entry) => entry.section === 'layout'));
  assert.ok(!JSON.stringify(report).includes('\u001b'), 'no raw escape character in the output');
});

test('project doctor child: no AGENTS.md adds no layout issue, git is queried for this directory, and a git failure only warns', async () => {
  const noAgents = await layoutRoot('child');
  await gitInit(noAgents);
  // In this repository's own exclude file, which a redirected GIT_DIR would not read (a .gitignore in the work tree would still apply).
  await fs.appendFile(path.join(noAgents, '.git', 'info', 'exclude'), '/tasks/*\n');
  assert.deepEqual((await doctorJson(noAgents)).sections.layout.issues, []);

  const other = await tempDir('skf-other-repo-');
  await gitInit(other);
  const inherited = (await doctorJson(noAgents, [], { GIT_DIR: path.join(other, '.git') })).sections.layout;
  assert.deepEqual(inherited.issues, [], 'GIT_DIR from the caller does not redirect the check to another repository');

  const fx = await syncedDoctorProject({ role: 'child' });
  await gitInit(fx.projectRoot);
  await fs.writeFile(path.join(fx.projectRoot, '.gitignore'), '/tasks/*\n!/tasks/todo.md\n');
  const bin = await tempDir('skf-fake-git-');
  await fs.writeFile(path.join(bin, 'git'), '#!/bin/sh\nexit 128\n', { mode: 0o755 });
  const { stdout } = await runDoctor(fx.projectRoot, ['--check', '--json'], { PATH: `${bin}:${process.env.PATH}` }, fx.env);
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true, 'a git failure never fails --check');
  assert.match(report.sections.layout.warnings.join(' '), /could not run git to check the ledger rule: git exited with 128/);
});
