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
  assert.ok(listPayload.some((skill) => skill.name === name));

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
    runtimeTarget: '~/.codex/skills/broken-sibling',
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
      runtimeTarget: '~/.codex/skills/abs-escape',
      tags: []
    },
    {
      type: 'skill',
      name: 'rel-escape',
      version: '0.1.0',
      scope: 'custom',
      path: 'inventory/skills/../../../tmp-should-not-delete',
      installable: true,
      runtimeTarget: '~/.codex/skills/rel-escape',
      tags: []
    },
    {
      type: 'skill',
      name: 'boundary-escape',
      version: '0.1.0',
      scope: 'custom',
      path: 'inventory/skills',
      installable: true,
      runtimeTarget: '~/.codex/skills/boundary-escape',
      tags: []
    },
    {
      type: 'skill',
      name: 'keep-me',
      version: '0.1.0',
      scope: 'custom',
      path: 'inventory/skills/keep-me',
      installable: true,
      runtimeTarget: '~/.codex/skills/keep-me',
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
