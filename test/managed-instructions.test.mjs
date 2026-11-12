import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Managed instructions: `instructions.variant` in skill-forge.json makes sync write a marked block
// into AGENTS.md (and CLAUDE.md with the claude-code shim), and exclude skf-managed ancestors'
// instruction files from Claude Code in .claude/settings.local.json.

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.js');
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t'
};

const BEGIN_FULL = '<!-- >>> skill-forge instructions full@0.1.0 >>> -->';
const BEGIN_SLIM = '<!-- >>> skill-forge instructions slim@0.1.0 >>> -->';
const END = '<!-- <<< skill-forge instructions <<< -->';
const FULL_CORE = '# Core\n\nUse `{{explore_agent}}` to explore.\n';
const FULL_CORE_RENDERED = '# Core\n\nUse `Explore` to explore.';
const CLAUDE_OVERLAY = '# Claude overlay\n\nClaude-only notes.\n';
const SLIM_CORE = '# Slim core\n';

const tempDirs = [];
async function tempDir(prefix) {
  // realpath: macOS tmpdir is a symlink, and the exclude entries are absolute real paths.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
});

async function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
}

/** A registry with two instruction variants: `full` (core + Claude block) and `slim` (core only). */
async function registryFixture() {
  const root = await tempDir('skf-mi-reg-');
  await writeFiles(root, {
    'inventory/skills/.keep': '',
    'inventory/agents/core.md': FULL_CORE,
    'inventory/agents/claude-code/CLAUDE.md': CLAUDE_OVERLAY,
    'inventory/agents/variants/slim/core.md': SLIM_CORE
  });
  const registry = {
    name: 'skill-forge-test',
    version: '0.0.0',
    schemaVersion: 1,
    skills: [],
    managedAgents: [],
    managedSubagents: [],
    managedHooks: [],
    instructionVariants: [
      {
        name: 'full',
        version: '0.1.0',
        description: 'Full process instructions.',
        core: 'inventory/agents/core.md',
        claude: 'inventory/agents/claude-code/CLAUDE.md',
        vars: { explore_agent: 'Explore' }
      },
      {
        name: 'slim',
        version: '0.1.0',
        description: 'Slim process instructions.',
        core: 'inventory/agents/variants/slim/core.md'
      }
    ]
  };
  const env = { ...process.env, ...GIT_ENV, SKILL_FORGE_ROOT: root };
  const fx = {
    root,
    env,
    cli: (cwd, args, extraEnv = {}) => run('node', [CLI, ...args], { cwd, env: { ...env, ...extraEnv } }),
    async writeRegistry(next) {
      await fs.writeFile(path.join(root, 'registry.json'), `${JSON.stringify(next, null, 2)}\n`);
      await fx.cli(root, ['lock']);
    },
    registry
  };
  await fx.writeRegistry(registry);
  return fx;
}

/** A session root with a manifest (claude-code shim by default) and the named files. */
async function projectAt(dir, files = {}, { shims = ['claude-code'], instructions } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const manifest = { schemaVersion: 2, extends: [], skills: { dependencies: {}, shims } };
  if (instructions !== undefined) manifest.instructions = instructions;
  await writeFiles(dir, { 'skill-forge.json': `${JSON.stringify(manifest, null, 2)}\n`, ...files });
  return dir;
}

const read = (dir, rel) => fs.readFile(path.join(dir, rel), 'utf8');
const exists = (p) => fs.lstat(p).then(() => true, () => false);
const readJson = async (dir, rel) => JSON.parse(await read(dir, rel));
const manifestOf = (dir) => readJson(dir, 'skill-forge.json');
const lockOf = (dir) => readJson(dir, 'skill-forge.lock.json');

test('no variant: sync leaves instruction files alone and adds nothing to the lock', async () => {
  const fx = await registryFixture();
  const dir = await projectAt(await tempDir('skf-mi-'), { 'AGENTS.md': '# Mine\n', 'CLAUDE.md': '@AGENTS.md\n' });
  await fx.cli(dir, ['sync']);
  assert.equal(await read(dir, 'AGENTS.md'), '# Mine\n');
  assert.equal(await read(dir, 'CLAUDE.md'), '@AGENTS.md\n');
  assert.equal((await lockOf(dir)).instructions, undefined);
  assert.equal(await exists(path.join(dir, '.claude', 'settings.local.json')), false);
  await fx.cli(dir, ['sync', '--check']);
});

test('use full writes marked blocks, records the variant in the manifest and lock, and passes sync --check', async () => {
  const fx = await registryFixture();
  const dir = await projectAt(await tempDir('skf-mi-'), { 'AGENTS.md': '# Mine\n', 'CLAUDE.md': '@AGENTS.md\n' });
  const { stdout } = await fx.cli(dir, ['project', 'instructions', 'use', 'full']);
  assert.match(stdout, /full@0\.1\.0/);

  assert.deepEqual((await manifestOf(dir)).instructions, { variant: 'full', version: '^0.1.0' });
  assert.equal(await read(dir, 'AGENTS.md'), `# Mine\n\n${BEGIN_FULL}\n${FULL_CORE_RENDERED}\n${END}\n`);
  assert.equal(await read(dir, 'CLAUDE.md'), `@AGENTS.md\n\n${BEGIN_FULL}\n${CLAUDE_OVERLAY.trimEnd()}\n${END}\n`);

  const lock = await lockOf(dir);
  assert.equal(lock.instructions.variant, 'full');
  assert.equal(lock.instructions.version, '0.1.0');
  assert.match(lock.instructions.sha256.agents, /^sha256-/);
  assert.match(lock.instructions.sha256.claude, /^sha256-/);
  await fx.cli(dir, ['sync', '--check']);
});

test('slim, then full, then none round-trips user prose byte-for-byte', async () => {
  const fx = await registryFixture();
  const agents = '# Mine\n\nKeep this.\n';
  const claude = '@AGENTS.md\n\n# Claude extras\n';
  const dir = await projectAt(await tempDir('skf-mi-'), { 'AGENTS.md': agents, 'CLAUDE.md': claude });

  await fx.cli(dir, ['project', 'instructions', 'use', 'slim']);
  assert.equal(await read(dir, 'AGENTS.md'), `${agents}\n${BEGIN_SLIM}\n${SLIM_CORE.trimEnd()}\n${END}\n`);
  assert.equal(await read(dir, 'CLAUDE.md'), claude, 'slim has no Claude block');

  await fx.cli(dir, ['project', 'instructions', 'use', 'full@^0.1.0']);
  assert.equal(await read(dir, 'AGENTS.md'), `${agents}\n${BEGIN_FULL}\n${FULL_CORE_RENDERED}\n${END}\n`);
  assert.equal(await read(dir, 'CLAUDE.md'), `${claude}\n${BEGIN_FULL}\n${CLAUDE_OVERLAY.trimEnd()}\n${END}\n`);

  await fx.cli(dir, ['project', 'instructions', 'use', 'none']);
  assert.equal(await read(dir, 'AGENTS.md'), agents);
  assert.equal(await read(dir, 'CLAUDE.md'), claude);
  assert.equal((await manifestOf(dir)).instructions, undefined);
  assert.equal((await lockOf(dir)).instructions, undefined);
  await fx.cli(dir, ['sync', '--check']);
});

test('use creates missing instruction files, and none removes what is left empty', async () => {
  const fx = await registryFixture();
  const dir = await projectAt(await tempDir('skf-mi-'));
  await fx.cli(dir, ['project', 'instructions', 'use', 'full']);
  assert.equal(await read(dir, 'AGENTS.md'), `${BEGIN_FULL}\n${FULL_CORE_RENDERED}\n${END}\n`);
  assert.equal(await read(dir, 'CLAUDE.md'), `@AGENTS.md\n\n${BEGIN_FULL}\n${CLAUDE_OVERLAY.trimEnd()}\n${END}\n`);

  await fx.cli(dir, ['project', 'instructions', 'use', 'none']);
  assert.equal(await exists(path.join(dir, 'AGENTS.md')), false);
  assert.equal(await exists(path.join(dir, 'CLAUDE.md')), false, 'a lone import of a deleted AGENTS.md goes too');

  // Without the claude-code shim, CLAUDE.md is never created.
  const noShim = await projectAt(await tempDir('skf-mi-'), {}, { shims: [] });
  await fx.cli(noShim, ['project', 'instructions', 'use', 'full']);
  assert.equal(await exists(path.join(noShim, 'CLAUDE.md')), false);
  assert.equal((await lockOf(noShim)).instructions.sha256.claude, undefined);
});

test('sync refuses malformed markers, a CLAUDE.md without the import, symlinked files, and $HOME', async () => {
  const fx = await registryFixture();
  const variant = { variant: 'full', version: '^0.1.0' };

  const unclosed = await projectAt(await tempDir('skf-mi-'), { 'AGENTS.md': `# Mine\n${BEGIN_FULL}\nhalf\n`, 'CLAUDE.md': '@AGENTS.md\n' }, { instructions: variant });
  await assert.rejects(fx.cli(unclosed, ['sync']), /AGENTS\.md.*marker/s);
  assert.equal(await read(unclosed, 'AGENTS.md'), `# Mine\n${BEGIN_FULL}\nhalf\n`, 'nothing written');

  const twice = `${BEGIN_FULL}\na\n${END}\n${BEGIN_FULL}\nb\n${END}\n`;
  const duplicate = await projectAt(await tempDir('skf-mi-'), { 'AGENTS.md': twice, 'CLAUDE.md': '@AGENTS.md\n' }, { instructions: variant });
  await assert.rejects(fx.cli(duplicate, ['sync']), /AGENTS\.md.*marker/s);

  const noImport = await projectAt(await tempDir('skf-mi-'), { 'AGENTS.md': '# Mine\n', 'CLAUDE.md': '# Standalone\n' }, { instructions: variant });
  await assert.rejects(fx.cli(noImport, ['sync']), /CLAUDE\.md does not import AGENTS\.md/);
  assert.equal(await read(noImport, 'AGENTS.md'), '# Mine\n', 'refused before writing anything');

  const linked = await projectAt(await tempDir('skf-mi-'), { 'AGENTS.md': '# Mine\n' }, { instructions: variant });
  await fs.symlink('AGENTS.md', path.join(linked, 'CLAUDE.md'));
  await assert.rejects(fx.cli(linked, ['sync']), /CLAUDE\.md is a symlink/);

  const home = await projectAt(await tempDir('skf-mi-home-'), { 'AGENTS.md': '# Mine\n', 'CLAUDE.md': '@AGENTS.md\n' }, { instructions: variant });
  await assert.rejects(fx.cli(home, ['sync'], { HOME: home }), /\$HOME/);
  assert.equal(await read(home, 'AGENTS.md'), '# Mine\n');
});

test('sync --check flags an edited block and a registry change, but not edited user prose', async () => {
  const fx = await registryFixture();
  const dir = await projectAt(await tempDir('skf-mi-'), { 'AGENTS.md': '# Mine\n', 'CLAUDE.md': '@AGENTS.md\n' });
  await fx.cli(dir, ['project', 'instructions', 'use', 'full']);

  await fs.writeFile(path.join(dir, 'AGENTS.md'), (await read(dir, 'AGENTS.md')).replace('# Mine', '# Mine, edited'));
  await fx.cli(dir, ['sync', '--check']);

  await fs.writeFile(path.join(dir, 'AGENTS.md'), (await read(dir, 'AGENTS.md')).replace('to explore', 'to wander'));
  await assert.rejects(fx.cli(dir, ['sync', '--check']), /AGENTS\.md: the skill-forge instructions block was edited/);
  await fx.cli(dir, ['sync']);
  assert.match(await read(dir, 'AGENTS.md'), /# Mine, edited\n/);
  assert.match(await read(dir, 'AGENTS.md'), /to explore/);

  const registry = structuredClone(fx.registry);
  registry.instructionVariants[0].version = '0.1.1';
  await fs.writeFile(path.join(fx.root, 'inventory/agents/core.md'), `${FULL_CORE}More.\n`);
  await fx.writeRegistry(registry);
  await assert.rejects(fx.cli(dir, ['sync', '--check']), /AGENTS\.md: the skill-forge instructions block is stale/);
  await fx.cli(dir, ['sync']);
  assert.match(await read(dir, 'AGENTS.md'), /instructions full@0\.1\.1 >>>/);
  await fx.cli(dir, ['sync', '--check']);
});

test('use rejects an unknown variant, a malformed range, and a range the registry does not satisfy', async () => {
  const fx = await registryFixture();
  const dir = await projectAt(await tempDir('skf-mi-'), { 'AGENTS.md': '# Mine\n', 'CLAUDE.md': '@AGENTS.md\n' });
  await assert.rejects(fx.cli(dir, ['project', 'instructions', 'use', 'huge']), /Unknown instructions variant "huge".*full, slim/s);
  await assert.rejects(fx.cli(dir, ['project', 'instructions', 'use', 'full@>=1']), /Invalid range/);
  await assert.rejects(fx.cli(dir, ['project', 'instructions', 'use', 'full@^0.2.0']), /does not satisfy/);
  assert.equal((await manifestOf(dir)).instructions, undefined, 'a refused use writes nothing');
  assert.equal(await read(dir, 'AGENTS.md'), '# Mine\n');
});

test('a child under an skf umbrella excludes the umbrella files, keeps other settings, and stays untracked', async () => {
  const fx = await registryFixture();
  const umbrella = await projectAt(await tempDir('skf-mi-umb-'), { 'AGENTS.md': '# Umbrella\n', 'CLAUDE.md': '@AGENTS.md\n' });
  const child = await projectAt(path.join(umbrella, 'app-be'), { 'AGENTS.md': '# Child\n', 'CLAUDE.md': '@AGENTS.md\n' });
  await writeFiles(child, { '.claude/settings.local.json': `${JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, claudeMdExcludes: ['/elsewhere/CLAUDE.md'] }, null, 2)}\n` });
  await run('git', ['init', '-q', '-b', 'main'], { cwd: child, env: fx.env });
  await run('git', ['add', 'AGENTS.md', 'CLAUDE.md', 'skill-forge.json'], { cwd: child, env: fx.env });
  await run('git', ['commit', '-q', '-m', 'init'], { cwd: child, env: fx.env });

  await fx.cli(child, ['project', 'instructions', 'use', 'full']);
  const umbrellaFiles = [`${umbrella}/CLAUDE.md`, `${umbrella}/.claude/CLAUDE.md`, `${umbrella}/AGENTS.md`];
  const settings = await readJson(child, '.claude/settings.local.json');
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] }, 'other keys kept');
  assert.deepEqual(settings.claudeMdExcludes, ['/elsewhere/CLAUDE.md', ...umbrellaFiles]);
  const { stdout: porcelain } = await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: child, env: fx.env });
  assert.doesNotMatch(porcelain, /settings\.local\.json/, 'the settings file is excluded from git');
  await fx.cli(child, ['sync', '--check']);

  // A removed entry is reported, and sync puts it back.
  await fs.writeFile(path.join(child, '.claude/settings.local.json'), `${JSON.stringify({ ...settings, claudeMdExcludes: ['/elsewhere/CLAUDE.md'] }, null, 2)}\n`);
  await assert.rejects(fx.cli(child, ['sync', '--check']), /settings\.local\.json does not exclude/);
  await fx.cli(child, ['sync']);
  assert.deepEqual((await readJson(child, '.claude/settings.local.json')).claudeMdExcludes, ['/elsewhere/CLAUDE.md', ...umbrellaFiles]);

  // The umbrella itself has no skf ancestor, so it excludes nothing.
  await fx.cli(umbrella, ['project', 'instructions', 'use', 'full']);
  assert.equal(await exists(path.join(umbrella, '.claude', 'settings.local.json')), false);

  // none removes only its own entries; a file it created and emptied goes away.
  await fx.cli(child, ['project', 'instructions', 'use', 'none']);
  assert.deepEqual(await readJson(child, '.claude/settings.local.json'), { permissions: { allow: ['Bash(ls)'] }, claudeMdExcludes: ['/elsewhere/CLAUDE.md'] });
  const bare = await projectAt(path.join(umbrella, 'app-fe'), { 'AGENTS.md': '# Fe\n', 'CLAUDE.md': '@AGENTS.md\n' });
  await fx.cli(bare, ['project', 'instructions', 'use', 'full']);
  assert.deepEqual((await readJson(bare, '.claude/settings.local.json')).claudeMdExcludes, umbrellaFiles);
  await fx.cli(bare, ['project', 'instructions', 'use', 'none']);
  assert.equal(await exists(path.join(bare, '.claude', 'settings.local.json')), false);
});

test('doctor fails when a child and its umbrella differ in variant or version, and lists the excluded files', async () => {
  const fx = await registryFixture();
  const umbrella = await projectAt(await tempDir('skf-mi-umb-'), { 'AGENTS.md': '# Umbrella\n', 'CLAUDE.md': '@AGENTS.md\n' });
  const child = await projectAt(path.join(umbrella, 'app-be'), { 'AGENTS.md': '# Child\n', 'CLAUDE.md': '@AGENTS.md\n' });
  await fx.cli(umbrella, ['project', 'instructions', 'use', 'full']);
  await fx.cli(child, ['project', 'instructions', 'use', 'slim']);

  const report = JSON.parse((await fx.cli(child, ['project', 'doctor', '--json'])).stdout);
  assert.equal(report.ok, false);
  assert.ok(report.sections.managed.issues.some((issue) => /slim@0\.1\.0.*full@0\.1\.0/.test(issue)), JSON.stringify(report.sections.managed));
  assert.ok(report.sections.managed.notes.some((note) => note.includes(`${umbrella}/AGENTS.md`)));

  await fx.cli(child, ['project', 'instructions', 'use', 'full']);
  const healthy = JSON.parse((await fx.cli(child, ['project', 'doctor', '--json'])).stdout);
  assert.deepEqual(healthy.sections.managed.issues, []);
});

test('validate rejects an instructions variant with a missing file or an unresolved placeholder', async () => {
  const fx = await registryFixture();
  await fx.cli(fx.root, ['validate']);

  const missing = structuredClone(fx.registry);
  missing.instructionVariants[1].core = 'inventory/agents/variants/nope/core.md';
  await fs.writeFile(path.join(fx.root, 'registry.json'), `${JSON.stringify(missing, null, 2)}\n`);
  await assert.rejects(fx.cli(fx.root, ['validate']), /instructions variant slim.*missing file/s);

  const unresolved = structuredClone(fx.registry);
  delete unresolved.instructionVariants[0].vars;
  await fs.writeFile(path.join(fx.root, 'registry.json'), `${JSON.stringify(unresolved, null, 2)}\n`);
  await assert.rejects(fx.cli(fx.root, ['validate']), /instructions variant full.*\{\{explore_agent\}\}/s);
});

// --- Regression tests from the Phase 1 review ---

const gitIn = (dir, args, env) => run('git', args, { cwd: dir, env });

test('the user\'s own exclude entries survive: $HOME files and non-skf ancestors are never sync\'s', async () => {
  const fx = await registryFixture();
  const home = await tempDir('skf-mi-home-');
  const plainParent = await tempDir('skf-mi-plain-');
  const umbrella = await projectAt(path.join(plainParent, 'umb'), { 'AGENTS.md': '# U\n' });
  const child = await projectAt(path.join(umbrella, 'app'), { 'AGENTS.md': '# C\n', 'CLAUDE.md': '@AGENTS.md\n' });
  const mine = [`${home}/.claude/CLAUDE.md`, `${plainParent}/CLAUDE.md`, `${plainParent}/AGENTS.md`];
  await writeFiles(child, { '.claude/settings.local.json': `${JSON.stringify({ claudeMdExcludes: mine })}\n` });
  const env = { HOME: home };

  await fx.cli(child, ['project', 'instructions', 'use', 'full'], env);
  const umbrellaFiles = [`${umbrella}/CLAUDE.md`, `${umbrella}/.claude/CLAUDE.md`, `${umbrella}/AGENTS.md`];
  assert.deepEqual((await readJson(child, '.claude/settings.local.json')).claudeMdExcludes, [...mine, ...umbrellaFiles]);
  await fx.cli(child, ['sync', '--check'], env);
  await fx.cli(child, ['project', 'instructions', 'use', 'none'], env);
  assert.deepEqual((await readJson(child, '.claude/settings.local.json')).claudeMdExcludes, mine);
});

test('a work-* worktree under an skf umbrella: excludes written, settings kept out of git, overlay --clear keeps the line', async () => {
  const fx = await registryFixture();
  const umbrella = await projectAt(await tempDir('skf-mi-umb-'), { 'AGENTS.md': '# U\n' });
  const child = await projectAt(path.join(umbrella, 'app-be'), { 'AGENTS.md': '# C\n', 'CLAUDE.md': '@AGENTS.md\n' });
  await fx.cli(child, ['sync']);
  await gitIn(child, ['init', '-q', '-b', 'main'], fx.env);
  await gitIn(child, ['add', '-A'], fx.env);
  await gitIn(child, ['commit', '-q', '-m', 'init'], fx.env);
  const worktree = path.join(umbrella, 'work-slice');
  await gitIn(child, ['worktree', 'add', '-q', worktree, '-b', 'slice'], fx.env);
  const { stdout: commonDir } = await gitIn(worktree, ['rev-parse', '--git-common-dir'], fx.env);
  const excludePath = path.join(path.resolve(worktree, commonDir.trim()), 'info', 'exclude');

  await fx.cli(worktree, ['project', 'instructions', 'use', 'full']);
  assert.deepEqual((await readJson(worktree, '.claude/settings.local.json')).claudeMdExcludes,
    [`${umbrella}/CLAUDE.md`, `${umbrella}/.claude/CLAUDE.md`, `${umbrella}/AGENTS.md`]);
  assert.match(await fs.readFile(excludePath, 'utf8'), /^\/\.claude\/settings\.local\.json$/m);
  const { stdout: porcelain } = await gitIn(worktree, ['status', '--porcelain', '--untracked-files=all'], fx.env);
  assert.doesNotMatch(porcelain, /settings\.local\.json/);

  await fx.cli(worktree, ['project', 'overlay', '--clear']);
  assert.match(await fs.readFile(excludePath, 'utf8'), /^\/\.claude\/settings\.local\.json$/m, 'overlay --clear keeps the managed line');
  await fx.cli(worktree, ['sync', '--check']);

  await fx.cli(worktree, ['project', 'instructions', 'use', 'none']);
  assert.doesNotMatch(await fs.readFile(excludePath, 'utf8'), /settings\.local\.json/, 'use none drops the line');
  assert.equal(await exists(path.join(worktree, '.claude', 'settings.local.json')), false);
});

test('CRLF files get CRLF block lines, a second sync changes nothing, and none restores them', async () => {
  const fx = await registryFixture();
  const agents = '# Mine\r\n\r\nKeep.\r\n';
  const claude = '@AGENTS.md\r\n';
  const dir = await projectAt(await tempDir('skf-mi-'), { 'AGENTS.md': agents, 'CLAUDE.md': claude });
  await fx.cli(dir, ['project', 'instructions', 'use', 'full']);
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const text = await read(dir, file);
    assert.doesNotMatch(text, /[^\r]\n/, `${file} has only CRLF line endings`);
    assert.match(text, /skill-forge instructions full@0\.1\.0/);
  }
  const { stdout } = await fx.cli(dir, ['sync']);
  assert.doesNotMatch(stdout, /updated/, 'an up-to-date CRLF block is not rewritten');
  await fx.cli(dir, ['sync', '--check']);
  await fx.cli(dir, ['project', 'instructions', 'use', 'none']);
  assert.equal(await read(dir, 'AGENTS.md'), agents);
  assert.equal(await read(dir, 'CLAUDE.md'), claude);
});

test('a variant without a Claude block still creates the CLAUDE.md import, and dropping the shim removes the Claude block', async () => {
  const fx = await registryFixture();
  const slim = await projectAt(await tempDir('skf-mi-'), { 'AGENTS.md': '# Mine\n' });
  await fx.cli(slim, ['project', 'instructions', 'use', 'slim']);
  assert.equal(await read(slim, 'CLAUDE.md'), '@AGENTS.md\n');

  const dir = await projectAt(await tempDir('skf-mi-'), { 'AGENTS.md': '# Mine\n', 'CLAUDE.md': '@AGENTS.md\n' });
  await fx.cli(dir, ['project', 'instructions', 'use', 'full']);
  const manifest = await manifestOf(dir);
  manifest.skills.shims = [];
  await fs.writeFile(path.join(dir, 'skill-forge.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(fx.cli(dir, ['sync', '--check']), /CLAUDE\.md: the skill-forge instructions block is no longer declared/);
  await fx.cli(dir, ['sync']);
  assert.equal(await read(dir, 'CLAUDE.md'), '@AGENTS.md\n');
  await fx.cli(dir, ['sync', '--check']);
});

test('a failed use restores the manifest, and a block with no variant or lock entry is still found and removed', async () => {
  const fx = await registryFixture();
  const broken = `# Mine\n${BEGIN_FULL}\nhalf\n`;
  const dir = await projectAt(await tempDir('skf-mi-'), { 'AGENTS.md': broken, 'CLAUDE.md': '@AGENTS.md\n' });
  const manifestBefore = await read(dir, 'skill-forge.json');
  await assert.rejects(fx.cli(dir, ['project', 'instructions', 'use', 'full']), /marker/);
  assert.equal(await read(dir, 'skill-forge.json'), manifestBefore);
  assert.equal(await read(dir, 'AGENTS.md'), broken);

  // As if an interrupted use had written the block but not the lock.
  const orphan = await projectAt(await tempDir('skf-mi-'), { 'AGENTS.md': `# Mine\n\n${BEGIN_FULL}\nold\n${END}\n`, 'CLAUDE.md': '@AGENTS.md\n' });
  await assert.rejects(fx.cli(orphan, ['sync', '--check']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /AGENTS\.md: the skill-forge instructions block is no longer declared/);
    return true;
  });
  await fx.cli(orphan, ['sync']);
  assert.equal(await read(orphan, 'AGENTS.md'), '# Mine\n');
});

test('sync warns when it replaces an edited block; a marker quoted inside prose is not a block', async () => {
  const fx = await registryFixture();
  const quoted = '# Mine\n\nThe format starts with `<!-- >>> skill-forge instructions full@0.1.0 >>> -->`.\n';
  const dir = await projectAt(await tempDir('skf-mi-'), { 'AGENTS.md': quoted, 'CLAUDE.md': '@AGENTS.md\n' });
  await fx.cli(dir, ['project', 'instructions', 'use', 'full']);
  assert.ok((await read(dir, 'AGENTS.md')).startsWith(quoted), 'quoted marker left as prose');
  await fs.writeFile(path.join(dir, 'AGENTS.md'), (await read(dir, 'AGENTS.md')).replace('to explore', 'to roam'));
  const { stdout } = await fx.cli(dir, ['sync']);
  assert.match(stdout, /AGENTS\.md: replaced an edited skill-forge instructions block/);
});

test('use refuses $HOME, a non-object instructions value, no variant name and an unknown action, writing nothing', async () => {
  const fx = await registryFixture();
  const home = await projectAt(await tempDir('skf-mi-home-'), { 'AGENTS.md': '# Mine\n' });
  const before = await read(home, 'skill-forge.json');
  await assert.rejects(fx.cli(home, ['project', 'instructions', 'use', 'full'], { HOME: home }), /\$HOME/);
  assert.equal(await read(home, 'skill-forge.json'), before);

  const bad = await projectAt(await tempDir('skf-mi-'), {}, { instructions: 'oops' });
  await assert.rejects(fx.cli(bad, ['project', 'instructions', 'use', 'full']), /"instructions" must be an object/);
  assert.equal((await manifestOf(bad)).instructions, 'oops');

  const dir = await projectAt(await tempDir('skf-mi-'), { 'AGENTS.md': '# Mine\n' }, { instructions: { role: 'repo' } });
  await assert.rejects(fx.cli(dir, ['project', 'instructions', 'use']), /Name a variant/);
  await assert.rejects(fx.cli(dir, ['project', 'instructions', 'swap', 'full']), /Unknown action "swap"/);
  await fx.cli(dir, ['project', 'instructions', 'use', 'full']);
  assert.deepEqual((await manifestOf(dir)).instructions, { role: 'repo', variant: 'full', version: '^0.1.0' }, 'role kept');
  await fx.cli(dir, ['project', 'instructions', 'use', 'none']);
  assert.deepEqual((await manifestOf(dir)).instructions, { role: 'repo' });
});

test('an ancestor path with glob characters is reported, not written, and does not block sync', async () => {
  const fx = await registryFixture();
  const umbrella = await projectAt(path.join(await tempDir('skf-mi-'), 'Projects (old)'), { 'AGENTS.md': '# U\n' });
  const child = await projectAt(path.join(umbrella, 'app'), { 'AGENTS.md': '# C\n', 'CLAUDE.md': '@AGENTS.md\n' });
  await fx.cli(child, ['project', 'instructions', 'use', 'full']);
  assert.match(await read(child, 'AGENTS.md'), /skill-forge instructions full/);
  assert.equal(await exists(path.join(child, '.claude', 'settings.local.json')), false);
  await assert.rejects(fx.cli(child, ['sync', '--check']), /cannot exclude .*Projects \(old\).*glob characters/);
});

test('sync refuses a tracked settings.local.json and a symlinked .claude folder before writing anything', async () => {
  const fx = await registryFixture();
  const umbrella = await projectAt(await tempDir('skf-mi-umb-'), { 'AGENTS.md': '# U\n' });
  const tracked = await projectAt(path.join(umbrella, 'tracked'), { 'AGENTS.md': '# C\n', 'CLAUDE.md': '@AGENTS.md\n', '.claude/settings.local.json': '{}\n' });
  await gitIn(tracked, ['init', '-q', '-b', 'main'], fx.env);
  // -f: a user-level git ignore file (~/.config/git/ignore) may already ignore this path.
  await gitIn(tracked, ['add', '-f', '-A', '.'], fx.env);
  await gitIn(tracked, ['add', '-f', '.claude/settings.local.json'], fx.env);
  await gitIn(tracked, ['commit', '-q', '-m', 'init'], fx.env);
  await assert.rejects(fx.cli(tracked, ['project', 'instructions', 'use', 'full']), /tracked by git/);
  assert.equal(await read(tracked, 'AGENTS.md'), '# C\n');
  assert.equal(await read(tracked, '.claude/settings.local.json'), '{}\n');

  const shared = await tempDir('skf-mi-shared-');
  const linked = await projectAt(path.join(umbrella, 'linked'), { 'AGENTS.md': '# C\n', 'CLAUDE.md': '@AGENTS.md\n' });
  await fs.symlink(shared, path.join(linked, '.claude'));
  await assert.rejects(fx.cli(linked, ['project', 'instructions', 'use', 'full']), /\.claude is a symlink/);
  assert.deepEqual(await fs.readdir(shared), []);
});

test('doctor compares locked versions on both sides and notes an ancestor variant on a root without one', async () => {
  const fx = await registryFixture();
  const umbrella = await projectAt(await tempDir('skf-mi-umb-'), { 'AGENTS.md': '# U\n', 'CLAUDE.md': '@AGENTS.md\n' });
  const child = await projectAt(path.join(umbrella, 'app'), { 'AGENTS.md': '# C\n', 'CLAUDE.md': '@AGENTS.md\n' });
  await fx.cli(umbrella, ['project', 'instructions', 'use', 'full']);

  const plain = JSON.parse((await fx.cli(child, ['project', 'doctor', '--json'])).stdout);
  assert.deepEqual(plain.sections.managed.issues, []);
  assert.ok(plain.sections.managed.notes.some((note) => note.includes('uses full@0.1.0 and this root declares none')));
  assert.ok(plain.sections.managed.notes.some((note) => note.startsWith('with a variant declared')));

  const registry = structuredClone(fx.registry);
  registry.instructionVariants[0].version = '0.1.1';
  await fx.writeRegistry(registry);
  await fx.cli(child, ['project', 'instructions', 'use', 'full']);
  await assert.rejects(fx.cli(child, ['project', 'doctor', '--check']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /managed: this root uses full@0\.1\.1 but .* uses full@0\.1\.0/);
    return true;
  });
});
